"""LanceDB writer for KB processor with processing mode support.

Supports two processing modes:
- full: Overwrites entire LanceDB table (creates fresh)
- incremental: Appends new vectors to existing table (LanceDB handles internal versioning)
"""

import json
from observability_client_runtime import get_logger
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

import lancedb
import pyarrow as pa

# Type alias: legacy callback(files_uploaded, total_files, bytes_uploaded)
UploadProgressCallback = Optional[Callable[[int, int, int], None]]

# New-style progress callback: callback(phase: str, detail: dict)
# Phases: "creating_table", "creating_vector_index", "creating_fts_index", "uploading"
PhaseProgressCallback = Optional[Callable[[str, Dict[str, Any]], None]]

logger = get_logger()

AUTO_INDEX_MIN_ROWS = 1000

_INDEX_RETRY_ATTEMPTS = 3
_INDEX_RETRY_BASE_DELAY_SEC = 2.0


def _peek_or_raise_empty(
    batches: Iterator[pa.RecordBatch],
    *,
    phase: str,
) -> Iterator[pa.RecordBatch]:
    """Peek a RecordBatch iterator; raise a clear error if it's empty.

    LanceDB's ``db.create_table(data=<iter>)`` runs the iterator in a
    background asyncio loop. An empty iterator surfaces as
    ``StopIteration`` inside that coroutine, which Python 3.7+ wraps as
    ``RuntimeError: coroutine raised StopIteration`` (PEP 479) — the
    resulting stack trace looks like a LanceDB bug, but the real cause
    is upstream: the embedding phase produced no usable batches (every
    partition's parquet was missing or unreadable).

    Returns an iterator that re-yields the peeked batch first, followed
    by the rest of the original iterator. Safe to pass straight into
    ``create_table(data=...)``.
    """
    peek = iter(batches)
    try:
        first = next(peek)
    except StopIteration:
        raise RuntimeError(
            f"Cannot create LanceDB table during {phase}: zero record batches received. "
            "Every partition's embeddings.parquet was missing, empty, or failed to download. "
            "Check the upstream embedding-generation phase for errors — common causes are "
            "Bifrost model_blocked / 403, network refused, TLS handshake failure, or "
            "every individual document failing chunking. Inspect the kb-processor logs "
            "above the merge phase for the first per-batch failure."
        )

    def _with_peeked() -> Iterator[pa.RecordBatch]:
        yield first
        yield from peek

    return _with_peeked()


class LanceDBWriter:
    """
    Creates and uploads LanceDB vector store with processing mode support.

    Storage model (blue-green versioned):
    - Each reprocess creates a NEW versioned S3 prefix.
    - When ``workflow_run_id`` is supplied the prefix is deterministic:
      knowledgebases/{kb_id}/lancedb-run-{workflow_run_id}/
      This is stable across activity retries within the same workflow run,
      enabling wipe-before-write cleanup of partial writes from failed
      attempts without orphaning data.
    - When no ``workflow_run_id`` is given (single-unit / legacy callers)
      the prefix falls back to a timestamp-based tag:
      knowledgebases/{kb_id}/lancedb-{YYYYMMDD-HHMMSS}/
    - Old index versions are retained for rollback capability.
    - metadata.json records the active lancedbPath so the retrieval service
      can discover the correct versioned index.
    - A garbage collection workflow can be introduced later to reclaim old versions.
    """

    TABLE_NAME = "kb_vectors"

    def __init__(
        self,
        kb_id: str,
        s3_path_prefix: str = '',
        temp_dir: Optional[Path] = None,
        workflow_run_id: Optional[str] = None,
    ):
        """
        Initialize LanceDB writer.

        Args:
            kb_id: Knowledge base ID
            s3_path_prefix: Storage path prefix (e.g., "projects/<projectId>")
            temp_dir: Temporary directory for local LanceDB
            workflow_run_id: Temporal workflow run ID.  When provided the
                prefix is deterministic per workflow run, allowing
                wipe-before-write cleanup of failed retry attempts.
        """
        self.kb_id = kb_id
        self.temp_dir = temp_dir or Path('/tmp/kb-processor')
        self._lance_path: Optional[Path] = None
        root = f"{s3_path_prefix}/knowledgebases/{self.kb_id}" if s3_path_prefix else f"knowledgebases/{self.kb_id}"
        self._base_prefix = root
        if workflow_run_id:
            self._lancedb_prefix = f"{self._base_prefix}/lancedb-run-{workflow_run_id}"
        else:
            version_tag = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            self._lancedb_prefix = f"{self._base_prefix}/lancedb-{version_tag}"
        self._metadata_key = f"{self._base_prefix}/metadata.json"

    @staticmethod
    def _default_store_root() -> Optional[str]:
        """Default app-scoped PVC root (same as dataset workers). When set, LanceDB uses POSIX."""
        p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
        return p or None

    def get_lance_table_path(self) -> str:
        """Return absolute POSIX path to the LanceDB table on the mount."""
        root = self._default_store_root()
        return str(Path(root) / self._lancedb_prefix)

    def write(
        self,
        table: pa.Table,
        mode: str = "full",
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None,
        progress_callback: UploadProgressCallback = None,
    ) -> str:
        """Write vectors to LanceDB on the POSIX mount.

        Args:
            table: PyArrow table with chunk data and vectors
            mode: 'full' (overwrite) or 'incremental' (append)
            indexing_mode: 'hybrid', 'semantic', or 'fts'
            quantization_type: 'none', 'ivf_pq', 'scalar', or 'ivf_rq'
            quantization_options: Options for vector quantization
            progress_callback: Optional callback (legacy, currently unused)

        Returns:
            Absolute POSIX path to the LanceDB table.
        """
        self._progress_callback = progress_callback
        if quantization_options is None:
            quantization_options = {}

        table_path = self.get_lance_table_path()
        self._lance_path = Path(table_path)

        self._clear_prefix()

        try:
            if mode == "incremental":
                return self._write_incremental(table, indexing_mode, quantization_type, quantization_options)
            else:
                return self._write_full(table, indexing_mode, quantization_type, quantization_options)
        except Exception as e:
            logger.error("Failed to write LanceDB table in %s mode: %s", mode, e)
            raise

    def write_stream(
        self,
        record_batches: Iterator[pa.RecordBatch],
        schema: pa.Schema,
        mode: str = "full",
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None,
        progress_callback: PhaseProgressCallback = None,
    ) -> str:
        """Write vectors to LanceDB on the POSIX mount.

        Connects LanceDB directly to the final mount path, writes in-place,
        and creates indices.  No temp-dir + upload step is needed.

        Args:
            record_batches: Iterator yielding ``pa.RecordBatch`` objects.
            schema: PyArrow schema matching the RecordBatches.
            mode: 'full' (overwrite) or 'incremental' (append).
            indexing_mode: 'hybrid', 'semantic', or 'fts'.
            quantization_type: 'none', 'ivf_pq', 'scalar', or 'ivf_rq'.
            quantization_options: Options for vector quantization.
            progress_callback: Optional ``(phase, detail_dict)`` callback.

        Returns:
            Absolute POSIX path to the LanceDB table.
        """
        self._phase_progress_callback = progress_callback
        if quantization_options is None:
            quantization_options = {}

        table_path = self.get_lance_table_path()
        self._lance_path = Path(table_path)

        # Wipe any partial data from a previous failed attempt.
        self._clear_prefix()

        try:
            if mode == "incremental":
                return self._write_stream_incremental(
                    record_batches, schema, indexing_mode,
                    quantization_type, quantization_options,
                )
            else:
                return self._write_stream_full(
                    record_batches, schema, indexing_mode,
                    quantization_type, quantization_options,
                )
        except Exception as e:
            logger.error("Failed to write LanceDB table (stream) in %s mode: %s", mode, e)
            raise

    def _get_storage_stats(self) -> Dict[str, Any]:
        """Collect file count and total bytes for the LanceDB prefix on POSIX mount."""
        total_bytes = 0
        file_count = 0
        root = self._default_store_root()
        base = Path(root) / self._lancedb_prefix
        try:
            if base.exists():
                for p in base.rglob("*"):
                    if p.is_file():
                        file_count += 1
                        total_bytes += p.stat().st_size
        except Exception as e:
            logger.warning("Failed to collect storage stats for %s: %s", base, e)
        return {"file_count": file_count, "total_bytes": total_bytes}

    # ------------------------------------------------------------------
    # Streaming write helpers (local write + upload, used by single-unit
    # and incremental paths)
    # ------------------------------------------------------------------

    def _write_stream_full(
        self,
        record_batches: Iterator[pa.RecordBatch],
        schema: pa.Schema,
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None,
    ) -> str:
        """Full-mode streaming write: create table from RecordBatch iterator."""
        logger.info("Writing LanceDB table in FULL mode (streaming overwrite) to %s", self._lance_path)
        if quantization_options is None:
            quantization_options = {}

        phase_cb = getattr(self, '_phase_progress_callback', None)

        db = lancedb.connect(str(self._lance_path))

        if phase_cb:
            phase_cb("creating_table", {"target": str(self._lance_path)})

        # Peek the iterator to detect the empty-batch case upfront.
        # Without this, LanceDB's create_table(data=<empty_iter>) raises
        # StopIteration inside its background async loop, which Python
        # 3.7+ wraps as "RuntimeError: coroutine raised StopIteration"
        # (PEP 479) — a stack trace that completely hides the actual
        # cause (the upstream embedding phase produced zero usable
        # batches). Surface it as a clear, actionable error instead.
        record_batches = _peek_or_raise_empty(record_batches, phase="merge")
        lance_table = db.create_table(
            self.TABLE_NAME, data=record_batches, schema=schema, mode="overwrite",
        )
        row_count = lance_table.count_rows()
        logger.info("Created LanceDB table '%s' with %s vectors (streamed)", self.TABLE_NAME, f"{row_count:,}")

        will_index = (
            quantization_type not in ('none', 'auto')
            or (quantization_type == 'auto'
                and indexing_mode in ('hybrid', 'semantic')
                and row_count >= AUTO_INDEX_MIN_ROWS)
        )
        if will_index and phase_cb:
            phase_cb("creating_vector_index", {"vectorCount": row_count})
        vector_index_ok = self._ensure_vector_index(lance_table, row_count, quantization_type, quantization_options, indexing_mode)

        fts_index_ok = False
        if indexing_mode in ('hybrid', 'fts'):
            if phase_cb:
                phase_cb("creating_fts_index", {"vectorCount": row_count})
            fts_index_ok = self._create_fts_index(lance_table)

        self._last_index_results = {
            "vector_index_created": vector_index_ok,
            "fts_index_created": fts_index_ok,
        }

        stats = self._get_storage_stats()
        self._last_upload_stats = stats
        if phase_cb:
            phase_cb("write_complete", {
                "files": stats.get("file_count", 0),
                "storageMB": round(stats.get("total_bytes", 0) / 1024 / 1024, 2),
            })

        return self.get_lance_table_path()

    def _write_stream_incremental(
        self,
        record_batches: Iterator[pa.RecordBatch],
        schema: pa.Schema,
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None,
    ) -> str:
        """Incremental-mode streaming write: append to existing table or create new."""
        logger.info("Writing LanceDB table in INCREMENTAL mode (streaming append)")
        if quantization_options is None:
            quantization_options = {}

        existing_found = self._check_existing_lancedb()
        db = lancedb.connect(str(self._lance_path))

        if existing_found and self.TABLE_NAME in db.table_names():
            lance_table = db.open_table(self.TABLE_NAME)
            existing_count = lance_table.count_rows()
            lance_table.add(record_batches)
            new_count = lance_table.count_rows()
            added = new_count - existing_count
            logger.info("Appended %s vectors (was %s, now %s)", f"{added:,}", f"{existing_count:,}", f"{new_count:,}")

            vector_index_ok = self._ensure_vector_index(lance_table, new_count, quantization_type, quantization_options, indexing_mode)
            fts_index_ok = False
            if indexing_mode in ('hybrid', 'fts'):
                fts_index_ok = self._create_fts_index(lance_table, replace=True)
        else:
            logger.info("No existing table found, creating new table (streaming)")
            # Same StopIteration-trap as the full-mode path — see
            # _write_stream_full above + _peek_or_raise_empty.
            record_batches = _peek_or_raise_empty(record_batches, phase="incremental-create")
            lance_table = db.create_table(
                self.TABLE_NAME, data=record_batches, schema=schema, mode="overwrite",
            )
            row_count = lance_table.count_rows()
            logger.info("Created new LanceDB table '%s' with %s vectors", self.TABLE_NAME, f"{row_count:,}")

            vector_index_ok = self._ensure_vector_index(lance_table, row_count, quantization_type, quantization_options, indexing_mode)
            fts_index_ok = False
            if indexing_mode in ('hybrid', 'fts'):
                fts_index_ok = self._create_fts_index(lance_table)

        self._last_index_results = {
            "vector_index_created": vector_index_ok,
            "fts_index_created": fts_index_ok,
        }

        stats = self._get_storage_stats()
        self._last_upload_stats = stats

        return self.get_lance_table_path()

    # ------------------------------------------------------------------
    # Legacy pa.Table write methods (kept for backward compatibility)
    # ------------------------------------------------------------------

    def _write_full(
        self,
        table: pa.Table,
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None
    ) -> str:
        """Full-mode write: create table at a versioned POSIX path."""
        logger.info("Writing LanceDB table in FULL mode (overwrite) to %s", self._lance_path)
        if quantization_options is None:
            quantization_options = {}

        db = lancedb.connect(str(self._lance_path))
        lance_table = db.create_table(self.TABLE_NAME, table, mode="overwrite")
        row_count = len(table)
        logger.info("Created LanceDB table '%s' with %d vectors", self.TABLE_NAME, row_count)

        vector_index_ok = self._ensure_vector_index(lance_table, row_count, quantization_type, quantization_options, indexing_mode)

        fts_index_ok = False
        if indexing_mode in ('hybrid', 'fts'):
            fts_index_ok = self._create_fts_index(lance_table)

        self._last_index_results = {
            "vector_index_created": vector_index_ok,
            "fts_index_created": fts_index_ok,
        }

        stats = self._get_storage_stats()
        self._last_upload_stats = stats

        return self.get_lance_table_path()

    def _write_incremental(
        self,
        table: pa.Table,
        indexing_mode: str = "hybrid",
        quantization_type: str = "none",
        quantization_options: dict = None
    ) -> str:
        """Incremental-mode write: append to existing table or create new."""
        logger.info("Writing LanceDB table in INCREMENTAL mode (append)")
        if quantization_options is None:
            quantization_options = {}

        existing_found = self._check_existing_lancedb()
        db = lancedb.connect(str(self._lance_path))

        if existing_found and self.TABLE_NAME in db.table_names():
            lance_table = db.open_table(self.TABLE_NAME)
            existing_count = lance_table.count_rows()
            lance_table.add(table)
            new_count = lance_table.count_rows()
            logger.info("Appended %d vectors (was %d, now %d)", len(table), existing_count, new_count)

            vector_index_ok = self._ensure_vector_index(lance_table, new_count, quantization_type, quantization_options, indexing_mode)
            fts_index_ok = False
            if indexing_mode in ('hybrid', 'fts'):
                fts_index_ok = self._create_fts_index(lance_table, replace=True)
        else:
            logger.info("No existing table found, creating new table")
            lance_table = db.create_table(self.TABLE_NAME, table, mode="overwrite")
            row_count = len(table)
            logger.info("Created new LanceDB table '%s' with %d vectors", self.TABLE_NAME, row_count)

            vector_index_ok = self._ensure_vector_index(lance_table, row_count, quantization_type, quantization_options, indexing_mode)
            fts_index_ok = False
            if indexing_mode in ('hybrid', 'fts'):
                fts_index_ok = self._create_fts_index(lance_table)

        self._last_index_results = {
            "vector_index_created": vector_index_ok,
            "fts_index_created": fts_index_ok,
        }

        stats = self._get_storage_stats()
        self._last_upload_stats = stats

        return self.get_lance_table_path()

    def _ensure_vector_index(self, lance_table, row_count: int, quantization_type: str,
                              quantization_options: dict, indexing_mode: str) -> bool:
        """Conditionally create a vector index based on quantization_type and data size.

        - 'auto': create IVF_HNSW_SQ if row_count >= AUTO_INDEX_MIN_ROWS and
          indexing_mode includes vector search; skip otherwise.
        - 'none': never create an index.
        - specific type ('ivf_pq', 'scalar', 'ivf_rq'): always create, regardless
          of indexing_mode (preserves existing behavior).

        Returns:
            True if an index was successfully created, False if skipped or failed.
        """
        if quantization_type == 'auto':
            if indexing_mode not in ('hybrid', 'semantic'):
                return False
            if row_count >= AUTO_INDEX_MIN_ROWS:
                logger.info("Auto-creating IVF_HNSW_SQ index for %s vectors", f"{row_count:,}")
                return self._create_vector_index(lance_table, 'scalar', {})
            else:
                logger.info("Skipping vector index: %d rows < threshold %d", row_count, AUTO_INDEX_MIN_ROWS)
                return False
        elif quantization_type != 'none':
            return self._create_vector_index(lance_table, quantization_type, quantization_options)
        return False

    def _create_vector_index(self, lance_table, quantization_type: str, options: dict) -> bool:
        """
        Create vector index with specified quantization for faster approximate search.

        Retries up to ``_INDEX_RETRY_ATTEMPTS`` times with exponential backoff
        to tolerate transient object-store consistency issues when writing
        directly to S3/MinIO.

        Returns:
            True if the index was created successfully, False otherwise.
        """
        for attempt in range(1, _INDEX_RETRY_ATTEMPTS + 1):
            try:
                if quantization_type == 'ivf_pq':
                    num_partitions = options.get('numPartitions', 256)
                    num_sub_vectors = options.get('numSubVectors', 96)
                    logger.info(f"Creating IVF_PQ vector index: partitions={num_partitions}, sub_vectors={num_sub_vectors}")
                    lance_table.create_index(
                        metric="cosine",
                        num_partitions=num_partitions,
                        num_sub_vectors=num_sub_vectors,
                    )
                    logger.info("IVF_PQ vector index created successfully")
                    return True

                elif quantization_type == 'scalar':
                    kwargs = {"metric": "cosine", "index_type": "IVF_HNSW_SQ"}
                    if options.get('numPartitions'):
                        kwargs["num_partitions"] = options['numPartitions']
                    if options.get('efConstruction'):
                        kwargs["ef_construction"] = options['efConstruction']
                    if options.get('m'):
                        kwargs["m"] = options['m']
                    logger.info(f"Creating IVF_HNSW_SQ vector index: {kwargs}")
                    lance_table.create_index(**kwargs)
                    logger.info("IVF_HNSW_SQ vector index created successfully")
                    return True

                elif quantization_type == 'ivf_rq':
                    num_bits = options.get('numBits', 1)
                    kwargs = {"metric": "cosine", "index_type": "IVF_RQ", "num_bits": num_bits}
                    if options.get('numPartitions'):
                        kwargs["num_partitions"] = options['numPartitions']
                    logger.info(f"Creating IVF_RQ vector index: {kwargs}")
                    lance_table.create_index(**kwargs)
                    logger.info("IVF_RQ vector index created successfully")
                    return True

                else:
                    logger.info(f"Unknown quantization type '{quantization_type}', skipping vector index creation")
                    return False

            except Exception as e:
                last_error = e
                if attempt < _INDEX_RETRY_ATTEMPTS:
                    delay = _INDEX_RETRY_BASE_DELAY_SEC * (2 ** (attempt - 1))
                    logger.warning(
                        "Vector index creation attempt %d/%d failed: %s. Retrying in %.1fs...",
                        attempt, _INDEX_RETRY_ATTEMPTS, e, delay,
                    )
                    time.sleep(delay)
                else:
                    raise RuntimeError(
                        f"Failed to create vector index after {_INDEX_RETRY_ATTEMPTS} attempts: {last_error}"
                    ) from last_error
        return False

    def _create_fts_index(self, lance_table, replace: bool = False) -> bool:
        """
        Create full-text search (FTS) index on the text column.

        Uses Lance-native FTS (use_tantivy=False) so the index is stored inside
        the Lance dataset and works across all LanceDB SDKs (Python, Rust, JS)
        and with cloud object storage (S3).  Tantivy-based indexes are
        Python-only and local-filesystem-only, making them incompatible with
        the Rust kb-retrieval-service.

        Retries up to ``_INDEX_RETRY_ATTEMPTS`` times with exponential backoff
        to tolerate transient 404s from S3/MinIO consistency delays after a
        direct object-store write.

        Returns:
            True if the FTS index was created successfully, False otherwise.
        """
        for attempt in range(1, _INDEX_RETRY_ATTEMPTS + 1):
            try:
                logger.info(f"Creating native Lance FTS index on 'text' column (replace={replace})...")
                lance_table.create_fts_index(
                    "text",
                    replace=replace,
                    use_tantivy=False,
                    stem=True,
                    language="English",
                    lower_case=True,
                    remove_stop_words=True,
                )
                logger.info("Native Lance FTS index created successfully on 'text' column")
                return True
            except TypeError as e:
                logger.warning(f"create_fts_index with native params failed: {e}. Trying minimal params...")
                try:
                    lance_table.create_fts_index("text", replace=replace, use_tantivy=False)
                    logger.info("FTS index created successfully (fallback mode)")
                    return True
                except Exception as e2:
                    last_error = e2
                    if attempt < _INDEX_RETRY_ATTEMPTS:
                        delay = _INDEX_RETRY_BASE_DELAY_SEC * (2 ** (attempt - 1))
                        logger.warning(
                            "FTS index creation attempt %d/%d failed: %s. Retrying in %.1fs...",
                            attempt, _INDEX_RETRY_ATTEMPTS, e2, delay,
                        )
                        time.sleep(delay)
                    else:
                        raise RuntimeError(
                            f"Failed to create FTS index after {_INDEX_RETRY_ATTEMPTS} attempts: {last_error}"
                        ) from last_error
            except Exception as e:
                last_error = e
                if attempt < _INDEX_RETRY_ATTEMPTS:
                    delay = _INDEX_RETRY_BASE_DELAY_SEC * (2 ** (attempt - 1))
                    logger.warning(
                        "FTS index creation attempt %d/%d failed: %s. Retrying in %.1fs...",
                        attempt, _INDEX_RETRY_ATTEMPTS, e, delay,
                    )
                    time.sleep(delay)
                else:
                    raise RuntimeError(
                        f"Failed to create FTS index after {_INDEX_RETRY_ATTEMPTS} attempts: {last_error}"
                    ) from last_error
        return False

    def _get_current_lancedb_path(self) -> str:
        """Resolve the POSIX path of the currently active LanceDB index.

        Reads lancedbPath from metadata.json. Falls back to the legacy
        convention-based path if metadata.json is absent.
        """
        root = self._default_store_root()
        try:
            metadata = self.read_metadata()
            if metadata:
                lance_path = metadata.get('lancedbPath', '')
                if lance_path:
                    if lance_path.startswith("/"):
                        logger.info("Resolved current LanceDB path from metadata: %s", lance_path)
                        return lance_path
                    prefix = lance_path.replace(f"s3://{self.kb_id}/", "").lstrip("/")
                    resolved = str(Path(root) / prefix)
                    logger.info("Resolved current LanceDB path from metadata: %s", resolved)
                    return resolved
        except Exception as e:
            logger.info("Could not read lancedbPath from metadata.json (using legacy path): %s", e)

        legacy = str(Path(root) / self._base_prefix / "lancedb")
        logger.info("Using legacy LanceDB path: %s", legacy)
        return legacy

    def _check_existing_lancedb(self) -> bool:
        """Check if an existing LanceDB table exists on the POSIX mount.

        For incremental mode, checks the CURRENT active index (resolved
        via metadata.json) rather than the new versioned output path.

        Returns:
            True if an existing table was found.
        """
        try:
            current_path = self._get_current_lancedb_path()
            src_dir = Path(current_path)
            if not src_dir.is_dir():
                logger.info("No existing LanceDB table at %s (first run)", src_dir)
                return False
            file_count = sum(1 for f in src_dir.rglob("*") if f.is_file())
            logger.info("Found existing LanceDB table (%d files) at %s", file_count, src_dir)
            return file_count > 0
        except Exception as e:
            logger.warning("Error checking existing LanceDB: %s", e)
            return False

    def get_upload_stats(self) -> Dict[str, Any]:
        """Get statistics from the last write operation."""
        return getattr(self, '_last_upload_stats', {})

    def get_index_results(self) -> Dict[str, bool]:
        """Get actual index creation outcomes from the last write operation.

        Returns:
            Dict with ``vector_index_created`` and ``fts_index_created`` bools.
        """
        return getattr(self, '_last_index_results', {
            "vector_index_created": False,
            "fts_index_created": False,
        })

    def _clear_prefix(self) -> None:
        """Remove the LanceDB prefix directory on the POSIX mount (wipe-before-write)."""
        root = self._default_store_root()
        target = Path(root) / self._lancedb_prefix
        try:
            if target.exists():
                shutil.rmtree(target, ignore_errors=False)
                logger.debug("Removed LanceDB prefix %s", target)
        except Exception as e:
            logger.warning("Error clearing LanceDB prefix %s: %s", target, e)

    def read_metadata(self) -> Optional[Dict[str, Any]]:
        """Read the current KB metadata from the POSIX mount."""
        root = self._default_store_root()
        p = Path(root) / self._metadata_key
        if not p.is_file():
            logger.debug("No metadata found at %s, will create new one", p)
            return None
        return json.loads(p.read_bytes())

    def upload_metadata(self, metadata: Dict[str, Any]) -> str:
        """Write KB metadata to the POSIX mount (atomic via tmp+rename).

        Returns:
            Absolute POSIX path to the metadata file.
        """
        metadata['updatedAt'] = datetime.now(timezone.utc).isoformat()
        if 'createdAt' not in metadata:
            metadata['createdAt'] = metadata['updatedAt']

        root = self._default_store_root()
        p = Path(root) / self._metadata_key
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(metadata, indent=2))
        tmp.rename(p)
        logger.info("Wrote KB metadata to %s", p)
        return str(p)
