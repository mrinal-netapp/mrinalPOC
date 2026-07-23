"""Catalog (managed) MCP tools suite — GCNV read-only logs (`gcnv_logs_mcp`).

Self-provisioning, GCP-env-gated flow against a live config-service:

    project -> gcp credential -> managed MCP server (gcnv_logs_mcp) -> runtime ready

Mirrors ``test_gcnv_mcp.py`` for the read-only GCNV logs catalog entry. The
suite creates its own GCP credential and managed MCP server, verifies each
step, then polls the managed runtime until the pod is running and ready.
Teardown (gated by ``INTEGRATION_CLEANUP``) deletes the MCP server, credential,
and project.

Skips entirely unless GCP settings are present
(``IntegrationSettings.has_gcp_metrics()``): ``GCP_PROJECT_ID`` +
``GCP_SERVICE_ACCOUNT_JSON_FILE`` (+ optional ``GCP_DEFAULT_REGION``).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.waits import wait_for_project_ready
from lib.models.credential_request import CredentialCreateRequest
from lib.models.managed_mcp_server_request import ManagedMcpServerRequest
from lib.models.resources import SuiteResources
from lib.utils.waits import wait_for_mcp_runtime_ready

pytestmark = [pytest.mark.tools, pytest.mark.gcp]

CATALOG_ID = "gcnv_logs_mcp"
# Managed MCP server names must match ^[a-zA-Z0-9_]+$ (no hyphens).
_MCP_NAME_PREFIX = "gcnv_logs_mcp"
_RUNTIME_TIMEOUT_SEC = 500
_RUNTIME_POLL_INTERVAL_SEC = 30


def _underscore_name(prefix: str) -> str:
    """Build an underscore-only unique name accepted by the MCP name regex."""
    return f"{prefix}_{int(time.time())}"


@dataclass
class GcnvLogsMcpContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    settings: IntegrationSettings
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    mcp_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestGcnvLogsMcp:
    """Ordered self-provisioning catalog-MCP flow for `gcnv_logs_mcp`."""

    catalog_id = CATALOG_ID
    mcp_name_prefix = _MCP_NAME_PREFIX

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> GcnvLogsMcpContext:
        """Before/after class: GCP gate, build client + shared context."""
        if not integration_settings.has_gcp_metrics():
            pytest.skip(
                "GCP settings not set — set GCP_PROJECT_ID and "
                "GCP_SERVICE_ACCOUNT_JSON_FILE in tests/integration/.env.local"
            )
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        state = GcnvLogsMcpContext(
            config_client=config_client,
            settings=integration_settings,
            config=agent_service_config,
        )
        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        config_client.close()

    def test_create_project(self, ctx: GcnvLogsMcpContext) -> None:
        """Create a fresh project that anchors the GCNV-logs managed-MCP flow."""
        name = _underscore_name("e2e_tools_gcnv_logs")
        resp = ctx.config_client.create_project(
            name, metadata={"source": "pytest-tools-gcnv-logs"}
        )
        log_exchange("POST", "api/v1/projects", {"name": name}, resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.project_id = data["id"]
        assert ctx.project_id, "project id missing in response"
        ctx.resources.add_project(ctx.project_id)
        # POST /projects returns before the async project-init workflow finishes;
        # gate here so downstream create calls don't race it (409/502).
        wait_for_project_ready(ctx.config_client, ctx.project_id)

    def test_add_gcnv_cred(self, ctx: GcnvLogsMcpContext) -> None:
        """Create the GCP credential the managed MCP server will reference."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_project did not succeed")
        request = CredentialCreateRequest(
            name=_underscore_name("gcnv_logs_cred"),
            provider="gcp",
            secret_data={"service_account_json": ctx.settings.gcp_service_account_json},
            metadata={
                "project_id": ctx.settings.gcp_project_id,
                "default_region": ctx.settings.gcp_default_region,
            },
        )
        url = ctx.config_client.credentials_url(ctx.project_id)
        resp = ctx.config_client.create_credential(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.credential_id = data["id"]
        assert ctx.credential_id, "credential id missing in response"
        assert data.get("provider") == "gcp"
        assert "secretData" not in data, "secretData must not be echoed"
        ctx.resources.add_credential(ctx.credential_id, ctx.project_id)

    def test_get_gcnv_cred_details(self, ctx: GcnvLogsMcpContext) -> None:
        """Fetch the credential and verify its non-secret shape."""
        if not ctx.credential_id:
            pytest.skip("no credential — test_add_gcnv_cred did not succeed")
        url = f"{ctx.config_client.credentials_url(ctx.project_id)}/{ctx.credential_id}"
        resp = ctx.config_client.get_credential(ctx.project_id, ctx.credential_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.credential_id
        assert data.get("provider") == "gcp"
        assert data.get("metadata", {}).get("project_id") == ctx.settings.gcp_project_id
        assert "secretData" not in data, "secretData must not be returned by GET"

    def test_add_gcnv_logs_mcp(self, ctx: GcnvLogsMcpContext) -> None:
        """Create the managed GCNV-logs MCP server (begins async provisioning)."""
        if not ctx.credential_id:
            pytest.skip("no credential — test_add_gcnv_cred did not succeed")
        request = ManagedMcpServerRequest(
            name=_underscore_name(self.mcp_name_prefix),
            catalog_id=self.catalog_id,
            runtime_credential_id=ctx.credential_id,
            env_overrides={
                "GOOGLE_CLOUD_PROJECT": ctx.settings.gcp_project_id,
                "GOOGLE_CLOUD_LOCATION": ctx.settings.gcp_default_region,
            },
        )
        url = ctx.config_client.mcp_servers_url(ctx.project_id)
        resp = ctx.config_client.add_mcp_server(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.mcp_id = data["id"]
        assert ctx.mcp_id, "mcp id missing in response"
        assert data.get("catalogId") == self.catalog_id
        assert data.get("runtimeStatus") == "provisioning"
        assert data.get("syncStatus") == "pending"
        ctx.resources.add_mcp_server(ctx.mcp_id, ctx.project_id)

    def test_get_gcnv_mcp_details(self, ctx: GcnvLogsMcpContext) -> None:
        """Poll runtime-status until the managed pod is running and ready."""
        if not ctx.mcp_id:
            pytest.skip("no mcp server — test_add_gcnv_logs_mcp did not succeed")
        log.info(
            f"  [poll] waiting for mcp {ctx.mcp_id} runtime ready "
            f"(timeout={_RUNTIME_TIMEOUT_SEC}s, interval={_RUNTIME_POLL_INTERVAL_SEC}s)"
        )
        body = wait_for_mcp_runtime_ready(
            lambda: ctx.config_client.get_mcp_runtime_status(ctx.project_id, ctx.mcp_id),
            timeout_sec=_RUNTIME_TIMEOUT_SEC,
            poll_interval_sec=_RUNTIME_POLL_INTERVAL_SEC,
        )
        assert body.get("runtimeStatus") == "running", body
        assert body.get("ready") is True, body
