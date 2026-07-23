"""Embedding generation for KB processor.

Calls the LLM gateway (Bifrost) at `/litellm/v1/embeddings` instead of running
a local SentenceTransformer model in-process. The pre-port image carried
~700 MB of torch + sentence-transformers weights; the new client makes the
worker pod start in seconds and the model live in the in-cluster TEI
Deployment (for built-ins) or at an upstream provider (for user-registered
remote models).

Keeps the previous public surface — :meth:`stream_record_batches` yields one
``pa.RecordBatch`` per HTTP batch so LanceDB ingests lazily, and
:attr:`embedding_dimension` / :meth:`get_schema` are unchanged — so the
caller in `processor.py` only needs to swap construction arguments.
"""

from observability_client_runtime import get_logger
import random
import time
from typing import Any, Callable, Dict, Iterator, List, Optional

import numpy as np
import pyarrow as pa
import requests

# Absolute import per commit 154a287 — kb-processor runs with /app on
# PYTHONPATH so relative `from .chunker import Chunk` fails at module load
# in the temporal worker entrypoint.
from processing.chunker import Chunk

logger = get_logger()

# Type alias: callback(completed_count, total_count)
ProgressCallback = Optional[Callable[[int, int], None]]

# How often (seconds) to emit a log line / invoke the progress callback.
# Keeps logs readable even when there are thousands of batches.
_LOG_INTERVAL_SECONDS = 10.0

# HTTP knobs. TEI's ORT backend can take 30-60s on cold start when the model
# hasn't been downloaded yet, so the per-request timeout is generous.
_DEFAULT_TIMEOUT_SECONDS = 180.0
_MAX_RETRIES = 5
_INITIAL_BACKOFF_SECONDS = 0.5
_MAX_BACKOFF_SECONDS = 30.0

# Adaptive batch bounds. Start at the caller-supplied size; halve on 413/429
# and back off; double back up after consecutive successes. Keeps a single
# slow chunk from poisoning throughput.
_MIN_BATCH_SIZE = 1
_MAX_BATCH_SIZE = 256


class EmbeddingGenerator:
    """Gateway-backed embedder. Drop-in replacement for the prior
    SentenceTransformer-based class — same public methods, same yield shape.

    Construction now requires the gateway URL, the per-project virtual key
    bearer token, and the embedding dimension (the dim is known to
    config-service at workflow-dispatch time, so we don't probe for it).
    """

    def __init__(
        self,
        model_name: str,
        proxy_url: str,
        api_key: str,
        dim: int,
        batch_size: int = 64,
        request_timeout: float = _DEFAULT_TIMEOUT_SECONDS,
    ):
        """
        Args:
            model_name: Identifier the gateway uses to route the embedding
                request. For built-ins, this is the HuggingFace id
                (e.g. ``sentence-transformers/all-MiniLM-L6-v2``). For
                remote-provider models, this is the value in
                ``Model.gatewayModelId`` (already provider-prefixed).
            proxy_url: Bifrost base URL (no trailing slash).
            api_key: Per-project Bifrost virtual-key bearer.
            dim: Embedding dimensionality (used to build the LanceDB schema
                without needing a probe request).
            batch_size: Initial batch size for the streaming API.
            request_timeout: Per-request HTTP timeout in seconds.
        """
        if not model_name:
            raise ValueError("EmbeddingGenerator: model_name is required")
        if not proxy_url:
            raise ValueError("EmbeddingGenerator: proxy_url is required (no LLM_GATEWAY_URL)")
        if not api_key:
            raise ValueError(
                "EmbeddingGenerator: api_key is required (no project virtual-key token)"
            )
        if dim <= 0:
            raise ValueError(f"EmbeddingGenerator: dim must be positive, got {dim}")

        self.model_name = model_name
        self.proxy_url = proxy_url.rstrip("/")
        self.api_key = api_key
        self.dim = dim
        self.batch_size = max(_MIN_BATCH_SIZE, min(_MAX_BATCH_SIZE, batch_size))
        self.request_timeout = request_timeout

        # Reuse one Session across batches so connection pool / keep-alive
        # survives between requests. Sessions are not thread-safe so each
        # worker activity gets its own (we instantiate one per processor run).
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {self.api_key}",
                # Bifrost accepts either header; sending both protects against
                # auth-middleware reshuffling on the gateway side.
                "x-api-key": self.api_key,
                "Content-Type": "application/json",
            }
        )

    @staticmethod
    def _fmt_duration(seconds: float) -> str:
        """Human-readable duration."""
        if seconds < 60:
            return f"{seconds:.1f}s"
        m, s = divmod(seconds, 60)
        if seconds < 3600:
            return f"{int(m)}m {int(s)}s"
        h, rem = divmod(seconds, 3600)
        m2, _ = divmod(rem, 60)
        return f"{int(h)}h {int(m2)}m"

    @staticmethod
    def get_schema(dim: int) -> pa.Schema:
        """PyArrow schema for the LanceDB embeddings table — unchanged from
        the pre-port implementation so existing tables are compatible."""
        return pa.schema(
            [
                pa.field("id", pa.utf8()),
                pa.field("document_id", pa.utf8()),
                pa.field("source", pa.utf8()),
                pa.field("text", pa.utf8()),
                pa.field("chunk_index", pa.int64()),
                pa.field("vector", pa.list_(pa.float32(), dim)),
                pa.field("metadata", pa.utf8()),
            ]
        )

    @staticmethod
    def _build_record_batch(
        chunks: List[Chunk], embeddings: np.ndarray, dim: int
    ) -> pa.RecordBatch:
        """Pack one HTTP batch into a PyArrow RecordBatch."""
        flat = embeddings.astype(np.float32, copy=False).ravel()
        values = pa.array(flat, type=pa.float32())
        vectors = pa.FixedSizeListArray.from_arrays(values, dim)
        return pa.RecordBatch.from_arrays(
            [
                pa.array([c.chunk_id for c in chunks]),
                pa.array([c.document_id for c in chunks]),
                pa.array([c.source for c in chunks]),
                pa.array([c.text for c in chunks]),
                pa.array([c.chunk_index for c in chunks], type=pa.int64()),
                vectors,
                pa.array([c.metadata_json for c in chunks]),
            ],
            names=[
                "id",
                "document_id",
                "source",
                "text",
                "chunk_index",
                "vector",
                "metadata",
            ],
        )

    # Exposed so callers (stream_record_batches) can switch on the failure
    # mode without parsing free-form error message text. Set on the
    # RuntimeError when retries are exhausted.
    _STATUS_THROTTLED = 429
    _STATUS_PAYLOAD_TOO_LARGE = 413

    def _post_embeddings(self, inputs: List[str]) -> np.ndarray:
        """POST one batch of texts to the gateway and return an (N, dim)
        float32 array. Retries on 429/5xx with exponential backoff + jitter.

        On exhaustion the raised `RuntimeError` carries the last observed
        HTTP status code as a `status_code` attribute so `stream_record_batches`
        can decide to shrink the batch without parsing the message text."""
        url = f"{self.proxy_url}/litellm/v1/embeddings"
        # `encoding_format: "float"` is critical — without it Bifrost returns
        # base64-encoded vectors and the downstream parse silently corrupts.
        # See commit a7310c1d.
        body = {
            "model": self.model_name,
            "input": inputs,
            "encoding_format": "float",
        }

        backoff = _INITIAL_BACKOFF_SECONDS
        last_exc: Optional[BaseException] = None
        last_status: Optional[int] = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                resp = self._session.post(url, json=body, timeout=self.request_timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_exc = exc
                last_status = None
                logger.warning(
                    f"Embedding request network error (attempt {attempt}/{_MAX_RETRIES}): {exc}"
                )
            else:
                if resp.status_code < 400:
                    return self._parse_response(resp.json(), len(inputs))
                # 4xx other than 413/429 is a permanent client error; surface it.
                if resp.status_code not in (413, 429) and resp.status_code < 500:
                    err = RuntimeError(
                        f"Embedding request failed with HTTP {resp.status_code}: "
                        f"{resp.text[:512]}"
                    )
                    err.status_code = resp.status_code  # type: ignore[attr-defined]
                    raise err
                last_exc = RuntimeError(
                    f"HTTP {resp.status_code} from {url}: {resp.text[:512]}"
                )
                last_status = resp.status_code
                logger.warning(
                    f"Embedding request transient error (attempt {attempt}/{_MAX_RETRIES}): "
                    f"HTTP {resp.status_code}"
                )

            if attempt < _MAX_RETRIES:
                sleep_for = min(
                    _MAX_BACKOFF_SECONDS,
                    backoff + random.uniform(0, backoff),
                )
                time.sleep(sleep_for)
                backoff = min(_MAX_BACKOFF_SECONDS, backoff * 2)

        # Out of retries. Surface the last observed HTTP status code as a
        # structured attribute so the caller's adaptive-shrink logic doesn't
        # have to substring-match the message text.
        last_status_str = f" (last HTTP status: {last_status})" if last_status else ""
        err = RuntimeError(
            f"Embedding request to {url} failed after {_MAX_RETRIES} retries{last_status_str}"
        )
        if last_status is not None:
            err.status_code = last_status  # type: ignore[attr-defined]
        raise err from last_exc

    def _parse_response(self, payload: Dict[str, Any], expected_count: int) -> np.ndarray:
        """Validate and extract the embeddings array from an OpenAI-shaped
        response body."""
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != expected_count:
            raise RuntimeError(
                f"Embedding response shape mismatch: expected {expected_count} "
                f"entries, got {len(data) if isinstance(data, list) else 'non-list'}"
            )
        # Each entry is { "object": "embedding", "embedding": [...], "index": i }.
        # Sort by index defensively (Bifrost is supposed to preserve order).
        ordered = sorted(data, key=lambda d: d.get("index", 0))
        rows = []
        for i, entry in enumerate(ordered):
            vec = entry.get("embedding")
            if not isinstance(vec, list) or len(vec) != self.dim:
                raise RuntimeError(
                    f"Embedding entry {i} has wrong shape: "
                    f"got {len(vec) if isinstance(vec, list) else 'non-list'}, expected {self.dim}"
                )
            rows.append(vec)
        return np.asarray(rows, dtype=np.float32)

    def stream_record_batches(
        self,
        chunks: List[Chunk],
        progress_callback: ProgressCallback = None,
    ) -> Iterator[pa.RecordBatch]:
        """Yield one ``pa.RecordBatch`` per HTTP batch. Mirrors the pre-port
        contract — the caller (lancedb_writer) iterates and ingests lazily so
        peak memory is proportional to ``batch_size`` rather than ``len(chunks)``."""
        if not chunks:
            raise ValueError("No chunks provided for embedding generation")

        total = len(chunks)
        current_batch_size = self.batch_size
        total_batches_est = (total + current_batch_size - 1) // current_batch_size

        logger.info(
            f"Streaming embeddings via gateway for {total:,} chunks "
            f"(model={self.model_name}, dim={self.dim}, initial_batch={current_batch_size})..."
        )

        encode_start = time.monotonic()
        last_log_time = encode_start
        last_pct_milestone = -1

        completed = 0
        batch_num = 0
        consecutive_successes = 0

        while completed < total:
            batch_end = min(completed + current_batch_size, total)
            batch_chunks = chunks[completed:batch_end]
            batch_texts = [c.text for c in batch_chunks]

            try:
                batch_embeddings = self._post_embeddings(batch_texts)
            except RuntimeError as exc:
                # Adaptive shrink on payload-too-large / throttling signals.
                # `_post_embeddings` attaches the last observed HTTP status
                # as `exc.status_code` so we don't substring-match the
                # message text — substrings disappeared after a previous
                # rewrap of the error.
                status = getattr(exc, "status_code", None)
                shrinkable = status in (413, 429)
                if current_batch_size > _MIN_BATCH_SIZE and shrinkable:
                    new_size = max(_MIN_BATCH_SIZE, current_batch_size // 2)
                    logger.warning(
                        f"Embedding batch shrink: {current_batch_size} -> {new_size} "
                        f"(HTTP {status})"
                    )
                    current_batch_size = new_size
                    consecutive_successes = 0
                    continue
                raise

            yield self._build_record_batch(batch_chunks, batch_embeddings, self.dim)

            completed = batch_end
            batch_num += 1
            consecutive_successes += 1

            # After 4 consecutive clean batches, gently grow back toward the
            # configured maximum.
            if (
                consecutive_successes >= 4
                and current_batch_size < self.batch_size
                and current_batch_size < _MAX_BATCH_SIZE
            ):
                current_batch_size = min(
                    self.batch_size, _MAX_BATCH_SIZE, current_batch_size * 2
                )
                consecutive_successes = 0
                logger.info(
                    f"Embedding batch grow: -> {current_batch_size} after consecutive successes"
                )

            now = time.monotonic()
            elapsed = now - encode_start
            rate = completed / elapsed if elapsed > 0 else 0
            pct = completed / total * 100
            pct_milestone = int(pct // 10)
            should_log = (
                batch_num == 1
                or completed >= total
                or pct_milestone > last_pct_milestone
                or (now - last_log_time) >= _LOG_INTERVAL_SECONDS
            )

            if should_log:
                eta = (total - completed) / rate if rate > 0 else 0
                logger.info(
                    f"[embedding {completed:,}/{total:,}] "
                    f"{pct:.1f}% | batch {batch_num:,}/~{total_batches_est:,} "
                    f"| {rate:,.0f} chunks/s | elapsed {self._fmt_duration(elapsed)} "
                    f"| ETA {self._fmt_duration(eta)}"
                )
                last_log_time = now

            if pct_milestone > last_pct_milestone:
                last_pct_milestone = pct_milestone

            if should_log and progress_callback:
                progress_callback(completed, total)

        encode_elapsed = time.monotonic() - encode_start
        logger.info(
            f"Embedding streaming complete: {total:,} chunks in "
            f"{self._fmt_duration(encode_elapsed)} ({total / encode_elapsed:,.0f} chunks/s)"
        )

    @property
    def embedding_dimension(self) -> int:
        """Embedding dimension. Resolved at construction time from the
        config-service-supplied value — no probe request."""
        return self.dim
