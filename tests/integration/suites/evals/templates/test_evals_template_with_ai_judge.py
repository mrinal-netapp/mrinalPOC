"""Evals templates suite — insurance KB agent with AI judge.

Chained end-to-end flow against a live deployment:

    project -> model -> insurance KB agent
            -> eval template (llm_judge + thresholds) -> read-back
            -> upload testcases (insurance_agent_eval_tests.json)
            -> update AI judge config -> delete -> 404

Requires ``INSURANCE_KB_ID`` in ``tests/integration/.env.local``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.evaluation_template_request import (
    EvaluationTemplateCreateRequest,
    EvaluationTemplateUpdateRequest,
)
from lib.models.resources import SuiteResources

pytestmark = [pytest.mark.evals]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")
TEMPLATE_ID_RE = re.compile(r"^evt-[a-z0-9]{8}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

PROJECT_NAME_PREFIX = "e2e-evals-ai-judge"
PROJECT_SOURCE = "pytest-evals-ai-judge-template"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

TESTCASES_FILENAME = "insurance_agent_eval_tests.json"

_ALL_JUDGE_DIMENSIONS = [
    "helpfulness",
    "correctness",
    "completeness",
    "coherence",
    "following_instructions",
    "professional_style_tone",
    "faithfulness_groundedness",
    "safety_harmlessness",
    "refusal_quality",
]

_INTEGRATION_ROOT = Path(__file__).resolve().parents[3]
_TESTCASES_FIXTURE = _INTEGRATION_ROOT / "docs" / TESTCASES_FILENAME


def _non_empty_line_count(data: bytes) -> int:
    """Match config-service testcases metadata: count non-empty lines in the body."""
    return len([line for line in data.decode("utf-8").split("\n") if line.strip()])


@dataclass
class AiJudgeTemplateContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    template_id: str = ""
    eval_name: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)

    @property
    def insurance_kb_id(self) -> str:
        return self.config.insurance_kb_id


class TestEvalsTemplateWithAiJudge:
    """Ordered AI-judge template lifecycle (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> AiJudgeTemplateContext:
        """Before/after class: build clients + shared context."""
        if not agent_service_config.insurance_kb_id:
            pytest.skip(
                "AI-judge evals suite requires INSURANCE_KB_ID in "
                "tests/integration/.env.local"
            )
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        state = AiJudgeTemplateContext(
            config_client=config_client,
            config=agent_service_config,
        )
        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        config_client.close()

    def test_create_and_validate_project(self, ctx: AiJudgeTemplateContext) -> None:
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
        self, ctx: AiJudgeTemplateContext
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

    def test_add_and_validate_model(self, ctx: AiJudgeTemplateContext) -> None:
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

    def test_create_insurance_agent_with_kb(self, ctx: AiJudgeTemplateContext) -> None:
        """Create an insurance assistant bound to ``INSURANCE_KB_ID``."""
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-evals-insurance-kb-agent"),
            description="Answers insurance policy questions from insurance KB",
            role="Insurance assistant",
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
        ctx.agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id), (
            f"unexpected agent id: {ctx.agent_id!r}"
        )
        ctx.resources.add_agent(ctx.agent_id, ctx.project_id)

    def test_create_eval_template_with_ai_judge(
        self, ctx: AiJudgeTemplateContext
    ) -> None:
        """Create an AI-judge template with all dimensions and thresholds."""
        if not ctx.agent_id or not ctx.model_id:
            pytest.skip("no agent/model — prerequisites did not succeed")
        ctx.eval_name = unique_name("e2e insurance ai judge eval")
        request = EvaluationTemplateCreateRequest(
            eval_name=ctx.eval_name,
            agent_id=ctx.agent_id,
            strategy="llm_judge",
            judge_models=[ctx.model_id],
            judge_dimensions=list(_ALL_JUDGE_DIMENSIONS),
            judge_eval_mode="pointwise",
            judge_sampling_mode="all",
            judge_stratified_slices=False,
            judge_gate_when_sampled="blocking",
            golden_available=True,
            thresholds={
                "gates": [
                    {"id": "correctness", "level": "warning", "threshold": 0.7},
                    {"id": "helpfulness", "level": "informational", "threshold": 0.6},
                ],
                "coverageMinPct": 80,
                "infraFailureMaxPct": 10,
                "safetyP0Threshold": 0,
                "minCompletedCases": 1,
            },
            suite="rag",
            evaluation_scope="full_agent_execution",
        )
        url = ctx.config_client.evaluation_templates_url(ctx.project_id)
        resp = ctx.config_client.create_evaluation_template(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.template_id = data["templateId"]
        assert TEMPLATE_ID_RE.match(ctx.template_id), (
            f"unexpected template id: {ctx.template_id!r}"
        )
        assert data.get("agent", {}).get("agentId") == ctx.agent_id
        evaluators = data.get("evaluators", {})
        assert evaluators.get("strategy") == "llm_judge"
        ai_judge = evaluators.get("aiJudge", {})
        assert ai_judge.get("models") == [ctx.model_id]
        assert set(ai_judge.get("dimensions", [])) == set(_ALL_JUDGE_DIMENSIONS)
        ctx.resources.add_evaluation_template(ctx.template_id, ctx.project_id)

    def test_get_eval_template_details(self, ctx: AiJudgeTemplateContext) -> None:
        """Fetch full template details and validate AI-judge + thresholds."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template_with_ai_judge did not succeed")
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}"
        )
        resp = ctx.config_client.get_evaluation_template_details(
            ctx.project_id, ctx.template_id
        )
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("templateId") == ctx.template_id
        assert data.get("projectId") == ctx.project_id
        assert data.get("evalName") == ctx.eval_name
        assert data.get("agent", {}).get("agentId") == ctx.agent_id
        evaluators = data.get("evaluators", {})
        assert evaluators.get("strategy") == "llm_judge"
        ai_judge = evaluators.get("aiJudge", {})
        assert ai_judge.get("models") == [ctx.model_id]
        assert set(ai_judge.get("dimensions", [])) == set(_ALL_JUDGE_DIMENSIONS)
        assert ai_judge.get("evalMode") == "pointwise"
        thresholds = data.get("thresholds", {})
        assert isinstance(thresholds.get("gates"), list)
        assert len(thresholds.get("gates", [])) >= 2
        assert data.get("target") == "agent_version"
        assert data.get("runMode") == "single"
        assert data.get("owner")
        assert data.get("createdBy")
        assert data.get("createdAt")
        assert data.get("updatedAt")

    def test_upload_test_cases(self, ctx: AiJudgeTemplateContext) -> None:
        """Upload the insurance golden-cases JSON fixture."""
        if not ctx.template_id or not ctx.eval_name:
            pytest.skip("no template — test_create_eval_template_with_ai_judge did not succeed")
        assert _TESTCASES_FIXTURE.is_file(), (
            f"fixture missing: {_TESTCASES_FIXTURE}"
        )
        fixture_bytes = _TESTCASES_FIXTURE.read_bytes()
        eval_id = ConfigServiceClient.slugify_eval_name(ctx.eval_name)
        url = (
            f"{ctx.config_client.evaluation_testcases_url(ctx.project_id, eval_id)}"
            f"?filename={TESTCASES_FILENAME}"
        )
        resp = ctx.config_client.upload_evaluation_testcases(
            ctx.project_id,
            eval_id,
            fixture_bytes,
            filename=TESTCASES_FILENAME,
        )
        log_exchange("PUT", url, f"<{len(fixture_bytes)} bytes>", resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("filename") == TESTCASES_FILENAME
        assert data.get("lineCount") == _non_empty_line_count(fixture_bytes)
        assert data.get("byteCount", 0) > 0

    def test_get_test_cases(self, ctx: AiJudgeTemplateContext) -> None:
        """Fetch test-case metadata and validate upload."""
        if not ctx.eval_name:
            pytest.skip("no template — test_create_eval_template_with_ai_judge did not succeed")
        eval_id = ConfigServiceClient.slugify_eval_name(ctx.eval_name)
        url = (
            f"{ctx.config_client.evaluation_testcases_url(ctx.project_id, eval_id)}"
            f"?include=metadata"
        )
        resp = ctx.config_client.get_evaluation_testcases(
            ctx.project_id, eval_id, include="metadata"
        )
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("filename") == TESTCASES_FILENAME
        assert data.get("lineCount") == _non_empty_line_count(
            _TESTCASES_FIXTURE.read_bytes()
        )

    def test_update_eval_template_ai_judge(self, ctx: AiJudgeTemplateContext) -> None:
        """Update AI-judge dimensions and eval mode."""
        if not ctx.template_id or not ctx.model_id:
            pytest.skip("prerequisites missing (template / model)")
        updated_dimensions = [
            "correctness",
            "faithfulness_groundedness",
            "safety_harmlessness",
        ]
        request = EvaluationTemplateUpdateRequest(
            strategy="llm_judge",
            judge_models=[ctx.model_id],
            judge_dimensions=updated_dimensions,
            judge_eval_mode="pairwise",
        )
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}"
        )
        resp = ctx.config_client.update_evaluation_template(
            ctx.project_id, ctx.template_id, request
        )
        log_exchange("PATCH", url, request.to_body(), resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        ai_judge = data.get("evaluators", {}).get("aiJudge", {})
        assert set(ai_judge.get("dimensions", [])) == set(updated_dimensions)
        assert ai_judge.get("evalMode") == "pairwise"

    def test_delete_eval_template(self, ctx: AiJudgeTemplateContext) -> None:
        """Soft-delete the evaluation template."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template_with_ai_judge did not succeed")
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}"
        )
        resp = ctx.config_client.delete_evaluation_template(
            ctx.project_id, ctx.template_id
        )
        log_exchange("DELETE", url, None, resp)
        assert resp.status_code == 204, resp.text
        ctx.resources.evaluation_templates = [
            ref
            for ref in ctx.resources.evaluation_templates
            if ref.id != ctx.template_id
        ]

    def test_get_deleted_template_404(self, ctx: AiJudgeTemplateContext) -> None:
        """Confirm the soft-deleted template is no longer readable."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template_with_ai_judge did not succeed")
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}"
        )
        resp = ctx.config_client.get_evaluation_template_details(
            ctx.project_id, ctx.template_id
        )
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 404, resp.text
