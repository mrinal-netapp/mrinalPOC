"""Shared CreateWorkPlanActivity implementation for dataset-worker and kb-worker.

Lists files from the POSIX mount (NEMO_DEFAULT_STORE_ROOT), derives a partition
count *K* from total bytes and env clamps, assigns every file into *K_eff*
non-empty shards (variant B: spread largest files across bins, then shuffled
round-robin for the tail), writes per-unit manifests, and returns a WorkPlan
dict with camelCase keys matching the Go types.WorkPlan struct.

*K* sizing: ``K_raw`` from ``ceil(total_bytes / WORK_UNIT_MAX_MB)`` when sizes
are known; if ``total_bytes == 0``, ``K_raw`` uses ``ceil(n / MAX_FILES_PER_UNIT)``
as a divisor only (not a per-shard file cap). ``K_clamped = clamp(K_raw,
MAX_WORK_UNITS, SCATTER_MAX_UNITS_CEILING)`` — ``MAX_WORK_UNITS`` is a **floor**
on shard count; ``SCATTER_MAX_UNITS_CEILING`` defaults to 2000. ``K_eff =
max(1, min(K_clamped, n))`` so no empty manifests. Per-shard byte/file caps are
**not** enforced after *K_eff* is chosen.

``WORK_UNIT_MAX_MB == 0`` disables the byte divisor; *K_raw* is then derived from
``MIN_FILES_PER_UNIT`` (legacy coarse parallelism).

All file I/O uses the locally mounted POSIX volume exclusively.
"""

import json
from observability_client_runtime import get_logger
import os
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from temporalio import activity

logger = get_logger()


# ---------------------------------------------------------------------------
# Env helpers (mirror Go envInt / envStr)
# ---------------------------------------------------------------------------

def _env_int(key: str, default: int) -> int:
    v = os.environ.get(key, "")
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


# ---------------------------------------------------------------------------
# S3FileInfo equivalent
# ---------------------------------------------------------------------------

class _FileInfo:
    __slots__ = ("key", "size", "last_modified", "local_path", "metadata")

    def __init__(
        self, key: str, size: int, last_modified: str,
        local_path: str = "", metadata: Optional[Dict[str, Any]] = None,
    ):
        self.key = key
        self.size = size
        self.last_modified = last_modified
        self.local_path = local_path
        self.metadata: Dict[str, Any] = metadata or {}

    def to_manifest_entry(self) -> Dict[str, Any]:
        e: Dict[str, Any] = {
            "key": self.key,
            "size": self.size,
            "lastModified": self.last_modified,
        }
        if self.local_path:
            e["local_path"] = self.local_path
        if self.metadata:
            e["metadata"] = self.metadata
        return e


# ---------------------------------------------------------------------------
# Scatter-gather config (mirrors getScatterGatherConfigFromEnv)
# ---------------------------------------------------------------------------

class _ScatterGatherConfig:
    def __init__(self) -> None:
        work_unit_max_mb = _env_int("WORK_UNIT_MAX_MB", 5)
        self.max_bytes_per_work_unit: int = work_unit_max_mb * 1024 * 1024 if work_unit_max_mb > 0 else 0
        self.max_files_per_unit: int = _env_int("MAX_FILES_PER_UNIT", 100)
        self.max_work_units: int = _env_int("MAX_WORK_UNITS", 10)
        self.min_files_per_unit: int = _env_int("MIN_FILES_PER_UNIT", 10)
        self.dataset_file_threshold: int = _env_int("DATASET_FILE_THRESHOLD", 20)
        self.kb_file_threshold: int = _env_int("KB_FILE_THRESHOLD", 25)
        self.scatter_max_units_ceiling: int = _env_int("SCATTER_MAX_UNITS_CEILING", 2000)


def _default_store_root() -> str:
    """Return the default app-scoped PVC mount root.  Raises if not configured."""
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


# ---------------------------------------------------------------------------
# File list / directory listing
# ---------------------------------------------------------------------------

def _coerce_size(v: Any) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            return 0
    return 0


def _parse_last_modified(s: Any) -> str:
    if s is None:
        return ""
    if isinstance(s, datetime):
        return s.strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = str(s).strip()
    if not raw:
        return ""
    return raw


def _load_file_list(key: str) -> List[_FileInfo]:
    """Read a file list from the POSIX mount.

    Supports two formats:
    - Legacy JSON (filelist.json): ``{"files": [{"key": ..., "size": ...}]}``
    - Parquet manifest (manifest.json): ``{"format": "parquet-partitioned", "partitions": [...]}``
      where each partition is a relative Parquet file under the same prefix.
    """
    mount = _default_store_root()
    fpath = os.path.join(mount, key)
    with open(fpath, "rb") as f:
        body = f.read()

    root = json.loads(body)

    if root.get("format") == "parquet-partitioned":
        return _load_parquet_manifest(root, key, mount)

    arr = root.get("files") or []
    files: List[_FileInfo] = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        key_str = str(item.get("key") or "").strip()
        lp = str(item.get("local_path") or item.get("localPath") or "").strip()
        sz = _coerce_size(item.get("size"))
        lm_str = item.get("lastModified") or item.get("last_modified") or ""
        lm = _parse_last_modified(lm_str)

        fi = _FileInfo(key="", size=sz, last_modified=lm, local_path="")
        if lp:
            fi.local_path = lp
            fi.key = key_str if key_str else lp
        else:
            fi.key = key_str
        if not fi.key:
            continue
        files.append(fi)
    return files


def _load_parquet_manifest(
    manifest: Dict[str, Any],
    manifest_key: str,
    mount: str,
) -> List[_FileInfo]:
    """Load file entries from Parquet partitions referenced by a manifest."""
    import pyarrow.dataset as ds

    source_type = manifest.get("sourceType", "")
    source = manifest.get("source") or {}
    partition_keys = manifest.get("partitions") or []
    if not partition_keys:
        return []

    manifest_dir = os.path.dirname(os.path.join(mount, manifest_key))
    partition_paths = []
    for pk in partition_keys:
        full = os.path.join(mount, pk)
        if os.path.isfile(full):
            partition_paths.append(full)
        else:
            alt = os.path.join(manifest_dir, pk)
            if os.path.isfile(alt):
                partition_paths.append(alt)

    if not partition_paths:
        return []

    dataset = ds.dataset(partition_paths, format="parquet")
    table = dataset.to_table()

    files: List[_FileInfo] = []
    uri_col = table.column("uri") if "uri" in table.column_names else None
    rp_col = table.column("relative_path") if "relative_path" in table.column_names else None
    size_col = table.column("size") if "size" in table.column_names else None
    lm_col = table.column("last_modified") if "last_modified" in table.column_names else None

    for i in range(table.num_rows):
        uri = str(uri_col[i].as_py()) if uri_col is not None else ""
        rel_path = str(rp_col[i].as_py()) if rp_col is not None else ""
        sz = int(size_col[i].as_py() or 0) if size_col is not None else 0
        lm_val = lm_col[i].as_py() if lm_col is not None else None
        lm = _parse_last_modified(lm_val)

        fi = _FileInfo(key="", size=sz, last_modified=lm, local_path="")
        if source_type == "volume" and uri.startswith("file://"):
            fi.local_path = uri[len("file://"):]
            fi.key = uri
        elif uri.startswith("s3://"):
            fi.key = uri[len("s3://"):].split("/", 1)[-1] if "/" in uri[5:] else uri
        else:
            fi.key = uri or rel_path
        if not fi.key:
            continue
        files.append(fi)
    return files


def _list_data_files(prefix: str) -> List[_FileInfo]:
    """Walk data_files/ from the POSIX mount."""
    mount = _default_store_root()
    return _list_posix_files(mount, prefix)


def _list_posix_files(mount: str, prefix: str) -> List[_FileInfo]:
    import_path = os.path.join(mount, prefix)
    files: List[_FileInfo] = []
    if not os.path.isdir(import_path):
        return files
    for dirpath, _dirnames, filenames in os.walk(import_path):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, mount)
            mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            files.append(_FileInfo(
                key=rel,
                size=st.st_size,
                last_modified=mtime,
            ))
    return files


# ---------------------------------------------------------------------------
# Manifest write (POSIX or S3)
# ---------------------------------------------------------------------------

def _write_manifest(key: str, data: bytes) -> None:
    mount = _default_store_root()
    fpath = os.path.join(mount, key)
    parent = os.path.dirname(fpath)
    os.makedirs(parent, exist_ok=True)
    tmp = fpath + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, fpath)


# ---------------------------------------------------------------------------
# Partitioning: K from bytes + clamps, variant B distribution into K_eff bins
# ---------------------------------------------------------------------------

def _scatter_clamp_bounds(cfg: _ScatterGatherConfig) -> Tuple[int, int]:
    """Return (floor, ceiling) for K_clamped with floor <= ceiling."""
    floor_u = max(1, cfg.max_work_units)
    ceil_u = max(1, cfg.scatter_max_units_ceiling)
    if floor_u > ceil_u:
        logger.warning(
            "[CreateWorkPlanActivity] MAX_WORK_UNITS (%d) > SCATTER_MAX_UNITS_CEILING (%d); "
            "using floor=min for clamp",
            floor_u, ceil_u,
        )
        return min(floor_u, ceil_u), ceil_u
    return floor_u, ceil_u


def _clamp_int(x: int, lo: int, hi: int) -> int:
    return min(max(x, lo), hi)


def _compute_k_raw(cfg: _ScatterGatherConfig, total_bytes: int, n: int) -> Tuple[int, str]:
    """Return (k_raw >= 1, reason) for sizing before K_clamped / K_eff."""
    if cfg.max_bytes_per_work_unit > 0:
        if total_bytes > 0:
            k_raw = (total_bytes + cfg.max_bytes_per_work_unit - 1) // cfg.max_bytes_per_work_unit
            return max(1, k_raw), "bytes"
        if n <= 0:
            return 1, "zero_sizes"
        m = max(cfg.max_files_per_unit, 1)
        k_raw = (n + m - 1) // m
        logger.info(
            "[CreateWorkPlanActivity] total_bytes=0 for %d files; K_raw from ceil(n / MAX_FILES_PER_UNIT=%d)",
            n, m,
        )
        return max(1, k_raw), "zero_sizes"
    # WORK_UNIT_MAX_MB == 0 — coarse shard count from MIN_FILES_PER_UNIT
    m = max(cfg.min_files_per_unit, 1)
    if n <= 0:
        return 1, "no_byte_cap"
    k_raw = max(1, n // m)
    return k_raw, "no_byte_cap"


def _compute_k_clamped(cfg: _ScatterGatherConfig, total_bytes: int, n: int) -> Tuple[int, int, int, str]:
    """Returns (k_raw, k_clamped, k_eff, reason)."""
    k_raw, reason = _compute_k_raw(cfg, total_bytes, n)
    lo, hi = _scatter_clamp_bounds(cfg)
    k_clamped = _clamp_int(k_raw, lo, hi)
    if k_raw > hi:
        logger.info(
            "[CreateWorkPlanActivity] K_raw=%d exceeds SCATTER_MAX_UNITS_CEILING=%d; capping to %d",
            k_raw, hi, k_clamped,
        )
    k_eff = max(1, min(k_clamped, n)) if n > 0 else 1
    return k_raw, k_clamped, k_eff, reason


def _distribute_into_k_partitions_variant_b(
    files: List[_FileInfo], k_eff: int, rng: random.Random,
) -> List[List[_FileInfo]]:
    """Spread the largest files across bins (argmin total bytes, tie-break lowest index), then shuffle + round-robin."""
    n = len(files)
    if k_eff <= 0 or n == 0:
        return []
    bins: List[List[_FileInfo]] = [[] for _ in range(k_eff)]
    sizes = [0] * k_eff

    sorted_desc = sorted(files, key=lambda f: f.size, reverse=True)
    top_n = min(n, 2 * k_eff)
    head = sorted_desc[:top_n]
    tail = sorted_desc[top_n:]

    for f in head:
        best_i = 0
        best_sz = sizes[0]
        for i in range(1, k_eff):
            if sizes[i] < best_sz or (sizes[i] == best_sz and i < best_i):
                best_i = i
                best_sz = sizes[i]
        bins[best_i].append(f)
        sizes[best_i] += f.size

    tail_shuf = list(tail)
    rng.shuffle(tail_shuf)
    for j, f in enumerate(tail_shuf):
        bins[j % k_eff].append(f)

    return bins


# ---------------------------------------------------------------------------
# Output prefix builder (mirrors buildWorkPlanOutputPrefix)
# ---------------------------------------------------------------------------

def _build_output_prefix(path_prefix: str, job_id: str) -> str:
    base = f"{path_prefix}/jobs" if path_prefix else "jobs"
    return f"{base}/{job_id}"


# ---------------------------------------------------------------------------
# CreateWorkPlanActivity
# ---------------------------------------------------------------------------

@activity.defn(name="CreateWorkPlanActivity")
def create_work_plan(input: Dict[str, Any]) -> Dict[str, Any]:
    """List files, partition into work units, write manifests, return WorkPlan.

    Input/output dicts use camelCase keys to match Go types.WorkPlan deserialization.
    """
    bucket_name = input.get("bucketName", "")
    path_prefix = input.get("pathPrefix", "")
    dataset_id = input.get("datasetId", "")
    job_id = input.get("jobId", "")
    workload_type = input.get("workloadType", "")
    file_list_key = (input.get("fileListKey") or "").strip()

    info = activity.info()
    logger.info(
        "[CreateWorkPlanActivity] Starting for %s: %s, job: %s",
        workload_type, dataset_id, job_id,
    )
    logger.info(
        "[CreateWorkPlanActivity] WorkflowID: %s, ActivityID: %s",
        info.workflow_id, info.activity_id,
    )

    source = input.get("source", "")

    files: List[_FileInfo]
    if source == "iceberg":
        logger.info("[CreateWorkPlanActivity] Loading file entries from Iceberg catalog")
        files = _load_iceberg_file_entries(input)
        logger.info("[CreateWorkPlanActivity] Loaded %d files from Iceberg table", len(files))
    elif file_list_key:
        logger.info("[CreateWorkPlanActivity] Loading pre-built file list %s/%s", bucket_name, file_list_key)
        files = _load_file_list(file_list_key)
        logger.info("[CreateWorkPlanActivity] Loaded %d files from fileListKey", len(files))
    else:
        if path_prefix:
            data_prefix = f"{path_prefix}/datasets/{dataset_id}/data_files/"
        else:
            data_prefix = f"datasets/{dataset_id}/data_files/"

        if workload_type == "dataset" and source != "iceberg":
            if path_prefix:
                acq_base = f"{path_prefix}/datasets/{dataset_id}/_acquisition"
            else:
                acq_base = f"datasets/{dataset_id}/_acquisition"
            mount = _default_store_root()
            resolved_key = ""
            for name in ("filelist.json", "manifest.json"):
                cand = f"{acq_base}/{name}"
                if os.path.isfile(os.path.join(mount, cand)):
                    resolved_key = cand
                    break
            if resolved_key:
                logger.info(
                    "[CreateWorkPlanActivity] Using acquisition artifact %s (retry / empty fileListKey)",
                    resolved_key,
                )
                files = _load_file_list(resolved_key)
            else:
                files = _list_data_files(data_prefix)
                logger.info("[CreateWorkPlanActivity] Found %d files under prefix %s", len(files), data_prefix)
        else:
            files = _list_data_files(data_prefix)
            logger.info("[CreateWorkPlanActivity] Found %d files under prefix %s", len(files), data_prefix)

    total_bytes = sum(f.size for f in files)

    cfg = _ScatterGatherConfig()

    threshold = cfg.kb_file_threshold if workload_type == "kb" else cfg.dataset_file_threshold

    job_output_prefix = _build_output_prefix(path_prefix, job_id)

    if len(files) <= threshold:
        logger.info(
            "[CreateWorkPlanActivity] %d files below threshold %d, using single worker",
            len(files), threshold,
        )
        set_id = "s0"
        output_prefix = f"{job_output_prefix}/partitions/{set_id}"
        manifest_key = f"{output_prefix}/manifest.json"

        manifest = {
            "files": [f.to_manifest_entry() for f in files],
            "totalFiles": len(files),
            "totalBytes": total_bytes,
            "setId": set_id,
        }
        _write_manifest(manifest_key, json.dumps(manifest).encode())

        return {
            "fileSets": [{
                "setId": set_id,
                "manifestS3Key": manifest_key,
                "totalFiles": len(files),
                "totalBytes": total_bytes,
                "outputPrefix": output_prefix,
            }],
            "totalFiles": len(files),
            "totalBytes": total_bytes,
            "useSingleWorker": True,
            "jobOutputPrefix": job_output_prefix,
        }

    n_files = len(files)
    k_raw, k_clamped, k_eff, k_reason = _compute_k_clamped(cfg, total_bytes, n_files)
    logger.info(
        "[CreateWorkPlanActivity] Partitioning: K_raw=%d K_clamped=%d K_eff=%d n=%d total_bytes=%d "
        "(reason=%s; WORK_UNIT_MAX_MB=%d floor=MAX_WORK_UNITS=%d ceiling=%d)",
        k_raw,
        k_clamped,
        k_eff,
        n_files,
        total_bytes,
        k_reason,
        cfg.max_bytes_per_work_unit // (1024 * 1024) if cfg.max_bytes_per_work_unit > 0 else 0,
        cfg.max_work_units,
        cfg.scatter_max_units_ceiling,
    )

    rng = random.Random()
    file_sets = _distribute_into_k_partitions_variant_b(files, k_eff, rng)

    result_file_sets: List[Dict[str, Any]] = []
    for i, set_files in enumerate(file_sets):
        set_id = f"s{i}"
        output_prefix = f"{job_output_prefix}/partitions/{set_id}"
        manifest_key = f"{output_prefix}/manifest.json"

        set_bytes = sum(f.size for f in set_files)
        manifest = {
            "files": [f.to_manifest_entry() for f in set_files],
            "totalFiles": len(set_files),
            "totalBytes": set_bytes,
            "setId": set_id,
        }
        _write_manifest(manifest_key, json.dumps(manifest).encode())

        result_file_sets.append({
            "setId": set_id,
            "manifestS3Key": manifest_key,
            "totalFiles": len(set_files),
            "totalBytes": set_bytes,
            "outputPrefix": output_prefix,
        })

    logger.info("[CreateWorkPlanActivity] Created %d file sets for %d files", len(result_file_sets), len(files))

    return {
        "fileSets": result_file_sets,
        "totalFiles": len(files),
        "totalBytes": total_bytes,
        "useSingleWorker": False,
        "jobOutputPrefix": job_output_prefix,
    }


# ---------------------------------------------------------------------------
# Iceberg catalog helpers (lazily import pyiceberg / requests)
# ---------------------------------------------------------------------------

def _get_iceberg_catalog(iceberg_cfg: Dict[str, Any]):
    """Build a RestCatalog from the nested ``iceberg`` config dict."""
    from pyiceberg.catalog.rest import RestCatalog
    import requests as _requests

    lakekeeper_url = iceberg_cfg.get("lakekeeperUrl", "")
    catalog_uri = f"{lakekeeper_url}/catalog"
    warehouse = (
        iceberg_cfg.get("warehouseId", "")
        or os.environ.get("WAREHOUSE_NAME", "")
        or os.environ.get("DEPLOYMENT_NAME", "")
    )

    issuer = iceberg_cfg.get("keycloakInternalIssuer", "")
    token_url = f"{issuer}/protocol/openid-connect/token"
    resp = _requests.post(token_url, data={
        "grant_type": "client_credentials",
        "client_id": iceberg_cfg["projectClientId"],
        "client_secret": iceberg_cfg["projectClientSecret"],
    })
    resp.raise_for_status()
    token = resp.json()["access_token"]

    s3_endpoint = iceberg_cfg.get("s3Endpoint", "http://s3gateway:7070")
    catalog_config = {
        "header.X-Iceberg-Access-Delegation": "none",
        "s3.endpoint": s3_endpoint,
        "s3.access-key-id": iceberg_cfg["awsAccessKeyId"],
        "s3.secret-access-key": iceberg_cfg["awsSecretAccessKey"],
        "s3.region": iceberg_cfg.get("awsRegion", ""),
        "s3.path-style-access": "true",
        "s3.remote-signing-enabled": "false",
    }
    return RestCatalog(
        name="lakekeeper", uri=catalog_uri, warehouse=warehouse,
        token=token, **catalog_config,
    )


def _configure_iceberg_io(table, iceberg_cfg: Dict[str, Any]) -> None:
    """Patch table IO properties with static S3 credentials."""
    s3_endpoint = iceberg_cfg.get("s3Endpoint", "http://s3gateway:7070")
    table_io = table.io
    io_props = None
    if hasattr(table_io, "properties") and isinstance(table_io.properties, dict):
        io_props = table_io.properties
    elif hasattr(table_io, "_properties") and isinstance(table_io._properties, dict):
        io_props = table_io._properties
    if io_props is not None:
        io_props["s3.access-key-id"] = iceberg_cfg["awsAccessKeyId"]
        io_props["s3.secret-access-key"] = iceberg_cfg["awsSecretAccessKey"]
        io_props["s3.endpoint"] = s3_endpoint
        io_props["s3.region"] = iceberg_cfg.get("awsRegion", "")
        io_props["s3.path-style-access"] = "true"
        io_props["s3.remote-signing-enabled"] = "false"
        io_props.pop("s3.signer", None)
        io_props.pop("s3.signer.uri", None)
        io_props.pop("s3.signer.endpoint", None)


def _load_iceberg_file_entries(input_dict: Dict[str, Any]) -> List[_FileInfo]:
    """Read file metadata from an Iceberg table and return _FileInfo entries."""
    iceberg_cfg = input_dict.get("iceberg", {})
    catalog = _get_iceberg_catalog(iceberg_cfg)

    namespace = iceberg_cfg.get("namespace", "default")
    dataset_name = iceberg_cfg.get("datasetName", "")
    table = catalog.load_table((namespace, dataset_name))
    _configure_iceberg_io(table, iceberg_cfg)

    os.environ.pop("AWS_SESSION_TOKEN", None)

    arrow_table = table.scan(
        selected_fields=("file_path", "file_name", "mime_type", "extension"),
    ).to_arrow()

    logger.info(
        "[CreateWorkPlanActivity] Loaded %d rows from Iceberg %s.%s",
        len(arrow_table), namespace, dataset_name,
    )

    files: List[_FileInfo] = []
    for i in range(len(arrow_table)):
        fp = arrow_table.column("file_path")[i].as_py() or ""
        fn = arrow_table.column("file_name")[i].as_py() or "unknown"
        mt = arrow_table.column("mime_type")[i].as_py() or ""
        ext = arrow_table.column("extension")[i].as_py() or ""
        if not fp:
            continue
        files.append(_FileInfo(
            key=fp,
            size=0,
            last_modified="",
            metadata={"file_name": fn, "mime_type": mt, "extension": ext},
        ))
    return files
