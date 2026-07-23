#!/usr/bin/env python3
"""
Knowledge Base Processor

Processes dataset content (files or Iceberg tables), generates embeddings,
and creates LanceDB vector store for semantic search.

Supports two dataset kinds:
- unstructured: Reads files from S3 (txt, md, csv)
- structured: Reads data from Iceberg tables via Lakekeeper catalog

Supports two processing modes:
- full: Process all files, overwrite LanceDB table
- incremental: Process only new/modified files, append to LanceDB table
"""

import json
import shutil
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple, Set

import requests
from observability_client_runtime import get_logger

logger = get_logger()

# Import modular components
from utils.config import Config
from utils.auth import get_access_token, get_authenticated_session
from utils.data_store import put_json_object, default_store_root, posix_path, download_file as posix_download_file, read_json_object, list_subdirs, delete_tree
from data_sources.base import DataSource
from data_sources.unstructured import UnstructuredDataSource
from data_sources.structured import StructuredDataSource
from processing.chunker import Chunk, create_chunker
from processing.embedder import EmbeddingGenerator
from processing.lancedb_writer import LanceDBWriter


def _create_embedder(config) -> EmbeddingGenerator:
    """Build a gateway-routed EmbeddingGenerator from the Config dataclass.

    Centralized so the three call sites in this file stay consistent and the
    "what model identity flows to the gateway" question has a single answer.

    Resolution order for the wire `model` field:
      1. embedding_gateway_model_id — Bifrost's provider-prefixed binding id
         (e.g. `openai/projxxx_credxxxx_text-embedding-3-small`). This is the
         identifier the project virtual-key's allowed_models[] matches against,
         so it MUST be used whenever the request flows through Bifrost.
      2. embedding_provider_model_id — raw HF / upstream id (e.g.
         `sentence-transformers/all-MiniLM-L6-v2`). Used for the bare-Ollama /
         non-Bifrost path and as a backwards-compat fallback for Model rows
         registered before the gatewayModelId column existed.
      3. embedding_model — legacy free-form string from pre-port KBs.

    Without (1) Bifrost responds 403 model_blocked / "Model '<x>' is not
    allowed for this virtual key", which is exactly the failure mode we
    saw on sks6316 with text-embedding-3-small.
    """
    model_name = (
        config.embedding_gateway_model_id
        or config.embedding_provider_model_id
        or config.embedding_model
    )
    dim = config.embedding_dimensions or config.vector_size or 384
    return EmbeddingGenerator(
        model_name=model_name,
        proxy_url=config.llm_gateway_url,
        api_key=config.project_virtual_key_token,
        dim=dim,
        batch_size=config.embedding_batch_size,
    )


class ProgressTracker:
    """
    Centralized progress tracker with timing, ETA, and throttled S3 writes.

    Tracks elapsed time per phase, computes estimated time remaining, and
    writes a rich progress.json to S3 at a configurable minimum interval so
    the pipeline never appears "stuck".
    """

    def __init__(self, config: Config, write_interval_seconds: float = 5.0):
        self.config = config
        self.write_interval = write_interval_seconds

        self._wall_start = time.monotonic()
        self._phase_start = self._wall_start
        self._current_phase = 'initializing'
        self._completed_phases: Dict[str, float] = {}
        self._last_s3_write: float = 0.0
        self._data: Dict[str, Any] = {}

    # -- helpers ---------------------------------------------------------------

    @staticmethod
    def _fmt(seconds: float) -> str:
        """Human-readable duration string."""
        if seconds < 60:
            return f"{seconds:.1f}s"
        elif seconds < 3600:
            m, s = divmod(seconds, 60)
            return f"{int(m)}m {int(s)}s"
        else:
            h, rem = divmod(seconds, 3600)
            m, _ = divmod(rem, 60)
            return f"{int(h)}h {int(m)}m"

    def _elapsed(self) -> float:
        return time.monotonic() - self._wall_start

    def _phase_elapsed(self) -> float:
        return time.monotonic() - self._phase_start

    @staticmethod
    def _eta(current: int, total: int, elapsed: float) -> Optional[float]:
        if current <= 0 or total <= 0 or elapsed <= 0:
            return None
        rate = current / elapsed
        return (total - current) / rate if rate > 0 else None

    # -- phase management ------------------------------------------------------

    def begin_phase(self, phase: str) -> None:
        self._current_phase = phase
        self._phase_start = time.monotonic()
        logger.info(f"--- Phase: {phase} (total elapsed {self._fmt(self._elapsed())}) ---")

    def end_phase(self, phase: str) -> None:
        self._completed_phases[phase] = self._phase_elapsed()
        logger.info(f"--- Phase {phase} completed in {self._fmt(self._completed_phases[phase])} "
                     f"(total elapsed {self._fmt(self._elapsed())}) ---")

    # -- updates ---------------------------------------------------------------

    def update(self, current: int, total: int, force: bool = False, **extra) -> None:
        """
        Build progress payload and write to S3 if the throttle interval has
        passed (or *force* is True).
        """
        now = time.monotonic()
        elapsed = now - self._wall_start
        phase_elapsed = now - self._phase_start
        pct = (current / total * 100) if total > 0 else 0
        remaining = self._eta(current, total, phase_elapsed)

        self._data = {
            'phase': self._current_phase,
            'status': 'in_progress',
            'current': current,
            'total': total,
            'percentage': round(pct, 1),
            'elapsedSeconds': round(elapsed, 1),
            'elapsedFormatted': self._fmt(elapsed),
            'phaseElapsedSeconds': round(phase_elapsed, 1),
            'phaseElapsedFormatted': self._fmt(phase_elapsed),
            'completedPhases': {k: round(v, 1) for k, v in self._completed_phases.items()},
            'timestamp': datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        if remaining is not None:
            self._data['estimatedRemainingSeconds'] = round(remaining, 1)
            self._data['estimatedRemainingFormatted'] = self._fmt(remaining)
            rate = current / phase_elapsed if phase_elapsed > 0 else 0
            self._data['ratePerSecond'] = round(rate, 2)

        if force or (now - self._last_s3_write >= self.write_interval):
            self._write_s3()
            self._last_s3_write = now

    def finish(self, **extra) -> None:
        """Force-write a final progress payload."""
        elapsed = self._elapsed()
        self._data.update({
            'status': 'completed',
            'elapsedSeconds': round(elapsed, 1),
            'elapsedFormatted': self._fmt(elapsed),
            'completedPhases': {k: round(v, 1) for k, v in self._completed_phases.items()},
            'timestamp': datetime.now(timezone.utc).isoformat(),
            **extra,
        })
        self._write_s3()

    def fail(self, error: str) -> None:
        """Force-write an error progress payload."""
        elapsed = self._elapsed()
        self._data = {
            'phase': self._current_phase,
            'status': 'error',
            'error': error,
            'elapsedSeconds': round(elapsed, 1),
            'elapsedFormatted': self._fmt(elapsed),
            'completedPhases': {k: round(v, 1) for k, v in self._completed_phases.items()},
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }
        self._write_s3()

    def _write_s3(self) -> None:
        write_progress(self.config, self._data)


# Re-export the canonical helpers from utils.kb_helpers so processor.py
# callers (write_progress, write_result, partition workers, main()) and the
# Temporal worker can use the same single implementation. The original
# bodies lived here; they were moved to utils/kb_helpers.py so the two
# import sides don't have to cross-import each other.
from utils.kb_helpers import (
    create_data_source,
    kb_s3_prefix,
    normalize_manifest_file_keys,
    update_kb_status,
)

# Back-compat alias — historical name was `_kb_s3_prefix` (private).
# temporal_worker.py and the in-file call sites below still reach for the
# underscore form; keep the alias until they're migrated.
_kb_s3_prefix = kb_s3_prefix


def get_source_files_with_metadata(dataset_id: str, s3_path_prefix: str = '') -> Dict[str, Dict[str, Any]]:
    """
    Get all source files with their metadata (last modified timestamps) from the POSIX mount.

    Args:
        dataset_id: Dataset ID
        s3_path_prefix: Path prefix (e.g., "projects/<projectId>")

    Returns:
        Dictionary mapping file keys to metadata (last_modified timestamp)
    """
    if s3_path_prefix:
        prefix = f"{s3_path_prefix}/datasets/{dataset_id}/data_files/"
    else:
        prefix = f"datasets/{dataset_id}/data_files/"
    files = {}

    try:
        base = posix_path(prefix)
        if base.is_dir():
            for p in base.rglob("*"):
                if p.is_file() and not p.name.startswith('.'):
                    key = f"{prefix}{p.relative_to(base)}"
                    stat = p.stat()
                    from datetime import datetime, timezone as _tz
                    files[key] = {
                        'last_modified': datetime.fromtimestamp(stat.st_mtime, tz=_tz.utc).isoformat(),
                        'size': stat.st_size,
                    }
    except Exception as e:
        logger.warning(f"Error listing source files: {e}")

    return files


def compute_files_to_process(
    current_files: Dict[str, Dict[str, Any]],
    processed_files: Dict[str, Dict[str, Any]],
    processing_mode: str
) -> Tuple[Set[str], Dict[str, Dict[str, Any]]]:
    """
    Determine which files need processing based on mode.

    Args:
        current_files: Current files in source with metadata
        processed_files: Previously processed files from metadata
        processing_mode: 'full' or 'incremental'

    Returns:
        Tuple of (set of file keys to process, updated processed_files dict)
    """
    if processing_mode == 'full':
        # Full mode: process all files, reset tracking
        logger.info(f"Full mode: will process all {len(current_files)} files")
        return set(current_files.keys()), {}

    # Incremental mode: compute diff
    files_to_process = set()
    new_count = 0
    modified_count = 0

    for file_key, file_meta in current_files.items():
        if file_key not in processed_files:
            # New file
            files_to_process.add(file_key)
            new_count += 1
        elif file_meta['last_modified'] > processed_files[file_key].get('last_modified', ''):
            # Modified file
            files_to_process.add(file_key)
            modified_count += 1

    logger.info(f"Incremental mode: {new_count} new files, {modified_count} modified files, "
               f"{len(files_to_process)} total to process (out of {len(current_files)} total files)")

    return files_to_process, processed_files


def write_progress(config, progress: Dict[str, Any]):
    """Write progress to the POSIX mount for workflow monitoring."""
    progress_key = f"{_kb_s3_prefix(config.kb_id, config.s3_path_prefix)}/progress.json"
    try:
        put_json_object(progress_key, progress)
    except Exception as e:
        logger.warning(f"Failed to write progress: {e}")


# write_result removed: the unified metadata.json is the single source of
# truth for the workflow-result fields. Pre-unification this wrote a
# separate kb_processing_results.json that the Go workflow re-read, which
# allowed the two files' counts to drift when only one was updated. The
# Temporal merge activity now returns the metadata dict in-memory and
# falls back to the unified metadata.json on the mount.


import os


def _run_kb_partition_worker(config):
    """Run as a KB partition worker: process a subset of documents from manifest."""
    manifest_key = os.environ['PARTITION_MANIFEST_KEY']
    output_prefix = os.environ['PARTITION_OUTPUT_PREFIX']
    partition_id = os.environ.get('PARTITION_ID', 'unknown')

    logger.info(f"KB partition worker {partition_id}: reading manifest from {manifest_key}")

    progress = ProgressTracker(config, write_interval_seconds=5)
    temp_dir = Path(f'/tmp/kb-partition-{partition_id}')
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        _manifest_data = read_json_object(manifest_key)
        manifest = _manifest_data if _manifest_data else {}
        file_keys = normalize_manifest_file_keys(manifest.get('files') or [])
        logger.info(f"Partition {partition_id}: {len(file_keys)} files to process")

        data_source = create_data_source(config)
        data_source.connect()

        chunker = create_chunker(
            strategy=config.chunk_strategy,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            options=config.chunk_options,
        )

        all_chunks: List[Chunk] = []
        doc_count = 0

        progress.begin_phase('processing_documents')
        process_all_docs = config.dataset_kind == 'structured' or not file_keys
        for doc in data_source.get_documents():
            if not process_all_docs:
                doc_source = doc.metadata.get('file_path') or doc.doc_id
                should_process = any(
                    doc_source.endswith(fk.split('/')[-1]) or fk in doc_source
                    for fk in file_keys
                )
                if not should_process:
                    continue

            chunks = chunker.chunk_document(doc)
            all_chunks.extend(chunks)
            doc_count += 1
            progress.update(doc_count, len(file_keys),
                            documentsProcessed=doc_count,
                            chunksCreated=len(all_chunks))

        progress.end_phase('processing_documents')
        logger.info(f"Partition {partition_id}: {doc_count} docs -> {len(all_chunks)} chunks")

        if all_chunks:
            progress.begin_phase('generating_and_writing')
            embedder = _create_embedder(config)
            schema = EmbeddingGenerator.get_schema(embedder.embedding_dimension)

            import pyarrow.parquet as pq_local
            import pyarrow as pa_local

            embedded_batches = list(embedder.stream_record_batches(all_chunks))
            if embedded_batches:
                combined = pa_local.Table.from_batches(embedded_batches, schema=schema)
                local_emb_path = temp_dir / 'embeddings.parquet'
                pq_local.write_table(combined, local_emb_path)
                dest = posix_path(f"{output_prefix}/embeddings.parquet")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(local_emb_path), str(dest))

            progress.end_phase('generating_and_writing')

        result = {
            'partitionId': partition_id,
            'status': 'success',
            'outputPath': output_prefix,
            'rowCount': len(all_chunks),
            'fileCount': doc_count,
        }
        put_json_object(f"{output_prefix}/partition_result.json", result)
        progress.finish()
        logger.info(f"KB partition worker {partition_id} completed")

    except Exception as e:
        logger.error(f"KB partition worker {partition_id} failed: {e}", exc_info=True)
        error_result = {
            'partitionId': partition_id,
            'status': 'error',
            'error': str(e),
        }
        try:
            put_json_object(f"{output_prefix}/partition_result.json", error_result)
        except Exception:
            pass
        progress.fail(str(e))
        sys.exit(1)
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def _run_kb_partition_aggregate(config):
    """Run as a KB partition aggregator: combine partition outputs into LanceDB."""
    job_output_prefix = os.environ['JOB_OUTPUT_PREFIX']
    output_prefix = f"{job_output_prefix}/aggregation"

    logger.info(f"KB aggregator: reading partitions from {job_output_prefix}")

    progress = ProgressTracker(config, write_interval_seconds=5)
    temp_dir = Path('/tmp/kb-aggregation')
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        progress.begin_phase('processing')

        partitions = list_subdirs(f"{job_output_prefix}/partitions")
        logger.info(f"Found {len(partitions)} partition outputs")

        import pyarrow.parquet as pq_agg

        embedder = _create_embedder(config)
        schema = EmbeddingGenerator.get_schema(embedder.embedding_dimension)

        writer = LanceDBWriter(
            kb_id=config.kb_id,
            s3_path_prefix=config.s3_path_prefix,
            temp_dir=temp_dir,
        )

        def record_batch_iterator():
            for i, p_prefix in enumerate(partitions):
                emb_key = f"{p_prefix}/embeddings.parquet"
                local_path = temp_dir / f'part_{i}.parquet'
                try:
                    posix_download_file(emb_key, local_path)
                    pf = pq_agg.ParquetFile(str(local_path))
                    for batch in pf.iter_batches(batch_size=1024):
                        yield batch
                    local_path.unlink()
                except Exception as e:
                    logger.warning(f"Failed to read embeddings from {p_prefix}: {e}")
                    if local_path.exists():
                        local_path.unlink()

        lance_table_path = writer.write_stream(
            record_batch_iterator(), schema, mode='full',
            indexing_mode=config.indexing_mode,
            quantization_type=config.quantization_type,
            quantization_options=config.quantization_options,
        )

        progress.end_phase('processing')

        update_kb_status(config, 'ready', lance_table_path)

        result = {
            'partitionId': 'aggregation',
            'status': 'success',
            'outputPath': output_prefix,
        }
        put_json_object(f"{output_prefix}/partition_result.json", result)

        try:
            delete_tree(f"{job_output_prefix}/partitions")
        except Exception as cleanup_err:
            logger.warning(f"Cleanup failed (non-fatal): {cleanup_err}")

        progress.finish()
        logger.info(f"KB aggregation completed: {lance_table_path}")

    except Exception as e:
        logger.error(f"KB aggregation failed: {e}", exc_info=True)
        error_result = {
            'partitionId': 'aggregation',
            'status': 'error',
            'error': str(e),
        }
        try:
            put_json_object(f"{output_prefix}/partition_result.json", error_result)
        except Exception:
            pass
        progress.fail(str(e))
        sys.exit(1)
    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def main():
    """Main processing function."""
    # Load configuration
    config = Config.from_environment()

    # Check for partition mode
    partition_mode = os.environ.get('PARTITION_MODE', '')
    if partition_mode == 'worker':
        logger.info("PARTITION_MODE=worker: running KB partition worker")
        _run_kb_partition_worker(config)
        return
    elif partition_mode == 'aggregate':
        logger.info("PARTITION_MODE=aggregate: running KB partition aggregator")
        _run_kb_partition_aggregate(config)
        return

    logger.info(f"Starting KB processor for KB: {config.kb_id}")
    logger.info(f"Dataset kind: {config.dataset_kind}, Source: {config.source_dataset_id}")
    logger.info(f"Processing mode: {config.processing_mode}")
    logger.info(f"Data mount: {default_store_root()}")

    temp_dir = Path('/tmp/kb-processor')
    temp_dir.mkdir(parents=True, exist_ok=True)

    progress: Optional[ProgressTracker] = None

    try:
        progress = ProgressTracker(config, write_interval_seconds=5)

        writer = LanceDBWriter(
            kb_id=config.kb_id,
            s3_path_prefix=config.s3_path_prefix,
            temp_dir=temp_dir,
        )

        # ----- Phase: listing_files -------------------------------------------
        progress.begin_phase('listing_files')

        # For incremental mode, load existing metadata to get processed files
        existing_metadata = writer.read_metadata() or {}
        processed_files = existing_metadata.get('processedFiles', {})

        # For unstructured datasets, compute file diff for incremental mode
        files_to_process = None
        source_files_metadata = {}
        if config.dataset_kind == 'unstructured':
            source_files_metadata = get_source_files_with_metadata(
                config.source_dataset_id, config.s3_path_prefix
            )
            files_to_process, processed_files = compute_files_to_process(
                source_files_metadata, processed_files, config.processing_mode
            )

            # If incremental and no files to process, we're done. The
            # existing metadata.json is still authoritative (nothing
            # changed); just bump lastProcessedAt to record that we ran a
            # no-op cycle, and update the KB status. No separate result
            # file is written — the unified metadata.json is the single
            # source of truth.
            if config.processing_mode == 'incremental' and not files_to_process:
                logger.info("Incremental mode: No new or modified files to process")
                lance_table_path = writer.get_lance_table_path()
                if existing_metadata:
                    refreshed = dict(existing_metadata)
                    refreshed['status'] = 'success'
                    refreshed['lastProcessingMode'] = 'incremental'
                    stats_blob = dict(refreshed.get('stats') or {})
                    stats_blob['lastProcessedAt'] = datetime.now(timezone.utc).isoformat()
                    refreshed['stats'] = stats_blob
                    writer.upload_metadata(refreshed)
                update_kb_status(config, 'ready', lance_table_path)
                progress.finish(phase='completed', message='KB is up to date, no processing needed')
                logger.info("KB is up to date, no processing needed")
                return

        progress.end_phase('listing_files')

        # ----- Phase: connecting ----------------------------------------------
        progress.begin_phase('connecting')

        data_source = create_data_source(config)

        logger.info("Connecting to data source...")
        data_source.connect()

        total_items = data_source.get_total_count()
        if total_items == 0:
            raise ValueError(f"No items found in data source")

        logger.info(f"Data source connected: {total_items} items, type={data_source.source_type}")
        progress.update(total_items, total_items, force=True,
                        sourceType=data_source.source_type,
                        processingMode=config.processing_mode,
                        totalItems=total_items)
        progress.end_phase('connecting')

        # Create chunker using factory based on strategy
        chunker = create_chunker(
            strategy=config.chunk_strategy,
            chunk_size=config.chunk_size,
            chunk_overlap=config.chunk_overlap,
            options=config.chunk_options
        )

        # ----- Phase: processing_documents ------------------------------------
        progress.begin_phase('processing_documents')
        logger.info(f"Processing {total_items} documents and creating chunks...")

        all_chunks: List[Chunk] = []
        doc_count = 0
        skipped_count = 0
        processed_doc_ids: Set[str] = set()
        # Pre-compute per-document-id chunk counts so finalization doesn't
        # need to re-iterate all_chunks (which will have been freed by then).
        per_doc_chunk_counts: Dict[str, int] = defaultdict(int)

        for doc in data_source.get_documents():
            # For incremental mode with unstructured data, filter by files to process
            if files_to_process is not None and config.processing_mode == 'incremental':
                doc_source = doc.metadata.get('file_path') or doc.doc_id
                should_process = any(
                    doc_source in fk or fk.endswith(doc_source) or doc_source.endswith(fk.split('/')[-1])
                    for fk in files_to_process
                )
                if not should_process:
                    skipped_count += 1
                    continue

            chunks = chunker.chunk_document(doc)
            all_chunks.extend(chunks)
            doc_count += 1
            processed_doc_ids.add(doc.doc_id)
            for chunk in chunks:
                per_doc_chunk_counts[chunk.document_id] += 1

            # Log every document with timing so the job never appears stuck
            doc_name = doc.metadata.get('relative_path') or doc.metadata.get('file_name') or doc.doc_id
            logger.info(
                f"[doc {doc_count}/{total_items}] "
                f"Processed '{doc_name}' -> {len(chunks)} chunks "
                f"(total chunks so far: {len(all_chunks)}, "
                f"elapsed: {progress._fmt(progress._phase_elapsed())})"
            )

            # Update S3 progress (throttled internally)
            progress.update(doc_count, total_items,
                            documentsProcessed=doc_count,
                            totalDocuments=total_items,
                            chunksCreated=len(all_chunks),
                            skippedDocuments=skipped_count,
                            currentFile=doc_name,
                            processingMode=config.processing_mode)

        if not all_chunks:
            if config.processing_mode == 'incremental':
                # Same no-op-cycle pattern as the no-files-to-process branch
                # above. Existing metadata.json remains authoritative; just
                # refresh lastProcessedAt and update the KB record.
                logger.info("Incremental mode: No new chunks to add")
                lance_table_path = writer.get_lance_table_path()
                if existing_metadata:
                    refreshed = dict(existing_metadata)
                    refreshed['status'] = 'success'
                    refreshed['lastProcessingMode'] = 'incremental'
                    stats_blob = dict(refreshed.get('stats') or {})
                    stats_blob['lastProcessedAt'] = datetime.now(timezone.utc).isoformat()
                    refreshed['stats'] = stats_blob
                    writer.upload_metadata(refreshed)
                update_kb_status(config, 'ready', lance_table_path)
                progress.finish(phase='completed', message='Incremental mode: no new chunks')
                return
            else:
                raise ValueError("No chunks created from documents")

        progress.end_phase('processing_documents')
        logger.info(f"Processed {doc_count} documents into {len(all_chunks)} chunks "
                     f"(skipped {skipped_count} unchanged documents)")

        # Force a progress write at phase boundary
        progress.update(doc_count, total_items, force=True,
                        documentsProcessed=doc_count,
                        chunksCreated=len(all_chunks),
                        skippedDocuments=skipped_count,
                        processingMode=config.processing_mode)

        # ----- Phase: generating_and_writing ----------------------------------
        # Embedding generation and LanceDB writing are merged into a single
        # streaming phase.  The embedder yields one RecordBatch per encoding
        # batch and LanceDB consumes them lazily, so peak memory stays
        # proportional to a single batch (~256 chunks) rather than the full
        # dataset.
        progress.begin_phase('generating_and_writing')

        total_chunks = len(all_chunks)
        unique_docs = len(processed_doc_ids)

        logger.info(
            f"Streaming embeddings for {total_chunks:,} chunks and writing "
            f"LanceDB table in {config.processing_mode} mode..."
        )

        embedder = _create_embedder(config)

        # Build schema (requires model dimension) for LanceDB iterator ingestion
        schema = EmbeddingGenerator.get_schema(embedder.embedding_dimension)

        def _embedding_progress_cb(completed: int, total: int):
            """Called by the embedder after each batch to update S3 progress."""
            progress.update(completed, total,
                            chunksEmbedded=completed,
                            totalChunks=total,
                            documentsProcessed=doc_count,
                            processingMode=config.processing_mode)

        # Create the streaming iterator — nothing is computed until consumed
        batch_iter = embedder.stream_record_batches(
            all_chunks, progress_callback=_embedding_progress_cb,
        )

        def _upload_progress_cb(uploaded: int, total: int, uploaded_bytes: int):
            """Called by the writer after each file is uploaded to S3."""
            progress.update(uploaded, total,
                            filesUploaded=uploaded,
                            totalFilesToUpload=total,
                            uploadedBytes=uploaded_bytes,
                            processingMode=config.processing_mode)

        # LanceDB lazily pulls from batch_iter, so embedding + write happen
        # interleaved without ever materialising the full embedding matrix.
        lance_table_path = writer.write_stream(
            batch_iter,
            schema,
            mode=config.processing_mode,
            indexing_mode=config.indexing_mode,
            quantization_type=config.quantization_type,
            quantization_options=config.quantization_options,
            progress_callback=_upload_progress_cb,
        )

        # Free the chunk list — only lightweight stats are needed from here on.
        del all_chunks

        progress.end_phase('generating_and_writing')
        logger.info(f"LanceDB table written to {lance_table_path}")
        progress.update(total_chunks, total_chunks, force=True,
                        vectorsCreated=total_chunks,
                        documentsProcessed=doc_count,
                        chunksCreated=total_chunks,
                        processingMode=config.processing_mode)

        # ----- Phase: finalizing ----------------------------------------------
        progress.begin_phase('finalizing')

        # Update processed files tracking for incremental mode.
        # Uses pre-computed per_doc_chunk_counts so we don't need all_chunks.
        def _chunk_count_for_key(file_key: str) -> int:
            """Look up chunk count for a file key using pre-computed map."""
            for doc_id, count in per_doc_chunk_counts.items():
                if file_key.endswith(doc_id) or doc_id in file_key:
                    return count
            return 0

        if config.processing_mode == 'full':
            new_processed_files = {
                key: {
                    'last_modified': meta['last_modified'],
                    'chunk_count': _chunk_count_for_key(key),
                }
                for key, meta in source_files_metadata.items()
            }
        else:
            new_processed_files = dict(processed_files)
            for key in files_to_process or []:
                if key in source_files_metadata:
                    new_processed_files[key] = {
                        'last_modified': source_files_metadata[key]['last_modified'],
                        'chunk_count': _chunk_count_for_key(key),
                    }

        # Get storage stats from the upload
        upload_stats = writer.get_upload_stats()
        last_processed = datetime.now(timezone.utc).isoformat()
        storage_bytes = upload_stats.get('total_bytes', 0)
        storage_mb = round(storage_bytes / 1024 / 1024, 2)
        index_results = writer.get_index_results()
        has_vector_index = index_results.get('vector_index_created', False)
        has_fts_index = index_results.get('fts_index_created', False)

        # Compute final counts up front so the unified block below can be
        # built in a single statement (mirrors temporal_worker.py's merge
        # block; fewer post-construction mutations = less drift surface).
        if config.processing_mode == 'full':
            document_count = unique_docs
            chunk_count = total_chunks
            vector_count = total_chunks
        else:
            document_count = existing_metadata.get('documentCount', 0) + unique_docs
            chunk_count = existing_metadata.get('chunkCount', 0) + total_chunks
            vector_count = existing_metadata.get('vectorCount', 0) + total_chunks

        # Unified metadata.json — single source of truth (matches the
        # temporal_worker.py merge-path shape verbatim; keep these two
        # writers in lockstep). The Go workflow's ReadKBMetadataActivity
        # decodes the top-level workflow-result fields; kb-retrieval-service
        # reads the KB-shape + embedding-identity fields. types.KBMetadata
        # is the authoritative shape.
        kb_metadata = {
            # --- Workflow-result fields ---
            'status': 'success',
            'knowledgeBaseId': config.kb_id,
            'projectId': config.project_id,
            'lanceTablePath': lance_table_path,
            'documentCount': document_count,
            'chunkCount': chunk_count,
            'vectorCount': vector_count,
            'sourceType': data_source.source_type,
            'stats': {
                'storageBytes': storage_bytes,
                'storageMB': storage_mb,
                'fileCount': upload_stats.get('file_count', 0),
                'lastProcessedAt': last_processed,
            },
            # --- KB-shape fields (kb-retrieval reads these) ---
            'tableName': writer.TABLE_NAME,
            'indexingMode': config.indexing_mode,
            'hasVectorIndex': has_vector_index,
            'vectorIndexMetric': 'cosine' if has_vector_index else None,
            'hasFtsIndex': has_fts_index,
            # --- Embedding-model identity (kb-retrieval cascade) ---
            'embeddingModel': config.embedding_provider_model_id or config.embedding_model,
            'embeddingProvider': config.embedding_provider or 'openai_compatible',
            'embeddingModelId': config.embedding_model_id,
            'embeddingProviderModelId': config.embedding_provider_model_id or config.embedding_model,
            'providerModelId': config.embedding_provider_model_id or config.embedding_model,
            'embeddingGatewayModelId': config.embedding_gateway_model_id or '',
            'embeddingEndpoint': config.embedding_endpoint or None,
            'vectorSize': embedder.embedding_dimension,
            # --- Reprocessing / config trail ---
            'chunkSize': config.chunk_size,
            'chunkOverlap': config.chunk_overlap,
            'chunkStrategy': config.chunk_strategy,
            'quantizationType': config.quantization_type,
            'lastProcessingMode': config.processing_mode,
            'processedFiles': new_processed_files,
        }
        writer.upload_metadata(kb_metadata)
        # The Go workflow no longer reads a separate kb_processing_results.json —
        # the in-memory dict returned by temporal_worker's merge IS the
        # workflow result. For the in-process (non-Temporal) path here, the
        # surrounding standalone caller (CLI / partition-worker) gets the
        # same source of truth via metadata.json on the mount.
        update_kb_status(config, 'ready', lance_table_path)

        progress.end_phase('finalizing')

        # Write final completed progress
        progress.finish(
            phase='completed',
            lanceTablePath=lance_table_path,
            processingMode=config.processing_mode,
            documentCount=unique_docs,
            chunkCount=total_chunks,
            vectorCount=total_chunks,
            sourceType=data_source.source_type,
            storageMB=round(upload_stats.get('total_bytes', 0) / 1024 / 1024, 2),
        )

        logger.info(
            f"Successfully processed KB in {config.processing_mode} mode. "
            f"{unique_docs} docs -> {total_chunks} chunks -> {total_chunks} vectors. "
            f"LanceDB: {lance_table_path} "
            f"(total time: {progress._fmt(progress._elapsed())})"
        )

    except Exception as e:
        logger.error(f"Processing failed: {e}", exc_info=True)

        # Write error progress via tracker if available
        if progress:
            progress.fail(str(e))

        # On error, we want to surface the failure WITHOUT clobbering a
        # previously-good metadata.json. If a prior successful run exists
        # (status=success), merge `error` + bump `lastProcessedAt` onto
        # the existing dict so kb-retrieval still sees the last-known-good
        # lanceTablePath / counts and searches keep working until the
        # next successful reprocess. If there's no prior metadata, stamp
        # a fresh status=error blob with zero counts so the GUI shows
        # the failure unambiguously.
        try:
            try:
                prior = writer.read_metadata() or {}
            except NameError:
                # writer not constructed yet — early-construction failure.
                # UnboundLocalError is a subclass of NameError so this
                # catches both module-name and local-binding cases.
                prior = {}
            except Exception:
                prior = {}

            now_iso = datetime.now(timezone.utc).isoformat()
            if prior.get('status') == 'success':
                error_metadata = dict(prior)
                error_metadata['lastError'] = str(e)
                # Don't change `status` — a search-time error is preferable
                # to silent zeros. The lastError field surfaces the issue
                # without breaking retrieval against the last good index.
                stats_blob = dict(error_metadata.get('stats') or {})
                stats_blob['lastErrorAt'] = now_iso
                error_metadata['stats'] = stats_blob
            else:
                error_metadata = {
                    'status': 'error',
                    'knowledgeBaseId': config.kb_id,
                    'projectId': config.project_id,
                    'error': str(e),
                    'documentCount': 0,
                    'chunkCount': 0,
                    'vectorCount': 0,
                    'stats': {'lastProcessedAt': now_iso},
                }

            try:
                writer.upload_metadata(error_metadata)
            except NameError:
                # writer wasn't constructed (early failure) — direct write
                # so the breadcrumb still lands on the mount.
                put_json_object(
                    f"{kb_s3_prefix(config.kb_id, config.s3_path_prefix)}/metadata.json",
                    error_metadata,
                )
            if not progress:
                write_progress(config, {
                    'phase': 'failed',
                    'status': 'error',
                    'error': str(e),
                    'timestamp': now_iso,
                })
            update_kb_status(config, 'errored', error_message=str(e))
        except Exception as nested_e:
            logger.error(f"Failed to write error metadata: {nested_e}")

        sys.exit(1)

    finally:
        # Clean up temporary directory
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


if __name__ == '__main__':
    main()
