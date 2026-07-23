"""Agent-service retrieval suite for one dual-KB agent.

Flow:
    project -> model -> agent(INSURANCE_KB_ID + GCNV_KB_ID) -> invokes

Validations:
- get agent details confirms both KBs and ragConfig entries
- greeting invoke has no tool executions and no KB citations
- insurance-focused invoke returns KB citations all from insurance KB
- gcnv-focused invoke returns KB citations all from gcnv KB
- combined invoke returns KB citations containing both KB ids
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
from lib.models.agent_invoke_request import AgentInvocationRequest
from lib.models.resources import SuiteResources

pytestmark = [
    pytest.mark.agent_service,
    pytest.mark.retrieval,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-retrieval-multi-kb"
PROJECT_SOURCE = "pytest-agent-retrieval-multi-kb"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

_INSURANCE_ONLY_QUERY = (
    "Answer only from Aegis Shield insurance policy documents: "
    "What is the HMO individual deductible?"
)
_GCNV_ONLY_QUERY = (
    "Answer only from Google Cloud NetApp Volumes (GCNV) documentation: "
    "How do I create a storage pool, and what required fields must be provided "
    "in console and gcloud?"
)
_COMBINED_QUERY = (
    "Use both knowledge bases. First, answer the HMO individual deductible from "
    "Aegis insurance docs. Then explain how to create a GCNV storage pool with "
    "required fields from GCNV docs."
)


@dataclass
class RetrievalMultipleKBContext:
    """Mutable state shared across ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    dual_agent_id: str = ""
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


class TestRetrievalMultipleKB:
    """Ordered retrieval flow for one dual-KB agent."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> RetrievalMultipleKBContext:
        if not agent_service_config.insurance_kb_id or not agent_service_config.gcnv_kb_id:
            pytest.skip(
                "multiple-kb retrieval suite requires INSURANCE_KB_ID and GCNV_KB_ID "
                "in tests/integration/.env.local"
            )

        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = RetrievalMultipleKBContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: RetrievalMultipleKBContext) -> None:
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
        self, ctx: RetrievalMultipleKBContext
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

    def test_add_and_validate_model(self, ctx: RetrievalMultipleKBContext) -> None:
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

    def test_create_dual_kb_agent(self, ctx: RetrievalMultipleKBContext) -> None:
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")

        request = AgentCreationRequest(
            name=unique_name("dual-kb-assistant"),
            description="Answers insurance and GCNV questions from both KBs",
            role="assistant",
            system_prompt="Answer using the provided knowledge bases and cite sources.",
            model_id=ctx.model_id,
            knowledge_base_ids=[ctx.insurance_kb_id, ctx.gcnv_kb_id],
            rag_config={
                ctx.insurance_kb_id: {
                    "topK": 5,
                    "searchMode": "hybrid",
                    "rerankingEnabled": True,
                    "similarityThreshold": 0.5,
                    "similarityThresholdEnabled": True,
                },
                ctx.gcnv_kb_id: {
                    "topK": 5,
                    "searchMode": "hybrid",
                    "rerankingEnabled": True,
                    "similarityThreshold": 0.5,
                    "similarityThresholdEnabled": True,
                },
            },
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.dual_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.dual_agent_id), f"unexpected agent id: {ctx.dual_agent_id!r}"
        ctx.resources.add_agent(ctx.dual_agent_id, ctx.project_id)

    def test_get_agent_detail_has_both_kbs_and_rag_config(
        self, ctx: RetrievalMultipleKBContext
    ) -> None:
        if not ctx.dual_agent_id:
            pytest.skip("no agent — test_create_dual_kb_agent did not succeed")

        url = (
            f"{ctx.config.config_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.dual_agent_id}"
        )
        resp = ctx.config_client.get_agent(ctx.project_id, ctx.dual_agent_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        kb_ids = data.get("knowledgeBaseIds") or []
        assert ctx.insurance_kb_id in kb_ids, (
            f"insurance KB {ctx.insurance_kb_id!r} missing in {kb_ids!r}"
        )
        assert ctx.gcnv_kb_id in kb_ids, f"gcnv KB {ctx.gcnv_kb_id!r} missing in {kb_ids!r}"

        rag_config = data.get("ragConfig") or {}
        assert ctx.insurance_kb_id in rag_config, "missing insurance ragConfig entry"
        assert ctx.gcnv_kb_id in rag_config, "missing gcnv ragConfig entry"

    def test_invoke_simple_hi_has_no_tools_or_kb_citations(
        self, ctx: RetrievalMultipleKBContext
    ) -> None:
        if not ctx.dual_agent_id:
            pytest.skip("no agent — test_create_dual_kb_agent did not succeed")

        request = AgentInvocationRequest(input="Hi")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.dual_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.dual_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("output"), "empty agent output"
        citations = data.get("citations") or {}
        assert len(_tool_executions_from_citations(citations)) == 0, (
            "greeting invoke should not execute tools"
        )
        assert len(_kb_citations_from_citations(citations)) == 0, (
            "greeting invoke should not include KB citations"
        )

    def test_invoke_insurance_only_query_uses_insurance_kb(
        self, ctx: RetrievalMultipleKBContext
    ) -> None:
        if not ctx.dual_agent_id:
            pytest.skip("no agent — test_create_dual_kb_agent did not succeed")

        request = AgentInvocationRequest(input=_INSURANCE_ONLY_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.dual_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.dual_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text

        data = resp.json()
        assert data.get("output"), "empty agent output"
        citations = data.get("citations")
        assert citations is not None, "citations missing from invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, "expected tool executions for insurance query"

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for insurance query"

        kb_ids = _citation_kb_ids(kb_citations)
        assert len(kb_ids) > 0, "no knowledgeBaseId values found in kb citations"
        assert all(kb_id == ctx.insurance_kb_id for kb_id in kb_ids), (
            "expected only insurance KB citations, got "
            f"{sorted(set(kb_ids))!r}"
        )

    def test_invoke_gcnv_only_query_uses_gcnv_kb(
        self, ctx: RetrievalMultipleKBContext
    ) -> None:
        if not ctx.dual_agent_id:
            pytest.skip("no agent — test_create_dual_kb_agent did not succeed")

        request = AgentInvocationRequest(input=_GCNV_ONLY_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.dual_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.dual_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text

        data = resp.json()
        assert data.get("output"), "empty agent output"
        citations = data.get("citations")
        assert citations is not None, "citations missing from invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, "expected tool executions for gcnv query"

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for gcnv query"

        kb_ids = _citation_kb_ids(kb_citations)
        assert len(kb_ids) > 0, "no knowledgeBaseId values found in kb citations"
        assert all(kb_id == ctx.gcnv_kb_id for kb_id in kb_ids), (
            "expected only gcnv KB citations, got "
            f"{sorted(set(kb_ids))!r}"
        )

    def test_invoke_combined_query_uses_both_kbs(
        self, ctx: RetrievalMultipleKBContext
    ) -> None:
        if not ctx.dual_agent_id:
            pytest.skip("no agent — test_create_dual_kb_agent did not succeed")

        request = AgentInvocationRequest(input=_COMBINED_QUERY)
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.dual_agent_id}/invoke"
        )
        resp = ctx.agent.invoke_agent(ctx.project_id, ctx.dual_agent_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text

        data = resp.json()
        assert data.get("output"), "empty agent output"
        citations = data.get("citations")
        assert citations is not None, "citations missing from invoke response"

        tool_executions = _tool_executions_from_citations(citations)
        assert len(tool_executions) > 0, "expected tool executions for combined query"

        kb_citations = _kb_citations_from_citations(citations)
        assert len(kb_citations) > 0, "expected KB citations for combined query"

        kb_ids = set(_citation_kb_ids(kb_citations))
        assert ctx.insurance_kb_id in kb_ids, (
            f"combined query missing insurance KB id {ctx.insurance_kb_id!r}; got {sorted(kb_ids)!r}"
        )
        assert ctx.gcnv_kb_id in kb_ids, (
            f"combined query missing gcnv KB id {ctx.gcnv_kb_id!r}; got {sorted(kb_ids)!r}"
        )
