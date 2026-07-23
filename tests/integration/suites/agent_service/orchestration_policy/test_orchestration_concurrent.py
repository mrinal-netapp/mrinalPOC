"""Agent-service concurrent orchestration policy suite.

Chained end-to-end flow against a live deployment:

    project -> model -> three agents -> concurrent team -> team invoke

Provisioning and team creation use config-service (`ConfigServiceClient`); the
team invoke uses agent-service (`AgentServiceClient`). Three distinct
science-domain agents (physics / chemistry / biology) are created and combined
into a team with the ``concurrent`` orchestration policy (no manager). The team
is first validated on creation, then invoked; the invoke response
`metadata.orchestration_type` must echo ``"concurrent"`` and `metadata.agent_names`
must include all three members (concurrent runs every member on the same task).
State flows between the ordered methods through a single class-scoped
`ConcurrentContext`.

See ``test_orchestration_sequential.py`` for the sequential-policy counterpart.
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
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.resources import SuiteResources
from lib.models.team_creation_request import TeamCreationRequest, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.orchestration,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-orch-concurrent"
PROJECT_SOURCE = "pytest-agent-orchestration-concurrent"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

_ORCHESTRATION_POLICY = "concurrent"


@dataclass
class ConcurrentContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    physics_agent_id: str = ""
    chemistry_agent_id: str = ""
    biology_agent_id: str = ""
    agent_names: list[str] = field(default_factory=list)
    team_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestOrchestrationConcurrent:
    """Ordered concurrent-team orchestration flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> ConcurrentContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = ConcurrentContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: ConcurrentContext) -> None:
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
        self, ctx: ConcurrentContext
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

    def test_add_and_validate_model(self, ctx: ConcurrentContext) -> None:
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

    def test_create_agents(self, ctx: ConcurrentContext) -> None:
        """Create the three science-domain member agents for the team.

        Test scenario:
            Skips when no model exists. Iterates physics / chemistry / biology
            specs, POSTing one agent per domain to config-service bound to the
            provisioned model, and records each agent id and name on the context.

        Validation we are covering:
            Every create returns HTTP 201 and each returned agent id matches the
            ``ag-xxxxxxxx`` id pattern.
        """
        if not ctx.model_ids:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        agent_url = ctx.config_client.agents_url(ctx.project_id)

        specs = [
            (
                "physics",
                "physics-solver",
                "You are a physics expert. Solve physics problems clearly and concisely.",
            ),
            (
                "chemistry",
                "chemistry-solver",
                "You are a chemistry expert. Solve chemistry problems clearly and concisely.",
            ),
            (
                "biology",
                "biology-solver",
                "You are a biology expert. Solve biology problems clearly and concisely.",
            ),
        ]
        created_ids: list[str] = []
        for domain, role, prompt in specs:
            name = unique_name(f"e2e-orch-{domain}-agent")
            request = AgentCreationRequest(
                name=name,
                role=role,
                system_prompt=prompt,
                model_id=ctx.model_ids[0],
            )
            resp = ctx.config_client.create_agent(ctx.project_id, request)
            log_exchange("POST", agent_url, request.to_body(), resp)
            assert resp.status_code == 201, resp.text
            agent_id = resp.json()["id"]
            assert AGENT_ID_RE.match(agent_id), f"unexpected agent id: {agent_id!r}"
            created_ids.append(agent_id)
            ctx.agent_names.append(name)
            ctx.resources.add_agent(agent_id, ctx.project_id)

        ctx.physics_agent_id, ctx.chemistry_agent_id, ctx.biology_agent_id = created_ids

    def test_create_team_concurrent(self, ctx: ConcurrentContext) -> None:
        """Create a three-member team using the ``concurrent`` orchestration policy.

        Test scenario:
            Skips when any of the three agents is missing. POSTs a team to
            config-service with ``orchestration_policy="concurrent"`` and the
            three member agent ids, then stores the team id on the context.

        Validation we are covering:
            The create returns HTTP 201, a non-empty team id is present, the
            echoed ``orchestrationPolicy`` equals ``"concurrent"``, and exactly
            three members are returned.
        """
        if not (
            ctx.physics_agent_id and ctx.chemistry_agent_id and ctx.biology_agent_id
        ):
            pytest.skip("no agents — test_create_agents did not succeed")
        team_request = TeamCreationRequest(
            name=unique_name("e2e-orch-concurrent-team"),
            orchestration_policy=_ORCHESTRATION_POLICY,
            members=[
                TeamMemberRef.agent(ctx.physics_agent_id),
                TeamMemberRef.agent(ctx.chemistry_agent_id),
                TeamMemberRef.agent(ctx.biology_agent_id),
            ],
        )
        team_url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, team_request)
        log_exchange("POST", team_url, team_request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.team_id = data["id"]
        assert ctx.team_id, "team id missing in response"
        assert data.get("orchestrationPolicy") == _ORCHESTRATION_POLICY
        assert len(data.get("members", [])) == 3
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_invoke_team_concurrent(self, ctx: ConcurrentContext) -> None:
        """Invoke the concurrent team and confirm every member ran the task.

        Test scenario:
            Skips when no team exists. POSTs an invoke request to agent-service
            with a single science-fact prompt and reads the response body and
            metadata.

        Validation we are covering:
            The invoke returns HTTP 200, ``output`` is non-empty,
            ``metadata.orchestration_type`` echoes ``"concurrent"``, and
            ``metadata.agent_names`` includes all three created member names
            (concurrent runs every member on the same task).
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_team_concurrent did not succeed")
        body = {"input": "State one interesting scientific fact about water."}
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
        assert metadata.get("orchestration_type") == _ORCHESTRATION_POLICY, (
            f"expected metadata.orchestration_type == {_ORCHESTRATION_POLICY!r}, "
            f"got {metadata.get('orchestration_type')!r} (metadata={metadata!r})"
        )
        agent_names = metadata.get("agent_names") or []
        missing = [n for n in ctx.agent_names if n not in agent_names]
        assert not missing, (
            f"expected all member agents in metadata.agent_names; missing {missing!r} "
            f"(got {agent_names!r})"
        )
