"""Reusable S3 helpers shared by the legacy AcquireFromObjectStore activity and
the new streaming acquisition pipeline (DiscoverSourceItems / AcquireBatch).

Extracted from objectstore.py so the streaming pipeline doesn't reimplement
glob filtering, server-side copy detection, retryable errors, etc.
"""
from __future__ import annotations

import fnmatch
from observability_client_runtime import get_logger
import os
import random
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from .acquisition_store_paths import acquisition_artifact_key_prefix

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.handlers import validate_bucket_name

logger = get_logger()

# Adaptive retries for transient 5xx / SlowDown from S3-compatible gateways under heavy load.
S3_BOTOCORE_RETRIES = {"max_attempts": 10, "mode": "adaptive"}


def _normalize_http_origin(endpoint: Optional[str]) -> Optional[str]:
    """Compare endpoints for same-cluster detection (scheme/host/port, no path)."""
    if not endpoint or not str(endpoint).strip():
        return None
    raw = endpoint.strip().rstrip("/")
    u = urlparse(raw if "://" in raw else f"http://{raw}")
    if not u.netloc:
        return None
    host = u.hostname or ""
    port = u.port
    if port is None:
        port = 443 if u.scheme == "https" else 80
    scheme = (u.scheme or "http").lower()
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        return f"{scheme}://{host.lower()}"
    return f"{scheme}://{host.lower()}:{port}"


def same_cluster_as_worker(connector_endpoint: Optional[str]) -> bool:
    """True if the connector points at the worker's internal S3 endpoint, so
    we can use server-side CopyObject instead of download+upload."""
    ext = _normalize_http_origin(connector_endpoint)
    internal = _normalize_http_origin(os.environ.get("S3_ENDPOINT"))
    if not ext or not internal:
        return False
    return ext == internal


def relative_key_under_prefix(prefix: str, key: str) -> str:
    """Path under connector prefix (preserves subfolders); avoids flattening
    basename collisions when multiple subdirs hold same-named files."""
    p = (prefix or "").strip().strip("/")
    k = (key or "").strip()
    if p and k.startswith(p):
        rel = k[len(p):].lstrip("/")
        return rel if rel else (k.rsplit("/", 1)[-1] if "/" in k else k)
    return k.rsplit("/", 1)[-1] if "/" in k else k


def is_retriable_s3_error(exc: Exception) -> bool:
    if isinstance(exc, ClientError):
        code = (exc.response.get("Error") or {}).get("Code", "")
        if code in (
            "InternalError",
            "SlowDown",
            "ServiceUnavailable",
            "OperationAborted",
            "RequestTimeout",
            "Throttling",
        ):
            return True
    return False


def copy_object_with_backoff(
    int_s3: Any,
    dest_bucket: str,
    dest_key: str,
    copy_source: Dict[str, str],
    *,
    max_attempts: int = 6,
    label: str = "copy_object",
) -> None:
    """Server-side CopyObject with extra retries + jitter for gateway InternalError under load."""
    last: Optional[Exception] = None
    for attempt in range(max_attempts):
        try:
            int_s3.copy_object(Bucket=dest_bucket, Key=dest_key, CopySource=copy_source)
            return
        except Exception as e:
            last = e
            if attempt >= max_attempts - 1 or not is_retriable_s3_error(e):
                raise
            delay = min(30.0, (0.5 * (2**attempt)) + random.random())
            logger.warning(
                "[%s] retry %s/%s after %s: sleeping %.1fs",
                label, attempt + 1, max_attempts, e, delay,
            )
            time.sleep(delay)
    if last is not None:
        raise last  # defensive; loop above already raises on terminal failure


def resolve_s3_access_key_id(creds: Dict[str, str]) -> str:
    return (creds.get("access_key_id") or creds.get("aws_access_key_id") or "").strip()


def resolve_s3_secret_access_key(creds: Dict[str, str]) -> str:
    return (creds.get("secret_access_key") or creds.get("aws_secret_access_key") or "").strip()


def resolve_s3_session_token(creds: Dict[str, str]) -> Optional[str]:
    """STS / SSO temporary credentials (AWS_SESSION_TOKEN). Optional for long-lived keys."""
    for key in ("session_token", "aws_session_token", "security_token"):
        value = (creds.get(key) or "").strip()
        if value:
            return value
    return None


def get_external_s3_client(creds: Dict[str, str], config: Dict[str, Any]):
    endpoint_url = config.get("endpoint")
    region = config.get("region")
    if endpoint_url:
        client_config = Config(
            connect_timeout=10,
            read_timeout=120,
            retries=S3_BOTOCORE_RETRIES,
            s3={"addressing_style": "path"},
        )
    else:
        client_config = Config(
            connect_timeout=10,
            read_timeout=120,
            retries=S3_BOTOCORE_RETRIES,
        )
    client_kwargs: Dict[str, Any] = {
        "endpoint_url": endpoint_url,
        "aws_access_key_id": resolve_s3_access_key_id(creds),
        "aws_secret_access_key": resolve_s3_secret_access_key(creds),
        "region_name": region,
        "config": client_config,
    }
    session_token = resolve_s3_session_token(creds)
    if session_token:
        client_kwargs["aws_session_token"] = session_token
    client = boto3.client("s3", **client_kwargs)
    # MinIO/Ceph/etc. don't enforce AWS bucket name regex; botocore validates on every
    # call (including when Bucket is empty), which breaks Test/Browse with custom names.
    if endpoint_url:
        try:
            client.meta.events.unregister("before-parameter-build.s3", validate_bucket_name)
        except Exception:
            pass
    return client


def get_internal_s3_client():
    """Build the worker-local S3 client (S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY)."""
    client_config = Config(
        connect_timeout=10,
        read_timeout=120,
        retries=S3_BOTOCORE_RETRIES,
        s3={"addressing_style": "path"},
    )
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY"),
        aws_secret_access_key=os.environ.get("S3_SECRET_KEY"),
        config=client_config,
    )


def parse_glob_patterns(value: str) -> List[str]:
    """Comma-separated glob list -> list of stripped non-empty strings."""
    if not value or not value.strip():
        return []
    return [p.strip() for p in value.split(",") if p.strip()]


def matches_any_pattern(filename: str, patterns: List[str]) -> bool:
    """True if filename matches any pattern (Unix-style fnmatch). Empty list = always True."""
    if not patterns:
        return True
    for pat in patterns:
        if fnmatch.fnmatch(filename, pat):
            return True
    return False


def split_s3_path(s3_path: str) -> tuple:
    """s3://bucket/prefix -> (bucket, prefix). Trailing slashes stripped from prefix."""
    parts = (s3_path or "").replace("s3://", "").split("/", 1)
    bucket = parts[0]
    prefix = parts[1].rstrip("/") if len(parts) > 1 else ""
    return bucket, prefix


def resolve_acquisition_dest(activity_input: Dict[str, Any]) -> Tuple[str, str]:
    """Destination bucket + object-key prefix for acquisition writes.

    Prefer ``outputPath`` as a POSIX-style path under the store root, e.g.
    ``/projects/<projectId>/datasets/<datasetId>/data_files``. In that case
    ``outputBucket`` must be the internal object-store bucket name when using
    server-side CopyObject.

    Legacy ``outputS3Path`` (``s3://bucket/prefix``) is still accepted.
    """
    raw = (
        (activity_input.get("outputPath") or activity_input.get("output_path") or "").strip()
        or (activity_input.get("outputS3Path") or activity_input.get("output_s3_path") or "").strip()
    )
    if not raw:
        raise ValueError("outputPath (or legacy outputS3Path) is required")
    if raw.startswith("s3://"):
        return split_s3_path(raw)
    prefix = raw.strip("/")
    bucket = (activity_input.get("outputBucket") or activity_input.get("output_bucket") or "").strip()
    return bucket, prefix


def log_list_params(activity_label: str, config: Dict[str, Any], params: Dict[str, Any]) -> None:
    """Log the ListObjectsV2 invocation for debugging empty-result mysteries."""
    endpoint = config.get("endpoint")
    logger.info(
        "[%s] S3 list_objects_v2: endpoint=%s bucket=%s prefix=%s max_keys=%s continuation_token=%s start_after=%s",
        activity_label,
        endpoint if endpoint else "(default/aws)",
        params.get("Bucket"),
        params.get("Prefix", ""),
        params.get("MaxKeys"),
        "yes" if params.get("ContinuationToken") else "no",
        params.get("StartAfter", ""),
    )
