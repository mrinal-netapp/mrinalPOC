"""PII reprocessing for dataset import.

Extracted from reprocess_pii_only() in legacy processor.py. Accepts Config,
returns result dict, raises on failure instead of sys.exit(1).
"""

import json
from observability_client_runtime import get_logger
import os
import shutil
from pathlib import Path
from typing import Any, Callable, Dict, Optional

# (phase, phase_pct, current, total, extra) -> None
WorkflowProgressCallback = Optional[Callable[[str, float, int, int, Dict[str, Any]], None]]

import pyarrow as pa

from .config import Config
from .files import (
    _run_pii_analysis,
    download_file,
    update_dataset_pii_summary,
    update_dataset_status,
    update_facet,
    write_pii_details,
    write_processing_result,
    _configure_table_io_for_static_credentials,
)

try:
    from pyiceberg.catalog.rest import RestCatalog
    from pyiceberg.types import StringType, LongType, BooleanType
    HAS_PYICEBERG = True
except ImportError:
    HAS_PYICEBERG = False

logger = get_logger()


# Interval for heartbeat during PII reprocessing (rows) so Temporal does not timeout
_PII_HEARTBEAT_INTERVAL_ROWS = 50


def _resolve_posix_fallback(mount: str, config: Config, file_name: str) -> Optional[Path]:
    """Try to locate a file on the POSIX mount when the stored file:// URI is empty.

    Searches under the dataset's data_files directory for a file matching file_name.
    Handles datasets that were processed before the URI fix was applied.
    """
    prefix = config.s3_path_prefix or ""
    dataset_id = config.dataset_id or ""
    if not dataset_id:
        return None
    if prefix:
        data_dir = Path(mount) / prefix / "datasets" / dataset_id / "data_files"
    else:
        data_dir = Path(mount) / "datasets" / dataset_id / "data_files"
    if not data_dir.is_dir():
        return None
    candidate = data_dir / file_name
    if candidate.is_file():
        return candidate
    # Walk in case the file is nested in subdirectories
    for dirpath, _, filenames in os.walk(data_dir):
        if file_name in filenames:
            return Path(dirpath) / file_name
    return None


def reprocess_pii(
    config: Config,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
    workflow_progress_callback: WorkflowProgressCallback = None,
) -> dict:
    """Re-run PII analysis on an existing dataset without full reimport.

    Reads all rows from the existing Iceberg table, downloads each file from the
    POSIX mount, re-runs PII analysis, updates the PII columns, and overwrites the table.
    Returns result dict. Raises on failure.
    If heartbeat_callback is set (e.g. Temporal activity.heartbeat), it is called
    periodically during the row loop to avoid heartbeat timeouts.
    If workflow_progress_callback is set, it is called for UI progress updates.
    """
    pii_config = Config(**{
        **config.__dict__,
        "enable_pii_analysis": True,
    })

    logger.info(f"Starting PII reprocessing for dataset: {config.dataset_id}")

    if not HAS_PYICEBERG:
        raise RuntimeError("PyIceberg is required for PII reprocessing but not available")

    catalog_uri = f"{config.lakekeeper_url}/catalog"
    warehouse_name = config.effective_warehouse_id()
    s3_endpoint = config.s3_endpoint or "http://s3gateway:7070"

    token = config.get_access_token()
    os.environ.pop("AWS_SESSION_TOKEN", None)

    catalog_config = {
        "header.X-Iceberg-Access-Delegation": "none",
        "s3.endpoint": s3_endpoint,
        "s3.access-key-id": config.aws_access_key_id,
        "s3.secret-access-key": config.aws_secret_access_key,
        "s3.region": config.aws_region,
        "s3.path-style-access": "true",
        "s3.remote-signing-enabled": "false",
    }
    catalog = RestCatalog(
        name="lakekeeper", uri=catalog_uri, warehouse=warehouse_name,
        token=token, **catalog_config,
    )

    # Must match MergeDatasetResults / register_table_with_pyiceberg (namespace.project table).
    # Workflow omitted namespace in ReprocessDatasetPii payload before fix — fallback to project_id.
    catalog_namespace = (config.namespace or "").strip() or config.project_id or "default"
    table_identifier = (catalog_namespace, config.dataset_name)
    iceberg_table = catalog.load_table(table_identifier)
    _configure_table_io_for_static_credentials(iceberg_table, config)

    pii_column_defs = [
        ("pii_entities", StringType()),
        ("pii_count", LongType()),
        ("sensitivity_class", StringType()),
        ("has_pii", BooleanType()),
        ("pii_risk_level", StringType()),
    ]
    existing_field_names = {field.name for field in iceberg_table.schema().fields}
    columns_to_add = [(name, typ) for name, typ in pii_column_defs if name not in existing_field_names]
    if columns_to_add:
        logger.info(f"Evolving Iceberg schema to add PII columns: {[c[0] for c in columns_to_add]}")
        with iceberg_table.update_schema() as schema_update:
            for col_name, col_type in columns_to_add:
                schema_update.add_column(col_name, col_type)
        iceberg_table.refresh()
        _configure_table_io_for_static_credentials(iceberg_table, config)

    existing_data = iceberg_table.scan().to_arrow()
    logger.info(f"Read {len(existing_data)} rows from existing table")

    if len(existing_data) == 0:
        logger.warning("No rows in existing table, nothing to reprocess")
        update_dataset_status(config, "ready")
        return {"status": "success", "rowCount": 0, "message": "no rows to reprocess"}

    temp_dir = Path("/tmp/pii-reprocess")
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        new_pii_entities = []
        new_pii_count = []
        new_sensitivity_class = []
        new_has_pii = []
        new_pii_risk_level = []

        for i in range(len(existing_data)):
            file_path_val = existing_data.column("file_path")[i].as_py() if existing_data.column("file_path")[i].is_valid else None
            file_name_val = existing_data.column("file_name")[i].as_py() if existing_data.column("file_name")[i].is_valid else "unknown"
            mime_type_val = existing_data.column("mime_type")[i].as_py() if existing_data.column("mime_type")[i].is_valid else ""
            extension_val = existing_data.column("extension")[i].as_py() if existing_data.column("extension")[i].is_valid else ""

            if not file_path_val:
                new_pii_entities.append(None)
                new_pii_count.append(None)
                new_sensitivity_class.append("unknown")
                new_has_pii.append(None)
                new_pii_risk_level.append("none")
                continue

            local_path = temp_dir / file_name_val
            try:
                file_ref = file_path_val
                if file_ref.startswith("file://"):
                    src = Path(file_ref[7:])
                    if not src.is_file():
                        mount = config.default_store_root() or ""
                        fallback = _resolve_posix_fallback(mount, config, file_name_val) if mount else None
                        if fallback and fallback.is_file():
                            src = fallback
                        else:
                            raise FileNotFoundError(f"Volume file not found: {src}")
                    shutil.copy2(str(src), str(local_path))
                elif file_ref.startswith("s3://"):
                    parts = file_ref[5:].split("/", 1)
                    dl_key = parts[1] if len(parts) > 1 else ""
                    download_file(config, dl_key, local_path)
                else:
                    download_file(config, file_ref, local_path)
                pii_info = _run_pii_analysis(pii_config, local_path, mime_type_val, extension_val)

                new_pii_entities.append(pii_info["pii_entities"])
                new_pii_count.append(pii_info["pii_count"])
                new_sensitivity_class.append(pii_info["sensitivity_class"])
                new_has_pii.append(pii_info["has_pii"])
                new_pii_risk_level.append(pii_info["pii_risk_level"])
            except Exception as e:
                logger.warning(f"Failed to reprocess PII for {file_name_val}: {e}")
                new_pii_entities.append(None)
                new_pii_count.append(None)
                new_sensitivity_class.append("unknown")
                new_has_pii.append(None)
                new_pii_risk_level.append("none")
            finally:
                if local_path.exists():
                    local_path.unlink()

            if (i + 1) % _PII_HEARTBEAT_INTERVAL_ROWS == 0:
                if heartbeat_callback:
                    try:
                        heartbeat_callback(f"reprocessing-pii ({i + 1}/{len(existing_data)})")
                    except Exception as e:
                        logger.debug("Heartbeat callback failed: %s", e)
                if workflow_progress_callback:
                    try:
                        current, total = i + 1, len(existing_data)
                        pct = 100.0 * current / total if total else 0
                        workflow_progress_callback(
                            "pii_analysis", pct, current, total,
                            {"processedFiles": current, "totalFiles": total},
                        )
                    except Exception as e:
                        logger.debug("Workflow progress callback failed: %s", e)

        existing_arrow_cols = set(existing_data.column_names)
        pii_cols_to_drop = [c for c in ["pii_entities", "pii_count", "sensitivity_class", "has_pii", "pii_risk_level"] if c in existing_arrow_cols]
        updated_table = existing_data.drop_columns(pii_cols_to_drop) if pii_cols_to_drop else existing_data
        updated_table = updated_table.append_column("pii_entities", pa.array(new_pii_entities, type=pa.string()))
        updated_table = updated_table.append_column("pii_count", pa.array(new_pii_count, type=pa.int64()))
        updated_table = updated_table.append_column("sensitivity_class", pa.array(new_sensitivity_class, type=pa.string()))
        updated_table = updated_table.append_column("has_pii", pa.array(new_has_pii, type=pa.bool_()))
        updated_table = updated_table.append_column("pii_risk_level", pa.array(new_pii_risk_level, type=pa.string()))

        iceberg_table.overwrite(updated_table)
        write_pii_details(config, updated_table)

        files_with_pii = sum(1 for v in new_has_pii if v is True)
        files_high = sum(1 for v in new_pii_risk_level if v == "high")
        files_medium = sum(1 for v in new_pii_risk_level if v == "medium")
        files_low = sum(1 for v in new_pii_risk_level if v == "low")
        pii_summary = {
            "filesWithPii": files_with_pii, "totalFiles": len(updated_table),
            "piiAnalysisEnabled": True,
            "filesWithHighRisk": files_high, "filesWithMediumRisk": files_medium, "filesWithLowRisk": files_low,
        }
        update_dataset_pii_summary(config, pii_summary)
        update_facet(config, "pii", "ready", summary=pii_summary, job_id=config.workflow_id)

        processing_result = {
            "status": "success", "datasetId": config.dataset_id,
            "datasetName": config.dataset_name, "datasetKind": config.dataset_kind,
            "projectId": config.project_id, "namespace": catalog_namespace,
            "rowCount": len(updated_table), "sourceFileCount": len(updated_table),
            "catalogRegistered": True, "catalogTableRef": f"{catalog_namespace}.{config.dataset_name}",
            "piiSummary": pii_summary,
        }
        write_processing_result(config, processing_result)
        logger.info(f"PII reprocessing completed: {files_with_pii}/{len(updated_table)} files with PII")
        return processing_result

    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)


def reprocess_pii_file_set(
    config: Config,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
) -> dict:
    """Process a single scatter work-unit of PII analysis.

    Reads its manifest from ``config.manifest_s3_key`` on the POSIX mount,
    downloads each file, runs ``_run_pii_analysis``, writes results to
    ``{output_prefix}/pii_results.json``, and returns a WorkUnitResult dict.
    """
    pii_config = Config(**{**config.__dict__, "enable_pii_analysis": True})

    mount = os.environ.get("NEMO_DEFAULT_STORE_ROOT", "")
    if not mount:
        raise RuntimeError("NEMO_DEFAULT_STORE_ROOT is not set")

    manifest_key = config.manifest_s3_key
    manifest_path = os.path.join(mount, manifest_key)
    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    entries = manifest.get("files", [])
    set_id = config.set_id or "s0"
    output_prefix = config.output_prefix or ""

    logger.info("reprocess_pii_file_set: set_id=%s, %d files", set_id, len(entries))

    temp_dir = Path(f"/tmp/pii-reprocess-{set_id}")
    temp_dir.mkdir(parents=True, exist_ok=True)

    results = []
    processed = 0
    try:
        for entry in entries:
            file_path = entry.get("key", "")
            metadata = entry.get("metadata", {})
            file_name = metadata.get("file_name") or entry.get("file_name") or os.path.basename(file_path) or "unknown"
            mime_type = metadata.get("mime_type", "")
            extension = metadata.get("extension", "")

            if not file_path:
                continue

            local_path = temp_dir / file_name
            try:
                if file_path.startswith("file://"):
                    src = Path(file_path[7:])
                    if not src.is_file():
                        # Fallback: broken "file://" URIs (empty path) from datasets
                        # processed before the fix — locate file on POSIX mount.
                        fallback = _resolve_posix_fallback(mount, config, file_name)
                        if fallback and fallback.is_file():
                            src = fallback
                        else:
                            raise FileNotFoundError(f"Volume file not found: {src}")
                    shutil.copy2(str(src), str(local_path))
                elif file_path.startswith("s3://"):
                    parts = file_path[5:].split("/", 1)
                    dl_key = parts[1] if len(parts) > 1 else ""
                    download_file(config, dl_key, local_path)
                else:
                    download_file(config, file_path, local_path)

                pii_info = _run_pii_analysis(pii_config, local_path, mime_type, extension)
                results.append({
                    "file_path": file_path,
                    "pii_entities": pii_info["pii_entities"],
                    "pii_count": pii_info["pii_count"],
                    "sensitivity_class": pii_info["sensitivity_class"],
                    "has_pii": pii_info["has_pii"],
                    "pii_risk_level": pii_info["pii_risk_level"],
                })
            except Exception as e:
                logger.warning("Failed PII analysis for %s: %s", file_name, e)
                results.append({
                    "file_path": file_path,
                    "pii_entities": None,
                    "pii_count": None,
                    "sensitivity_class": "unknown",
                    "has_pii": None,
                    "pii_risk_level": "none",
                })
            finally:
                if local_path.exists():
                    local_path.unlink()

            processed += 1
            if processed % _PII_HEARTBEAT_INTERVAL_ROWS == 0 and heartbeat_callback:
                try:
                    heartbeat_callback(f"pii-reprocess ({processed}/{len(entries)})")
                except Exception:
                    pass

        results_key = f"{output_prefix}/pii_results.json"
        results_path = os.path.join(mount, results_key)
        os.makedirs(os.path.dirname(results_path), exist_ok=True)
        with open(results_path, "w") as f:
            json.dump(results, f)

        logger.info("reprocess_pii_file_set: set_id=%s done, %d files processed", set_id, processed)
        return {
            "setId": set_id,
            "status": "success",
            "fileCount": processed,
        }

    finally:
        if temp_dir.exists():
            shutil.rmtree(temp_dir, ignore_errors=True)


def merge_pii_results(
    config: Config,
    heartbeat_callback: Optional[Callable[[str], None]] = None,
) -> dict:
    """Merge PII results from all scatter partitions and update the Iceberg table.

    Reads ``pii_results.json`` from each partition directory, builds a
    file_path -> pii_result lookup, loads the Iceberg table, applies PII
    columns, overwrites the table, and updates facets/summary.
    """
    if not HAS_PYICEBERG:
        raise RuntimeError("PyIceberg is required for PII merge but not available")

    mount = os.environ.get("NEMO_DEFAULT_STORE_ROOT", "")
    if not mount:
        raise RuntimeError("NEMO_DEFAULT_STORE_ROOT is not set")

    job_output_prefix = config.job_output_prefix or ""

    pii_lookup: Dict[str, Dict[str, Any]] = {}
    partitions_dir = os.path.join(mount, job_output_prefix, "partitions")
    if os.path.isdir(partitions_dir):
        for set_dir in sorted(os.listdir(partitions_dir)):
            results_path = os.path.join(partitions_dir, set_dir, "pii_results.json")
            if not os.path.isfile(results_path):
                continue
            with open(results_path, "r") as f:
                partition_results = json.load(f)
            for entry in partition_results:
                fp = entry.get("file_path", "")
                if fp:
                    pii_lookup[fp] = entry

    logger.info("merge_pii_results: loaded %d PII results from partitions", len(pii_lookup))

    if heartbeat_callback:
        try:
            heartbeat_callback("loading-iceberg-table")
        except Exception:
            pass

    catalog_uri = f"{config.lakekeeper_url}/catalog"
    warehouse_name = config.effective_warehouse_id()
    s3_endpoint = config.s3_endpoint or "http://s3gateway:7070"

    token = config.get_access_token()
    os.environ.pop("AWS_SESSION_TOKEN", None)

    catalog_config = {
        "header.X-Iceberg-Access-Delegation": "none",
        "s3.endpoint": s3_endpoint,
        "s3.access-key-id": config.aws_access_key_id,
        "s3.secret-access-key": config.aws_secret_access_key,
        "s3.region": config.aws_region,
        "s3.path-style-access": "true",
        "s3.remote-signing-enabled": "false",
    }
    catalog = RestCatalog(
        name="lakekeeper", uri=catalog_uri, warehouse=warehouse_name,
        token=token, **catalog_config,
    )

    catalog_namespace = (config.namespace or "").strip() or config.project_id or "default"
    table_identifier = (catalog_namespace, config.dataset_name)
    iceberg_table = catalog.load_table(table_identifier)
    _configure_table_io_for_static_credentials(iceberg_table, config)

    pii_column_defs = [
        ("pii_entities", StringType()),
        ("pii_count", LongType()),
        ("sensitivity_class", StringType()),
        ("has_pii", BooleanType()),
        ("pii_risk_level", StringType()),
    ]
    existing_field_names = {field.name for field in iceberg_table.schema().fields}
    columns_to_add = [(name, typ) for name, typ in pii_column_defs if name not in existing_field_names]
    if columns_to_add:
        logger.info("Evolving Iceberg schema to add PII columns: %s", [c[0] for c in columns_to_add])
        with iceberg_table.update_schema() as schema_update:
            for col_name, col_type in columns_to_add:
                schema_update.add_column(col_name, col_type)
        iceberg_table.refresh()
        _configure_table_io_for_static_credentials(iceberg_table, config)

    if heartbeat_callback:
        try:
            heartbeat_callback("scanning-table")
        except Exception:
            pass

    existing_data = iceberg_table.scan().to_arrow()
    logger.info("merge_pii_results: read %d rows from Iceberg table", len(existing_data))

    if len(existing_data) == 0:
        return {"status": "success", "rowCount": 0, "message": "no rows to update"}

    new_pii_entities = []
    new_pii_count = []
    new_sensitivity_class = []
    new_has_pii = []
    new_pii_risk_level = []

    for i in range(len(existing_data)):
        fp_val = existing_data.column("file_path")[i].as_py() if existing_data.column("file_path")[i].is_valid else None
        result_entry = pii_lookup.get(fp_val) if fp_val else None
        if result_entry:
            new_pii_entities.append(result_entry.get("pii_entities"))
            new_pii_count.append(result_entry.get("pii_count"))
            new_sensitivity_class.append(result_entry.get("sensitivity_class", "unknown"))
            new_has_pii.append(result_entry.get("has_pii"))
            new_pii_risk_level.append(result_entry.get("pii_risk_level", "none"))
        else:
            new_pii_entities.append(None)
            new_pii_count.append(None)
            new_sensitivity_class.append("unknown")
            new_has_pii.append(None)
            new_pii_risk_level.append("none")

    if heartbeat_callback:
        try:
            heartbeat_callback("overwriting-table")
        except Exception:
            pass

    existing_arrow_cols = set(existing_data.column_names)
    pii_cols_to_drop = [c for c in ["pii_entities", "pii_count", "sensitivity_class", "has_pii", "pii_risk_level"] if c in existing_arrow_cols]
    updated_table = existing_data.drop_columns(pii_cols_to_drop) if pii_cols_to_drop else existing_data
    updated_table = updated_table.append_column("pii_entities", pa.array(new_pii_entities, type=pa.string()))
    updated_table = updated_table.append_column("pii_count", pa.array(new_pii_count, type=pa.int64()))
    updated_table = updated_table.append_column("sensitivity_class", pa.array(new_sensitivity_class, type=pa.string()))
    updated_table = updated_table.append_column("has_pii", pa.array(new_has_pii, type=pa.bool_()))
    updated_table = updated_table.append_column("pii_risk_level", pa.array(new_pii_risk_level, type=pa.string()))

    iceberg_table.overwrite(updated_table)
    write_pii_details(config, updated_table)

    files_with_pii = sum(1 for v in new_has_pii if v is True)
    files_high = sum(1 for v in new_pii_risk_level if v == "high")
    files_medium = sum(1 for v in new_pii_risk_level if v == "medium")
    files_low = sum(1 for v in new_pii_risk_level if v == "low")
    pii_summary = {
        "filesWithPii": files_with_pii,
        "totalFiles": len(updated_table),
        "piiAnalysisEnabled": True,
        "filesWithHighRisk": files_high,
        "filesWithMediumRisk": files_medium,
        "filesWithLowRisk": files_low,
    }
    update_dataset_pii_summary(config, pii_summary)
    update_facet(config, "pii", "ready", summary=pii_summary, job_id=config.workflow_id)

    logger.info(
        "merge_pii_results: completed — %d/%d files with PII",
        files_with_pii, len(updated_table),
    )
    return {
        "status": "success",
        "rowCount": len(updated_table),
        "piiSummary": pii_summary,
    }
