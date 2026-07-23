"""Manual dataset upload helpers (S3 gateway PUT + manifest registration)."""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import allure
import httpx

from lib.common.platform_client import PlatformClient
from lib.common.settings import INTEGRATION_ROOT, IntegrationSettings


_S3_URI_RE = re.compile(r"^s3://([^/]+)/(.+)$")

# Default upload when MANUAL_UPLOAD_FILE_PATH is unset (local + CI without env).
_DEFAULT_MANUAL_UPLOAD_FIXTURE = (
    INTEGRATION_ROOT / "fixtures" / "manual-upload" / "integration-test.txt"
)


def resolve_manual_upload_payload(
    settings: IntegrationSettings,
) -> tuple[str, bytes, str]:
    """Resolve manual-upload file name, bytes, and content type from settings."""
    path_value = settings.manual_upload_file_path
    if not path_value:
        file_path = _DEFAULT_MANUAL_UPLOAD_FIXTURE
        if not file_path.is_file():
            raise FileNotFoundError(
                f"Default manual-upload fixture missing: {file_path}"
            )
    else:
        file_path = Path(path_value).expanduser()
        if not file_path.is_absolute():
            file_path = INTEGRATION_ROOT / file_path
        if not file_path.is_file():
            raise FileNotFoundError(
                f"MANUAL_UPLOAD_FILE_PATH not found: {file_path} "
                f"(resolved from {path_value!r})"
            )

    file_name = settings.manual_upload_file_name or file_path.name
    if settings.manual_upload_content_type:
        content_type = settings.manual_upload_content_type
    else:
        guessed, _ = mimetypes.guess_type(file_name)
        content_type = guessed or "application/octet-stream"

    return file_name, file_path.read_bytes(), content_type


def parse_project_storage_root(home_dir: str | None) -> tuple[str, str]:
    """Parse project home_dir into (bucket_name, path_prefix)."""
    if not home_dir:
        raise ValueError("project home_dir is missing")
    match = _S3_URI_RE.match(home_dir.strip())
    if not match:
        raise ValueError(f"invalid project home_dir: {home_dir!r}")
    bucket, prefix = match.group(1), match.group(2).rstrip("/")
    return bucket, prefix


def sanitize_upload_relative_path(relative_path: str) -> str:
    return "/".join(
        segment.replace(" ", "_")
        for segment in relative_path.split("/")
        if segment
    )


def s3_gateway_root(api_base_url: str) -> str:
    base = api_base_url.rstrip("/")
    if base.endswith("/config"):
        root = base[: -len("/config")]
    else:
        root = base
    return f"{root}/s3"


def put_object_via_gateway(
    client: PlatformClient,
    *,
    bucket: str,
    object_key: str,
    body: bytes,
    content_type: str = "text/plain",
) -> None:
    """PUT an object through the platform S3 gateway (same path as the UI)."""
    gateway = s3_gateway_root(client.settings.api_base_url).rstrip("/")
    encoded_key = "/".join(quote(part, safe="") for part in object_key.split("/"))
    url = f"{gateway}/{quote(bucket, safe='')}/{encoded_key}"

    client._auth.refresh_if_needed(client._http)
    token = client._auth.get_access_token(client._http)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type,
    }
    resp = client._http.put(url, headers=headers, content=body)
    assert resp.status_code in (200, 201), (
        f"S3 gateway PUT failed: HTTP {resp.status_code} {resp.text[:500]}"
    )


def upload_manual_file(
    client: PlatformClient,
    *,
    project_home_dir: str | None,
    dataset_id: str,
    relative_path: str,
    content: bytes,
    content_type: str = "text/plain",
) -> dict[str, Any]:
    """Upload one file and return an uploadedFiles entry for the dataset API."""
    bucket, path_prefix = parse_project_storage_root(project_home_dir)
    safe_rel = sanitize_upload_relative_path(relative_path)
    base_path = (
        f"{path_prefix}/datasets/{dataset_id}/data_files"
        if path_prefix
        else f"datasets/{dataset_id}/data_files"
    )
    s3_key = f"{base_path}/{safe_rel}"
    with allure.step(f"PUT manual upload s3://{bucket}/{s3_key}"):
        put_object_via_gateway(
            client,
            bucket=bucket,
            object_key=s3_key,
            body=content,
            content_type=content_type,
        )
    return {
        "key": s3_key,
        "url": f"s3://{bucket}/{s3_key}",
        "size": len(content),
        "originalName": relative_path,
    }


def register_uploaded_files(
    client: PlatformClient,
    prefix: str,
    dataset_id: str,
    uploaded_files: list[dict[str, Any]],
) -> httpx.Response:
    """PUT dataset with uploadedFiles (triggers manifest + auto-commit on first batch)."""
    with allure.step("Register uploaded files on dataset"):
        return client.put_dataset(
            prefix,
            dataset_id,
            {"uploadedFiles": uploaded_files},
        )
