"""Dataset acquisition path helpers (stdlib only — safe to import without boto3)."""

from __future__ import annotations

from typing import Any, Dict, Tuple


def _split_s3_path(s3_path: str) -> Tuple[str, str]:
    """s3://bucket/prefix -> (bucket, prefix). Trailing slashes stripped from prefix."""
    parts = (s3_path or "").replace("s3://", "").split("/", 1)
    bucket = parts[0]
    prefix = parts[1].rstrip("/") if len(parts) > 1 else ""
    return bucket, prefix


def acquisition_artifact_key_prefix(activity_input: Dict[str, Any]) -> str:
    """POSIX object-store key prefix for ``_acquisition/*`` (sibling of ``data_files/``).

    Payload copies stay under ``resolve_acquisition_dest`` (typically
    ``.../datasets/<id>/data_files``). Metadata — manifests, ``filelist.json``,
    partition Parquet, errors — lives under
    ``{artifact_prefix}/_acquisition/...`` where ``artifact_prefix`` is
    ``projects/<projectId>/datasets/<datasetId>`` when those IDs are present,
    else the dataset store prefix derived from ``outputPath`` / ``outputS3Path``
    by stripping a trailing ``/data_files`` segment when present.
    """
    pid = str(activity_input.get("projectID") or activity_input.get("projectId") or "").strip()
    did = str(activity_input.get("datasetID") or activity_input.get("datasetId") or "").strip()
    if pid and did:
        return f"projects/{pid}/datasets/{did}"

    raw = (
        (activity_input.get("outputPath") or activity_input.get("output_path") or "").strip()
        or (activity_input.get("outputS3Path") or activity_input.get("output_s3_path") or "").strip()
    )
    if not raw:
        raise ValueError(
            "acquisition_artifact_key_prefix requires projectID+datasetID or outputPath (or legacy outputS3Path)",
        )
    if raw.startswith("s3://"):
        _bucket, prefix = _split_s3_path(raw)
        p = prefix.rstrip("/")
    else:
        p = raw.strip("/")
    if p.endswith("/data_files"):
        return p[: -len("/data_files")]
    return p
