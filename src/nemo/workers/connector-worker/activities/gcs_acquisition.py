"""GCS acquisition for Google Cloud (connector_type: cloud) datasets."""
from __future__ import annotations

import json
from observability_client_runtime import get_logger
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from google.cloud import storage
from google.oauth2 import service_account
from temporalio import activity

from .activity_logging import log_activity_start, log_activity_result
from .credentials import resolve_credential
from .gcp_sa_json import resolve_gcp_service_account_json
from .s3_helpers import (
    acquisition_artifact_key_prefix,
    matches_any_pattern as _matches_any_pattern,
    parse_glob_patterns as _parse_glob_patterns,
    relative_key_under_prefix as _relative_key_under_prefix,
    split_s3_path as _split_s3_path,
)

logger = get_logger()

_GCP_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _default_store_root() -> str:
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError("NEMO_DEFAULT_STORE_ROOT is not set")
    return p


def _gcs_client(creds_dict: Dict[str, str], project_id: str) -> storage.Client:
    sa_json = resolve_gcp_service_account_json(creds_dict)
    if not sa_json:
        raise ValueError("Credential missing service account JSON for GCS acquisition")

    info = json.loads(sa_json)
    creds = service_account.Credentials.from_service_account_info(info, scopes=_GCP_SCOPES)
    return storage.Client(project=project_id or info.get("project_id"), credentials=creds)


def _list_candidate_blobs(
    client: storage.Client, bucket_name: str, prefix: str
) -> List[Tuple[str, int]]:
    """Return (object_name, size) for blobs under prefix; prefix may name a single object."""
    b = client.bucket(bucket_name)
    pfx = (prefix or "").strip()
    out: List[Tuple[str, int]] = []
    blobs = client.list_blobs(b, prefix=pfx or None)
    for blob in blobs:
        # Skip implicit "directory" placeholders
        if blob.name.endswith("/"):
            continue
        out.append((blob.name, int(blob.size or 0)))
    return out


@activity.defn(name="AcquireFromGCS")
def acquire_from_gcs(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    project_id = str(config.get("project_id", "") or "")
    bucket = str(config.get("bucket", "") or "")
    prefix = str(config.get("prefix", "") or "")
    dest_raw = (
        (input.get("outputPath") or input.get("output_path") or "").strip()
        or (input.get("outputS3Path") or input.get("output_s3_path") or "").strip()
    )
    if not dest_raw:
        raise ValueError("outputPath (or legacy outputS3Path) is required")
    file_glob = input.get("fileGlob", "")
    file_exclude_pattern = input.get("fileExcludePattern", "")

    if not bucket:
        raise ValueError("AcquireFromGCS: connectorConfig.bucket is required (set via dataset resource selection)")

    include_patterns = _parse_glob_patterns(file_glob)
    exclude_patterns = _parse_glob_patterns(file_exclude_pattern)

    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    client = _gcs_client(creds, project_id)

    activity.heartbeat("listing-files")
    all_keys = _list_candidate_blobs(client, bucket, prefix)
    logger.info(
        "[AcquireFromGCS] Discovered %d objects under gs://%s/%s",
        len(all_keys),
        bucket,
        prefix,
    )

    keys_to_copy: List[Tuple[str, int]] = []
    for name, sz in all_keys:
        filename = name.rsplit("/", 1)[-1] if "/" in name else name
        if not filename:
            continue
        if include_patterns and not _matches_any_pattern(filename, include_patterns):
            continue
        if exclude_patterns and _matches_any_pattern(filename, exclude_patterns):
            continue
        keys_to_copy.append((name, sz))

    logger.info(
        "[AcquireFromGCS] After glob filter: %d files (include=%s exclude=%s)",
        len(keys_to_copy),
        include_patterns or ["*"],
        exclude_patterns,
    )

    if dest_raw.startswith("s3://"):
        _ob, out_prefix = _split_s3_path(dest_raw)
    else:
        out_prefix = dest_raw.strip("/")

    mount = _default_store_root()
    stored: List[Dict[str, Any]] = []
    gcs_bucket = client.bucket(bucket)

    for idx, (obj_name, size) in enumerate(keys_to_copy):
        activity.heartbeat(f"copying-{idx}")
        rel = _relative_key_under_prefix(prefix, obj_name)
        dest_key = f"{out_prefix}/{rel}" if out_prefix else rel
        dest_key = "/".join(p for p in dest_key.split("/") if p)
        dest_path = Path(mount) / dest_key
        dest_path.parent.mkdir(parents=True, exist_ok=True)

        blob = gcs_bucket.blob(obj_name)
        tmp_path: Optional[str] = None
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = tmp.name
        try:
            blob.download_to_filename(tmp_path)
            # /tmp and NEMO_DEFAULT_STORE_ROOT are often different mounts;
            # os.rename / Path.replace fails with EXDEV — shutil.move copies then removes.
            shutil.move(tmp_path, str(dest_path))
            tmp_path = None
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        stored.append({"key": dest_key, "size": size})

    artifact_prefix = acquisition_artifact_key_prefix(input)
    filelist_key = f"{artifact_prefix}/_acquisition/filelist.json"
    list_path = Path(mount) / filelist_key
    list_path.parent.mkdir(parents=True, exist_ok=True)
    list_path.write_text(
        json.dumps(
            {
                "files": stored,
                "totalFiles": len(stored),
                "source": "gcs",
                "bucket": bucket,
                "prefix": prefix,
            },
            separators=(",", ":"),
            default=str,
        ),
        encoding="utf-8",
    )

    result = {
        "filesCopied": float(len(stored)),
        "totalBytes": float(sum(s for _, s in keys_to_copy)),
        "fileListKey": filelist_key,
    }
    logger.info("[AcquireFromGCS] Done copied=%d fileListKey=%s", len(stored), filelist_key)
    log_activity_result(result)
    return result
