"""Authenticated HTTP client for config, workflow, analytics, and KB APIs."""

from __future__ import annotations

import time
from typing import Any

import httpx

from .auth import KeycloakAuth
from .gateway_urls import gateway_roots
from .settings import IntegrationSettings


class PlatformClient:
    def __init__(self, settings: IntegrationSettings, auth: KeycloakAuth) -> None:
        self.settings = settings
        self._auth = auth
        self._urls = gateway_roots(settings.api_base_url)
        timeout = httpx.Timeout(120.0, connect=60.0)
        self._http = httpx.Client(
            verify=settings.verify_tls, timeout=timeout, trust_env=False
        )

    def close(self) -> None:
        self._http.close()

    def _headers(self) -> dict[str, str]:
        self._auth.refresh_if_needed(self._http)
        token = self._auth.get_access_token(self._http)
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, base: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{base}/{path.lstrip('/')}"
        return self._http.request(method, url, headers=self._headers(), **kwargs)

    def config_get(self, path: str) -> httpx.Response:
        return self._request("GET", self._urls["config"], path)

    def config_post(self, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
        return self._request("POST", self._urls["config"], path, json=body or {})

    def config_put(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._request("PUT", self._urls["config"], path, json=body)

    def config_put(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._request("PUT", self._urls["config"], path, json=body)

    def config_patch(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._request("PATCH", self._urls["config"], path, json=body)

    def config_delete(self, path: str) -> httpx.Response:
        return self._request("DELETE", self._urls["config"], path)

    # --- Projects ---

    def create_project(self, body: dict[str, Any]) -> httpx.Response:
        return self.config_post("api/v1/projects", body)

    # --- Credentials ---

    def create_credential(self, prefix: str, body: dict[str, Any]) -> httpx.Response:
        return self.config_post(f"{prefix}/credentials", body)

    def list_credentials(self, prefix: str) -> httpx.Response:
        return self.config_get(f"{prefix}/credentials")

    def get_credential(self, prefix: str, credential_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/credentials/{credential_id}")

    def patch_credential(
        self, prefix: str, credential_id: str, body: dict[str, Any]
    ) -> httpx.Response:
        return self.config_patch(f"{prefix}/credentials/{credential_id}", body)

    def delete_credential(self, prefix: str, credential_id: str) -> httpx.Response:
        return self.config_delete(f"{prefix}/credentials/{credential_id}")

    def validate_credential(self, prefix: str, credential_id: str) -> httpx.Response:
        return self.config_post(f"{prefix}/credentials/{credential_id}/validate", {})

    def credential_dependents(self, prefix: str, credential_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/credentials/{credential_id}/dependents")

    # --- Datasources ---

    def create_datasource(self, prefix: str, body: dict[str, Any]) -> httpx.Response:
        return self.config_post(f"{prefix}/datasources", body)

    def list_datasources(self, prefix: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasources")

    def get_datasource(self, prefix: str, datasource_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasources/{datasource_id}")

    def put_datasource(
        self, prefix: str, datasource_id: str, body: dict[str, Any]
    ) -> httpx.Response:
        return self.config_put(f"{prefix}/datasources/{datasource_id}", body)

    def delete_datasource(self, prefix: str, datasource_id: str) -> httpx.Response:
        return self.config_delete(f"{prefix}/datasources/{datasource_id}")

    def scan_datasource(
        self, prefix: str, datasource_id: str, body: dict[str, Any] | None = None
    ) -> httpx.Response:
        return self.config_post(
            f"{prefix}/datasources/{datasource_id}/scan", body or {}
        )

    def get_datasource_history(self, prefix: str, datasource_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasources/{datasource_id}/history")

    def record_datasource_connection_test_result(
        self,
        prefix: str,
        datasource_id: str,
        *,
        success: bool,
        message: str = "",
    ) -> httpx.Response:
        """Persist Test Connection outcome (same PATCH the Studio UI calls)."""
        body: dict[str, Any] = {"success": success}
        if message:
            body["message"] = message
        return self.config_patch(
            f"{prefix}/datasources/{datasource_id}/connection-test-result",
            body,
        )

    # --- Datasets ---

    def create_dataset(self, prefix: str, body: dict[str, Any]) -> httpx.Response:
        return self.config_post(f"{prefix}/datasets", body)

    def list_datasets(self, prefix: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasets")

    def get_dataset(self, prefix: str, dataset_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasets/{dataset_id}")

    def patch_dataset(
        self, prefix: str, dataset_id: str, body: dict[str, Any]
    ) -> httpx.Response:
        return self.config_patch(f"{prefix}/datasets/{dataset_id}", body)

    def put_dataset(
        self, prefix: str, dataset_id: str, body: dict[str, Any]
    ) -> httpx.Response:
        return self.config_put(f"{prefix}/datasets/{dataset_id}", body)

    def delete_dataset(self, prefix: str, dataset_id: str) -> httpx.Response:
        return self.config_delete(f"{prefix}/datasets/{dataset_id}")

    def import_dataset(self, project_id: str, dataset_id: str) -> httpx.Response:
        return self.config_post(f"api/v1/projects/{project_id}/datasets/{dataset_id}/import")

    def get_project_service_account(self, project_id: str) -> httpx.Response:
        return self.config_get(f"api/v1/projects/{project_id}/service-account")

    def create_project_service_account(self, project_id: str) -> httpx.Response:
        return self.config_post(f"api/v1/projects/{project_id}/service-account")

    def acquire_dataset(self, project_id: str, dataset_id: str) -> httpx.Response:
        return self.workflow_post(
            f"api/v1/projects/{project_id}/datasets/{dataset_id}/acquire"
        )

    def list_dataset_manifests(self, prefix: str, dataset_id: str) -> httpx.Response:
        return self.config_get(f"{prefix}/datasets/{dataset_id}/manifests")

    def commit_manifest(
        self, prefix: str, dataset_id: str, manifest_id: str
    ) -> httpx.Response:
        return self.config_put(
            f"{prefix}/datasets/{dataset_id}/manifests/{manifest_id}/status",
            {"status": "committed"},
        )

    def workflow_post(self, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
        return self._request("POST", self._urls["workflow"], path, json=body or {})

    def workflow_get(self, path: str) -> httpx.Response:
        return self._request("GET", self._urls["workflow"], path)

    def workflow_put(self, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
        return self._request("PUT", self._urls["workflow"], path, json=body or {})

    def workflow_delete(
        self, path: str, body: dict[str, Any] | None = None
    ) -> httpx.Response:
        return self._request("DELETE", self._urls["workflow"], path, json=body or {})

    # --- Project membership (read via config-service, writes via workflow-engine) ---

    def list_members(self, project_id: str) -> httpx.Response:
        """GET config-service members list: {projectId, members:[{userId, role, ...}]}."""
        return self.config_get(f"api/v1/projects/{project_id}/members")

    def add_member(self, project_id: str, email: str, role: str) -> httpx.Response:
        """POST workflow-engine add-member (async, 202 + workflowId)."""
        return self.workflow_post(
            f"api/v1/projects/{project_id}/members", {"email": email, "role": role}
        )

    def change_member_role(
        self, project_id: str, email: str, role: str
    ) -> httpx.Response:
        """PUT workflow-engine change-role (async, 202 + workflowId)."""
        return self.workflow_put(
            f"api/v1/projects/{project_id}/members/role", {"email": email, "role": role}
        )

    def remove_member(self, project_id: str, email: str) -> httpx.Response:
        """DELETE workflow-engine remove-member (async, 202 + workflowId)."""
        return self.workflow_delete(
            f"api/v1/projects/{project_id}/members", {"email": email}
        )

    def datasource_connection_test(
        self, project_prefix: str, datasource_id: str
    ) -> tuple[httpx.Response, httpx.Response]:
        """
        Platform connection test for a saved connector datasource (same as GUI).

        1. GET config-service datasource (connector_config + credential_id)
        2. POST workflow-engine …/connectors/{id}/test
        """
        ds_resp = self.config_get(f"{project_prefix}/datasources/{datasource_id}")
        if ds_resp.status_code != 200:
            return ds_resp, ds_resp
        body = ds_resp.json()
        connector_config = body.get("connector_config")
        credential_id = body.get("credential_id") or ""
        if not connector_config or not credential_id:
            return ds_resp, ds_resp
        project_id = project_prefix.rsplit("/projects/", 1)[-1]
        test_resp = self.workflow_post(
            f"api/v1/projects/{project_id}/connectors/{datasource_id}/test",
            {
                "connectorConfig": connector_config,
                "credentialId": credential_id,
            },
        )
        return ds_resp, test_resp

    def analytics_post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._request("POST", self._urls["analytics"], path, json=body)

    def kb_get(self, path: str) -> httpx.Response:
        return self._request("GET", self._urls["kb"], path)

    def kb_post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        return self._request("POST", self._urls["kb"], path, json=body)

    def project_prefix(self, project_id: str) -> str:
        return f"api/v1/projects/{project_id}"

    def mcp_server_post(self, project_id: str, body: dict[str, Any]) -> httpx.Response:
        return self.config_post(f"api/v1/projects/{project_id}/mcp-servers", body)

    def mcp_server_get(self, project_id: str, mcp_server_id: str) -> httpx.Response:
        return self.config_get(f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}")

    def mcp_server_delete(self, project_id: str, mcp_server_id: str) -> httpx.Response:
        return self.config_delete(
            f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}"
        )

    def mcp_server_test_connection(
        self, project_id: str, mcp_server_id: str
    ) -> httpx.Response:
        return self.config_post(
            f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}/test-connection",
            {},
        )

    def mcp_server_list_tools(self, project_id: str, mcp_server_id: str) -> httpx.Response:
        return self.config_get(
            f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}/tools"
        )

    def mcp_server_call_tool(
        self,
        project_id: str,
        mcp_server_id: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
    ) -> httpx.Response:
        return self.config_post(
            f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}/tools/call",
            {"toolName": tool_name, "arguments": arguments or {}},
        )

    def mcp_server_runtime_status(
        self, project_id: str, mcp_server_id: str
    ) -> httpx.Response:
        return self.config_get(
            f"api/v1/projects/{project_id}/mcp-servers/{mcp_server_id}/runtime-status"
        )


def unique_name(prefix: str) -> str:
    return f"{prefix}-{int(time.time())}"


def unique_mcp_name(prefix: str) -> str:
    """Unique name valid for MCP servers (SEP-986: ^[a-zA-Z0-9_]+$)."""
    return f"{prefix.replace('-', '_')}_{int(time.time())}"


def make_user_client(
    settings: IntegrationSettings, username: str, password: str
) -> PlatformClient:
    """Build a PlatformClient authenticated as an arbitrary realm user.

    Used by the role tests to act as the second (member/viewer) user without
    touching the shared session-scoped identity.
    """
    return PlatformClient(settings, KeycloakAuth(settings, username=username, password=password))
