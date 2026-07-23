"""KB-processor shared helpers.

Functions extracted from `processor.py` so both the in-process orchestrator
(processor.py main + partition modes) and the Temporal-driven path
(temporal_worker.py activities) can call the same code without one importing
from the other. Pre-unification these lived in processor.py and
temporal_worker.py reached across to grab them, which made the dependency
direction confusing — and the helpers were private (`_kb_s3_prefix`),
which doesn't survive a clean cross-module import. Promoted to public
names here so both call sites can import directly.

Anything that needs more than a function (state, classes, orchestration)
stays in its own module. This file is intentionally a flat collection of
pure-ish helpers — no class hierarchy, no shared state.
"""

from typing import Any, Dict, List, Optional

import requests
from observability_client_runtime import get_logger

from data_sources.base import DataSource
from data_sources.structured import StructuredDataSource
from data_sources.unstructured import UnstructuredDataSource
from utils.auth import get_access_token, get_authenticated_session
from utils.config import Config

logger = get_logger()


def kb_s3_prefix(kb_id: str, s3_path_prefix: str = "") -> str:
    """Build the storage prefix for a knowledge base.

    Pre-unification this lived as a private `_kb_s3_prefix` in processor.py
    and temporal_worker.py imported it from there (private-name import,
    fragile across refactors). Public here so the two call sites share one
    definition. `s3_path_prefix` is the project home-dir convention
    (e.g. `projects/<projectId>`) — empty for legacy installs.
    """
    if s3_path_prefix:
        return f"{s3_path_prefix}/knowledgebases/{kb_id}"
    return f"knowledgebases/{kb_id}"


def _extract_s3_key_from_uri(uri: str) -> str:
    """Extract the S3 key from a URI; passthrough for plain keys."""
    if not isinstance(uri, str) or not uri:
        return ""
    s = uri.strip()
    if s.startswith("s3://"):
        rest = s[5:].lstrip("/")
        if "/" in rest:
            return rest.split("/", 1)[1]  # drop bucket segment
        return rest
    return s


def normalize_manifest_file_keys(raw_files: List[Any]) -> List[str]:
    """Normalize a manifest's `files` array to a list of S3 key strings.

    Accepts the three shapes producers actually emit:
      - workflow-engine work plan: dicts with "key" (and size, lastModified)
      - config-service manifest:   dicts with "uri" or "fileName"
      - legacy:                    raw string keys
    URI values of the form `s3://bucket/key` are reduced to `key` so the
    downstream prefix-match works regardless of whether the producer
    qualified the bucket.
    """
    keys: List[str] = []
    for f in raw_files or []:
        if isinstance(f, str):
            keys.append(_extract_s3_key_from_uri(f))
        elif isinstance(f, dict):
            raw = f.get("key") or f.get("uri") or f.get("fileName") or ""
            k = _extract_s3_key_from_uri(raw) if isinstance(raw, str) else str(raw)
            if k:
                keys.append(k)
    return [k for k in keys if k]


def create_data_source(
    config: Config, file_keys: Optional[List[str]] = None
) -> DataSource:
    """Build the appropriate `DataSource` for the configured dataset kind.

    Structured datasets read through Lakekeeper (Iceberg catalog) and need a
    fresh Keycloak token at each invocation. Unstructured datasets read
    files directly from the mounted bucket and don't need credentials —
    `file_keys`, when set, restricts the read to a partition slice.
    """
    if config.dataset_kind == "structured":
        logger.info(
            "Creating structured data source for table: %s", config.catalog_table_ref
        )

        token = get_access_token(
            keycloak_url=config.keycloak_internal_issuer,
            client_id=config.project_client_id,
            client_secret=config.project_client_secret,
        )

        return StructuredDataSource(
            catalog_table_ref=config.catalog_table_ref,
            lakekeeper_url=config.lakekeeper_url,
            warehouse_id=config.effective_warehouse_id(),
            token=token,
            text_columns=config.text_columns,
            s3_endpoint=config.s3_endpoint,
            s3_access_key=config.aws_access_key_id,
            s3_secret_key=config.aws_secret_access_key,
            s3_region=config.aws_region,
        )

    logger.info(
        "Creating unstructured data source for dataset: %s", config.source_dataset_id
    )
    return UnstructuredDataSource(
        dataset_id=config.source_dataset_id,
        s3_path_prefix=config.s3_path_prefix,
        file_keys=file_keys,
    )


def update_kb_status(
    config: Config,
    status: str,
    lance_table_path: Optional[str] = None,
    error_message: Optional[str] = None,
) -> None:
    """PUT the KB record's status (and optional lanceTablePath / errorMessage).

    Best-effort — a failed config-service call is logged but does not raise,
    because the Temporal activity owns the authoritative state machine and
    will retry the surrounding step. Raising here would convert a transient
    config-service hiccup into a workflow-level failure.
    """
    url = f"{config.config_service_url}/api/v1/projects/{config.project_id}/knowledgebases/{config.kb_id}"

    payload: Dict[str, Any] = {"status": status}
    if lance_table_path:
        payload["lanceTablePath"] = lance_table_path
    if error_message:
        payload["errorMessage"] = error_message

    try:
        session = get_authenticated_session(
            keycloak_url=config.keycloak_internal_issuer,
            client_id=config.project_client_id,
            client_secret=config.project_client_secret,
        )
        response = session.put(url, json=payload, timeout=30)
        response.raise_for_status()
        logger.info("Updated KB status to: %s", status)
    except requests.exceptions.RequestException as e:
        logger.warning("Failed to update KB status: %s", e)
