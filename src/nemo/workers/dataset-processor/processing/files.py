"""File processing functions for dataset import.

Refactored from the legacy processor.py monolith. All functions accept a Config
object instead of reading module-level globals, and return result dicts instead
of writing to S3 as side effects + sys.exit(1).
"""

import contextvars
import json
import hashlib
from observability_client_runtime import get_logger
import mimetypes
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

# Type alias for workflow progress callback (phase, phase_pct, current, total, extra) -> None
WorkflowProgressCallback = Optional[Callable[[str, float, int, int, Dict[str, Any]], None]]

import pyarrow as pa
import pyarrow.parquet as pq

from .config import Config

try:
    from pyiceberg.catalog.rest import RestCatalog
    from pyiceberg.schema import Schema
    from pyiceberg.types import (
        StringType, LongType, DoubleType, BooleanType, FloatType,
        IntegerType, TimestampType, TimestamptzType, DateType, BinaryType, NestedField,
    )
    HAS_PYICEBERG = True
except ImportError:
    HAS_PYICEBERG = False

try:
    import magic
    HAS_MAGIC = True
except ImportError:
    HAS_MAGIC = False

logger = get_logger()


# ---------------------------------------------------------------------------
# Background heartbeat
# ---------------------------------------------------------------------------


class _BackgroundHeartbeat:
    """Sends Temporal heartbeats on a fixed interval from a daemon thread.

    Prevents heartbeat timeouts during long-running phases where
    ``ProgressTracker.update()`` isn't called (e.g. Parquet writes, large
    file downloads, schema unification on huge tables).

    The worker thread **must** run with a copy of the caller's ``contextvars``
    context: Temporal records activity context in contextvars, and plain
    ``threading.Thread`` targets start with an empty context, so
    ``activity.heartbeat`` would otherwise not reach the server.

    Usage::

        with _BackgroundHeartbeat(activity.heartbeat, interval=30):
            do_long_work()
    """

    def __init__(
        self,
        heartbeat_fn: Callable[[str], None],
        interval: float = 30.0,
    ):
        self._heartbeat_fn = heartbeat_fn
        self._interval = interval
        self._phase = "working"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def set_phase(self, phase: str) -> None:
        self._phase = phase

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._heartbeat_fn(f"background: {self._phase}")
            except Exception:
                pass

    def __enter__(self) -> "_BackgroundHeartbeat":
        self._stop.clear()
        ctx = contextvars.copy_context()
        self._thread = threading.Thread(target=lambda: ctx.run(self._run), daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


# ---------------------------------------------------------------------------
# ProgressTracker
# ---------------------------------------------------------------------------


class ProgressTracker:
    """Progress tracker with phase timing, ETA, and throttled POSIX writes."""

    def __init__(self, config: Config, write_interval_seconds: float = 5.0,
                 progress_key_override: Optional[str] = None,
                 heartbeat_callback: Optional[Callable[[str], None]] = None,
                 workflow_progress_callback: WorkflowProgressCallback = None):
        self.config = config
        self.write_interval = write_interval_seconds
        self._progress_key = config.progress_key(progress_key_override)
        self._heartbeat_callback = heartbeat_callback
        self._workflow_progress_callback = workflow_progress_callback
        self._wall_start = time.monotonic()
        self._phase_start = self._wall_start
        self._current_phase = "initializing"
        self._completed_phases: Dict[str, float] = {}
        self._last_s3_write: float = 0.0
        self._data: Dict[str, Any] = {}

    @staticmethod
    def _fmt(seconds: float) -> str:
        if seconds < 60:
            return f"{seconds:.1f}s"
        elif seconds < 3600:
            m, s = divmod(seconds, 60)
            return f"{int(m)}m {int(s)}s"
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

    def begin_phase(self, phase: str) -> None:
        self._current_phase = phase
        self._phase_start = time.monotonic()
        logger.info(f"--- Phase: {phase} (total elapsed {self._fmt(self._elapsed())}) ---")

    def end_phase(self, phase: str) -> None:
        self._completed_phases[phase] = self._phase_elapsed()
        logger.info(
            f"--- Phase {phase} completed in {self._fmt(self._completed_phases[phase])} "
            f"(total elapsed {self._fmt(self._elapsed())}) ---"
        )

    def update(self, current: int, total: int, force: bool = False, **extra) -> None:
        now = time.monotonic()
        elapsed = now - self._wall_start
        phase_elapsed = now - self._phase_start
        pct = (current / total * 100) if total > 0 else 0
        remaining = self._eta(current, total, phase_elapsed)

        self._data = {
            "phase": self._current_phase,
            "status": "in_progress",
            "current": current,
            "total": total,
            "percentage": round(pct, 1),
            "elapsedSeconds": round(elapsed, 1),
            "elapsedFormatted": self._fmt(elapsed),
            "phaseElapsedSeconds": round(phase_elapsed, 1),
            "phaseElapsedFormatted": self._fmt(phase_elapsed),
            "completedPhases": {k: round(v, 1) for k, v in self._completed_phases.items()},
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        }
        if remaining is not None:
            self._data["estimatedRemainingSeconds"] = round(remaining, 1)
            self._data["estimatedRemainingFormatted"] = self._fmt(remaining)
            rate = current / phase_elapsed if phase_elapsed > 0 else 0
            self._data["ratePerSecond"] = round(rate, 2)

        if force or (now - self._last_s3_write >= self.write_interval):
            self._write_s3()
            self._last_s3_write = now
            if self._heartbeat_callback and self._data:
                msg = f"{self._current_phase}: {current}/{total}" if total else self._current_phase
                try:
                    self._heartbeat_callback(msg)
                except Exception as e:
                    logger.debug("Heartbeat callback failed: %s", e)
            if self._workflow_progress_callback and self._data:
                phase_pct = float(self._data.get("percentage", 0))
                extra = {
                    k: self._data[k]
                    for k in (
                        "processedFiles", "totalFiles", "currentFile", "elapsedFormatted",
                        "estimatedRemainingFormatted", "ratePerSecond", "rowCount", "sourceFileCount",
                    )
                    if k in self._data
                }
                try:
                    self._workflow_progress_callback(
                        self._current_phase, phase_pct, current, total, extra
                    )
                except Exception as e:
                    logger.debug("Workflow progress callback failed: %s", e)

    def finish(self, **extra) -> None:
        elapsed = self._elapsed()
        self._data.update({
            "status": "completed",
            "elapsedSeconds": round(elapsed, 1),
            "elapsedFormatted": self._fmt(elapsed),
            "completedPhases": {k: round(v, 1) for k, v in self._completed_phases.items()},
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **extra,
        })
        self._write_s3()

    def fail(self, error: str) -> None:
        elapsed = self._elapsed()
        self._data = {
            "phase": self._current_phase,
            "status": "error",
            "error": error,
            "elapsedSeconds": round(elapsed, 1),
            "elapsedFormatted": self._fmt(elapsed),
            "completedPhases": {k: round(v, 1) for k, v in self._completed_phases.items()},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        self._write_s3()

    def _write_s3(self) -> None:
        try:
            _posix_write_json(self.config.posix_path(self._progress_key), self._data)
        except Exception as e:
            logger.warning(f"Failed to write progress: {e}")


# ---------------------------------------------------------------------------
# POSIX I/O helpers (NEMO_DEFAULT_STORE_ROOT)
# ---------------------------------------------------------------------------

def _posix_write_atomic(path: Path, data: bytes) -> None:
    """Write bytes atomically via temp-then-rename (safe on NFS)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.rename(path)


def _posix_write_json(path: Path, obj: Any) -> None:
    _posix_write_atomic(path, json.dumps(obj, default=str).encode("utf-8"))


def _posix_read_json(path: Path) -> Any:
    return json.loads(path.read_bytes())


# ---------------------------------------------------------------------------
# File storage helpers
# ---------------------------------------------------------------------------

def _upload_json(config: Config, key: str, data: Any) -> None:
    _posix_write_json(config.posix_path(key), data)


def _upload_file(config: Config, local_src: Path, key: str) -> None:
    dest = config.posix_path(key)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(local_src), str(dest))


def _read_json(config: Config, key: str) -> Any:
    return _posix_read_json(config.posix_path(key))


def _write_bytes(config: Config, key: str, data: bytes) -> None:
    _posix_write_atomic(config.posix_path(key), data)


def _list_partition_outputs(config: Config, job_output_prefix: str) -> List[str]:
    base = config.posix_path(f"{job_output_prefix}/partitions")
    if not base.is_dir():
        return []
    return sorted(
        f"{job_output_prefix}/partitions/{d.name}"
        for d in base.iterdir() if d.is_dir()
    )


def _cleanup_partition_artifacts(config: Config, job_output_prefix: str) -> None:
    base = config.posix_path(f"{job_output_prefix}/partitions")
    if base.is_dir():
        shutil.rmtree(base)
        logger.info("Cleaned up partition artifacts at %s", base)


# ---------------------------------------------------------------------------
# File I/O helpers
# ---------------------------------------------------------------------------

def download_file(config: Config, key: str, local_path: Path) -> None:
    src = config.posix_path(key)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(local_path))


def list_data_files(config: Config) -> List[Dict[str, Any]]:
    if config.s3_path_prefix:
        prefix = f"{config.s3_path_prefix}/datasets/{config.dataset_id}/data_files/"
    else:
        prefix = f"datasets/{config.dataset_id}/data_files/"

    base = config.posix_path(prefix)
    files = []
    if base.is_dir():
        for p in sorted(base.rglob("*")):
            if p.is_file():
                rel_key = f"{prefix}{p.relative_to(base)}"
                st = p.stat()
                files.append({
                    "key": rel_key,
                    "size": st.st_size,
                    "last_modified": os.path.getmtime(p),
                    "etag": "",
                })
    logger.info(f"Found {len(files)} files under {base}")
    return files


def _get_relative_path(key: str) -> str:
    if key is None or not isinstance(key, str):
        return "unknown"
    key = key.strip()
    if not key:
        return "unknown"
    marker = "data_files/"
    idx = key.find(marker)
    if idx != -1:
        relative = key[idx + len(marker) :].lstrip("/")
        if relative:
            return relative
    return Path(key).name or "unknown"


def compute_checksum(
    file_path: Path,
    heartbeat_fn: Optional[Callable[[str], None]] = None,
    heartbeat_stride_bytes: int = 16 * 1024 * 1024,
) -> str:
    """Streaming SHA-256; optional ``heartbeat_fn`` for long reads (large single files)."""
    sha256_hash = hashlib.sha256()
    read_total = 0
    next_hb_at = heartbeat_stride_bytes
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(65536), b""):
            sha256_hash.update(byte_block)
            read_total += len(byte_block)
            if heartbeat_fn and read_total >= next_hb_at:
                try:
                    heartbeat_fn(f"checksum {file_path.name}: {read_total // (1024 * 1024)} MiB")
                except Exception:
                    pass
                next_hb_at = read_total + heartbeat_stride_bytes
    return sha256_hash.hexdigest()


def get_mime_type(file_path: Path) -> str:
    if HAS_MAGIC:
        try:
            mime = magic.Magic(mime=True)
            return mime.from_file(str(file_path))
        except Exception:
            pass
    mime_type, _ = mimetypes.guess_type(str(file_path))
    return mime_type or "application/octet-stream"


# ---------------------------------------------------------------------------
# Structured file readers
# ---------------------------------------------------------------------------

def normalize_table_for_iceberg(table: pa.Table) -> pa.Table:
    new_columns = []
    new_names = []
    for i, field in enumerate(table.schema):
        column = table.column(i)
        col_type = field.type
        if pa.types.is_struct(col_type) or pa.types.is_list(col_type) or pa.types.is_map(col_type):
            json_values = []
            for value in column.to_pylist():
                json_values.append(None if value is None else json.dumps(value, default=str))
            new_columns.append(pa.array(json_values, type=pa.string()))
        else:
            new_columns.append(column)
        new_names.append(field.name)
    return pa.table(dict(zip(new_names, new_columns)))


def read_parquet_file(file_path: Path) -> pa.Table:
    table = pq.read_table(file_path)
    return normalize_table_for_iceberg(table)


def read_csv_file(file_path: Path) -> pa.Table:
    import pandas as pd
    df = pd.read_csv(file_path)
    return pa.Table.from_pandas(df)


def read_json_file(file_path: Path) -> pa.Table:
    import pandas as pd
    if file_path.stat().st_size == 0:
        raise ValueError("JSON file is empty")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read().strip()
    if not content:
        raise ValueError("JSON file is empty or contains only whitespace")
    first_char = content[0]
    if first_char == "[":
        df = pd.read_json(file_path, orient="records")
    elif first_char == "{":
        if "\n" in content:
            try:
                df = pd.read_json(file_path, lines=True)
            except ValueError:
                df = pd.read_json(file_path)
        else:
            df = pd.DataFrame([json.loads(content)])
    else:
        raise ValueError(f"Invalid JSON: unexpected first character '{first_char}'")
    if df.empty:
        raise ValueError("JSON file parsed but resulted in empty DataFrame")
    table = pa.Table.from_pandas(df)
    return normalize_table_for_iceberg(table)


def read_structured_file(file_path: Path) -> Optional[pa.Table]:
    suffix = file_path.suffix.lower()
    if suffix == ".parquet":
        return read_parquet_file(file_path)
    elif suffix == ".csv":
        return read_csv_file(file_path)
    elif suffix in [".json", ".jsonl"]:
        return read_json_file(file_path)
    logger.warning(f"Unsupported file format for structured data: {suffix}")
    return None


def _process_single_structured_file(config: Config, file_info: Dict[str, Any], temp_base: str) -> Optional[pa.Table]:
    """Process a single structured file in a child process."""
    vol = (file_info.get("local_path") or file_info.get("localPath") or "").strip()
    if vol:
        vp = Path(vol)
        if vp.is_file():
            try:
                return read_structured_file(vp)
            except Exception as e:
                logger.warning("Skipping volume file %s: %s", vol, e)
                return None
        logger.warning("Volume path is not a readable file: %s", vol)
        return None

    key = file_info.get("key") or ""
    try:
        src = config.posix_path(key)
        return read_structured_file(src)
    except Exception as e:
        logger.warning(f"Skipping {key} due to error: {e}")
        return None


def process_structured_data(
    config: Config, files: List[Dict[str, Any]], temp_dir: Path,
    tracker: Optional[ProgressTracker] = None,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
) -> Tuple[pa.Table, pa.Schema]:
    from concurrent.futures import ProcessPoolExecutor, as_completed

    tables = []
    total_files = len(files)
    max_workers = min(os.cpu_count() or 2, total_files, 4)

    if max_workers > 1 and total_files > 1:
        logger.info(f"Processing {total_files} structured files with {max_workers} workers")
        with ProcessPoolExecutor(max_workers=max_workers) as pool:
            futures = {
                pool.submit(_process_single_structured_file, config, f, str(temp_dir)): f
                for f in files
            }
            for i, future in enumerate(as_completed(futures)):
                try:
                    table = future.result()
                    if table is not None:
                        tables.append(table)
                except Exception as e:
                    logger.warning(f"Skipping file due to error: {e}")
                if tracker:
                    tracker.update(i + 1, total_files, totalFiles=total_files, processedFiles=i + 1)
    else:
        for i, file_info in enumerate(files):
            key = file_info["key"]
            vol = (file_info.get("local_path") or file_info.get("localPath") or "").strip()
            if vol:
                vp = Path(vol)
                if tracker:
                    tracker.update(i, total_files, totalFiles=total_files, processedFiles=i, currentFile=vp.name)
                try:
                    if vp.is_file():
                        if heartbeat_callback:
                            try:
                                heartbeat_callback(f"structured: reading {vp.name}")
                            except Exception:
                                pass
                        table = read_structured_file(vp)
                        if table is not None:
                            tables.append(table)
                except Exception as e:
                    logger.warning("Skipping volume file %s: %s", vol, e)
                continue
            if tracker:
                tracker.update(i, total_files, totalFiles=total_files, processedFiles=i, currentFile=Path(key).name)
            try:
                src = config.posix_path(key)
                if heartbeat_callback:
                    try:
                        heartbeat_callback(f"structured: reading {Path(key).name}")
                    except Exception:
                        pass
                table = read_structured_file(src)
                if table is not None:
                    tables.append(table)
            except Exception as e:
                logger.warning(f"Skipping {key} due to error: {e}")

    if tracker:
        tracker.update(total_files, total_files, force=True, totalFiles=total_files, processedFiles=total_files)
    if not tables:
        raise ValueError("No structured files were successfully processed")

    if heartbeat_callback:
        try:
            heartbeat_callback("structured: unify_schema_and_concat")
        except Exception:
            pass
    unified_schema = pa.unify_schemas([t.schema for t in tables], promote_options="default")
    unified_tables = []
    for t in tables:
        try:
            unified_tables.append(t.cast(unified_schema))
        except Exception:
            unified_tables.append(t)
    combined_table = pa.concat_tables(unified_tables, promote_options="default")
    logger.info(f"Combined {len(tables)} files into table with {len(combined_table)} rows")
    return combined_table, combined_table.schema


# ---------------------------------------------------------------------------
# Unstructured file processing
# ---------------------------------------------------------------------------

def _is_text_file(config: Config, mime_type: str, extension: str) -> bool:
    if any(mime_type.startswith(prefix) for prefix in config.text_mime_prefixes):
        return True
    return extension in config.text_extensions


def _is_image_file(config: Config, mime_type: str, extension: str) -> bool:
    if mime_type.startswith(config.image_mime_prefix):
        return True
    return extension in config.image_extensions


def _is_document_file(config: Config, mime_type: str, extension: str) -> bool:
    if mime_type in config.document_mime_types:
        return True
    return extension in config.document_extensions


def _run_pii_analysis(
    config: Config,
    local_path: Path,
    mime_type: str,
    extension: str,
    heartbeat_fn: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    default_result: Dict[str, Any] = {
        "pii_entities": None,
        "pii_count": None,
        "sensitivity_class": "unknown",
        "has_pii": None,
        "pii_risk_level": "none",
    }
    if not config.enable_pii_analysis:
        return default_result
    try:
        from analyzers.pii import analyze_text
        from analyzers.image_pii import analyze_image
        from analyzers.sensitivity import classify_image
    except ImportError as exc:
        logger.warning("PII analyzer modules not importable: %s", exc)
        return default_result
    try:
        if _is_image_file(config, mime_type, extension):
            if heartbeat_fn:
                try:
                    heartbeat_fn(f"pii: analyze_image {local_path.name}")
                except Exception:
                    pass
            img_result = analyze_image(str(local_path))
            sens_result = classify_image(str(local_path))
            risk_level = img_result.risk_level
            has_pii = img_result.count > 0
            if sens_result.sensitivity_class == "sensitive":
                risk_level = "high"
                has_pii = True
            return {
                "pii_entities": img_result.to_json() if img_result.entities else None,
                "pii_count": img_result.count,
                "sensitivity_class": sens_result.sensitivity_class,
                "has_pii": has_pii,
                "pii_risk_level": risk_level,
            }
        elif _is_document_file(config, mime_type, extension) and not config.pii_analysis_image_only:
            if heartbeat_fn:
                try:
                    heartbeat_fn(f"pii: extract_document {local_path.name}")
                except Exception:
                    pass
            from analyzers.document_extractor import extract_document_text
            content = extract_document_text(str(local_path), extension)
            if content is None:
                # Password-protected, oversized, or unrecoverable parse error.
                return {
                    "pii_entities": None,
                    "pii_count": None,
                    "sensitivity_class": "not_applicable",
                    "has_pii": None,
                    "pii_risk_level": "none",
                }
            if heartbeat_fn:
                try:
                    heartbeat_fn(f"pii: analyze_text {local_path.name}")
                except Exception:
                    pass
            text_result = analyze_text(content)
            return {
                "pii_entities": text_result.to_json() if text_result.entities else None,
                "pii_count": text_result.count,
                "sensitivity_class": "not_applicable",
                "has_pii": text_result.count > 0,
                "pii_risk_level": text_result.risk_level,
            }
        elif _is_text_file(config, mime_type, extension) and not config.pii_analysis_image_only:
            if heartbeat_fn:
                try:
                    heartbeat_fn(f"pii: read_text {local_path.name}")
                except Exception:
                    pass
            content = local_path.read_text(errors="replace")
            if heartbeat_fn:
                try:
                    heartbeat_fn(f"pii: analyze_text {local_path.name}")
                except Exception:
                    pass
            text_result = analyze_text(content)
            return {
                "pii_entities": text_result.to_json() if text_result.entities else None,
                "pii_count": text_result.count,
                "sensitivity_class": "not_applicable",
                "has_pii": text_result.count > 0,
                "pii_risk_level": text_result.risk_level,
            }
        else:
            return {
                "pii_entities": None,
                "pii_count": None,
                "sensitivity_class": "not_applicable",
                "has_pii": None,
                "pii_risk_level": "none",
            }
    except Exception as exc:
        logger.warning("PII analysis failed for %s: %s", local_path.name, exc)
        return default_result


def _download_and_extract_metadata(
    config: Config, file_info: Dict[str, Any], temp_dir: Path,
    heartbeat_fn: Optional[Callable[[str], None]] = None,
) -> Optional[Tuple[Path, Dict[str, Any], str, str, str]]:
    vol = (file_info.get("local_path") or file_info.get("localPath") or "").strip()
    if vol:
        vp = Path(vol)
        if not vp.is_file():
            logger.warning("Volume path is not a file for metadata: %s", vol)
            return None
        try:
            mime_type = get_mime_type(vp)
            checksum = compute_checksum(vp, heartbeat_fn=heartbeat_fn)
            extension = vp.suffix.lower() or ""
            return (vp, file_info, mime_type, checksum, extension)
        except Exception as e:
            logger.warning("Failed to read volume file metadata for %s: %s", vol, e)
            return None

    key = file_info["key"]
    src = config.posix_path(key)
    try:
        mime_type = get_mime_type(src)
        checksum = compute_checksum(src, heartbeat_fn=heartbeat_fn)
        extension = src.suffix.lower() or ""
        return (src, file_info, mime_type, checksum, extension)
    except Exception as e:
        logger.warning(f"Failed to read metadata for {key} from mount: {e}")
        return None


def process_unstructured_data(
    config: Config, files: List[Dict[str, Any]], temp_dir: Path,
    tracker: Optional[ProgressTracker] = None,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
) -> Tuple[pa.Table, pa.Schema]:
    from concurrent.futures import ThreadPoolExecutor, as_completed

    metadata_records = []
    total_files = len(files)

    max_io_workers = min(os.cpu_count() or 2, total_files, 8)
    parallel_meta = max_io_workers > 1 and total_files > 1
    # activity.heartbeat uses contextvars; only call from this thread, not worker threads.
    hb_for_metadata = None if parallel_meta else heartbeat_callback
    downloaded = []
    if parallel_meta:
        with ThreadPoolExecutor(max_workers=max_io_workers) as pool:
            futures = {
                pool.submit(_download_and_extract_metadata, config, f, temp_dir, None): f
                for f in files
            }
            for future in as_completed(futures):
                result = future.result()
                if result is not None:
                    downloaded.append(result)
                if heartbeat_callback:
                    try:
                        heartbeat_callback(
                            f"metadata: downloaded {len(downloaded)}/{total_files}",
                        )
                    except Exception:
                        pass
    else:
        for file_info in files:
            result = _download_and_extract_metadata(
                config, file_info, temp_dir, heartbeat_fn=hb_for_metadata,
            )
            if result is not None:
                downloaded.append(result)

    for i, (local_path, file_info, mime_type, checksum, extension) in enumerate(downloaded):
        key = file_info["key"]
        vol_src = (file_info.get("local_path") or file_info.get("localPath") or "").strip()
        posix_source = bool(vol_src) or config.use_posix()
        file_name = Path(key).name
        if tracker:
            tracker.update(i, total_files, totalFiles=total_files, processedFiles=i, currentFile=file_name)
        try:
            pii_info = _run_pii_analysis(
                config, local_path, mime_type, extension, heartbeat_fn=heartbeat_callback,
            )
            lm = file_info.get("last_modified")
            lm_dt = _parse_iso_timestamp(lm) if lm is not None else None
            if vol_src:
                uri = f"file://{vol_src}"
            elif posix_source:
                uri = f"file://{local_path}"
            else:
                uri = f"s3://{config.bucket_name}/{key}"
            metadata_records.append({
                "file_path": uri,
                "file_name": file_name,
                "file_size": file_info["size"],
                "extension": extension,
                "mime_type": mime_type,
                "checksum": checksum,
                "created_time": lm_dt,
                "modified_time": lm_dt,
                "pii_entities": pii_info["pii_entities"],
                "pii_count": pii_info["pii_count"],
                "sensitivity_class": pii_info["sensitivity_class"],
                "has_pii": pii_info["has_pii"],
                "pii_risk_level": pii_info["pii_risk_level"],
            })
            if not posix_source:
                local_path.unlink()
        except Exception as e:
            logger.warning(f"Failed to process {key}: {e}")
            if not posix_source and local_path.exists():
                local_path.unlink()

    if tracker:
        tracker.update(total_files, total_files, force=True, totalFiles=total_files, processedFiles=total_files)
    if not metadata_records:
        raise ValueError("No files were successfully processed for metadata extraction")

    if heartbeat_callback:
        try:
            heartbeat_callback("unstructured: building_metadata_table")
        except Exception:
            pass
    schema = _unstructured_metadata_schema()
    columns = {col_name: [r[col_name] for r in metadata_records] for col_name in schema.names}
    table = pa.table(columns, schema=schema)
    logger.info(f"Created metadata table with {len(table)} rows")
    return table, schema


def _unstructured_metadata_schema() -> pa.Schema:
    """Canonical PyArrow schema for unstructured file metadata. Use when merging to avoid pa.null() inference."""
    return pa.schema([
        ("file_path", pa.string()),
        ("file_name", pa.string()),
        ("file_size", pa.int64()),
        ("extension", pa.string()),
        ("mime_type", pa.string()),
        ("checksum", pa.string()),
        ("created_time", pa.timestamp("us", tz="UTC")),
        ("modified_time", pa.timestamp("us", tz="UTC")),
        ("pii_entities", pa.string()),
        ("pii_count", pa.int64()),
        ("sensitivity_class", pa.string()),
        ("has_pii", pa.bool_()),
        ("pii_risk_level", pa.string()),
    ])


def _parse_iso_timestamp(s: Optional[str]) -> Optional[datetime]:
    """Parse ISO-format timestamp string (from JSON) to datetime for PyArrow."""
    if s is None or (isinstance(s, str) and not s.strip()):
        return None
    if isinstance(s, datetime):
        return s.replace(tzinfo=timezone.utc) if s.tzinfo is None else s
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _cast_unstructured_table_to_schema(table: pa.Table) -> pa.Table:
    """Cast a table (e.g. from from_pylist) to the canonical unstructured schema. Replaces pa.null() columns with concrete types.
    Handles JSON round-trip: partition metadata is serialized with default=str so timestamps become strings; we parse them back."""
    target = _unstructured_metadata_schema()
    columns = []
    for name in target.names:
        if name not in table.column_names:
            columns.append(pa.array([None] * len(table), type=target.field(name).type))
            continue
        col = table.column(name)
        target_type = target.field(name).type
        if col.type == pa.null():
            columns.append(pa.array([None] * len(table), type=target_type))
            continue
        if col.type == target_type:
            columns.append(col)
            continue
        try:
            # String columns from JSON: parse into target type so we don't lose values
            if pa.types.is_string(col.type) and pa.types.is_timestamp(target_type):
                py_vals = [_parse_iso_timestamp(col[i].as_py()) for i in range(len(col))]
                columns.append(pa.array(py_vals, type=target_type))
            elif pa.types.is_string(col.type) and pa.types.is_integer(target_type):
                py_vals = []
                for i in range(len(col)):
                    v = col[i].as_py()
                    if v is None or v == "":
                        py_vals.append(None)
                    else:
                        try:
                            py_vals.append(int(v))
                        except (ValueError, TypeError):
                            py_vals.append(None)
                columns.append(pa.array(py_vals, type=target_type))
            elif pa.types.is_string(col.type) and pa.types.is_boolean(target_type):
                py_vals = []
                for i in range(len(col)):
                    v = col[i].as_py()
                    if v is None or v == "":
                        py_vals.append(None)
                    else:
                        s = str(v).lower()
                        py_vals.append(s in ("true", "1", "yes"))
                columns.append(pa.array(py_vals, type=target_type))
            else:
                columns.append(pa.compute.cast(col, target_type))
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError, TypeError):
            columns.append(pa.array([None] * len(table), type=target_type))
    return pa.table(columns, schema=target)


# ---------------------------------------------------------------------------
# Iceberg / catalog helpers
# ---------------------------------------------------------------------------

def pyarrow_type_to_iceberg(pa_type) -> str:
    type_str = str(pa_type).lower()
    type_mapping = {
        "int8": "int", "int16": "int", "int32": "int", "int64": "long",
        "uint8": "int", "uint16": "int", "uint32": "long", "uint64": "long",
        "float16": "float", "float32": "float", "float": "float",
        "float64": "double", "double": "double",
        "bool": "boolean", "boolean": "boolean",
        "string": "string", "large_string": "string", "utf8": "string",
        "binary": "binary", "large_binary": "binary",
        "date32": "date", "date64": "date",
    }
    if type_str in type_mapping:
        return type_mapping[type_str]
    if type_str.startswith("timestamp"):
        return "timestamptz" if "tz=" in type_str else "timestamp"
    if type_str.startswith("time32") or type_str.startswith("time64"):
        return "time"
    if type_str.startswith("decimal"):
        import re
        match = re.search(r"decimal\d*\((\d+),\s*(\d+)\)", type_str)
        if match:
            return f"decimal({match.group(1)}, {match.group(2)})"
        return "string"
    return "string"


def build_iceberg_schema(pyarrow_schema: pa.Schema) -> Dict[str, Any]:
    fields = []
    for i, field in enumerate(pyarrow_schema):
        fields.append({
            "id": i + 1,
            "name": field.name,
            "type": pyarrow_type_to_iceberg(field.type),
            "required": not field.nullable,
        })
    return {"type": "struct", "schema-id": 0, "fields": fields}


def pyarrow_to_pyiceberg_type(pa_type):
    if not HAS_PYICEBERG:
        raise RuntimeError("PyIceberg not available")
    type_str = str(pa_type).lower()
    if "int64" in type_str or "uint64" in type_str:
        return LongType()
    elif "int" in type_str:
        return IntegerType()
    elif "float32" in type_str or type_str == "float":
        return FloatType()
    elif "double" in type_str or "float64" in type_str:
        return DoubleType()
    elif "bool" in type_str:
        return BooleanType()
    elif "timestamp" in type_str:
        if hasattr(pa_type, "tz") and pa_type.tz is not None:
            return TimestamptzType()
        return TimestampType()
    elif "date" in type_str:
        return DateType()
    elif "binary" in type_str:
        return BinaryType()
    return StringType()


def build_pyiceberg_schema(pyarrow_schema) -> "Schema":
    if not HAS_PYICEBERG:
        raise RuntimeError("PyIceberg not available")
    fields = []
    for i, field in enumerate(pyarrow_schema):
        iceberg_type = pyarrow_to_pyiceberg_type(field.type)
        fields.append(NestedField(field_id=i + 1, name=field.name, field_type=iceberg_type, required=not field.nullable))
    return Schema(*fields)


def _iceberg_type_to_pyarrow(iceberg_type) -> pa.DataType:
    """Map PyIceberg field type to PyArrow type for casting."""
    if isinstance(iceberg_type, StringType):
        return pa.string()
    if isinstance(iceberg_type, LongType):
        return pa.int64()
    if isinstance(iceberg_type, IntegerType):
        return pa.int32()
    if isinstance(iceberg_type, BooleanType):
        return pa.bool_()
    if isinstance(iceberg_type, TimestamptzType):
        return pa.timestamp("us", tz="UTC")
    if isinstance(iceberg_type, TimestampType):
        return pa.timestamp("us")  # timestamp without tz to match Iceberg TimestampType
    if isinstance(iceberg_type, DateType):
        return pa.date32()
    if isinstance(iceberg_type, FloatType):
        return pa.float32()
    if isinstance(iceberg_type, DoubleType):
        return pa.float64()
    if isinstance(iceberg_type, BinaryType):
        return pa.binary()
    return pa.string()


def _cast_parquet_table_to_iceberg_schema(parquet_table: pa.Table, table) -> pa.Table:
    """Cast parquet table columns to match the existing Iceberg table schema so append() succeeds."""
    columns = []
    target_schema_fields = []
    for i, field in enumerate(table.schema().fields):
        name = field.name
        iceberg_type = field.field_type
        target_pa_type = _iceberg_type_to_pyarrow(iceberg_type)
        target_schema_fields.append(pa.field(name, target_pa_type, nullable=True))
        if name not in parquet_table.column_names:
            columns.append(pa.array([None] * parquet_table.num_rows, type=target_pa_type))
            continue
        col = parquet_table.column(name)
        if col.type == target_pa_type:
            columns.append(col)
            continue
        try:
            if pa.types.is_timestamp(col.type) and target_pa_type == pa.string():
                # PyArrow cast(timestamp, string) may not be available; convert via Python
                py_vals = [x.as_py().isoformat() if x.is_valid else None for x in col]
                columns.append(pa.array(py_vals, type=pa.string()))
            elif pa.types.is_timestamp(col.type) and pa.types.is_timestamp(target_pa_type):
                # Table may have timestamp (no tz) while parquet has timestamptz; cast to match
                columns.append(pa.compute.cast(col, target_pa_type))
            elif pa.types.is_boolean(col.type) and target_pa_type == pa.string():
                py_vals = [str(x.as_py()) if x.is_valid else None for x in col]
                columns.append(pa.array(py_vals, type=pa.string()))
            elif pa.types.is_integer(col.type) and target_pa_type == pa.string():
                py_vals = [str(x.as_py()) if x.is_valid else None for x in col]
                columns.append(pa.array(py_vals, type=pa.string()))
            else:
                columns.append(pa.compute.cast(col, target_pa_type))
        except (pa.ArrowInvalid, pa.ArrowNotImplementedError, TypeError):
            py_vals = [str(col[i].as_py()) if col[i].is_valid else None for i in range(len(col))]
            columns.append(pa.array(py_vals, type=target_pa_type))
    return pa.table(columns, schema=pa.schema(target_schema_fields))


def _configure_table_io_for_static_credentials(table, config: Config) -> None:
    s3_endpoint = config.s3_endpoint or "http://s3gateway:7070"
    table_io = table.io
    io_props = None
    if hasattr(table_io, "properties") and isinstance(table_io.properties, dict):
        io_props = table_io.properties
    elif hasattr(table_io, "_properties") and isinstance(table_io._properties, dict):
        io_props = table_io._properties
    if io_props is not None:
        io_props["s3.access-key-id"] = config.aws_access_key_id
        io_props["s3.secret-access-key"] = config.aws_secret_access_key
        io_props["s3.endpoint"] = s3_endpoint
        io_props["s3.region"] = config.aws_region
        io_props["s3.path-style-access"] = "true"
        io_props["s3.remote-signing-enabled"] = "false"
        io_props.pop("s3.signer", None)
        io_props.pop("s3.signer.uri", None)
        io_props.pop("s3.signer.endpoint", None)


def register_table_with_pyiceberg(
    config: Config,
    pyarrow_schema,
    parquet_file_path: Optional[str],
    replace_existing: bool = False,
) -> str:
    """Create the dataset's Iceberg table (if absent) and write the parquet rows.

    ``replace_existing`` controls what happens when the table already exists:
    - False (default): append the rows (incremental — used by acquired datasets).
    - True: overwrite (delete all existing rows, then write these) — used by manual
      uploads, whose committed manifest is the *complete* file set, so a re-import
      must fully replace the table contents rather than pile new rows on top of the
      old ones (which would leave removed files behind and duplicate kept files).

    A freshly created table has nothing to replace, so it is always written with
    append regardless of ``replace_existing``.
    """
    if not HAS_PYICEBERG:
        raise RuntimeError("PyIceberg not available")

    catalog_uri = f"{config.lakekeeper_url}/catalog"
    warehouse_name = config.effective_warehouse_id()
    s3_endpoint = config.s3_endpoint or "http://s3gateway:7070"

    os.environ.pop("AWS_SESSION_TOKEN", None)
    token = config.get_access_token()

    catalog_config = {
        "header.X-Iceberg-Access-Delegation": "none",
        "s3.endpoint": s3_endpoint,
        "s3.access-key-id": config.aws_access_key_id,
        "s3.secret-access-key": config.aws_secret_access_key,
        "s3.region": config.aws_region,
        "s3.path-style-access": "true",
        "s3.remote-signing-enabled": "false",
    }
    catalog = RestCatalog(name="lakekeeper", uri=catalog_uri, warehouse=warehouse_name, token=token, **catalog_config)

    iceberg_schema = build_pyiceberg_schema(pyarrow_schema)
    table_identifier = (config.namespace, config.dataset_name)
    table = None
    table_existed = False
    try:
        table = catalog.load_table(table_identifier)
        table_existed = True
        mode = "replace" if replace_existing else "append"
        logger.info(f"Table {config.namespace}.{config.dataset_name} already exists, will {mode}")
    except Exception:
        logger.info("Table does not exist, will create")

    def _table_storage_location() -> str:
        if config.s3_path_prefix:
            return f"s3://{config.bucket_name}/{config.s3_path_prefix}/datasets/{config.dataset_id}/parquet"
        return f"s3://{config.bucket_name}/datasets/{config.dataset_id}/parquet"

    def _create_table():
        try:
            catalog.create_namespace(config.namespace)
        except Exception as e:
            if "already exists" not in str(e).lower():
                logger.warning(f"Error creating namespace: {e}")
        return catalog.create_table(
            identifier=table_identifier,
            schema=iceberg_schema,
            location=_table_storage_location(),
            properties={"agentstudio.dataset.id": config.dataset_id, "agentstudio.dataset.kind": config.dataset_kind},
        )

    if table is None:
        table = _create_table()

    _configure_table_io_for_static_credentials(table, config)

    if parquet_file_path:
        parquet_table = pq.read_table(parquet_file_path)
        existing_field_names = {f.name for f in table.schema().fields}
        missing = set(parquet_table.column_names) - existing_field_names
        if missing:
            with table.update_schema() as schema_update:
                for col_name in sorted(missing):
                    pa_field = parquet_table.schema.field(col_name)
                    schema_update.add_column(col_name, pyarrow_to_pyiceberg_type(pa_field.type))
            table.refresh()
            _configure_table_io_for_static_credentials(table, config)
        # Cast parquet to match existing table schema so append()/overwrite() does not
        # raise schema mismatch (e.g. table may have string for
        # created_time/modified_time/pii_count/has_pii from an older schema)
        parquet_table = _cast_parquet_table_to_iceberg_schema(parquet_table, table)
        try:
            if replace_existing and table_existed:
                # Manual re-import: the manifest is the full desired file set, so wipe
                # the old rows and write these. Without this, removed files would linger
                # and kept files would be duplicated on every save.
                logger.info(
                    f"Replacing all rows in {config.namespace}.{config.dataset_name} (manual re-import)"
                )
                table.overwrite(parquet_table)
            else:
                table.append(parquet_table)
        except FileNotFoundError as write_err:
            if not table_existed:
                raise
            logger.warning(
                f"Broken Iceberg metadata for {config.namespace}.{config.dataset_name}, "
                f"recreating table: {write_err}"
            )
            catalog.drop_table(table_identifier)
            table = _create_table()
            _configure_table_io_for_static_credentials(table, config)
            parquet_table = _cast_parquet_table_to_iceberg_schema(
                pq.read_table(parquet_file_path), table
            )
            table.append(parquet_table)

    return f"{config.namespace}.{config.dataset_name}"


# ---------------------------------------------------------------------------
# Config-service API helpers
# ---------------------------------------------------------------------------

def get_dataset(config: Config) -> Optional[Dict[str, Any]]:
    """Fetch the dataset record from config-service. Returns None on any failure."""
    import requests
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/datasets/{config.dataset_id}"
    try:
        token = config.get_access_token()
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        logger.warning(f"Failed to fetch dataset {config.dataset_id}: {e}")
        return None


def is_manual_dataset(config: Config) -> bool:
    """True when the dataset was created by manual upload (``type == 'manual'``).

    Manual datasets carry the *complete* file set in every committed manifest, so
    an import must REPLACE the table contents; acquired datasets append
    incrementally. Workflow input sets ``config.dataset_type`` so merge does not
    depend on a live config-service GET. On any lookup failure we default to
    False (append) so historical behavior is preserved when type is unknown.
    """
    dataset_type = (config.dataset_type or "").strip().lower()
    if dataset_type:
        return dataset_type == "manual"
    dataset = get_dataset(config)
    if not dataset:
        return False
    return str(dataset.get("type", "")).lower() == "manual"


def update_dataset_status(config: Config, status: str, error_message: Optional[str] = None) -> None:
    import requests
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/datasets/{config.dataset_id}/status"
    payload: Dict[str, Any] = {"status": status}
    if error_message:
        payload["errorMessage"] = error_message
    token = config.get_access_token()
    response = requests.put(url, json=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=30)
    response.raise_for_status()
    logger.info(f"Updated dataset status to: {status}")


def update_dataset_catalog_ref(config: Config, catalog_table_ref: str) -> None:
    import requests
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/datasets/{config.dataset_id}"
    parts = catalog_table_ref.split(".", 1)
    namespace = parts[0] if len(parts) == 2 else "default"
    table_name = parts[1] if len(parts) == 2 else catalog_table_ref
    payload = {"catalogTableRef": catalog_table_ref, "namespace": namespace, "catalogTableName": table_name}
    token = config.get_access_token()
    try:
        response = requests.put(url, json=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=30)
        response.raise_for_status()
    except Exception as e:
        logger.warning(f"Failed to update catalog reference: {e}")


def update_dataset_pii_summary(config: Config, pii_summary: Dict[str, Any]) -> None:
    import requests
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/datasets/{config.dataset_id}"
    payload = {"piiSummary": pii_summary}
    token = config.get_access_token()
    try:
        response = requests.put(url, json=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=30)
        response.raise_for_status()
    except Exception as e:
        logger.warning(f"Failed to update PII summary: {e}")


def update_facet(config: Config, facet_type: str, state: str, summary: Optional[Dict[str, Any]] = None,
                 error_message: Optional[str] = None, job_id: Optional[str] = None) -> None:
    import requests
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/datasets/{config.dataset_id}/facets/{facet_type}"
    payload: Dict[str, Any] = {"state": state}
    if summary:
        payload["summary"] = summary
    if error_message:
        payload["errorMessage"] = error_message
    if job_id:
        payload["jobId"] = job_id
    token = config.get_access_token()
    try:
        response = requests.put(url, json=payload, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=30)
        response.raise_for_status()
    except Exception as e:
        logger.warning(f"Failed to update facet '{facet_type}': {e}")


def write_processing_result(config: Config, result: Dict[str, Any]) -> None:
    result_json = json.dumps(result, indent=2)
    _write_bytes(config, config.result_key(), result_json.encode("utf-8"))


def write_pii_details(config: Config, table: pa.Table) -> None:
    from analyzers.pii import get_risk_level

    files_list = []
    total_files = len(table)
    has_risk_col = "pii_risk_level" in table.column_names
    files_with_pii = 0
    files_high = files_medium = files_low = 0

    for i in range(total_files):
        row_file_name = table.column("file_name")[i].as_py() if table.column("file_name")[i].is_valid else ""
        row_file_path = table.column("file_path")[i].as_py() if table.column("file_path")[i].is_valid else ""
        row_file_size = table.column("file_size")[i].as_py() if table.column("file_size")[i].is_valid else 0
        row_mime_type = table.column("mime_type")[i].as_py() if table.column("mime_type")[i].is_valid else ""

        raw_entities = table.column("pii_entities")[i].as_py() if table.column("pii_entities")[i].is_valid else None
        pii_entities = None
        if raw_entities:
            try:
                pii_entities = json.loads(raw_entities) if isinstance(raw_entities, str) else raw_entities
            except (json.JSONDecodeError, TypeError):
                pii_entities = None

        pii_count_val = table.column("pii_count")[i].as_py() if table.column("pii_count")[i].is_valid else 0
        has_pii_val = table.column("has_pii")[i].as_py() if table.column("has_pii")[i].is_valid else False

        if has_pii_val:
            files_with_pii += 1
        risk_level_val = "none"
        if has_risk_col:
            risk_level_val = table.column("pii_risk_level")[i].as_py() if table.column("pii_risk_level")[i].is_valid else "none"
        elif pii_count_val and pii_count_val > 0:
            risk_level_val = get_risk_level(pii_count_val)
        if risk_level_val == "high":
            files_high += 1
        elif risk_level_val == "medium":
            files_medium += 1
        elif risk_level_val == "low":
            files_low += 1

        sensitivity_class = ""
        if "sensitivity_class" in table.column_names:
            sc = table.column("sensitivity_class")[i]
            sensitivity_class = sc.as_py() if sc.is_valid else ""

        entities_list = pii_entities if isinstance(pii_entities, list) else (list(pii_entities) if pii_entities else [])
        high_c = 1 if risk_level_val == "high" else 0
        med_c = 1 if risk_level_val == "medium" else 0
        low_c = 1 if risk_level_val == "low" else 0
        files_list.append({
            "fileName": row_file_name, "filePath": row_file_path, "fileSize": row_file_size,
            "mimeType": row_mime_type, "hasPii": has_pii_val, "piiCount": pii_count_val or 0,
            "riskLevel": risk_level_val, "entities": entities_list,
            "piiEntities": entities_list, "piiRiskLevel": risk_level_val,
            "sensitivityClass": sensitivity_class,
            "highRiskCount": high_c, "mediumRiskCount": med_c, "lowRiskCount": low_c,
        })

    analysis_ts = datetime.now(timezone.utc).isoformat()
    summary = {
        "totalFiles": total_files, "filesWithPii": files_with_pii,
        "filesWithHighRisk": files_high, "filesWithMediumRisk": files_medium,
        "filesWithLowRisk": files_low, "piiAnalysisEnabled": True,
    }
    pii_details = {
        "datasetId": config.dataset_id,
        "analysisTimestamp": analysis_ts,
        "summary": summary,
        "files": files_list,
        "generatedAt": analysis_ts,
    }
    if config.s3_path_prefix:
        key = f"{config.s3_path_prefix}/datasets/{config.dataset_id}/pii_details.json"
    else:
        key = f"datasets/{config.dataset_id}/pii_details.json"
    _upload_json(config, key, pii_details)


# ---------------------------------------------------------------------------
# Column stats
# ---------------------------------------------------------------------------

def compute_column_stats(table: pa.Table, max_columns: int = 50) -> Dict[str, Any]:
    import pyarrow.compute as pc

    def _classify(field: pa.Field) -> str:
        t = field.type
        if pa.types.is_boolean(t):
            return "boolean"
        if pa.types.is_integer(t):
            return "integer"
        if pa.types.is_floating(t) or pa.types.is_decimal(t):
            return "float"
        if pa.types.is_timestamp(t) or pa.types.is_date(t) or pa.types.is_time(t):
            return "temporal"
        return "string"

    def _safe_scalar(val):
        if val is None or not val.is_valid:
            return None
        py = val.as_py()
        if hasattr(py, "isoformat"):
            return py.isoformat()
        return py

    total_rows = table.num_rows
    columns_stats: Dict[str, Any] = {}
    fields = list(table.schema)[: max_columns]

    for field in fields:
        col_name = field.name
        try:
            col = table.column(col_name)
            category = _classify(field)
            null_count = col.null_count
            valid_count = total_rows - null_count
            null_pct = round((null_count / total_rows) * 100, 2) if total_rows > 0 else 0.0

            stat: Dict[str, Any] = {
                "type": str(field.type), "category": category,
                "count": valid_count, "nullCount": null_count, "nullPercentage": null_pct,
            }

            if category == "boolean" and valid_count > 0:
                true_count = pc.sum(pc.cast(col, pa.int64())).as_py() or 0
                stat["trueCount"] = true_count
                stat["truePercentage"] = round((true_count / valid_count) * 100, 1)
            elif category in ("integer", "float") and valid_count > 0:
                stat["min"] = str(_safe_scalar(pc.min(col)))
                stat["max"] = str(_safe_scalar(pc.max(col)))
                avg_val = _safe_scalar(pc.mean(col))
                if avg_val is not None:
                    stat["avg"] = str(round(float(avg_val), 4))
                try:
                    median_val = _safe_scalar(pc.approximate_median(col))
                    if median_val is not None:
                        stat["median"] = str(median_val)
                except Exception:
                    pass
                stat["approxUnique"] = pc.count_distinct(col).as_py()
                if category == "integer":
                    try:
                        import numpy as np
                        min_v = float(pc.min(col).as_py())
                        max_v = float(pc.max(col).as_py())
                        if max_v > min_v:
                            valid_arr = pc.drop_null(col).to_pylist()
                            counts, edges = np.histogram(valid_arr, bins=10, range=(min_v, max_v))
                            stat["histogram"] = [
                                {"label": f"{edges[i]:.6g}\u2013{edges[i+1]:.6g}", "count": int(c)}
                                for i, c in enumerate(counts)
                            ]
                    except Exception:
                        pass
            elif category == "temporal" and valid_count > 0:
                stat["min"] = str(_safe_scalar(pc.min(col)))
                stat["max"] = str(_safe_scalar(pc.max(col)))
                stat["approxUnique"] = pc.count_distinct(col).as_py()
            else:
                n_unique = pc.count_distinct(col).as_py()
                stat["approxUnique"] = n_unique
                if n_unique <= 20:
                    stat["category"] = "categorical"
                    try:
                        vc = pc.value_counts(col)
                        buckets = []
                        for item in vc:
                            v = item["values"]
                            c = item["counts"]
                            label = str(v.as_py()) if v.is_valid else "(null)"
                            buckets.append({"label": label, "count": c.as_py()})
                        buckets.sort(key=lambda b: b["count"], reverse=True)
                        stat["histogram"] = buckets[:20]
                    except Exception:
                        pass
                elif valid_count > 0:
                    try:
                        lengths = pc.utf8_length(pc.cast(col, pa.string()))
                        avg_len = _safe_scalar(pc.mean(lengths))
                        if avg_len is not None:
                            stat["avgLength"] = round(float(avg_len), 1)
                    except Exception:
                        pass

            columns_stats[col_name] = stat
        except Exception as exc:
            logger.warning(f"Failed to compute stats for column '{col_name}': {exc}")
            columns_stats[col_name] = {"type": str(field.type), "category": _classify(field), "count": 0, "nullCount": 0, "nullPercentage": 0.0}

    return {"columns": columns_stats}


# ---------------------------------------------------------------------------
# File stats (unstructured datasets)
# ---------------------------------------------------------------------------

_SIZE_BUCKETS: List[Tuple[str, int, int]] = [
    ("< 1 KB", 0, 1024),
    ("1-100 KB", 1024, 102400),
    ("100 KB-1 MB", 102400, 1048576),
    ("1-10 MB", 1048576, 10485760),
    ("10-100 MB", 10485760, 104857600),
    ("100 MB-1 GB", 104857600, 1073741824),
    ("> 1 GB", 1073741824, -1),
]

_AGE_BUCKETS: List[Tuple[str, int]] = [
    ("< 30 days", 30),
    ("30-90 days", 90),
    ("90 days-1 year", 365),
    ("1-2 years", 730),
    ("> 2 years", -1),
]


def compute_file_stats(table: pa.Table) -> Dict[str, Any]:
    """Compute aggregate file distributions for unstructured datasets.

    Expects columns: ``extension`` (string), ``file_size`` (int),
    ``modified_time`` (timestamp/string).  Missing columns are silently
    skipped, producing empty distributions.
    """
    import pyarrow.compute as pc

    result: Dict[str, Any] = {
        "extensionDistribution": [],
        "sizeDistribution": [],
        "ageDistribution": [],
        "totalFiles": table.num_rows,
        "totalSizeBytes": 0,
        "avgFileSizeBytes": 0,
    }

    # --- Extension distribution ---
    if "extension" in table.column_names:
        try:
            vc = pc.value_counts(table.column("extension"))
            items = []
            for item in vc:
                label = item["values"].as_py() if item["values"].is_valid else "(none)"
                items.append({"label": str(label), "count": item["counts"].as_py()})
            items.sort(key=lambda b: b["count"], reverse=True)
            if len(items) > 9:
                top = items[:9]
                other_count = sum(b["count"] for b in items[9:])
                top.append({"label": "Other", "count": other_count})
                items = top
            result["extensionDistribution"] = items
        except Exception as exc:
            logger.warning(f"compute_file_stats: extension distribution failed: {exc}")

    # --- Size distribution ---
    if "file_size" in table.column_names:
        try:
            sizes = table.column("file_size")
            total_bytes = pc.sum(sizes).as_py() or 0
            result["totalSizeBytes"] = total_bytes
            valid_count = table.num_rows - sizes.null_count
            result["avgFileSizeBytes"] = total_bytes // valid_count if valid_count > 0 else 0
            try:
                result["medianFileSizeBytes"] = int(pc.approximate_median(sizes).as_py() or 0)
            except Exception:
                pass

            size_list = pc.drop_null(sizes).to_pylist()
            buckets = []
            for label, lo, hi in _SIZE_BUCKETS:
                if hi == -1:
                    cnt = sum(1 for s in size_list if s >= lo)
                else:
                    cnt = sum(1 for s in size_list if lo <= s < hi)
                buckets.append({"label": label, "count": cnt})
            result["sizeDistribution"] = buckets
        except Exception as exc:
            logger.warning(f"compute_file_stats: size distribution failed: {exc}")

    # --- Age distribution ---
    if "modified_time" in table.column_names:
        try:
            col = table.column("modified_time")
            now = datetime.now(timezone.utc)

            timestamps = []
            for val in col.to_pylist():
                if val is None:
                    continue
                if isinstance(val, str):
                    try:
                        ts = datetime.fromisoformat(val.replace("Z", "+00:00"))
                    except Exception:
                        continue
                elif hasattr(val, "timestamp"):
                    ts = val if val.tzinfo else val.replace(tzinfo=timezone.utc)
                else:
                    continue
                timestamps.append(ts)

            if timestamps:
                result["oldestFile"] = min(timestamps).isoformat()
                result["newestFile"] = max(timestamps).isoformat()

            age_days_list = [(now - ts).days for ts in timestamps]
            buckets = []
            for label, max_days in _AGE_BUCKETS:
                if max_days == -1:
                    cnt = sum(1 for d in age_days_list if d >= _AGE_BUCKETS[-2][1])
                else:
                    prev_max = 0
                    idx = [b[1] for b in _AGE_BUCKETS].index(max_days)
                    if idx > 0:
                        prev_max = _AGE_BUCKETS[idx - 1][1]
                    cnt = sum(1 for d in age_days_list if prev_max <= d < max_days)
                buckets.append({"label": label, "count": cnt})
            result["ageDistribution"] = buckets
        except Exception as exc:
            logger.warning(f"compute_file_stats: age distribution failed: {exc}")

    return result


def merge_column_stats(partition_stats_list: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not partition_stats_list:
        return {"columns": {}}

    all_col_names = set()
    for ps in partition_stats_list:
        all_col_names.update(ps.get("columns", {}).keys())

    merged_columns: Dict[str, Any] = {}
    for col_name in all_col_names:
        per_partition = [ps.get("columns", {}).get(col_name) for ps in partition_stats_list if ps.get("columns", {}).get(col_name)]
        if not per_partition:
            continue
        first = per_partition[0]
        category = first.get("category", "string")
        total_count = sum(s.get("rowCount", s.get("count", 0)) for s in per_partition)
        total_null = sum(s.get("nullCount", 0) for s in per_partition)
        total_rows = total_count + total_null

        merged: Dict[str, Any] = {
            "type": first.get("type", "unknown"), "category": category,
            "count": total_count, "nullCount": total_null,
            "nullPercentage": round((total_null / total_rows) * 100, 2) if total_rows > 0 else 0.0,
        }

        if category == "boolean":
            total_true = sum(s.get("trueCount", 0) for s in per_partition)
            merged["trueCount"] = total_true
            merged["truePercentage"] = round((total_true / total_count) * 100, 1) if total_count > 0 else 0
        elif category in ("integer", "float"):
            mins = [float(s["min"]) for s in per_partition if s.get("min") is not None]
            maxs = [float(s["max"]) for s in per_partition if s.get("max") is not None]
            if mins:
                merged["min"] = str(min(mins))
            if maxs:
                merged["max"] = str(max(maxs))
            weighted_avg_sum = 0.0
            avg_count = 0
            for s in per_partition:
                if s.get("avg") is not None:
                    cnt = s.get("rowCount", s.get("count", 0))
                    weighted_avg_sum += float(s["avg"]) * cnt
                    avg_count += cnt
            if avg_count > 0:
                merged["avg"] = str(round(weighted_avg_sum / avg_count, 4))
            medians = [(float(s["median"]), s.get("rowCount", s.get("count", 0))) for s in per_partition if s.get("median") is not None]
            if medians:
                medians.sort(key=lambda x: x[0])
                total_w = sum(w for _, w in medians)
                cumulative = 0
                approx_median = medians[-1][0]
                for val, w in medians:
                    cumulative += w
                    if cumulative >= total_w / 2:
                        approx_median = val
                        break
                merged["median"] = str(approx_median)
        elif category == "temporal":
            mins = [s["min"] for s in per_partition if s.get("min") is not None]
            maxs = [s["max"] for s in per_partition if s.get("max") is not None]
            if mins:
                merged["min"] = str(min(mins))
            if maxs:
                merged["max"] = str(max(maxs))
        elif category == "categorical":
            value_counts: Dict[str, int] = {}
            for s in per_partition:
                for bucket in s.get("histogram", []):
                    label = bucket.get("label", "")
                    value_counts[label] = value_counts.get(label, 0) + bucket.get("count", 0)
            if len(value_counts) <= 20:
                merged["category"] = "categorical"
                buckets = [{"label": k, "count": v} for k, v in value_counts.items()]
                buckets.sort(key=lambda b: b["count"], reverse=True)
                merged["histogram"] = buckets[:20]
            else:
                merged["category"] = "string"
                merged["approxUnique"] = len(value_counts)
        else:
            weighted_len_sum = 0.0
            len_count = 0
            for s in per_partition:
                if s.get("avgLength") is not None:
                    cnt = s.get("rowCount", s.get("count", 0))
                    weighted_len_sum += float(s["avgLength"]) * cnt
                    len_count += cnt
            if len_count > 0:
                merged["avgLength"] = round(weighted_len_sum / len_count, 1)

        merged_columns[col_name] = merged
    return {"columns": merged_columns}


# ---------------------------------------------------------------------------
# PII summarization helper (used by merge_results)
# ---------------------------------------------------------------------------

def _compute_pii_summary(table: pa.Table) -> Optional[Dict[str, Any]]:
    """Compute PII summary from a table that has PII columns."""
    if "has_pii" not in table.column_names:
        return None
    try:
        has_pii_col = table.column("has_pii")
        files_with_pii = sum(1 for v in has_pii_col if v.is_valid and v.as_py())
        total_files = len(table)
        files_high = files_medium = files_low = 0
        if "pii_risk_level" in table.column_names:
            risk_col = table.column("pii_risk_level")
            for v in risk_col:
                if v.is_valid:
                    rv = v.as_py()
                    if rv == "high":
                        files_high += 1
                    elif rv == "medium":
                        files_medium += 1
                    elif rv == "low":
                        files_low += 1
        return {
            "filesWithPii": files_with_pii, "totalFiles": total_files,
            "piiAnalysisEnabled": True,
            "filesWithHighRisk": files_high, "filesWithMediumRisk": files_medium, "filesWithLowRisk": files_low,
        }
    except Exception as exc:
        logger.warning(f"Failed to compute PII summary: {exc}")
        return None


# ===========================================================================
# MAIN ACTIVITY FUNCTIONS
# ===========================================================================

def process_file_set(
    config: Config,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
    workflow_progress_callback: WorkflowProgressCallback = None,
) -> dict:
    """Process a set of files from a manifest.

    Extracted from _run_partition_worker(). Accepts Config, returns result dict.
    If heartbeat_callback is set (e.g. Temporal activity.heartbeat), it is called
    periodically during long-running phases to avoid heartbeat timeouts.
    If workflow_progress_callback is set, it is called with (phase, phase_pct, current, total, extra)
    so the workflow-engine progress store can be updated for the UI.
    """
    tracker = ProgressTracker(
        config, write_interval_seconds=5,
        progress_key_override=f"{config.output_prefix}/progress.json",
        heartbeat_callback=heartbeat_callback,
        workflow_progress_callback=workflow_progress_callback,
    )

    manifest = _read_json(config, config.manifest_s3_key)
    raw_files = manifest["files"]
    # Support manifest format: list of {"key", "size", "lastModified"} or legacy list of key strings
    files = []
    for entry in raw_files:
        if isinstance(entry, dict):
            key_val = entry.get("key") or entry.get("Key") or ""
            lp = (entry.get("local_path") or entry.get("localPath") or "")
            if isinstance(lp, str):
                lp = lp.strip()
            else:
                lp = ""
            row = {
                "key": str(key_val).strip() or (lp or "unknown"),
                "size": int(entry.get("size", 0)) if entry.get("size") is not None else 0,
                "last_modified": entry.get("lastModified"),
                "etag": (entry.get("etag") or "").strip().strip('"'),
            }
            if lp:
                row["local_path"] = lp
            files.append(row)
        else:
            files.append({"key": str(entry).strip() or "unknown", "size": 0, "last_modified": None, "etag": ""})

    temp_dir = Path(f"/tmp/fileset-{config.set_id}")
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Background heartbeat thread keeps the activity alive during phases that
    # don't call tracker.update() (Parquet writes, large file processing, etc.).
    bg_hb = _BackgroundHeartbeat(heartbeat_callback) if heartbeat_callback else None

    try:
        if bg_hb:
            bg_hb.__enter__()

        tracker.begin_phase("processing")
        if bg_hb:
            bg_hb.set_phase("processing")
        if config.dataset_kind == "structured":
            table, schema = process_structured_data(
                config, files, temp_dir, tracker=tracker, heartbeat_callback=heartbeat_callback
            )
            tracker.end_phase("processing")

            tracker.begin_phase("writing_parquet")
            if bg_hb:
                bg_hb.set_phase("writing_parquet")
            local_path = temp_dir / "data.parquet"
            if heartbeat_callback:
                try:
                    heartbeat_callback("writing_parquet: before write_table")
                except Exception:
                    pass
            pq.write_table(table, local_path)
            if heartbeat_callback:
                try:
                    heartbeat_callback("writing_parquet: after write_table")
                except Exception:
                    pass
            _upload_file(config, local_path, f"{config.output_prefix}/data.parquet")

            schema_info = [{"name": f.name, "type": str(f.type)} for f in schema]
            _upload_json(config, f"{config.output_prefix}/schema.json", {"fields": schema_info})

            col_stats = compute_column_stats(table)
            for col_name, stats in col_stats.get("columns", {}).items():
                col = table.column(col_name)
                stats["rowCount"] = table.num_rows - col.null_count
            _upload_json(config, f"{config.output_prefix}/column_stats.json", col_stats)
            tracker.end_phase("writing_parquet")
        else:
            table, schema = process_unstructured_data(
                config, files, temp_dir, tracker=tracker, heartbeat_callback=heartbeat_callback
            )
            tracker.end_phase("processing")

            tracker.begin_phase("writing_parquet")
            if bg_hb:
                bg_hb.set_phase("writing_parquet")
            if heartbeat_callback:
                try:
                    heartbeat_callback("writing_parquet: before to_pydict")
                except Exception:
                    pass
            d = table.to_pydict()
            if heartbeat_callback:
                try:
                    heartbeat_callback("writing_parquet: after to_pydict")
                except Exception:
                    pass
            if d:
                n = len(next(iter(d.values())))
                metadata = [dict(zip(d.keys(), [d[k][i] for k in d])) for i in range(n)]
            else:
                metadata = []
            _upload_json(config, f"{config.output_prefix}/metadata.json", metadata)
            tracker.end_phase("writing_parquet")

        result = {
            "setId": config.set_id,
            "status": "success",
            "outputPath": config.output_prefix,
            "rowCount": table.num_rows if hasattr(table, "num_rows") else len(table),
            "fileCount": len(files),
        }
        _upload_json(config, f"{config.output_prefix}/partition_result.json", result)
        tracker.finish()
        logger.info(f"File set {config.set_id} completed successfully")
        return result

    except Exception as e:
        logger.error(f"File set {config.set_id} failed: {e}", exc_info=True)
        error_result = {"setId": config.set_id, "status": "error", "error": str(e)}
        try:
            _upload_json(config, f"{config.output_prefix}/partition_result.json", error_result)
        except Exception:
            pass
        tracker.fail(str(e))
        raise
    finally:
        if bg_hb:
            bg_hb.__exit__(None, None, None)
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def merge_results(
    config: Config,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
    workflow_progress_callback: WorkflowProgressCallback = None,
) -> dict:
    """Merge partition results into final dataset.

    Extracted from _run_partition_aggregate(). Augmented with PII summarization
    from the monolithic main() path (lines 2583-2621 of legacy processor.py).
    Accepts Config, returns result dict.
    If heartbeat_callback is set (e.g. Temporal activity.heartbeat), it is called
    periodically during long-running phases to avoid heartbeat timeouts.
    If workflow_progress_callback is set, it is called for UI progress updates.
    """
    output_prefix = f"{config.job_output_prefix}/aggregation"
    tracker = ProgressTracker(
        config, write_interval_seconds=5,
        progress_key_override=f"{output_prefix}/progress.json",
        heartbeat_callback=heartbeat_callback,
        workflow_progress_callback=workflow_progress_callback,
    )

    temp_dir = Path("/tmp/aggregation")
    temp_dir.mkdir(parents=True, exist_ok=True)

    bg_hb = _BackgroundHeartbeat(heartbeat_callback) if heartbeat_callback else None

    try:
        if bg_hb:
            bg_hb.__enter__()

        tracker.begin_phase("processing")
        if bg_hb:
            bg_hb.set_phase("merging")
        partitions = _list_partition_outputs(config, config.job_output_prefix)
        logger.info(f"Found {len(partitions)} partition outputs")

        if not partitions:
            raise ValueError("No partition outputs found; nothing to merge")

        # Manual datasets send the complete file set on every commit, so a re-import
        # must replace the table's rows instead of appending. Resolve once here and
        # pass it to the first (table-creating) write; later partitions append onto
        # the just-replaced table, yielding exactly the new file set.
        replace_existing = is_manual_dataset(config)

        if config.dataset_kind == "structured":
            if not HAS_PYICEBERG:
                raise RuntimeError("PyIceberg is required for structured data aggregation")

            row_count = 0
            schema = None
            catalog_table_ref = ""

            for i, p_prefix in enumerate(partitions):
                tracker.update(i, len(partitions), totalFiles=len(partitions), processedFiles=i)
                local_path = temp_dir / f"partition_{i}.parquet"
                download_file(config, f"{p_prefix}/data.parquet", local_path)
                table = pq.read_table(local_path)
                row_count += table.num_rows

                if i == 0:
                    schema = table.schema
                    catalog_table_ref = register_table_with_pyiceberg(
                        config, schema, str(local_path), replace_existing=replace_existing
                    )
                else:
                    catalog_table_ref = f"{config.namespace}.{config.dataset_name}"
                    try:
                        token = config.get_access_token()
                        catalog = RestCatalog(
                            "lakekeeper",
                            uri=f"{config.lakekeeper_url}/catalog",
                            warehouse=config.effective_warehouse_id(),
                            token=token,
                        )
                        iceberg_table = catalog.load_table(catalog_table_ref)
                        iceberg_table.append(table)
                    except Exception as append_err:
                        logger.warning(f"Failed to append partition {i}: {append_err}")

                del table
                local_path.unlink()

            # Merge column stats across partitions
            all_stats = []
            for p_prefix in partitions:
                try:
                    all_stats.append(_read_json(config, f"{p_prefix}/column_stats.json"))
                except Exception:
                    continue
            if all_stats:
                merged_stats = merge_column_stats(all_stats)
                try:
                    update_facet(config, "column_stats", "ready", summary=merged_stats)
                except Exception as e:
                    logger.warning(f"Failed to store merged column stats: {e}")

            update_dataset_catalog_ref(config, catalog_table_ref)
            update_dataset_status(config, "ready")

            columns = [{"name": f.name, "type": str(f.type)} for f in schema] if schema else []
            processing_result = {
                "status": "success", "datasetId": config.dataset_id,
                "datasetName": config.dataset_name, "datasetKind": config.dataset_kind,
                "projectId": config.project_id, "namespace": config.namespace,
                "icebergSchema": build_iceberg_schema(schema) if schema else None,
                "rowCount": row_count, "columnCount": len(columns), "columns": columns,
                "sourceFileCount": len(partitions),
                "catalogRegistered": True, "catalogTableRef": catalog_table_ref,
            }
        else:
            # Unstructured: merge metadata from partitions
            all_metadata = []
            for p_prefix in partitions:
                try:
                    meta = _read_json(config, f"{p_prefix}/metadata.json")
                    if isinstance(meta, list):
                        all_metadata.extend(meta)
                    else:
                        all_metadata.append(meta)
                except Exception as e:
                    logger.warning(f"Failed to read metadata from {p_prefix}: {e}")

            if not all_metadata:
                raise ValueError("No metadata from any partition")

            # Support both row-oriented list ([{file_name: "a", ...}, ...]) and legacy column-oriented ([{file_name: [a,b], ...}]).
            first = all_metadata[0]
            if isinstance(first, dict) and first and isinstance(next(iter(first.values())), list):
                # Legacy: single column-oriented dict; convert to row list.
                d = first
                n = len(next(iter(d.values())))
                all_metadata = [dict(zip(d.keys(), [d[k][i] for k in d])) for i in range(n)]
            table = pa.Table.from_pylist(all_metadata)
            table = _cast_unstructured_table_to_schema(table)
            schema = table.schema
            # Write merged metadata to parquet so register_table_with_pyiceberg can create table and append rows.
            # Without this, the Iceberg table would be created empty and preview would show 0 rows.
            merged_parquet = temp_dir / "merged_metadata.parquet"
            pq.write_table(table, merged_parquet)
            catalog_table_ref = register_table_with_pyiceberg(
                config, schema, str(merged_parquet), replace_existing=replace_existing
            )

            update_dataset_catalog_ref(config, catalog_table_ref)
            update_dataset_status(config, "ready")

            # File stats for unstructured datasets
            try:
                file_stats = compute_file_stats(table)
                update_facet(config, "file_stats", "ready", summary=file_stats)
            except Exception as fs_exc:
                logger.warning(f"Failed to compute/store file stats: {fs_exc}")

            # PII summarization (augmented from monolithic path)
            pii_summary = None
            if config.enable_pii_analysis:
                pii_summary = _compute_pii_summary(table)
                if pii_summary:
                    update_dataset_pii_summary(config, pii_summary)
                    update_facet(config, "pii", "ready", summary=pii_summary)
                    try:
                        write_pii_details(config, table)
                    except Exception as pii_exc:
                        logger.warning(f"Failed to write PII details: {pii_exc}")

            processing_result = {
                "status": "success", "datasetId": config.dataset_id,
                "datasetName": config.dataset_name, "datasetKind": config.dataset_kind,
                "projectId": config.project_id, "namespace": config.namespace,
                "rowCount": len(table), "columnCount": len(schema),
                "sourceFileCount": len(all_metadata),
                "catalogRegistered": True, "catalogTableRef": catalog_table_ref,
            }
            if pii_summary:
                processing_result["piiSummary"] = pii_summary

        write_processing_result(config, processing_result)
        tracker.end_phase("processing")

        agg_result = {"setId": "aggregation", "status": "success", "outputPath": output_prefix}
        _upload_json(config, f"{output_prefix}/partition_result.json", agg_result)

        try:
            _cleanup_partition_artifacts(config, config.job_output_prefix)
        except Exception as cleanup_err:
            logger.warning(f"Cleanup of partition artifacts failed: {cleanup_err}")

        tracker.finish()
        logger.info("Merge completed successfully")
        return processing_result

    except Exception as e:
        logger.error(f"Merge failed: {e}", exc_info=True)
        error_result = {"setId": "aggregation", "status": "error", "error": str(e)}
        try:
            _upload_json(config, f"{output_prefix}/partition_result.json", error_result)
        except Exception:
            pass
        tracker.fail(str(e))
        raise
    finally:
        if bg_hb:
            bg_hb.__exit__(None, None, None)
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
