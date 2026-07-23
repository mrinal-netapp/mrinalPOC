"""Agent-service instantiation suite — team flow.

Chained end-to-end flow against a live deployment:

    project -> model -> agent A + agent B
            -> sequential team (2 agents, no manager) -> team invoke

The suite uses a single model (`azure/gpt-4o-mini`). Provisioning and teams
use config-service (`ConfigServiceClient`); invokes use agent-service
(`AgentServiceClient`). State flows between the ordered methods through a
single class-scoped `InstantiationTeamContext`.

This file covers the team half of the instantiation flow (two member agents,
team create, and the orchestration-policy cache-bypass scenario across the
default and `staging=playground` paths, sync and SSE). The single-agent half
lives in the sibling `test_instantiation_agent.py`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.agent_service.streaming import EVENT_STARTED, StreamResult
from lib.common.logger import log, log_exchange, log_stream
from lib.common.platform_client import unique_name
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.common.settings import IntegrationSettings
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources
from lib.models.team_creation_request import TeamCreationRequest, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.instantiation,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-instantiation-team"
PROJECT_SOURCE = "pytest-team-instantiation"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

# The two member agents that make up the team. Distinct roles/prompts so the
# members are clearly differentiated; neither carries memory of its own.
MEMBER_A_ROLE = "assistant"
MEMBER_A_SYSTEM_PROMPT = "You are a helpful assistant."
MEMBER_B_ROLE = "researcher"
MEMBER_B_SYSTEM_PROMPT = "You research and summarize concisely."

# Orchestration policies threaded through the team cache-bypass scenario:
# create sequential, update to concurrent (seen only via playground), back
# to sequential.
TEAM_POLICY_INITIAL = "sequential"
TEAM_POLICY_UPDATED = "concurrent"

# Query params that opt an invoke into the playground staging path, which
# bypasses agent-service's bundle + config caches and reads config-service
# fresh on every request.
PLAYGROUND_PARAMS = {"staging": "playground"}



@dataclass
class InstantiationTeamContext:
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
    team_name: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _stream_invoke_response(result: StreamResult) -> dict[str, Any]:
    """Validate an SSE stream end-to-end and return its ``invokeResponse``.

    Asserts the streaming contract — HTTP 200, ``text/event-stream``
    content-type, a leading ``started`` event, non-empty concatenated token
    text, no ``error`` event, and a terminal ``completed`` event — then returns
    the decoded ``completed.metadata.invokeResponse`` envelope. That envelope
    matches REST sync for both ``citations`` and ``metadata``.
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
    assert result.text, "no streamed token text"
    completed = result.completed_event
    assert completed is not None, "no terminal 'completed' event"
    parsed = completed.data_json
    assert isinstance(parsed, dict), "completed event data is not JSON"
    metadata = parsed.get("metadata")
    assert isinstance(metadata, dict), "completed event missing metadata"
    invoke_response = metadata.get("invokeResponse")
    assert isinstance(invoke_response, dict), (
        "completed.metadata.invokeResponse missing or malformed"
    )
    return invoke_response


class TestInstantiationTeam:
    """Ordered team instantiation flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> InstantiationTeamContext:
        """Before/after class: build clients, provision project + model, cleanup.

        Prerequisites provisioned once before the class runs:

        - project: reused from ``PROJECT_ID`` or freshly created and
          readiness-gated (``wait_for_project_ready``).
        - model: reused from ``MODEL_ID`` or freshly created via an Azure
          credential (``add_azure_openai_credentials``) plus the
          ``$LLM_MODEL_NAME`` deployment (``add_llm_models``).

        Env-provided ids are never tracked for cleanup, so only suite-created
        resources are torn down.
        """
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = InstantiationTeamContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: InstantiationTeamContext) -> None:
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
        self, ctx: InstantiationTeamContext
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

    def test_add_and_validate_model(self, ctx: InstantiationTeamContext) -> None:
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

    def test_create_first_agent(self, ctx: InstantiationTeamContext) -> None:
        """Create the first member agent bound to the provisioned model.

        Test scenario:
            Skips if no model exists. POSTs an ``AgentCreationRequest`` (role
            ``assistant``) to config-service and stores the returned agent id on
            the context as the first team member.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, and that the echoed ``modelId`` and ``role`` match what was
            requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-team-agent1"),
            role=MEMBER_A_ROLE,
            system_prompt=MEMBER_A_SYSTEM_PROMPT,
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
        assert data.get("role") == MEMBER_A_ROLE
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_create_second_agent(self, ctx: InstantiationTeamContext) -> None:
        """Create the second member agent bound to the provisioned model.

        Test scenario:
            Skips if no model exists. POSTs a second ``AgentCreationRequest``
            (role ``researcher``) to config-service and stores the returned
            agent id on the context as the second team member.

        Validation we are covering:
            Asserts HTTP 201, that the agent id matches the ``ag-xxxxxxxx``
            pattern, and that the echoed ``modelId`` and ``role`` match what was
            requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-team-agent2"),
            role=MEMBER_B_ROLE,
            system_prompt=MEMBER_B_SYSTEM_PROMPT,
            model_id=ctx.model_ids[0],
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id_2 = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id_2), (
            f"unexpected agent id: {ctx.agent_id_2!r}"
        )
        assert data.get("modelId") == ctx.model_ids[0]
        assert data.get("role") == MEMBER_B_ROLE
        ctx.resources.add_agent(ctx.agent_id_2, ctx.project_id)

    def test_create_team_sequential(self, ctx: InstantiationTeamContext) -> None:
        """Create a sequential two-member team from the member agents.

        Test scenario:
            Skips if either member agent is missing. POSTs a
            ``TeamCreationRequest`` with a ``sequential`` orchestration policy
            whose members are both agent ids, storing the team id on the context.

        Validation we are covering:
            Asserts HTTP 201, a non-empty team id, ``orchestrationPolicy`` of
            ``sequential``, and exactly two members.
        """
        if not (ctx.agent_id and ctx.agent_id_2):
            pytest.skip("prerequisites missing (member agents)")
        ctx.team_name = unique_name("e2e-team")
        team_request = TeamCreationRequest(
            name=ctx.team_name,
            orchestration_policy=TEAM_POLICY_INITIAL,
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
        assert data.get("orchestrationPolicy") == TEAM_POLICY_INITIAL
        assert len(data.get("members", [])) == 2
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_invoke_team(self, ctx: InstantiationTeamContext) -> None:
        """Invoke the sequential team end-to-end (default path).

        Test scenario:
            Skips if no team exists. POSTs a single prompt to the agent-service
            team invoke endpoint with no ``staging`` query param, exercising the
            sequential orchestration across both member agents. This first
            default invoke populates agent-service's bundle cache for the team
            (orchestration policy ``sequential``).

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, a present ``durationMs``
            field, and that ``metadata.orchestration_type`` is ``sequential``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        assert "durationMs" in data
        metadata = data.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL

    def test_invoke_team_stream(self, ctx: InstantiationTeamContext) -> None:
        """Stream the team invoke (default path); orchestration matches sync.

        Test scenario:
            Skips if no team exists. Streams the same summarization prompt to the
            team's ``/invoke/stream`` endpoint with no ``staging`` query param.
            The bundle cache is warm from the sync team invoke above, so the
            streamed envelope should echo the cached ``sequential`` policy.

        Validation we are covering:
            Via ``_stream_invoke_response`` the SSE contract holds, then we assert
            ``metadata.orchestration_type`` is ``sequential``.
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
        invoke_response = _stream_invoke_response(result)
        metadata = invoke_response.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL

    def test_update_team_configuration(self, ctx: InstantiationTeamContext) -> None:
        """Update the team's orchestration policy to ``concurrent``.

        Test scenario:
            Skips if no team exists. Issues a full-body ``PUT`` to
            config-service changing ``orchestrationPolicy`` from ``sequential``
            to ``concurrent``. Agent-service is not notified and keeps serving
            the cached sequential bundle on the default path.

        Validation we are covering:
            Asserts HTTP 200 and that the echoed ``orchestrationPolicy`` is
            ``concurrent``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        request = TeamCreationRequest(
            name=ctx.team_name,
            orchestration_policy=TEAM_POLICY_UPDATED,
            members=[
                TeamMemberRef.agent(ctx.agent_id),
                TeamMemberRef.agent(ctx.agent_id_2),
            ],
        )
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}"
        )
        resp = ctx.config_client.update_team(ctx.project_id, ctx.team_id, request)
        log_exchange("PUT", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("orchestrationPolicy") == TEAM_POLICY_UPDATED

    def test_invoke_team_again(self, ctx: InstantiationTeamContext) -> None:
        """Re-invoke the team on the default path; cached policy must persist.

        Test scenario:
            Skips if no team exists. POSTs to the default team invoke endpoint
            (no ``staging``) after the policy was changed to ``concurrent``.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that
            ``metadata.orchestration_type`` is still ``sequential`` — proving
            the default path serves the cached bundle.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        metadata = data.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL

    def test_invoke_team_again_stream(self, ctx: InstantiationTeamContext) -> None:
        """Re-stream the team on the default path; cached policy must persist.

        Test scenario:
            Skips if no team exists. Streams to the default team
            ``/invoke/stream`` endpoint (no ``staging``) after the policy was
            changed to ``concurrent``.

        Validation we are covering:
            Via ``_stream_invoke_response`` the SSE contract holds, then we assert
            ``metadata.orchestration_type`` is still ``sequential``, proving the
            default path serves the cached bundle.
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
        invoke_response = _stream_invoke_response(result)
        metadata = invoke_response.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL

    def test_invoke_team_from_playground(self, ctx: InstantiationTeamContext) -> None:
        """Invoke the team with ``staging=playground``; fresh policy must show.

        Test scenario:
            Skips if no team exists. Invokes the team with the
            ``staging=playground`` query param, which bypasses the bundle and
            config caches and reads the team fresh from config-service (now
            ``concurrent``).

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that
            ``metadata.orchestration_type`` is ``concurrent`` — proving
            playground bypasses the cache.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke?staging=playground"
        )
        resp = ctx.agent.invoke_team(
            ctx.project_id, ctx.team_id, body, params=PLAYGROUND_PARAMS
        )
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        metadata = data.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_UPDATED

    def test_invoke_team_from_playground_stream(
        self, ctx: InstantiationTeamContext
    ) -> None:
        """Stream the team with ``staging=playground``; fresh policy must show.

        Test scenario:
            Skips if no team exists. Streams to the team's ``/invoke/stream``
            endpoint with the ``staging=playground`` query param, which bypasses
            the caches and reads the team fresh from config-service (now
            ``concurrent``).

        Validation we are covering:
            Via ``_stream_invoke_response`` the SSE contract holds, then we assert
            ``metadata.orchestration_type`` is ``concurrent``, proving playground
            bypasses the bundle cache.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke/stream?staging=playground"
        )
        result = ctx.agent.invoke_team_stream(
            ctx.project_id, ctx.team_id, body, params=PLAYGROUND_PARAMS
        )
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        metadata = invoke_response.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_UPDATED

    def test_update_team_configuration_again(
        self, ctx: InstantiationTeamContext
    ) -> None:
        """Update the team's orchestration policy back to ``sequential``.

        Test scenario:
            Skips if no team exists. Issues a second full-body ``PUT`` to
            config-service changing ``orchestrationPolicy`` from ``concurrent``
            back to ``sequential``.

        Validation we are covering:
            Asserts HTTP 200 and that the echoed ``orchestrationPolicy`` is
            ``sequential``.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        request = TeamCreationRequest(
            name=ctx.team_name,
            orchestration_policy=TEAM_POLICY_INITIAL,
            members=[
                TeamMemberRef.agent(ctx.agent_id),
                TeamMemberRef.agent(ctx.agent_id_2),
            ],
        )
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}"
        )
        resp = ctx.config_client.update_team(ctx.project_id, ctx.team_id, request)
        log_exchange("PUT", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        assert resp.json().get("orchestrationPolicy") == TEAM_POLICY_INITIAL

    def test_invoke_team_from_playground_again(
        self, ctx: InstantiationTeamContext
    ) -> None:
        """Invoke the team with ``staging=playground`` again; latest policy.

        Test scenario:
            Skips if no team exists. Invokes the team again with the
            ``staging=playground`` query param after the policy was changed back
            to ``sequential``; playground re-reads config-service on every call.

        Validation we are covering:
            Asserts HTTP 200, non-empty ``output``, and that
            ``metadata.orchestration_type`` is ``sequential`` — proving each
            playground invoke reflects the current config-service state.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke?staging=playground"
        )
        resp = ctx.agent.invoke_team(
            ctx.project_id, ctx.team_id, body, params=PLAYGROUND_PARAMS
        )
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        metadata = data.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL

    def test_invoke_team_from_playground_again_stream(
        self, ctx: InstantiationTeamContext
    ) -> None:
        """Stream the team with ``staging=playground`` again; latest policy.

        Test scenario:
            Skips if no team exists. Streams again with the ``staging=playground``
            query param after the policy was changed back to ``sequential``;
            playground re-reads config-service on every streamed call.

        Validation we are covering:
            Via ``_stream_invoke_response`` the SSE contract holds, then we assert
            ``metadata.orchestration_type`` is ``sequential``, proving playground
            re-reads config-service on every call.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_sequential did not succeed")
        body = {
            "input": "Summarize in one sentence what collaboration means for a support team."
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke/stream?staging=playground"
        )
        result = ctx.agent.invoke_team_stream(
            ctx.project_id, ctx.team_id, body, params=PLAYGROUND_PARAMS
        )
        log_stream("POST", url, body, result)
        invoke_response = _stream_invoke_response(result)
        metadata = invoke_response.get("metadata") or {}
        assert metadata.get("orchestration_type") == TEAM_POLICY_INITIAL
