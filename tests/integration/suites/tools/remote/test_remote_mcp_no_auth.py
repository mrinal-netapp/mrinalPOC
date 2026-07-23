"""Remote MCP tools suite — no-auth remote weather MCP.

Registers a remote MCP server (``deploymentType: "remote"``, ``authType:
"none"``) pointing at an externally supplied weather MCP URL, then validates
the persisted record. Config-service live-connects at create time and requires
at least one tool, so the server is returned ``status: "connected"`` / ``syncStatus: "synced"``.

    project -> remote MCP server (weather) -> validate details

Skips entirely unless ``WEATHER_MCP_SERVER_URL`` is set. The transport comes
from ``WEATHER_MCP_CONNECTION_TYPE`` (defaults to ``streamable-http``). Teardown
(gated by ``INTEGRATION_CLEANUP``) deletes the remote MCP server and the
suite-created project.

Note: the strict health check means this suite fails in an environment where
the remote server is unreachable or config-service cannot register it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log_exchange
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.waits import wait_for_project_ready
from lib.models.remote_mcp_server_request import RemoteMcpServerRequest
from lib.models.resources import SuiteResources

pytestmark = [pytest.mark.tools]

# Remote MCP server names must match ^[a-zA-Z0-9_]+$ (no hyphens).
_MCP_NAME_PREFIX = "weather_mcp"


def _underscore_name(prefix: str) -> str:
    """Build an underscore-only unique name accepted by the MCP name regex."""
    return f"{prefix}_{int(time.time())}"


@dataclass
class RemoteMcpContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    mcp_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestRemoteMcpNoAuth:
    """Ordered register-and-validate flow for a no-auth remote weather MCP."""

    mcp_name_prefix = _MCP_NAME_PREFIX

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> RemoteMcpContext:
        """Before/after class: env gate, build client + shared context."""
        if not agent_service_config.weather_mcp_server_url:
            pytest.skip(
                "WEATHER_MCP_SERVER_URL not set — set it in "
                "tests/integration/.env.local"
            )
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        state = RemoteMcpContext(
            config_client=config_client,
            config=agent_service_config,
        )
        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        config_client.close()

    def test_create_project(self, ctx: RemoteMcpContext) -> None:
        """Create a fresh project that anchors the remote-MCP flow."""
        name = _underscore_name("e2e_tools_remote_weather")
        resp = ctx.config_client.create_project(
            name, metadata={"source": "pytest-tools-remote"}
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

    def test_add_custom_weather_mcp(self, ctx: RemoteMcpContext) -> None:
        """Register the no-auth remote weather MCP server."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_project did not succeed")
        request = RemoteMcpServerRequest(
            name=_underscore_name(self.mcp_name_prefix),
            url=ctx.config.weather_mcp_server_url,
            transport=ctx.config.weather_mcp_connection_type,
            auth_type="none",
        )
        url = ctx.config_client.mcp_servers_url(ctx.project_id)
        resp = ctx.config_client.add_custom_mcp(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.mcp_id = data["id"]
        assert ctx.mcp_id, "mcp id missing in response"
        assert data.get("deploymentType") == "remote"
        ctx.resources.add_mcp_server(ctx.mcp_id, ctx.project_id)

    def test_validate_weather_mcp_details(self, ctx: RemoteMcpContext) -> None:
        """Fetch the remote server by id and validate its fields + health."""
        if not ctx.mcp_id:
            pytest.skip("no mcp server — test_add_custom_weather_mcp did not succeed")
        url = f"{ctx.config_client.mcp_servers_url(ctx.project_id)}/{ctx.mcp_id}"
        resp = ctx.config_client.get_mcp_server(ctx.project_id, ctx.mcp_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.mcp_id
        assert data.get("name"), "mcp name missing in response"
        assert data.get("deploymentType") == "remote"
        assert data.get("transport") == ctx.config.weather_mcp_connection_type
        assert data.get("url") == ctx.config.weather_mcp_server_url
        assert data.get("authType") == "none"
        assert data.get("status") == "connected", (
            f"remote weather MCP not connected: status={data.get('status')!r}, "
            f"syncStatus={data.get('syncStatus')!r}"
        )
        assert data.get("syncStatus") == "synced", (
            f"remote weather MCP not synced: status={data.get('status')!r}, "
            f"syncStatus={data.get('syncStatus')!r}"
        )
