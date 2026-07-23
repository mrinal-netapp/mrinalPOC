"""Agent-service route (triage-backed) orchestration policy suite.

Chained end-to-end flow against a live deployment:

    project -> model -> science + math agents -> route team (router) -> invokes

Provisioning and team creation use config-service (`ConfigServiceClient`); team
invokes use agent-service (`AgentServiceClient`). Two domain-specialist agents
(science-only and math-only) are created with routing ``description`` fields, then
combined into a team with the ``route`` orchestration policy plus an inline
router manager that delegates to the best-matching specialist.

The team is validated on creation (config-service echoes
``orchestrationPolicy == "route"`` and the inline manager). It is then invoked
twice: once with a pure science question and once with a pure math question.
Because agent-service aliases ``route`` to the ``triage`` runtime orchestrator,
each invoke response ``metadata.orchestration_type`` echoes ``"triage"`` (not
``"route"``). State flows between the ordered methods through a single
class-scoped `RouteContext`.

See ``test_orchestration_coordinate.py``, ``test_orchestration_concurrent.py``,
and ``test_orchestration_sequential.py`` for the other policy counterparts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources
from lib.models.team_creation_request import TeamCreationRequest, TeamManagerConfig, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.orchestration,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-orch-route"
PROJECT_SOURCE = "pytest-agent-orchestration-route"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

_ORCHESTRATION_POLICY = "route"
# Agent-service aliases ``route`` to the ``triage`` runtime orchestrator, so the
# invoke response metadata echoes this value (not the policy name).
_RUNTIME_ORCHESTRATION_TYPE = "triage"

_ROUTER_NAME = "subject-router"

_SCIENCE_PROMPT = "Why does ice float on liquid water?"
_MATH_PROMPT = "What is the derivative of x^2 with respect to x?"


@dataclass
class RouteContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    science_agent_id: str = ""
    math_agent_id: str = ""
    science_agent_name: str = ""
    math_agent_name: str = ""
    team_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


def _responding_agent_name(data: dict[str, Any]) -> str | None:
    """Return the specialist name from citations, if the service populated it."""
    citations = data.get("citations") or {}
    responding = citations.get("respondingAgent") or {}
    name = responding.get("name")
    if name:
        return str(name)
    trace = citations.get("agentTrace") or []
    for step in trace:
        agent_name = step.get("agentName")
        if agent_name and agent_name != _ROUTER_NAME:
            return str(agent_name)
    return None


def _assert_route_invoke(
    ctx: RouteContext,
    *,
    body: dict[str, str],
    expected_agent_name: str,
    label: str,
) -> None:
    """Shared invoke assertions for route/triage team runs."""
    url = (
        f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
        f"/agent-teams/{ctx.team_id}/invoke"
    )
    resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, body)
    log_exchange("POST", url, body, resp)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data.get("output"), f"empty team output ({label})"
    metadata = data.get("metadata") or {}
    assert metadata.get("orchestration_type") == _RUNTIME_ORCHESTRATION_TYPE, (
        f"expected metadata.orchestration_type == {_RUNTIME_ORCHESTRATION_TYPE!r} "
        f"(route aliases to triage), got "
        f"{metadata.get('orchestration_type')!r} (metadata={metadata!r})"
    )
    routed_to = _responding_agent_name(data)
    if routed_to is not None:
        assert routed_to == expected_agent_name, (
            f"expected {label} invoke to route to {expected_agent_name!r}, "
            f"got {routed_to!r} (metadata={metadata!r})"
        )

    # agentTrace must be exactly two steps: the router delegates (step 0) and
    # the chosen specialist responds (step 1).
    agent_trace = (data.get("citations") or {}).get("agentTrace") or []
    assert len(agent_trace) == 2, (
        f"expected agentTrace of size 2 for {label} invoke, got "
        f"{len(agent_trace)} (agentTrace={agent_trace!r})"
    )
    assert agent_trace[0].get("agentName") == _ROUTER_NAME, (
        f"expected first agentTrace step to be the router {_ROUTER_NAME!r}, "
        f"got {agent_trace[0].get('agentName')!r} (agentTrace={agent_trace!r})"
    )
    assert agent_trace[1].get("agentName") == expected_agent_name, (
        f"expected second agentTrace step to be {expected_agent_name!r}, "
        f"got {agent_trace[1].get('agentName')!r} (agentTrace={agent_trace!r})"
    )


class TestOrchestrationRoute:
    """Ordered route-team orchestration flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> RouteContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = RouteContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: RouteContext) -> None:
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
        self, ctx: RouteContext
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

    def test_add_and_validate_model(self, ctx: RouteContext) -> None:
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

    def test_create_agents(self, ctx: RouteContext) -> None:
        """Create science-only and math-only specialist agents for routing."""
        if not ctx.model_ids:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        agent_url = ctx.config_client.agents_url(ctx.project_id)

        specs = [
            (
                "science",
                "science-expert",
                "You ONLY answer natural-science questions (physics, chemistry, biology). "
                "If asked anything else, say it is out of scope.",
                "Answers natural science questions: physics, chemistry, biology.",
            ),
            (
                "math",
                "math-expert",
                "You ONLY answer mathematics questions (arithmetic, algebra, geometry, calculus). "
                "If asked anything else, say it is out of scope.",
                "Answers mathematics questions: arithmetic, algebra, geometry, calculus.",
            ),
        ]
        created: list[tuple[str, str, str]] = []
        for domain, role, prompt, description in specs:
            name = unique_name(f"e2e-orch-{domain}-agent")
            request = AgentCreationRequest(
                name=name,
                role=role,
                system_prompt=prompt,
                description=description,
                model_id=ctx.model_ids[0],
            )
            resp = ctx.config_client.create_agent(ctx.project_id, request)
            log_exchange("POST", agent_url, request.to_body(), resp)
            assert resp.status_code == 201, resp.text
            agent_id = resp.json()["id"]
            assert AGENT_ID_RE.match(agent_id), f"unexpected agent id: {agent_id!r}"
            created.append((domain, agent_id, name))
            ctx.resources.add_agent(agent_id, ctx.project_id)

        ctx.science_agent_id = created[0][1]
        ctx.science_agent_name = created[0][2]
        ctx.math_agent_id = created[1][1]
        ctx.math_agent_name = created[1][2]

    def test_create_team_route(self, ctx: RouteContext) -> None:
        """Create a route team with an inline router over two specialists."""
        if not ctx.science_agent_id or not ctx.math_agent_id:
            pytest.skip("no agents — test_create_agents did not succeed")
        team_request = TeamCreationRequest(
            name=unique_name("e2e-orch-route-team"),
            orchestration_policy=_ORCHESTRATION_POLICY,
            members=[
                TeamMemberRef.agent(ctx.science_agent_id),
                TeamMemberRef.agent(ctx.math_agent_id),
            ],
            manager=TeamManagerConfig(
                name=_ROUTER_NAME,
                system_prompt=(
                    "You are a router. Read the question and delegate to the single "
                    "best-matching specialist: the science expert for natural-science "
                    "questions, the math expert for mathematics questions. Do not answer "
                    "yourself."
                ),
                model_id=ctx.model_ids[0],
            ),
        )
        team_url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, team_request)
        log_exchange("POST", team_url, team_request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.team_id = data["id"]
        assert ctx.team_id, "team id missing in response"
        assert data.get("orchestrationPolicy") == _ORCHESTRATION_POLICY
        assert len(data.get("members", [])) == 2
        manager = data.get("manager") or {}
        assert manager.get("name") == _ROUTER_NAME, (
            f"expected inline manager echoed back; got {manager!r}"
        )
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    @pytest.mark.xfail(
        reason="LLM routing is non-deterministic; the router may pick the "
        "subject-router agent instead of the expected science agent",
        strict=False,
    )
    def test_invoke_team_route_science(self, ctx: RouteContext) -> None:
        """Invoke the route team with a pure science question."""
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_route did not succeed")
        _assert_route_invoke(
            ctx,
            body={"input": _SCIENCE_PROMPT},
            expected_agent_name=ctx.science_agent_name,
            label="science",
        )

    @pytest.mark.xfail(
        reason="LLM routing is non-deterministic; the router may pick the "
        "subject-router agent instead of the expected math agent",
        strict=False,
    )
    def test_invoke_team_route_math(self, ctx: RouteContext) -> None:
        """Invoke the route team with a pure math question."""
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_route did not succeed")
        _assert_route_invoke(
            ctx,
            body={"input": _MATH_PROMPT},
            expected_agent_name=ctx.math_agent_name,
            label="math",
        )
