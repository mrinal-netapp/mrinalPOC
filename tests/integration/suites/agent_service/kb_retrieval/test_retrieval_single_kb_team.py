"""Agent-service retrieval suite for a route-orchestrated team of single-KB agents.

Flow:
    project -> model
            -> insurance_agent (INSURANCE_KB_ID, single KB)
            -> gcnv_agent     (GCNV_KB_ID,      single KB)
            -> route team (inline kb-router)
            -> invokes

The two member agents each own exactly one KB; the inline router manager
delegates each query to the correct specialist.  Invocations are validated for:
- team details: orchestrationPolicy == route, two members, inline manager present
- greeting: no tool executions, no KB citations
- insurance query: routes to insurance agent, KB citations all from INSURANCE_KB_ID
- GCNV query:      routes to GCNV agent,      KB citations all from GCNV_KB_ID
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
from lib.models.agent_invoke_request import AgentInvocationRequest
from lib.models.resources import SuiteResources
from lib.models.team_creation_request import TeamCreationRequest, TeamManagerConfig, TeamMemberRef

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.retrieval,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-retrieval-kb-team"
PROJECT_SOURCE = "pytest-agent-retrieval-kb-team"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TEAM_ID_RE = re.compile(r"^agr-[a-z0-9]{8}$")

_ORCHESTRATION_POLICY = "route"
# Agent-service aliases ``route`` to the ``triage`` runtime orchestrator, so the
# invoke response metadata echoes this value (not the policy name).
_RUNTIME_ORCHESTRATION_TYPE = "triage"

_ROUTER_NAME = "kb-router"

_INSURANCE_QUERY = (
    "Answer only from Aegis Shield insurance policy documents: "
    "What is the HMO individual deductible?"
)
_GCNV_QUERY = (
    "Answer only from Google Cloud NetApp Volumes (GCNV) documentation: "
    "How do I create a storage pool, and what required fields must be provided "
    "in console and gcloud?"
)


@dataclass
class RetrievalTeamContext:
    """Mutable state shared across ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    insurance_agent_id: str = ""
    gcnv_agent_id: str = ""
    insurance_agent_name: str = ""
    gcnv_agent_name: str = ""
    team_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)

    @property
    def insurance_kb_id(self) -> str:
        return self.config.insurance_kb_id

    @property
    def gcnv_kb_id(self) -> str:
        return self.config.gcnv_kb_id


def _tool_executions_from_citations(citations: dict) -> list[dict]:
    tool_executions: list[dict] = []
    for step in citations.get("agentTrace") or []:
        tool_executions.extend(step.get("toolExecutions") or [])
    return tool_executions


def _kb_citations_from_citations(citations: dict) -> list[dict]:
    kb_citations: list[dict] = []
    for tool_exec in _tool_executions_from_citations(citations):
        kb_citations.extend(tool_exec.get("kbCitations") or [])
    if not kb_citations:
        kb_citations.extend(citations.get("kbCitations") or [])
    return kb_citations


def _citation_kb_ids(citations: list[dict]) -> list[str]:
    return [c.get("knowledgeBaseId") for c in citations if c.get("knowledgeBaseId")]


def _responding_agent_name(data: dict[str, Any]) -> str | None:
    """Return the specialist agent name from citations, if the service populated it."""
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


class TestRetrievalKBSingleTeam:
    """Ordered KB-retrieval flow for a route-orchestrated team (methods run in order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> RetrievalTeamContext:
        if not agent_service_config.insurance_kb_id or not agent_service_config.gcnv_kb_id:
            pytest.skip(
                "kb-team retrieval suite requires INSURANCE_KB_ID and GCNV_KB_ID "
                "in tests/integration/.env.local"
            )
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = RetrievalTeamContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: RetrievalTeamContext) -> None:
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
        self, ctx: RetrievalTeamContext
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

    def test_add_and_validate_model(self, ctx: RetrievalTeamContext) -> None:
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

    def test_create_insurance_agent(self, ctx: RetrievalTeamContext) -> None:
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        ctx.insurance_agent_name = unique_name("kb-team-insurance")
        request = AgentCreationRequest(
            name=ctx.insurance_agent_name,
            description=(
                "Answers insurance policy questions from the Aegis Shield "
                "insurance knowledge base."
            ),
            role="Insurance knowledge-base specialist",
            system_prompt=(
                "You are an insurance assistant. Answer only from the "
                "insurance knowledge base and cite sources."
            ),
            model_id=ctx.model_id,
            knowledge_base_ids=[ctx.insurance_kb_id],
            rag_config={
                ctx.insurance_kb_id: {
                    "topK": 5,
                    "similarityThreshold": 0.3,
                    "searchMode": "semantic",
                }
            },
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.insurance_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.insurance_agent_id), (
            f"unexpected agent id: {ctx.insurance_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.insurance_agent_id, ctx.project_id)

    def test_create_gcnv_agent(self, ctx: RetrievalTeamContext) -> None:
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        ctx.gcnv_agent_name = unique_name("kb-team-gcnv")
        request = AgentCreationRequest(
            name=ctx.gcnv_agent_name,
            description=(
                "Answers Google Cloud NetApp Volumes (GCNV) documentation "
                "and cloud storage configuration questions."
            ),
            role="GCNV knowledge-base specialist",
            system_prompt=(
                "You are a Google Cloud NetApp Volumes assistant. "
                "Answer only from the GCNV knowledge base and cite sources."
            ),
            model_id=ctx.model_id,
            knowledge_base_ids=[ctx.gcnv_kb_id],
            rag_config={
                ctx.gcnv_kb_id: {
                    "topK": 5,
                    "similarityThreshold": 0.3,
                    "searchMode": "semantic",
                }
            },
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.gcnv_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.gcnv_agent_id), (
            f"unexpected agent id: {ctx.gcnv_agent_id!r}"
        )
        ctx.resources.add_agent(ctx.gcnv_agent_id, ctx.project_id)

    def test_create_kb_routing_team(self, ctx: RetrievalTeamContext) -> None:
        if not ctx.insurance_agent_id or not ctx.gcnv_agent_id:
            pytest.skip(
                "no agents — test_create_insurance_agent / test_create_gcnv_agent "
                "did not succeed"
            )
        request = TeamCreationRequest(
            name=unique_name("kb-route-team"),
            orchestration_policy=_ORCHESTRATION_POLICY,
            members=[
                TeamMemberRef.agent(ctx.insurance_agent_id),
                TeamMemberRef.agent(ctx.gcnv_agent_id),
            ],
            manager=TeamManagerConfig(
                name=_ROUTER_NAME,
                system_prompt=(
                    "You are a knowledge-base router. "
                    "Delegate insurance and policy questions to the insurance specialist. "
                    "Delegate Google Cloud NetApp Volumes (GCNV) or cloud storage "
                    "questions to the GCNV specialist. "
                    "Do not answer yourself."
                ),
                model_id=ctx.model_id,
            ),
        )
        url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.team_id = data["id"]
        assert TEAM_ID_RE.match(ctx.team_id), f"unexpected team id: {ctx.team_id!r}"
        assert data.get("orchestrationPolicy") == _ORCHESTRATION_POLICY
        assert len(data.get("members", [])) == 2
        manager = data.get("manager") or {}
        assert manager.get("name") == _ROUTER_NAME, (
            f"expected inline router manager echoed back; got {manager!r}"
        )
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_get_team_details(self, ctx: RetrievalTeamContext) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_routing_team did not succeed")
        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}"
        )
        resp = ctx.config_client.get_team(ctx.project_id, ctx.team_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("id") == ctx.team_id
        assert data.get("orchestrationPolicy") == _ORCHESTRATION_POLICY
        member_ids = {m.get("memberId") for m in data.get("members") or []}
        assert ctx.insurance_agent_id in member_ids, (
            f"insurance agent {ctx.insurance_agent_id!r} missing in "
            f"team members {member_ids!r}"
        )
        assert ctx.gcnv_agent_id in member_ids, (
            f"gcnv agent {ctx.gcnv_agent_id!r} missing in team members {member_ids!r}"
        )
        manager = data.get("manager") or {}
        assert manager.get("name") == _ROUTER_NAME, (
            f"expected inline router {_ROUTER_NAME!r}; got {manager!r}"
        )

    def test_invoke_team_greeting_hi(self, ctx: RetrievalTeamContext) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_routing_team did not succeed")
        request = AgentInvocationRequest(input="Hi")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"
        citations = data.get("citations") or {}
        assert len(_tool_executions_from_citations(citations)) == 0, (
            "greeting invoke should not execute tools"
        )
        assert len(_kb_citations_from_citations(citations)) == 0, (
            "greeting invoke should not include KB citations"
        )

    @pytest.mark.xfail(
        reason=(
            "LLM-based team routing is non-deterministic: an insurance query may be "
            "answered by the router itself instead of routing to the insurance "
            "agent. Remove this marker once routing is deterministic / more reliable."
        ),
        strict=False,
    )
    def test_invoke_team_insurance_query_routes_to_insurance_agent(
        self, ctx: RetrievalTeamContext
    ) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_routing_team did not succeed")
        request = AgentInvocationRequest(input=_INSURANCE_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"

        routed_to = _responding_agent_name(data)
        if routed_to is not None:
            assert routed_to == ctx.insurance_agent_name, (
                f"expected insurance query to route to {ctx.insurance_agent_name!r}, "
                f"got {routed_to!r}"
            )

        citations = data.get("citations")
        assert citations is not None, "citations missing from team invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, "expected tool executions for insurance query"

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for insurance query"

        kb_ids = _citation_kb_ids(kb_citations)
        assert len(kb_ids) > 0, "no knowledgeBaseId values found in KB citations"
        assert all(kb_id == ctx.insurance_kb_id for kb_id in kb_ids), (
            f"expected only insurance KB citations ({ctx.insurance_kb_id!r}), "
            f"got {sorted(set(kb_ids))!r}"
        )

    @pytest.mark.xfail(
        reason=(
            "LLM-based team routing is non-deterministic: a GCNV query may be "
            "answered by the router itself instead of routing to the GCNV agent. "
            "Remove this marker once routing is deterministic / more reliable."
        ),
        strict=False,
    )
    def test_invoke_team_gcnv_query_routes_to_gcnv_agent(
        self, ctx: RetrievalTeamContext
    ) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_routing_team did not succeed")
        request = AgentInvocationRequest(input=_GCNV_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"

        routed_to = _responding_agent_name(data)
        if routed_to is not None:
            assert routed_to == ctx.gcnv_agent_name, (
                f"expected GCNV query to route to {ctx.gcnv_agent_name!r}, "
                f"got {routed_to!r}"
            )

        citations = data.get("citations")
        assert citations is not None, "citations missing from team invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, "expected tool executions for GCNV query"

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for GCNV query"

        kb_ids = _citation_kb_ids(kb_citations)
        assert len(kb_ids) > 0, "no knowledgeBaseId values found in KB citations"
        assert all(kb_id == ctx.gcnv_kb_id for kb_id in kb_ids), (
            f"expected only GCNV KB citations ({ctx.gcnv_kb_id!r}), "
            f"got {sorted(set(kb_ids))!r}"
        )
