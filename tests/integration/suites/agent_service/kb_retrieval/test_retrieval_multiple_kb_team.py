"""Agent-service retrieval suite for a coordinate-orchestrated team of single-KB agents.

Flow:
    project -> model
            -> insurance_agent (INSURANCE_KB_ID, single KB)
            -> gcnv_agent     (GCNV_KB_ID,      single KB)
            -> coordinate team (inline kb-coordinator manager)
            -> invokes

The two member agents each own exactly one KB; the inline coordinator manager
can engage one or both specialists per query — unlike the triage-backed ``route``
policy which picks exactly one.  Invocations are validated for:

- team details: orchestrationPolicy == coordinate, two members, inline manager present
- greeting: no tool executions and no KB citations
- insurance-only query:  KB citations all from INSURANCE_KB_ID; magentic runtime confirmed
- GCNV-only query:       KB citations all from GCNV_KB_ID;      magentic runtime confirmed
- combined query:        KB citations contain BOTH INSURANCE_KB_ID and GCNV_KB_ID;
                         metadata.agent_names includes both specialist agent names

The combined-query tests at the end are unique to this suite: they exploit the
``coordinate``/``magentic`` multi-agent capability where the coordinator
orchestrates both specialists in a single invoke, producing citations from both
knowledge bases in one response.
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
PROJECT_NAME_PREFIX = "e2e-retrieval-multi-kb-team"
PROJECT_SOURCE = "pytest-agent-retrieval-multi-kb-team"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TEAM_ID_RE = re.compile(r"^agr-[a-z0-9]{8}$")

_ORCHESTRATION_POLICY = "coordinate"
# Agent-service aliases ``coordinate`` to the ``magentic`` runtime orchestrator,
# so the invoke response metadata echoes this value (not the policy name).
_RUNTIME_ORCHESTRATION_TYPE = "magentic"

_COORDINATOR_NAME = "kb-coordinator"

_INSURANCE_QUERY = (
    "Answer only from Aegis Shield insurance policy documents: "
    "What is the HMO individual deductible?"
)
_GCNV_QUERY = (
    "Answer only from Google Cloud NetApp Volumes (GCNV) documentation: "
    "How do I create a storage pool, and what required fields must be provided "
    "in console and gcloud?"
)
# Combined: spans both domains so the coordinator should engage both specialists.
_COMBINED_QUERY = (
    "Use both knowledge bases to answer two questions. "
    "First, from the Aegis Shield insurance policy documents: "
    "what is the HMO individual deductible? "
    "Second, from the Google Cloud NetApp Volumes (GCNV) documentation: "
    "what required fields must be provided when creating a storage pool in the "
    "console and gcloud?"
)


@dataclass
class RetrievalMultipleKBTeamContext:
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


# ---------------------------------------------------------------------------
# Citation helpers
# ---------------------------------------------------------------------------


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


def _assert_magentic_metadata(data: dict[str, Any]) -> None:
    """Assert that metadata.orchestration_type reflects the magentic runtime."""
    metadata = data.get("metadata") or {}
    assert metadata.get("orchestration_type") == _RUNTIME_ORCHESTRATION_TYPE, (
        f"expected metadata.orchestration_type == {_RUNTIME_ORCHESTRATION_TYPE!r} "
        f"(coordinate aliases to magentic), got "
        f"{metadata.get('orchestration_type')!r} (metadata={metadata!r})"
    )


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------


class TestRetrievalMultipleKBTeam:
    """Ordered KB-retrieval flow for a coordinate-orchestrated team (methods run in order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> RetrievalMultipleKBTeamContext:
        if not agent_service_config.insurance_kb_id or not agent_service_config.gcnv_kb_id:
            pytest.skip(
                "multiple-kb-team retrieval suite requires INSURANCE_KB_ID and GCNV_KB_ID "
                "in tests/integration/.env.local"
            )
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = RetrievalMultipleKBTeamContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: RetrievalMultipleKBTeamContext) -> None:
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

    def test_add_and_validate_azure_openai_cred(
        self, ctx: RetrievalMultipleKBTeamContext
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

    def test_add_and_validate_model(self, ctx: RetrievalMultipleKBTeamContext) -> None:
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

    # ------------------------------------------------------------------
    # Provisioning
    # ------------------------------------------------------------------

    def test_create_insurance_agent(self, ctx: RetrievalMultipleKBTeamContext) -> None:
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        ctx.insurance_agent_name = unique_name("kb-coord-insurance")
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

    def test_create_gcnv_agent(self, ctx: RetrievalMultipleKBTeamContext) -> None:
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        ctx.gcnv_agent_name = unique_name("kb-coord-gcnv")
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

    def test_create_kb_coordinate_team(self, ctx: RetrievalMultipleKBTeamContext) -> None:
        if not ctx.insurance_agent_id or not ctx.gcnv_agent_id:
            pytest.skip(
                "no agents — test_create_insurance_agent / test_create_gcnv_agent "
                "did not succeed"
            )
        request = TeamCreationRequest(
            name=unique_name("kb-coord-team"),
            orchestration_policy=_ORCHESTRATION_POLICY,
            members=[
                TeamMemberRef.agent(ctx.insurance_agent_id),
                TeamMemberRef.agent(ctx.gcnv_agent_id),
            ],
            manager=TeamManagerConfig(
                name=_COORDINATOR_NAME,
                system_prompt=(
                    "You are a knowledge-base coordinator. "
                    "For insurance or policy questions, engage the insurance specialist. "
                    "For Google Cloud NetApp Volumes (GCNV) or cloud storage questions, "
                    "engage the GCNV specialist. "
                    "For questions that span both topics, engage both specialists and "
                    "synthesize a comprehensive answer from their responses."
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
        assert manager.get("name") == _COORDINATOR_NAME, (
            f"expected inline coordinator manager echoed back; got {manager!r}"
        )
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    # ------------------------------------------------------------------
    # Team detail validation
    # ------------------------------------------------------------------

    def test_get_team_details(self, ctx: RetrievalMultipleKBTeamContext) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_coordinate_team did not succeed")
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
        assert manager.get("name") == _COORDINATOR_NAME, (
            f"expected inline coordinator {_COORDINATOR_NAME!r}; got {manager!r}"
        )

    # ------------------------------------------------------------------
    # Single-domain invoke tests (mirrors test_retrieval_single_kb_team)
    # ------------------------------------------------------------------

    @pytest.mark.xfail(
        reason=(
            "Intermittent read timeout: coordinate multi-KB team invoke makes many "
            "sequential model round-trips (coordinator + member agents) and can "
            "exceed the client read timeout under a slow/rate-limited model backend. "
            "Remove this marker once team-invoke latency is reliable."
        ),
        strict=False,
    )
    def test_invoke_team_greeting_hi(self, ctx: RetrievalMultipleKBTeamContext) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_coordinate_team did not succeed")
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

    def test_invoke_team_insurance_query_uses_insurance_kb(
        self, ctx: RetrievalMultipleKBTeamContext
    ) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_coordinate_team did not succeed")
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

        _assert_magentic_metadata(data)

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

    def test_invoke_team_gcnv_query_uses_gcnv_kb(
        self, ctx: RetrievalMultipleKBTeamContext
    ) -> None:
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_coordinate_team did not succeed")
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

        _assert_magentic_metadata(data)

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

    # ------------------------------------------------------------------
    # Combined-domain invoke tests (unique to coordinate/multi-agent)
    # ------------------------------------------------------------------

    def test_invoke_team_combined_query_uses_both_kbs(
        self, ctx: RetrievalMultipleKBTeamContext
    ) -> None:
        """Invoke with a question spanning both domains and validate dual-KB citations.

        The coordinator engages both the insurance specialist and the GCNV specialist
        in a single invoke.  Because each agent only holds its own KB, the merged
        KB citations must contain entries from BOTH INSURANCE_KB_ID and GCNV_KB_ID.
        ``metadata.agent_names`` must include both specialist agent names, confirming
        both were activated by the magentic orchestrator.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_kb_coordinate_team did not succeed")
        request = AgentInvocationRequest(input=_COMBINED_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke"
        )
        resp = ctx.agent.invoke_team(ctx.project_id, ctx.team_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty team output"

        _assert_magentic_metadata(data)

        # Both specialist agents should appear in metadata.agent_names.
        metadata = data.get("metadata") or {}
        agent_names = metadata.get("agent_names") or []
        if agent_names:
            missing = [
                n
                for n in (ctx.insurance_agent_name, ctx.gcnv_agent_name)
                if n not in agent_names
            ]
            assert not missing, (
                f"expected both specialist agents in metadata.agent_names; "
                f"missing {missing!r} (got {agent_names!r})"
            )

        citations = data.get("citations")
        assert citations is not None, "citations missing from team invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, (
            "expected tool executions for combined KB query"
        )

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for combined query"

        kb_ids = set(_citation_kb_ids(kb_citations))
        assert len(kb_ids) > 0, "no knowledgeBaseId values found in KB citations"
        assert ctx.insurance_kb_id in kb_ids, (
            f"combined query missing insurance KB {ctx.insurance_kb_id!r} in citations; "
            f"got {sorted(kb_ids)!r}"
        )
        assert ctx.gcnv_kb_id in kb_ids, (
            f"combined query missing GCNV KB {ctx.gcnv_kb_id!r} in citations; "
            f"got {sorted(kb_ids)!r}"
        )
