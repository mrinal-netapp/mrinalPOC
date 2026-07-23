"""S3-compatible object store helpers (AWS S3, MinIO, s3gateway)."""

from __future__ import annotations

import time
from dataclasses import dataclass

import boto3
from botocore.config import Config

from lib.common.settings import IntegrationSettings


@dataclass(frozen=True)
class ObjectStoreTarget:
    """Connection parameters for an external object store."""

    label: str
    endpoint: str
    bucket: str
    prefix: str
    access_key_id: str
    secret_access_key: str
    region: str


@dataclass
class SeededObject:
    key: str
    marker: str


def object_store_from_s3_settings(settings: IntegrationSettings) -> ObjectStoreTarget:
    settings.require_s3compatible()
    return ObjectStoreTarget(
        label="s3compatible",
        endpoint=settings.s3_endpoint,
        bucket=settings.s3_bucket,
        prefix=settings.s3_prefix,
        access_key_id=settings.aws_access_key_id,
        secret_access_key=settings.aws_secret_access_key,
        region=settings.aws_region,
    )


def _s3_client(store: ObjectStoreTarget, *, verify_tls: bool):
    return boto3.client(
        "s3",
        endpoint_url=store.endpoint,
        aws_access_key_id=store.access_key_id,
        aws_secret_access_key=store.secret_access_key,
        region_name=store.region or "us-east-1",
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        verify=verify_tls,
    )


def seed_marker_object(
    store: ObjectStoreTarget,
    settings: IntegrationSettings,
    run_id: int | None = None,
) -> SeededObject:
    run_id = run_id or int(time.time())
    marker = f"{settings.e2e_search_marker_prefix}{run_id}"
    prefix = store.prefix.strip("/")
    object_name = f"integration-e2e-{run_id}.txt"
    key = f"{prefix}/{object_name}" if prefix else object_name

    body = (
        f"AgentStudio E2E integration marker {marker}\n"
        f"Run id {run_id}\n"
        "Used by pytest to verify KB retrieval.\n"
    ).encode("utf-8")

    _s3_client(store, verify_tls=settings.verify_tls).put_object(
        Bucket=store.bucket, Key=key, Body=body
    )
    return SeededObject(key=key, marker=marker)


def delete_seeded_object(
    store: ObjectStoreTarget, settings: IntegrationSettings, key: str
) -> None:
    _s3_client(store, verify_tls=settings.verify_tls).delete_object(
        Bucket=store.bucket, Key=key
    )
