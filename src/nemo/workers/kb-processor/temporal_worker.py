"""Temporal activity worker for KB processing.

Registers ProcessKBDocuments and MergeKBResults activities on the
kb-processing task queue.
"""

import asyncio
import contextvars
import os
import signal
import threading
from datetime import timedelta
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

from observability_client_runtime import bind_context, clear_context, get_logger
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from utils.config import Config
# Public helpers live in utils.kb_helpers (split out so this module doesn't
# have to import private names from processor.py — see commit comment in
# utils/kb_helpers.py for the rationale).
from utils.kb_helpers import (
    create_data_source,
    kb_s3_prefix,
    normalize_manifest_file_keys,
    update_kb_status,
)
# _create_embedder still lives in processor.py — the in-process
# orchestrator owns it and temporal_worker needs it for the partition path.
# write_result is gone; the unified metadata.json is the sole result file.
from processor import _create_embedder
from utils.data_store import put_json_object, default_store_root, posix_path, download_file as posix_download_file, read_json_object, list_subdirs, delete_tree
from processing.chunker import create_chunker
from processing.embedder import EmbeddingGenerator
from processing.lancedb_writer import LanceDBWriter
from shared.work_planning import create_work_plan
from shared.temporal_readiness import start_watchdog, wait_for_temporal


def _bind_activity_context(**extra: str) -> None:
    """Bind workflow/activity fields plus optional extras into the observability context.

    Called at the start of each activity so every log line in that activity
    automatically carries workflow_id, activity_id, activity_type, and any
    caller-supplied fields (e.g. kb_id, set_id).
    """
    try:
        if activity.in_activity():
            info = activity.info()
            bind_context(
                activity_id=info.activity_id or "",
                activity_type=info.activity_type or "",
                workflow_id=info.workflow_id or "",
                **extra,
            )
        elif extra:
            bind_context(**extra)
    except Exception:
        pass


logger = get_logger()

# Minimum seconds between progress POSTs to avoid flooding the workflow-engine
_PROGRESS_POST_INTERVAL_SEC = 5.0


def _graceful_shutdown_timeout() -> timedelta:
    raw = (os.environ.get("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT") or "90s").strip().lower().rstrip("s")
    try:
        return timedelta(seconds=int(raw))
    except ValueError:
        return timedelta(seconds=90)


def _post_workflow_progress(
    workflow_id: str,
    workflow_engine_url: str,
    phase: str,
    percentage: float,
    current: int,
    total: int,
    message: str = "",
    extra: Optional[Dict[str, Any]] = None,
    unit_id: Optional[str] = None,
) -> None:
    """POST progress to the workflow-engine in-memory store for UI polling."""
    url = f"{workflow_engine_url.rstrip('/')}/api/v1/workflows/{workflow_id}/progress"
    payload = {
        "phase": phase,
        "percentage": percentage,
        "current": current,
        "total": total,
        "message": message or f"{phase}: {current}/{total}" if total else phase,
        "extra": extra or {},
    }
    if unit_id:
        payload["unitId"] = unit_id
    try:
        data = __import__("json").dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        logger.debug("Failed to POST progress to workflow-engine: %s", e)


class _WorkflowProgressReporter:
    """Throttled progress reporter that POSTs to the workflow-engine for live UI updates."""

    def __init__(
        self,
        workflow_id: str,
        workflow_engine_url: Optional[str] = None,
        unit_id: Optional[str] = None,
    ):
        self.workflow_id = workflow_id
        self.url = (workflow_engine_url or os.environ.get("WORKFLOW_ENGINE_URL") or "").strip()
        self.unit_id = unit_id or ""
        self._last_post_time = 0.0

    def post(
        self,
        phase: str,
        percentage: float,
        current: int,
        total: int,
        message: str = "",
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.url:
            return
        now = time.monotonic()
        if now - self._last_post_time < _PROGRESS_POST_INTERVAL_SEC and (extra or {}).get("_force") != True:
            return
        self._last_post_time = now
        _post_workflow_progress(
            self.workflow_id,
            self.url,
            phase=phase,
            percentage=percentage,
            current=current,
            total=total,
            message=message,
            extra={k: v for k, v in (extra or {}).items() if k != "_force"},
            unit_id=self.unit_id or None,
        )


class _PeriodicHeartbeat:
    """Send periodic Temporal heartbeats from a background thread.

    Use as a context manager around code that may run for longer than
    HeartbeatTimeout, especially when the work happens in threads
    without activity context (e.g. LanceDB iterator consumption).

    The main thread updates ``self.status`` to reflect current progress;
    the daemon thread includes that string in each heartbeat.
    """

    def __init__(self, interval: float = 30.0):
        self.interval = interval
        self.status = "running"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._ctx = contextvars.copy_context()

    def __enter__(self) -> "_PeriodicHeartbeat":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self._ctx.run(activity.heartbeat, self.status)
            except Exception as e:
                logger.debug("Periodic heartbeat failed (stopping): %s", e)
                break


# ---------------------------------------------------------------------------
# Merge chunking thresholds (env-configurable)
# ---------------------------------------------------------------------------
_MERGE_DIRECT_THRESHOLD_MB = int(os.environ.get("MERGE_DIRECT_THRESHOLD_MB", "200"))
_MERGE_CHUNK_SIZE_MB = int(os.environ.get("MERGE_CHUNK_SIZE_MB", "200"))


@activity.defn(name="ProcessKBDocuments")
def process_kb_documents(input: dict) -> dict:
    """Process KB documents from a manifest. Extracted from _run_kb_partition_worker."""
    kb_id = input.get("kb_id", "?")
    set_id = input.get("set_id", "?")
    _bind_activity_context(kb_id=kb_id, set_id=set_id)
    logger.info(
        "Activity ProcessKBDocuments started: kb_id=%s set_id=%s manifest_s3_key=%s",
        kb_id, set_id, input.get("manifest_s3_key", ""),
    )
    config = Config.from_dict(input)
    activity.heartbeat("initializing")

    workflow_id = input.get("workflow_id") or ""
    set_id = input.get("set_id", "s0")
    progress_reporter = (
        _WorkflowProgressReporter(workflow_id, unit_id=set_id) if workflow_id else None
    )
    if progress_reporter and progress_reporter.url:
        progress_reporter.post("processing", 0.0, 0, 0, "initializing", extra={"totalFiles": 0})

    manifest_s3_key = input.get("manifest_s3_key", "")
    output_prefix = input.get("output_prefix", "")

    import json
    import shutil
    from pathlib import Path
    from processing.chunker import Chunk

    temp_dir = Path(f"/tmp/kb-fileset-{set_id}")
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        if manifest_s3_key:
            manifest = read_json_object(manifest_s3_key)
            if manifest is None:
                manifest = {}
            file_keys = normalize_manifest_file_keys(manifest.get("files") or [])
        else:
            file_keys = []
        logger.info(f"KB set {set_id}: {len(file_keys)} files to process")

        activity.heartbeat(f"processing {len(file_keys)} files")
        total_files_estimate = len(file_keys) or 0
        if progress_reporter and progress_reporter.url:
            progress_reporter.post(
                "processing",
                1.0,
                0,
                total_files_estimate,
                f"Processing {total_files_estimate} files",
                extra={"totalFiles": total_files_estimate},
            )

        data_source = create_data_source(config, file_keys=file_keys if file_keys else None)
        data_source.connect()

        chunker = create_chunker(
            strategy=config.chunk_strategy,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            options=config.chunk_options,
        )

        all_chunks = []
        doc_count = 0
        # When file_keys was passed, the data source only yields those files; no filter needed.
        # For structured or single-unit (no manifest), process every doc we get.
        process_all_docs = (config.dataset_kind == "structured") or (len(file_keys) == 0)

        for doc in data_source.get_documents():
            if not process_all_docs:
                doc_source = doc.metadata.get("file_path") or doc.doc_id
                should_process = any(
                    doc_source.endswith(fk.split("/")[-1]) or fk in doc_source
                    for fk in file_keys
                )
                if not should_process:
                    continue

            chunks = chunker.chunk_document(doc)
            all_chunks.extend(chunks)
            doc_count += 1
            if doc_count % 10 == 0:
                activity.heartbeat(f"processed {doc_count} docs, {len(all_chunks)} chunks")
                if progress_reporter and progress_reporter.url:
                    # Chunk generation (processing) = 0%–25% of overall
                    total_est = total_files_estimate or max(doc_count, 1)
                    pct = 25.0 * (doc_count / total_est) if total_est else 5.0
                    progress_reporter.post(
                        "processing",
                        min(pct, 24.0),
                        doc_count,
                        total_est,
                        f"Processed {doc_count} documents, {len(all_chunks)} chunks",
                        extra={
                            "documentsProcessed": doc_count,
                            "totalDocuments": total_est,
                            "chunksCreated": len(all_chunks),
                            "totalFiles": total_files_estimate,
                        },
                    )

        logger.info(f"KB set {set_id}: {doc_count} docs -> {len(all_chunks)} chunks")

        if all_chunks:
            activity.heartbeat("generating embeddings")
            if progress_reporter and progress_reporter.url:
                progress_reporter.post(
                    "generating_embeddings",
                    25.0,
                    0,
                    len(all_chunks),
                    "Generating embeddings",
                    extra={
                        "documentsProcessed": doc_count,
                        "totalDocuments": doc_count,
                        "chunksCreated": len(all_chunks),
                        "vectorsCreated": 0,
                    },
                )
            # Gateway-backed embedder (processor._create_embedder) needs
            # proxy_url + api_key + dim from the Config dataclass; the old
            # 2-arg form was for the in-process SentenceTransformer path
            # that no longer exists. See processing/embedder.py.
            embedder = _create_embedder(config)
            schema = EmbeddingGenerator.get_schema(embedder.embedding_dimension)

            import pyarrow.parquet as pq_local
            import pyarrow as pa_local

            total_chunks = len(all_chunks)

            def _heartbeat_embedding_progress(completed: int, total: int) -> None:
                activity.heartbeat(f"generating embeddings ({completed}/{total})")
                if progress_reporter and progress_reporter.url:
                    # Embedding phase 25%–94% of overall
                    pct = 25.0 + 69.0 * (completed / total) if total else 25.0
                    progress_reporter.post(
                        "generating_embeddings",
                        min(pct, 94.0),
                        completed,
                        total,
                        f"Generating embeddings ({completed}/{total})",
                        extra={
                            "documentsProcessed": doc_count,
                            "totalDocuments": doc_count,
                            "chunksCreated": total_chunks,
                            "vectorsCreated": completed,
                        },
                    )

            embedded_batches = []
            for batch in embedder.stream_record_batches(
                all_chunks, progress_callback=_heartbeat_embedding_progress
            ):
                embedded_batches.append(batch)
            if embedded_batches:
                combined = pa_local.Table.from_batches(embedded_batches, schema=schema)
                local_emb_path = temp_dir / "embeddings.parquet"
                pq_local.write_table(combined, local_emb_path)
                dest = posix_path(f"{output_prefix}/embeddings.parquet")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(local_emb_path), str(dest))

        result = {
            "setId": set_id,
            "status": "success",
            "outputPath": output_prefix,
            "rowCount": len(all_chunks),
            "fileCount": doc_count,
        }
        put_json_object(f"{output_prefix}/partition_result.json", result)
        return result

    except Exception as e:
        logger.error(f"KB set {set_id} failed: {e}", exc_info=True)
        error_result = {"setId": set_id, "status": "error", "error": str(e)}
        try:
            put_json_object(f"{output_prefix}/partition_result.json", error_result)
        except Exception:
            pass
        raise
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


@activity.defn(name="MergeKBResults")
def merge_kb_results(input: dict) -> dict:
    """Merge KB partition outputs into a single LanceDB table.

    Writes the LanceDB table **directly to S3** via Lance's built-in
    object-store layer, eliminating the local-write-then-upload pattern
    and the intermediate consolidation step.

    Key properties:
    - **Direct S3 write** -- no local LanceDB directory, no sequential
      upload.  Lance uses Rust ``object_store`` with multi-part uploads.
    - **Run-scoped prefix** -- the S3 prefix is deterministic per
      workflow run (``lancedb-run-{workflow_run_id}``).  A wipe-before-
      write at the start of each attempt cleans up partial data from
      failed retries.
    - **Streaming** -- partition parquets are downloaded one at a time
      and streamed as RecordBatches into LanceDB.  Only a single temp
      parquet file exists on disk at any moment.
    - **Prefetching** -- a background thread downloads the *next*
      partition while the current one is consumed, overlapping network
      I/O with LanceDB ingestion.
    - **Background heartbeat** thread keeps the activity alive during
      long-running LanceDB writes and index creation.
    - **Live progress** via ``_WorkflowProgressReporter`` for GUI.
    """
    kb_id = input.get("kb_id", "?")
    _bind_activity_context(kb_id=kb_id, phase="merge")
    logger.info(
        "Activity MergeKBResults started: kb_id=%s job_output_prefix=%s",
        kb_id, input.get("job_output_prefix", ""),
    )
    config = Config.from_dict(input)
    activity.heartbeat("merging")

    workflow_id = input.get("workflow_id") or ""
    progress_reporter = _WorkflowProgressReporter(workflow_id) if workflow_id else None

    # Retrieve the workflow run ID from Temporal activity context for
    # deterministic, retry-safe S3 prefix scoping.
    wf_run_id: Optional[str] = None
    try:
        wf_run_id = activity.info().workflow_run_id
    except Exception:
        logger.warning("Could not retrieve workflow_run_id from activity context")

    job_output_prefix = input.get("job_output_prefix", "")

    import json
    import shutil
    from pathlib import Path
    from concurrent.futures import ThreadPoolExecutor, Future

    temp_dir = Path("/tmp/kb-merge")
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        with _PeriodicHeartbeat(interval=30) as hb:
            # ---- Phase 1: List partitions ----
            hb.status = "listing partitions"
            activity.heartbeat("listing partitions")
            partitions = list_subdirs(f"{job_output_prefix}/partitions")

            num_partitions = len(partitions)
            logger.info(f"Found {num_partitions} partition outputs")
            if progress_reporter:
                progress_reporter.post(
                    "merging", 88.0, 0, num_partitions,
                    f"Found {num_partitions} partitions to merge",
                    extra={"totalPartitions": num_partitions},
                )

            # ---- Phase 2: Read partition results ----
            hb.status = "reading partition results"
            total_documents = 0
            for idx, p_prefix in enumerate(partitions):
                try:
                    pr_key = f"{p_prefix}/partition_result.json"
                    pr = read_json_object(pr_key)
                    if pr and pr.get("status") == "success":
                        total_documents += int(pr.get("fileCount") or 0)
                except Exception as e:
                    logger.warning(f"Could not read partition result from {p_prefix}: {e}")

                hb.status = f"reading partition results ({idx + 1}/{num_partitions})"
                if progress_reporter and (idx + 1) % 5 == 0:
                    progress_reporter.post(
                        "merging", 88.5, idx + 1, num_partitions,
                        f"Reading partition results ({idx + 1}/{num_partitions})",
                        extra={"documentCount": total_documents, "totalPartitions": num_partitions},
                    )

            logger.info(
                f"{num_partitions} partitions, {total_documents} source documents"
            )

            import pyarrow.parquet as pq_agg

            from datetime import datetime, timezone

            embedder = _create_embedder(config)
            schema = EmbeddingGenerator.get_schema(embedder.embedding_dimension)

            writer = LanceDBWriter(
                kb_id=config.kb_id,
                s3_path_prefix=config.s3_path_prefix,
                temp_dir=temp_dir,
                workflow_run_id=wf_run_id,
            )

            # ---- Phase 3: Stream partitions with 1-slot prefetch ----
            total_rows = [0]

            def _download_partition(idx: int) -> Optional[Path]:
                """Copy a single partition parquet from the POSIX mount to a temp file."""
                p_prefix = partitions[idx]
                emb_key = f"{p_prefix}/embeddings.parquet"
                local_path = temp_dir / f"part_{idx}.parquet"
                try:
                    posix_download_file(emb_key, local_path)
                    return local_path
                except Exception as e:
                    logger.warning(f"Failed to read embeddings from {p_prefix}: {e}")
                    return None

            def record_batch_iterator():
                """Yield RecordBatches from all partitions with 1-slot lookahead prefetch."""
                with ThreadPoolExecutor(max_workers=1, thread_name_prefix="prefetch") as prefetch_pool:
                    pending_future: Optional[Future] = None

                    # Kick off the first download.
                    if num_partitions > 0:
                        pending_future = prefetch_pool.submit(_download_partition, 0)

                    for i in range(num_partitions):
                        hb.status = f"streaming partition {i + 1}/{num_partitions}"

                        # Wait for the current partition download to finish.
                        local_path = pending_future.result() if pending_future else None

                        # Prefetch the *next* partition while we iterate this one.
                        if i + 1 < num_partitions:
                            pending_future = prefetch_pool.submit(_download_partition, i + 1)
                        else:
                            pending_future = None

                        if local_path is None or not local_path.exists():
                            continue

                        try:
                            pf = pq_agg.ParquetFile(str(local_path))
                            for batch in pf.iter_batches(batch_size=1024):
                                total_rows[0] += batch.num_rows
                                yield batch
                        except Exception as e:
                            logger.warning(f"Failed to read partition {i}: {e}")
                        finally:
                            if local_path.exists():
                                local_path.unlink()

                        if progress_reporter and (i + 1) % 5 == 0:
                            progress_reporter.post(
                                "merging", 89.0 + 1.0 * ((i + 1) / max(num_partitions, 1)),
                                i + 1, num_partitions,
                                f"Streaming partition {i + 1}/{num_partitions}",
                                extra={"documentCount": total_documents, "totalPartitions": num_partitions},
                            )

            # ---- Phase 4: Write LanceDB table to POSIX mount ----
            hb.status = "writing LanceDB table"
            if progress_reporter:
                progress_reporter.post(
                    "merging", 90.0, 0, 0,
                    "Writing LanceDB table",
                    extra={"documentCount": total_documents, "totalPartitions": num_partitions},
                )

            def _lance_progress_callback(phase: str, detail: dict) -> None:
                hb.status = f"LanceDB: {phase}"
                if progress_reporter:
                    extra = {"documentCount": total_documents, **detail}
                    if phase == "creating_fts_index":
                        pct = 94.0
                        msg = "Creating full-text search index"
                    elif phase == "creating_vector_index":
                        pct = 93.0
                        msg = "Creating vector index"
                    elif phase == "write_complete":
                        pct = 97.0
                        msg = f"Write complete ({detail.get('storageMB', 0)} MB)"
                    elif phase == "creating_table":
                        pct = 91.0
                        msg = "Writing vectors"
                    else:
                        pct = 92.0
                        msg = phase
                    progress_reporter.post("merging", min(pct, 99.0), 0, 0, msg, extra=extra)

            lance_table_path = writer.write_stream(
                record_batch_iterator(), schema,
                mode='full',
                indexing_mode=config.indexing_mode,
                quantization_type=config.quantization_type,
                quantization_options=config.quantization_options,
                progress_callback=_lance_progress_callback,
            )

            # ---- Phase 5: Write results and metadata ----
            hb.status = "writing metadata"
            write_stats = writer.get_upload_stats()
            vector_count = total_rows[0]
            last_processed = datetime.now(timezone.utc).isoformat()
            storage_bytes = write_stats.get("total_bytes", 0)
            storage_mb = round(storage_bytes / 1024 / 1024, 2)
            index_results = writer.get_index_results()
            has_vector_index = index_results["vector_index_created"]
            has_fts_index = index_results["fts_index_created"]

            # KBStats: storage / file info ONLY. Counts live on the top
            # level of the metadata payload, mirroring types.KBMetadata.
            stats = {
                "storageBytes": storage_bytes,
                "storageMB": storage_mb,
                "fileCount": write_stats.get("file_count", 0),
                "lastProcessedAt": last_processed,
            }

            # Unified metadata.json — single source of truth. Pre-unification
            # this path wrote TWO files (kb_processing_results.json for the
            # Go workflow + metadata.json for kb-retrieval) with overlapping
            # fields that drifted between runs. Now it writes one:
            #   * workflow-result fields the Go workflow consumes via
            #     ReadKBMetadataActivity (status / counts / lanceTablePath / stats),
            #   * index-capability + embedding-identity fields kb-retrieval
            #     reads on every search.
            # The Go side maps this exact dict into types.KBMetadata; field
            # names + nesting must stay aligned with that struct.
            metadata = {
                # --- Workflow-result fields (Go side decodes these) ---
                "status": "success",
                "knowledgeBaseId": config.kb_id,
                "projectId": config.project_id,
                "lanceTablePath": lance_table_path,
                "documentCount": total_documents,
                "chunkCount": vector_count,
                "vectorCount": vector_count,
                # `sourceType` comes from the dataset kind on the config —
                # the structured-data path sets `dataset_kind=structured`,
                # the file-data path leaves it as `unstructured`. The Python
                # workers stamp this on partition results too; the merge
                # rolls them up to the same value here so the JSON shape
                # matches processor.py main()'s in-process write.
                "sourceType": "structured" if config.dataset_kind == "structured" else "unstructured",
                "stats": stats,
                # `lastProcessingMode` mirrors the in-process write so a KB
                # always carries the most recent dispatch mode regardless
                # of which Python path produced its metadata.json. Note:
                # `processedFiles` is intentionally NOT stamped here — the
                # per-file diff state is owned by process_kb_documents
                # (the partition worker) and isn't aggregated through the
                # merge today. Tracked as a follow-up; the in-process path
                # in processor.py still writes it for that orchestrator's
                # incremental flow.
                "lastProcessingMode": config.processing_mode,
                # --- KB-shape fields (kb-retrieval reads these directly) ---
                "tableName": writer.TABLE_NAME,
                "indexingMode": config.indexing_mode,
                "hasVectorIndex": has_vector_index,
                "vectorIndexMetric": "cosine" if has_vector_index else None,
                "hasFtsIndex": has_fts_index,
                # --- Embedding-model identity (kb-retrieval cascade) ---
                # The preferred field is embeddingGatewayModelId — the Bifrost
                # wire identifier (<provider>/<gatewayBindingName>) the
                # project VK's allowed_models[] is keyed on. Empty for
                # non-Bifrost paths; the retrieval cascade then falls
                # through to providerModelId. Other fields kept for
                # back-compat with the older cascade order.
                "embeddingModel": config.embedding_provider_model_id or config.embedding_model,
                "embeddingProvider": config.embedding_provider or "openai_compatible",
                "embeddingModelId": config.embedding_model_id,
                "embeddingProviderModelId": config.embedding_provider_model_id or config.embedding_model,
                "providerModelId": config.embedding_provider_model_id or config.embedding_model,
                "embeddingGatewayModelId": config.embedding_gateway_model_id or "",
                "embeddingEndpoint": config.embedding_endpoint or None,
                "vectorSize": embedder.embedding_dimension,
                # --- Reprocessing / config trail ---
                "chunkSize": config.chunk_size,
                "chunkOverlap": config.chunk_overlap,
                "chunkStrategy": config.chunk_strategy,
                "quantizationType": config.quantization_type,
            }
            metadata_key = f"{kb_s3_prefix(config.kb_id, config.s3_path_prefix)}/metadata.json"
            put_json_object(metadata_key, metadata)
            logger.info(
                "Wrote unified metadata to %s (vectors=%d)",
                posix_path(metadata_key), vector_count,
            )

            # Return the same dict in-memory so the Temporal workflow can
            # consume it directly and skip the S3 re-read on the happy path.
            # See kbMetadataFromMergeResult in workflow-engine.
            result = metadata

            update_kb_status(config, "ready", lance_table_path)

            if progress_reporter:
                progress_reporter.post(
                    "merging", 99.0, vector_count, vector_count,
                    f"Merge complete: {vector_count:,} vectors, {storage_mb} MB",
                    extra={
                        "documentCount": total_documents,
                        "vectorCount": vector_count,
                        "chunksCreated": vector_count,
                        "vectorsCreated": vector_count,
                        "storageMB": storage_mb,
                    },
                )

            hb.status = "cleaning up partitions"
            try:
                delete_tree(f"{job_output_prefix}/partitions")
            except Exception:
                pass

            return result

    except Exception as e:
        logger.error(f"KB merge failed: {e}", exc_info=True)
        raise
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def _consolidate_partitions_chunked(
    partitions: List[str],
    partition_sizes: List[int],
    temp_dir,
    schema,
    hb: _PeriodicHeartbeat,
    progress_reporter: Optional[_WorkflowProgressReporter],
    total_documents: int,
) -> List:
    """Group partitions into bounded-size chunks and consolidate each into a single parquet.

    Returns a list of Path objects pointing to consolidated parquet files on local disk.
    This bounds peak disk usage and gives granular progress during merge.
    """
    import pyarrow.parquet as pq_chunk
    import pyarrow as pa_chunk
    from pathlib import Path

    chunk_size_bytes = _MERGE_CHUNK_SIZE_MB * 1024 * 1024

    # Build groups of partitions whose cumulative size <= chunk_size_bytes
    groups: List[List[int]] = []
    current_group: List[int] = []
    current_size = 0
    for idx, size in enumerate(partition_sizes):
        if current_group and current_size + size > chunk_size_bytes:
            groups.append(current_group)
            current_group = []
            current_size = 0
        current_group.append(idx)
        current_size += size
    if current_group:
        groups.append(current_group)

    num_groups = len(groups)
    logger.info(
        f"Chunked merge: {len(partitions)} partitions -> {num_groups} groups "
        f"(threshold={_MERGE_DIRECT_THRESHOLD_MB} MB, chunk={_MERGE_CHUNK_SIZE_MB} MB)"
    )

    consolidated_dir = temp_dir / "consolidated"
    consolidated_dir.mkdir(parents=True, exist_ok=True)
    consolidated_paths: List[Path] = []

    for g_idx, group in enumerate(groups):
        hb.status = f"consolidating chunk {g_idx + 1}/{num_groups} ({len(group)} partitions)"
        if progress_reporter:
            pct = 89.0 + 1.0 * ((g_idx) / max(num_groups, 1))
            progress_reporter.post(
                "merging", min(pct, 89.9), g_idx, num_groups,
                f"Consolidating chunk {g_idx + 1}/{num_groups} ({len(group)} partitions)",
                extra={"documentCount": total_documents, "totalPartitions": len(partitions)},
            )

        batches = []
        for p_idx in group:
            p_prefix = partitions[p_idx]
            emb_key = f"{p_prefix}/embeddings.parquet"
            local_path = temp_dir / f"part_{p_idx}.parquet"
            try:
                posix_download_file(emb_key, local_path)
                pf = pq_chunk.ParquetFile(str(local_path))
                for batch in pf.iter_batches(batch_size=1024):
                    batches.append(batch)
                local_path.unlink()
            except Exception as e:
                logger.warning(f"Failed to read embeddings from {p_prefix}: {e}")
                if local_path.exists():
                    local_path.unlink()

        if batches:
            consolidated_path = consolidated_dir / f"consolidated_{g_idx}.parquet"
            table = pa_chunk.Table.from_batches(batches, schema=schema)
            pq_chunk.write_table(table, consolidated_path)
            consolidated_paths.append(consolidated_path)
            logger.info(
                f"Consolidated chunk {g_idx + 1}/{num_groups}: "
                f"{table.num_rows:,} rows -> {consolidated_path.name}"
            )
            del table
            del batches

    return consolidated_paths


def _warmup_embedding_model():
    """No-op under the gateway-backed EmbeddingGenerator.

    The pre-port worker loaded a SentenceTransformer in-process and
    needed an explicit warmup so the first task didn't pay the ~3-5s
    cold start. The current EmbeddingGenerator (see
    processing/embedder.py) calls the LLM gateway via HTTP — the model
    lives in the in-cluster TEI Deployment (always warm) or at the
    upstream provider — so there's nothing to preload here. Construction
    also requires per-task fields (proxy_url, api_key, dim) that aren't
    known at worker startup. Kept as a no-op stub so the call site in
    main() stays put and we can revive it later if a runtime cache
    needs warming.
    """
    logger.info(
        "Embedding warmup skipped (gateway-backed embedder; model lives in TEI / upstream provider)."
    )


async def main():
    from observability_client_runtime import configure_observability_minimal
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/kb-processor.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "kb-processor"),
        prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
    )

    temporal_address = os.environ.get("TEMPORAL_ADDRESS", "temporal:7233")
    temporal_namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    task_queue = os.environ.get("TASK_QUEUE", "kb-processing")
    max_concurrent = int(os.environ.get("MAX_CONCURRENT_ACTIVITIES", "2"))

    logger.info(
        "Starting KB worker: address=%s, namespace=%s, queue=%s, max_concurrent=%d",
        temporal_address, temporal_namespace, task_queue, max_concurrent,
    )

    _warmup_embedding_model()

    # Wait for Temporal's namespace to be queryable before constructing
    # the Worker. Bare Client.connect succeeds as soon as the gRPC channel
    # is up, which can happen before the namespace service is loaded — in
    # that window the Rust core's heartbeat-capabilities probe times out
    # and the poller never comes online (verified on sks6316:
    # `temporal task-queue describe` showed 0 pollers for hours while the
    # Python process appeared "running"). See shared.temporal_readiness.
    client = await wait_for_temporal(temporal_address, temporal_namespace)

    worker = Worker(
        client,
        task_queue=task_queue,
        graceful_shutdown_timeout=_graceful_shutdown_timeout(),
        activities=[process_kb_documents, merge_kb_results, create_work_plan],
        activity_executor=ThreadPoolExecutor(max_workers=max_concurrent),
        max_concurrent_activities=max_concurrent,
    )

    # Crash the pod if Temporal becomes persistently unreachable mid-life
    # (e.g., a `force-pull-rollout-local` rolls platform after this worker
    # started). K8s restart with the new wait_for_temporal gates the next
    # boot cleanly.
    start_watchdog(client, temporal_namespace)

    shutdown_event = asyncio.Event()

    def _request_shutdown(sig: signal.Signals) -> None:
        logger.info("Received %s — stopping activity polling and draining in-flight activities...", sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_shutdown, sig)

    logger.info(f"Worker listening on queue: {task_queue}")
    async with worker:
        await shutdown_event.wait()
        logger.info("Initiating graceful shutdown (timeout=%s)...", _graceful_shutdown_timeout())
    logger.info("KB worker shut down cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
