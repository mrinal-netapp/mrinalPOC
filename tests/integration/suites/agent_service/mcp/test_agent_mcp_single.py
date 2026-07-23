"""Agent-service single-agent remote-MCP tool-call suite.

Chained end-to-end flow against a live deployment:

    project -> model -> agent (with remote MCP) -> simple invoke -> tool invoke

Provisioning uses config-service (``ConfigServiceClient``); invokes use
agent-service (``AgentServiceClient``). The agent is created with a remote MCP
server (``WEATHER_MCP_ID``) attached so it has access to the meteo weather MCP
tools. Two invocations are made:

1. A simple greeting — asserts the agent responds without errors.
2. An air-quality query — asserts that at least one MCP tool was called
   (``toolExecutions`` non-empty in the agent trace).

State flows between ordered methods through a single class-scoped
``McpSingleRemoteContext``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.agent_invoke_request import AgentInvocationRequest
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.mcp,
]

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-mcp"
PROJECT_SOURCE = "pytest-mcp"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

_AIR_QUALITY_QUERY = (
    "Use the air_quality tool to get the current air quality in Bengaluru, India. "
    "The coordinates are latitude 12.9716, longitude 77.5946. "
    "Request hourly pm2_5 and nitrogen_dioxide for 1 forecast day."
)


@dataclass
class McpSingleRemoteContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestMcpSingleRemote:
    """Ordered single-agent remote-MCP tool-call flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings,
        agent_service_config: AgentServiceConfig,
    ) -> McpSingleRemoteContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = McpSingleRemoteContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )

        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: McpSingleRemoteContext) -> None:
        """Reuse a healthy ``PROJECT_ID`` or create + readiness-gate a project."""
        env_project_id = ctx.config.project_id
        if env_project_id:
            resp = ctx.config_client.get_project_service_account(env_project_id)
            log_exchange(
                "GET",
                f"{ctx.config.config_service_url}/api/v1/projects/{env_project_id}"
                "/service-account",
                None,
                resp,
            )
            if resp.status_code == 200:
                log.info(f"  [setup] reusing healthy project PROJECT_ID={env_project_id}")
                ctx.project_id = env_project_id
                return
            log.info(
                f"  [setup] PROJECT_ID={env_project_id} not healthy "
                f"(HTTP {resp.status_code}) — creating a new project"
            )

        name = unique_name(PROJECT_NAME_PREFIX)
        metadata = {"source": PROJECT_SOURCE}
        url = f"{ctx.config.config_service_url}/api/v1/projects"
        resp = ctx.config_client.create_project(name, metadata=metadata)
        log_exchange("POST", url, {"name": name, "metadata": metadata}, resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        project_id = data["id"]
        assert project_id, "project id missing in response"
        ctx.resources.add_project(project_id)
        wait_for_project_ready(
            ctx.config_client,
            project_id,
            timeout_sec=PROJECT_READY_TIMEOUT_SEC,
            poll_interval_sec=PROJECT_READY_POLL_SEC,
        )
        ctx.project_id = project_id
        if hasattr(ctx, "project_name"):
            ctx.project_name = data.get("name", name)

    def test_add_and_validate_azure_openai_cred(
        self, ctx: McpSingleRemoteContext
    ) -> None:
        """Reuse a healthy ``AZURE_OPENAI_CRED_ID`` or create + validate a cred."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        if ctx.config.model_id:
            log.info("LLM_MODEL_ID set — skipping Azure credential provisioning")
            return

        env_cred_id = ctx.config.azure_openai_cred_id
        if env_cred_id:
            resp = ctx.config_client.get_credential(ctx.project_id, env_cred_id)
            log_exchange(
                "GET",
                f"{ctx.config_client.credentials_url(ctx.project_id)}/{env_cred_id}",
                None,
                resp,
            )
            if resp.status_code == 200:
                log.info(
                    f"  [setup] reusing healthy credential "
                    f"AZURE_OPENAI_CRED_ID={env_cred_id}"
                )
                ctx.credential_id = env_cred_id
                return
            log.info(
                f"  [setup] AZURE_OPENAI_CRED_ID={env_cred_id} not healthy "
                f"(HTTP {resp.status_code}) — creating a new credential"
            )

        provisioner = ModelProvisioner(ctx.config_client, on_exchange=log_exchange)
        credential_id = provisioner.add_azure_openai_credentials(ctx.project_id)
        ctx.resources.add_credential(credential_id, ctx.project_id)
        resp = ctx.config_client.get_credential(ctx.project_id, credential_id)
        log_exchange(
            "GET",
            f"{ctx.config_client.credentials_url(ctx.project_id)}/{credential_id}",
            None,
            resp,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == credential_id
        assert data.get("provider") == "azure"
        ctx.credential_id = credential_id

    def test_add_and_validate_model(self, ctx: McpSingleRemoteContext) -> None:
        """Reuse ``LLM_MODEL_ID`` or register + validate a model on the credential."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        env_model_id = ctx.config.model_id
        if env_model_id:
            log.info(f"  [setup] reusing model from LLM_MODEL_ID env: {env_model_id}")
            ctx.model_id = env_model_id
            return

        if not ctx.credential_id:
            pytest.skip(
                "no credential — test_add_and_validate_azure_openai_cred did not succeed"
            )
        provisioner = ModelProvisioner(ctx.config_client, on_exchange=log_exchange)
        model_id = provisioner.add_llm_models(ctx.project_id, ctx.credential_id)
        assert model_id, "model id missing in response"
        assert UUID_RE.match(model_id), f"unexpected model id: {model_id!r}"
        ctx.resources.add_model(model_id, ctx.project_id)
        ctx.model_id = model_id

    def test_create_agent_with_mcp(self, ctx: McpSingleRemoteContext) -> None:
        """Create an agent with the weather MCP server attached.

        Test scenario:
            Skips if no model exists or ``WEATHER_MCP_ID`` is not set in the
            environment. POSTs an ``AgentCreationRequest`` with
            ``mcpServerIds`` containing the weather MCP server id.

        Validation we are covering:
            Asserts HTTP 201, a non-empty agent id, that the echoed ``modelId``
            matches, and that ``mcpServerIds`` contains the requested MCP id.
        """
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        if not ctx.config.weather_mcp_id:
            pytest.skip("WEATHER_MCP_ID not set — skipping MCP agent creation")
        request = AgentCreationRequest(
            name=unique_name("weather_mcp_agent"),
            role="assistant",
            system_prompt=(
                "You are a weather and air quality assistant. "
                "You MUST ALWAYS use the available tools to fetch real-time data. "
                "NEVER respond from memory or training data. "
                "For any weather or air quality question: "
                "1) Use the geocoding tool to get coordinates if needed. "
                "2) Call the relevant weather or air_quality tool with those coordinates. "
                "Always call tools before responding."
            ),
            description="Agent for weather and air quality queries via MCP",
            model_id=ctx.model_id,
            mcp_server_ids=[ctx.config.weather_mcp_id],
            function_choice_behavior="auto",
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id = data["id"]
        assert ctx.agent_id, "agent id missing in response"
        assert data.get("modelId") == ctx.model_id
        assert ctx.config.weather_mcp_id in (data.get("mcpServerIds") or []), (
            f"weather MCP id {ctx.config.weather_mcp_id!r} not in mcpServerIds: "
            f"{data.get('mcpServerIds')!r}"
        )
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_invoke_agent_simple(self, ctx: McpSingleRemoteContext) -> None:
        """Invoke the MCP agent with a simple greeting.

        Test scenario:
            Skips if no agent exists. Invokes with ``"Hi"`` and checks the
            agent responds normally without errors.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and ``durationMs`` present.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent_with_mcp did not succeed")
        request = AgentInvocationRequest(input="Hi")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output on simple greeting"
        assert "durationMs" in data

    def test_invoke_agent_with_tool_call(self, ctx: McpSingleRemoteContext) -> None:
        """Invoke the agent with an air-quality query and assert MCP tool was called.

        Test scenario:
            Skips if no agent exists. Invokes with a query that explicitly
            requests the ``air_quality`` tool for Bengaluru coordinates, then
            inspects ``citations.agentTrace`` to verify at least one MCP tool
            execution was recorded.

        Validation we are covering:
            Asserts HTTP 200, non-empty output, and that
            ``citations.agentTrace[*].toolExecutions`` contains at least one
            entry whose ``toolName`` includes ``"air_quality"`` — confirming
            the MCP tool was actually invoked rather than the LLM hallucinating
            an answer from training data.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent_with_mcp did not succeed")
        request = AgentInvocationRequest(input=_AIR_QUALITY_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output on air quality query"

        agent_trace = (data.get("citations") or {}).get("agentTrace") or []
        all_tool_calls = [
            execution.get("toolName", "")
            for step in agent_trace
            for execution in (step.get("toolExecutions") or [])
        ]
        air_quality_calls = [t for t in all_tool_calls if "air_quality" in t]
        assert air_quality_calls, (
            f"expected at least one air_quality tool call but got: {all_tool_calls!r}. "
            f"Agent output: {data.get('output', '')[:300]!r}"
        )
