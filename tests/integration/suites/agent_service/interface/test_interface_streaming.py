"""Agent-service interface suite — SSE streaming (``/invoke/stream``).

Chained end-to-end flow against a live deployment, exercising the Server-Sent
Events streaming transport via
:meth:`AgentServiceClient.invoke_agent_stream` /
:meth:`AgentServiceClient.invoke_team_stream`:

    project -> model -> agent -> stream -> re-stream
            -> sequential team (2 agents, no manager) -> team stream

Each streaming response is fully validated: HTTP 200, ``text/event-stream``
content-type, a leading ``started`` event, non-empty concatenated ``token``
text, no ``error`` event, and a terminal ``completed`` event whose
``metadata.invokeResponse`` matches the sync ``InvokeResponse`` contract
(``output`` / ``durationMs`` / ``agentId``).

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
from lib.agent_service.streaming import EVENT_STARTED, StreamResult
from lib.common.logger import log, log_exchange, log_stream
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
PROJECT_NAME_PREFIX = "e2e-interface-stream"
PROJECT_SOURCE = "pytest-agent-interface-stream"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


@dataclass
class StreamingInterfaceContext:
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
    team_id: str = ""
    session_id: str | None = None
    resources: SuiteResources = field(default_factory=SuiteResources)


def _assert_sse(result: StreamResult) -> dict[str, Any]:
    """Validate an SSE stream end-to-end and return its ``invokeResponse``.

    Asserts the full streaming contract and returns the decoded
    ``completed.metadata.invokeResponse`` envelope (the same shape REST sync
    returns) so callers can make per-step assertions on it.
    """
    assert result.status_code == 200, result.raw_non_sse_body or "non-200 stream"
    content_type = result.headers.get("content-type", "")
    assert content_type.startswith("text/event-stream"), (
        f"unexpected content-type: {content_type!r}"
    )

    assert result.events, "no SSE events received"
    assert result.events[0].event == EVENT_STARTED, (
        f"first event was {result.events[0].event!r}, expected {EVENT_STARTED!r}"
    )
    assert result.error_event is None, f"stream emitted error: {result.error_event}"

    completed = result.completed_event
    assert completed is not None, "no terminal 'completed' event"

    assert result.text, "no streamed token text"

    parsed = completed.data_json
    assert isinstance(parsed, dict), "completed event data is not JSON"
    metadata = parsed.get("metadata")
    assert isinstance(metadata, dict), "completed event missing metadata"
    invoke_response = metadata.get("invokeResponse")
    assert isinstance(invoke_response, dict), (
        "completed.metadata.invokeResponse missing or malformed"
    )

    assert invoke_response.get("output"), "empty invokeResponse output"
    assert "durationMs" in invoke_response, "invokeResponse missing durationMs"
    assert invoke_response.get("agentId"), "invokeResponse missing agentId"
    return invoke_response


class TestStreamingInterface:
    """Ordered SSE-streaming flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> StreamingInterfaceContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = StreamingInterfaceContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: StreamingInterfaceContext) -> None:
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
        self, ctx: StreamingInterfaceContext
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

    def test_add_and_validate_model(self, ctx: StreamingInterfaceContext) -> None:
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

    def test_create_agent(self, ctx: StreamingInterfaceContext) -> None:
        """Create the primary assistant agent for the streaming-interface suite.

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
        name = unique_name("e2e-interface-stream-agent")
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

    def test_get_agent_details(self, ctx: StreamingInterfaceContext) -> None:
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

    def test_invoke_agent(self, ctx: StreamingInterfaceContext) -> None:
        """Invoke the agent over SSE streaming and capture the session id.

        Test scenario:
            Skip if no agent exists. Stream a fixed prompt to the agent's
            /invoke/stream endpoint, validate the full SSE contract, and store
            the returned sessionId on the context.

        Validation we are covering:
            Via _assert_sse: HTTP 200, text/event-stream content-type, a leading
            started event, non-empty token text, no error event, and a completed
            event whose invokeResponse has output, durationMs, and agentId.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Reply with exactly: PROTOCOL_STREAM_OK"}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream"
        )
        result = ctx.agent.invoke_agent_stream(ctx.project_id, ctx.agent_id, body)
        log_stream("POST", url, body, result)
        invoke_response = _assert_sse(result)
        ctx.session_id = invoke_response.get("sessionId")

    def test_invoke_agent_again(self, ctx: StreamingInterfaceContext) -> None:
        """Re-invoke the agent over SSE, reusing the prior session when available.

        Test scenario:
            Skip if no agent exists. Stream a second prompt to /invoke/stream,
            attaching the stored sessionId when present, and validate the
            streaming contract.

        Validation we are covering:
            Via _assert_sse the full SSE streaming contract holds, plus the
            decoded invokeResponse output is non-empty.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body: dict[str, object] = {"input": "What is 2 + 2? Reply with only the number."}
        if ctx.session_id:
            body["sessionId"] = ctx.session_id
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/stream"
        )
        result = ctx.agent.invoke_agent_stream(ctx.project_id, ctx.agent_id, body)
        log_stream("POST", url, body, result)
        invoke_response = _assert_sse(result)
        assert invoke_response.get("output"), "empty agent output"

    def test_create_team_sequential(self, ctx: StreamingInterfaceContext) -> None:
        """Create a second agent and a two-member sequential team (no manager).

        Test scenario:
            Skip if prerequisites (agent/model) are missing. Create a second
            researcher agent, then create a sequential team from the two agents
            and store the team id on the context.

        Validation we are covering:
            HTTP 201 for both creations, the second agent id matches the
            ag-xxxxxxxx pattern, a non-empty team id is returned, the
            orchestrationPolicy is sequential, and the team has two members.
        """
        if not ctx.agent_id or not ctx.model_ids:
            pytest.skip("prerequisites missing (agent / model)")
        agent2_name = unique_name("e2e-interface-stream-agent2")
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

        team_name = unique_name("e2e-interface-stream-team")
        team_request = TeamCreationRequest(
            name=team_name,
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
        data = resp.json()
        ctx.team_id = data["id"]
        assert ctx.team_id, "team id missing in response"
        assert data.get("orchestrationPolicy") == "sequential"
        assert len(data.get("members", [])) == 2
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_get_team_details(self, ctx: StreamingInterfaceContext) -> None:
        """Fetch the created team from config-service and validate all fields.

        Test scenario:
            Skip if no team exists. GET the team by id from config-service and
            assert that every field echoed in the response matches the creation
            request: id, name, orchestrationPolicy, and the member list.

        Validation we are covering:
            HTTP 200; ``id`` matches the stored team id; ``name`` is non-empty;
            ``orchestrationPolicy`` is ``sequential``; ``members`` has exactly
            two entries; and both ``agent_id`` and ``agent_id_2`` appear in the
            member list.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}"
        )
        resp = ctx.config_client.get_team(ctx.project_id, ctx.team_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.team_id, "team id mismatch"
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

    def test_invoke_team(self, ctx: StreamingInterfaceContext) -> None:
        """Invoke the sequential team over SSE streaming.

        Test scenario:
            Skip if no team exists. Stream a one-sentence summarization prompt to
            the team's /invoke/stream endpoint and validate the streaming
            contract.

        Validation we are covering:
            Via _assert_sse the full SSE streaming contract holds, plus the
            decoded invokeResponse team output is non-empty.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke/stream"
        )
        result = ctx.agent.invoke_team_stream(ctx.project_id, ctx.team_id, body)
        log_stream("POST", url, body, result)
        invoke_response = _assert_sse(result)
        assert invoke_response.get("output"), "empty team output"
