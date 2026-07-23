"""GCS object-store explorer adapter (resource scope, S3-shaped listBuckets/listPath)."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict

from .base import ExplorerError, ExplorerResponse, ProviderAdapter
from .gcp_adapter import GCPAdapter, _build_credentials
from activities.gcp_sa_json import resolve_gcp_service_account_json

logger = logging.getLogger(__name__)


def _resolve_project_id(connector_config: Dict[str, Any], credential: Dict[str, str]) -> str:
    project_id = str(connector_config.get("project_id", "") or "").strip()
    if project_id:
        return project_id
    sa_json = resolve_gcp_service_account_json(credential)
    if sa_json:
        try:
            return str(json.loads(sa_json).get("project_id", "") or "")
        except json.JSONDecodeError:
            return ""
    return ""


class GCSAdapter(ProviderAdapter):
    """Resource-scope GCS browsing for objectstore connectors (provider=gcs)."""

    def __init__(self) -> None:
        self._gcp = GCPAdapter()

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        try:
            creds = _build_credentials(credential)
            project_id = _resolve_project_id(connector_config, credential)

            if action == "listBuckets":
                return self._gcp._list_buckets(creds, project_id)
            if action == "listPath":
                return self._gcp._list_path(creds, project_id, payload)
            return ExplorerResponse(
                error=ExplorerError(
                    "UNSUPPORTED_ACTION",
                    f"Action '{action}' not supported by GCS adapter",
                )
            )
        except json.JSONDecodeError as e:
            return ExplorerResponse(
                error=ExplorerError("CREDENTIAL_ERROR", f"Invalid service account JSON: {e}")
            )
        except Exception as e:
            logger.exception("GCS adapter error: action=%s", action)
            return ExplorerResponse(error=ExplorerError("PROVIDER_ERROR", str(e)))
