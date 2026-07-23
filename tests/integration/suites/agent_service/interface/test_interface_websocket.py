"""Agent-service interface suite — WebSocket (``/ws``).

Chained end-to-end flow against a live deployment, exercising the bidirectional
WebSocket transport via
:meth:`AgentServiceClient.invoke_agent_ws` /
:meth:`AgentServiceClient.invoke_team_ws`:

    project -> model -> agent -> ws -> re-ws
            -> fresh (unmaterialised) team -> ws team (xfail)

Each WS turn is fully validated: a clean handshake, a leading ``started``
frame, non-empty concatenated ``token`` text, no ``error`` frame, and a
terminal ``completed`` frame whose ``metadata.invokeResponse`` matches the sync
``InvokeResponse`` contract (``output`` / ``durationMs`` / ``agentId``).

Auth is controlled by ``ENABLE_AUTH_AGENT_SERVICE``: when enabled, the client
attaches the Keycloak bearer token to the WS handshake (handled in the client).

This file is fully self-contained: it provisions its own project, model,
agents, and team in the ``ctx`` fixture and cleans them up on teardown.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.client import AgentServiceClient
from lib.agent_service.env import AgentServiceConfig
from lib.agent_service.websocket import EVENT_STARTED, WS_NORMAL_CLOSURE, WSResult
from lib.common.logger import log, log_exchange, log_ws
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources
from lib.models.team_creation_request import TeamCreationRequest, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.interface,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-interface-ws"
PROJECT_SOURCE = "pytest-agent-interface-ws"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


@dataclass
class WebSocketInterfaceContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    project_name: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    agent_id: str = ""
    agent_id_2: str = ""
    # A dedicated team created by test_create_ws_team and intentionally never
    # invoked over HTTP/SSE, so it stays unmaterialised in the server registry
    # and reliably reproduces the WS team-resolution bug.
    ws_team_id: str = ""
    session_id: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


def _assert_ws(result: WSResult) -> dict[str, Any]:
    """Validate a WS invoke turn end-to-end and return its ``invokeResponse``.

    Asserts the full WebSocket contract and returns the decoded
    ``completed.metadata.invokeResponse`` envelope (the same shape REST sync
    returns) so callers can make per-step assertions on it.
    """
    assert result.connect_error is None, f"WS handshake/connect failed: {result.connect_error}"
    assert result.close_code in (None, WS_NORMAL_CLOSURE), (
        f"unexpected WS close code: {result.close_code}"
    )

    assert result.events, "no WS frames received"
    assert result.events[0].event == EVENT_STARTED, (
        f"first frame was {result.events[0].event!r}, expected {EVENT_STARTED!r}"
    )
    assert result.error_event is None, f"stream emitted error: {result.error_event}"

    completed = result.completed_event
    assert completed is not None, "no terminal 'completed' frame"

    assert result.text, "no streamed token text"

    invoke_response = result.invoke_response
    assert isinstance(invoke_response, dict), (
        "completed.metadata.invokeResponse missing or malformed"
    )
    assert invoke_response.get("output"), "empty invokeResponse output"
    assert "durationMs" in invoke_response, "invokeResponse missing durationMs"
    assert invoke_response.get("agentId"), "invokeResponse missing agentId"
    return invoke_response


class TestWebSocketProtocol:
    """Ordered WebSocket flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> WebSocketInterfaceContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = WebSocketInterfaceContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: WebSocketInterfaceContext) -> None:
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
        self, ctx: WebSocketInterfaceContext
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

    def test_add_and_validate_model(self, ctx: WebSocketInterfaceContext) -> None:
        """Reuse ``LLM_MODEL_ID`` or register + validate a model on the credential."""
        if not ctx.project_id:
            pytest.skip("no project — test_create_and_validate_project did not succeed")

        env_model_id = ctx.config.model_id
        if env_model_id:
            log.info(f"  [setup] reusing model from LLM_MODEL_ID env: {env_model_id}")
            ctx.model_ids.append(env_model_id)
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
        ctx.model_ids.append(model_id)

    def test_create_agent(self, ctx: WebSocketInterfaceContext) -> None:
        """Create the primary assistant agent for the WebSocket-interface suite.

        Test scenario:
            Skip if no models exist. POST an AgentCreationRequest with role
            assistant bound to the shared model and store the agent id on the
            context.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, and the
            echoed modelId and role match what was requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        name = unique_name("e2e-interface-ws-agent")
        request = AgentCreationRequest(
            name=name,
            role="assistant",
            system_prompt="You are a helpful assistant.",
            model_id=ctx.model_ids[0],
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), f"unexpected agent id: {ctx.agent_id!r}"
        assert data.get("modelId") == ctx.model_ids[0]
        assert data.get("role") == "assistant"
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_get_agent_details(self, ctx: WebSocketInterfaceContext) -> None:
        """Fetch the created agent from config-service and validate all fields.

        Test scenario:
            Skip if no agent exists. GET the agent by id from config-service and
            assert that every field echoed in the response matches the creation
            request: id, name, role, modelId, and systemPrompt.

        Validation we are covering:
            HTTP 200; ``id`` matches the stored agent id; ``name`` is non-empty;
            ``role`` is ``assistant``; ``modelId`` matches the provisioned model;
            and ``systemPrompt`` is echoed back as non-empty.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}"
        )
        resp = ctx.config_client.get_agent(ctx.project_id, ctx.agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.agent_id, "agent id mismatch"
        assert data.get("name"), "agent name missing in get-agent response"
        assert data.get("role") == "assistant", (
            f"unexpected role: {data.get('role')!r}"
        )
        assert data.get("modelId") == ctx.model_ids[0], (
            f"model id mismatch: {data.get('modelId')!r} != {ctx.model_ids[0]!r}"
        )
        assert data.get("systemPrompt"), "systemPrompt missing in get-agent response"

    def test_invoke_agent(self, ctx: WebSocketInterfaceContext) -> None:
        """Invoke the agent over WebSocket and capture the session id.

        Test scenario:
            Skip if no agent exists. Open a WS turn to the agent's /ws endpoint
            with a fixed prompt, validate the full WS contract, and store the
            returned sessionId on the context.

        Validation we are covering:
            Via _assert_ws: clean handshake and close code, a leading started
            frame, non-empty token text, no error frame, and a completed frame
            whose invokeResponse has output, durationMs, and agentId.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PROTOCOL_WS_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/ws"
        )
        result = ctx.agent.invoke_agent_ws(ctx.project_id, ctx.agent_id, body)
        log_ws("WS", url, body, result)
        invoke_response = _assert_ws(result)
        ctx.session_id = invoke_response.get("sessionId")

    def test_invoke_agent_again(self, ctx: WebSocketInterfaceContext) -> None:
        """Re-invoke the agent over WebSocket, reusing the prior session if set.

        Test scenario:
            Skip if no agent exists. Open a second WS turn to /ws, attaching the
            stored sessionId when present, and validate the WS contract.

        Validation we are covering:
            Via _assert_ws the full WebSocket contract holds, plus the decoded
            invokeResponse output is non-empty.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body: dict[str, object] = {"input": "What is 2 + 2? Reply with only the number."}
        if ctx.session_id:
            body["sessionId"] = ctx.session_id
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/ws"
        )
        result = ctx.agent.invoke_agent_ws(ctx.project_id, ctx.agent_id, body)
        log_ws("WS", url, body, result)
        invoke_response = _assert_ws(result)
        assert invoke_response.get("output"), "empty agent output"

    def test_create_ws_team(self, ctx: WebSocketInterfaceContext) -> None:
        """Create a second agent and a team used only by the WS team invoke.

        Test scenario:
            Skip if the primary agent or model is not provisioned. Create a
            second researcher agent and a sequential team from the two agents.
            This team is intentionally never invoked over HTTP/SSE before the WS
            team test, so it stays unmaterialised in the server registry and
            reliably reproduces the WS team-resolution failure.

        Validation we are covering:
            HTTP 201 for both the agent and team creation; the second agent id
            matches the ag-xxxxxxxx pattern; and a non-empty ws team id is
            returned and stored on the context.
        """
        if not ctx.agent_id or not ctx.model_ids:
            pytest.skip("prerequisites missing (agent / model)")
        agent2_name = unique_name("e2e-interface-ws-agent2")
        agent2_request = AgentCreationRequest(
            name=agent2_name,
            role="researcher",
            system_prompt="You research and summarize concisely.",
            model_id=ctx.model_ids[0],
        )
        agent_url = ctx.config_client.agents_url(ctx.project_id)
        resp2 = ctx.config_client.create_agent(ctx.project_id, agent2_request)
        log_exchange("POST", agent_url, agent2_request.to_body(), resp2)
        assert resp2.status_code == 201, resp2.text
        ctx.agent_id_2 = resp2.json()["id"]
        assert AGENT_ID_RE.match(ctx.agent_id_2)
        ctx.resources.add_agent(ctx.agent_id_2, ctx.project_id)

        team_request = TeamCreationRequest(
            name=unique_name("e2e-interface-ws-team"),
            orchestration_policy="sequential",
            members=[
                TeamMemberRef.agent(ctx.agent_id),
                TeamMemberRef.agent(ctx.agent_id_2),
            ],
        )
        team_url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, team_request)
        log_exchange("POST", team_url, team_request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        ctx.ws_team_id = resp.json()["id"]
        assert ctx.ws_team_id, "ws team id missing in response"
        ctx.resources.add_team(ctx.ws_team_id, ctx.project_id)

    def test_get_team_details(self, ctx: WebSocketInterfaceContext) -> None:
        """Fetch the created WebSocket team from config-service and validate all fields.

        Test scenario:
            Skip if no ws team exists. GET the team by id from config-service and
            assert that every field echoed in the response matches the creation
            request: id, name, orchestrationPolicy, and the member list.

        Validation we are covering:
            HTTP 200; ``id`` matches the stored ws_team_id; ``name`` is
            non-empty; ``orchestrationPolicy`` is ``sequential``; ``members``
            has exactly two entries; and both ``agent_id`` and ``agent_id_2``
            appear in the member list.
        """
        if not ctx.ws_team_id:
            pytest.skip("no ws team — test_create_ws_team did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.ws_team_id}"
        )
        resp = ctx.config_client.get_team(ctx.project_id, ctx.ws_team_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.ws_team_id, "team id mismatch"
        assert data.get("name"), "team name missing in get-team response"
        assert data.get("orchestrationPolicy") == "sequential", (
            f"unexpected orchestrationPolicy: {data.get('orchestrationPolicy')!r}"
        )
        members = data.get("members") or []
        assert len(members) == 2, f"expected 2 members, got {len(members)}"
        member_ids = {m.get("memberId") for m in members}
        assert ctx.agent_id in member_ids, (
            f"agent {ctx.agent_id!r} missing in team members {member_ids!r}"
        )
        assert ctx.agent_id_2 in member_ids, (
            f"agent2 {ctx.agent_id_2!r} missing in team members {member_ids!r}"
        )

    @pytest.mark.xfail(
        reason=(
            "Known agent-service limitation: the WebSocket handler resolves teams "
            "via the eager registry (ws_handler.py get_in_project/default_for_project) "
            "instead of the lazy get_or_load_team path used by HTTP/SSE "
            "(routes.py _resolve_via_lazy). This case invokes a team that was created "
            "fresh (test_create_ws_team) and never invoked over HTTP/SSE, so it is not "
            "materialised in the registry and the server returns an 'error' frame "
            "('Failed to build execution context'). Remove this marker once the WS "
            "handler lazily loads teams."
        ),
        strict=False,
    )
    def test_invoke_team(self, ctx: WebSocketInterfaceContext) -> None:
        """Invoke the fresh, unmaterialised team over WebSocket.

        Test scenario:
            Skip if no ws team exists. Open a WS turn to the team's /ws endpoint
            with a summarization prompt. Marked xfail because the WS handler
            resolves teams via the eager registry rather than the lazy load path
            used by HTTP/SSE, so this unmaterialised team yields an error frame.

        Validation we are covering:
            Via _assert_ws the full WebSocket contract holds, plus the decoded
            invokeResponse team output is non-empty.
        """
        if not ctx.ws_team_id:
            pytest.skip("no ws team — test_create_ws_team did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.ws_team_id}/ws"
        )
        result = ctx.agent.invoke_team_ws(ctx.project_id, ctx.ws_team_id, body)
        log_ws("WS", url, body, result)
        invoke_response = _assert_ws(result)
        assert invoke_response.get("output"), "empty team output"
