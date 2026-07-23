"""Evals templates suite — simple agent, deterministic-only (no AI judge).

Chained end-to-end flow against a live deployment:

    project -> model -> agent_1 + agent_2
            -> eval template (deterministic/correctness) -> read-back
            -> upload testcases (simple_agent_eval_tests.json)
            -> swap agent -> delete -> 404

Provisioning uses config-service (``ConfigServiceClient``); no runs are
triggered. State flows between ordered methods through a class-scoped
``SimpleTemplateContext``.
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

PROJECT_NAME_PREFIX = "e2e-evals-simple"
PROJECT_SOURCE = "pytest-evals-simple-template"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

TESTCASES_FILENAME = "simple_agent_eval_tests.json"

_INTEGRATION_ROOT = Path(__file__).resolve().parents[3]
_TESTCASES_FIXTURE = _INTEGRATION_ROOT / "docs" / TESTCASES_FILENAME


def _non_empty_line_count(data: bytes) -> int:
    """Match config-service testcases metadata: count non-empty lines in the body."""
    return len([line for line in data.decode("utf-8").split("\n") if line.strip()])


def _find_template_in_list(
    items: list[dict],
    template_id: str,
) -> dict | None:
    """Return the list item matching ``templateId``, or ``None``."""
    return next(
        (item for item in items if item.get("templateId") == template_id),
        None,
    )


def _assert_list_item_enriched(item: dict, *, agent_id: str) -> None:
    """Validate enriched list fields for a deterministic template."""
    assert item.get("agent", {}).get("agentId") == agent_id
    assert item.get("evaluators", {}).get("strategy") == "deterministic"
    assert item.get("runCount") == 0
    assert item.get("latestRunStatus") is None
    assert item.get("lastRunUpdatedAt") is None


@dataclass
class SimpleTemplateContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id_1: str = ""
    agent_id_2: str = ""
    template_id: str = ""
    eval_name: str = ""
    template_id_2: str = ""
    eval_name_2: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestEvalsTemplateSimpleWithoutAiJudge:
    """Ordered deterministic-only template lifecycle (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> SimpleTemplateContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        state = SimpleTemplateContext(
            config_client=config_client,
            config=agent_service_config,
        )
        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        config_client.close()

    def test_create_and_validate_project(self, ctx: SimpleTemplateContext) -> None:
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
        self, ctx: SimpleTemplateContext
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

    def test_add_and_validate_model(self, ctx: SimpleTemplateContext) -> None:
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

    def test_create_agent_1(self, ctx: SimpleTemplateContext) -> None:
        """Create the first simple assistant agent (no tools/KB)."""
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-evals-simple-agent1"),
            role="assistant",
            system_prompt="You are a helpful assistant. Give short, clear answers.",
            model_id=ctx.model_id,
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.agent_id_1 = data["id"]
        assert AGENT_ID_RE.match(ctx.agent_id_1), (
            f"unexpected agent id: {ctx.agent_id_1!r}"
        )
        ctx.resources.add_agent(ctx.agent_id_1, ctx.project_id)

    def test_create_agent_2(self, ctx: SimpleTemplateContext) -> None:
        """Create the second simple assistant agent (different prompt)."""
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-evals-simple-agent2"),
            role="assistant",
            system_prompt=(
                "You are a concise assistant. Answer briefly and stay on topic."
            ),
            model_id=ctx.model_id,
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
        ctx.resources.add_agent(ctx.agent_id_2, ctx.project_id)

    def test_create_eval_template(self, ctx: SimpleTemplateContext) -> None:
        """Create a deterministic-only evaluation template bound to agent 1."""
        if not ctx.agent_id_1:
            pytest.skip("no agent — test_create_agent_1 did not succeed")
        ctx.eval_name = unique_name("e2e simple eval")
        request = EvaluationTemplateCreateRequest(
            eval_name=ctx.eval_name,
            agent_id=ctx.agent_id_1,
            strategy="deterministic",
            deterministic_metrics=["correctness"],
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
        assert data.get("agent", {}).get("agentId") == ctx.agent_id_1
        assert data.get("evaluators", {}).get("strategy") == "deterministic"
        ctx.resources.add_evaluation_template(ctx.template_id, ctx.project_id)

    def test_create_eval_template_2(self, ctx: SimpleTemplateContext) -> None:
        """Create a second template (different name, same agent and evaluators)."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
        ctx.eval_name_2 = unique_name("e2e simple eval two")
        request = EvaluationTemplateCreateRequest(
            eval_name=ctx.eval_name_2,
            agent_id=ctx.agent_id_1,
            strategy="deterministic",
            deterministic_metrics=["correctness"],
        )
        url = ctx.config_client.evaluation_templates_url(ctx.project_id)
        resp = ctx.config_client.create_evaluation_template(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.template_id_2 = data["templateId"]
        assert TEMPLATE_ID_RE.match(ctx.template_id_2), (
            f"unexpected template id: {ctx.template_id_2!r}"
        )
        assert data.get("agent", {}).get("agentId") == ctx.agent_id_1
        assert data.get("evaluators", {}).get("strategy") == "deterministic"
        ctx.resources.add_evaluation_template(ctx.template_id_2, ctx.project_id)

    def test_list_eval_templates(self, ctx: SimpleTemplateContext) -> None:
        """List templates and confirm both created templates appear with enriched fields."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
        url = ctx.config_client.evaluation_templates_url(ctx.project_id)
        resp = ctx.config_client.list_evaluation_templates(ctx.project_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        items = resp.json()
        assert isinstance(items, list)
        assert len(items) >= 1

        match_1 = _find_template_in_list(items, ctx.template_id)
        assert match_1 is not None, (
            f"template {ctx.template_id!r} not found in list response"
        )
        _assert_list_item_enriched(match_1, agent_id=ctx.agent_id_1)

        if not ctx.template_id_2:
            return

        assert len(items) >= 2
        match_2 = _find_template_in_list(items, ctx.template_id_2)
        assert match_2 is not None, (
            f"template {ctx.template_id_2!r} not found in list response"
        )
        _assert_list_item_enriched(match_2, agent_id=ctx.agent_id_1)

    def test_get_eval_template_details(self, ctx: SimpleTemplateContext) -> None:
        """Fetch full template details and validate all expected fields."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
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
        assert data.get("agent", {}).get("agentId") == ctx.agent_id_1
        assert data.get("evaluators", {}).get("strategy") == "deterministic"
        metrics = data.get("evaluators", {}).get("deterministic", {}).get("metrics", [])
        assert "correctness" in metrics
        assert "aiJudge" not in data.get("evaluators", {})
        assert data.get("target") == "agent_version"
        assert data.get("runMode") == "single"
        assert data.get("owner")
        assert data.get("createdBy")
        assert data.get("createdAt")
        assert data.get("updatedAt")

    def test_upload_test_cases(self, ctx: SimpleTemplateContext) -> None:
        """Upload the simple-agent golden-cases JSON fixture."""
        if not ctx.template_id or not ctx.eval_name:
            pytest.skip("no template — test_create_eval_template did not succeed")
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

    def test_upload_test_cases_template_2(self, ctx: SimpleTemplateContext) -> None:
        """Upload the same golden-cases fixture to the second template."""
        if not ctx.template_id_2 or not ctx.eval_name_2:
            pytest.skip("no template 2 — test_create_eval_template_2 did not succeed")
        assert _TESTCASES_FIXTURE.is_file(), (
            f"fixture missing: {_TESTCASES_FIXTURE}"
        )
        fixture_bytes = _TESTCASES_FIXTURE.read_bytes()
        eval_id = ConfigServiceClient.slugify_eval_name(ctx.eval_name_2)
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

    def test_get_test_cases(self, ctx: SimpleTemplateContext) -> None:
        """Fetch test-case metadata and validate upload."""
        if not ctx.eval_name:
            pytest.skip("no template — test_create_eval_template did not succeed")
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

    def test_update_eval_template_swap_agent(self, ctx: SimpleTemplateContext) -> None:
        """Swap the bound agent from agent 1 to agent 2."""
        if not ctx.template_id or not ctx.agent_id_2:
            pytest.skip("prerequisites missing (template / agent_2)")
        request = EvaluationTemplateUpdateRequest(agent_id=ctx.agent_id_2)
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
        assert data.get("agent", {}).get("agentId") == ctx.agent_id_2

    def test_delete_eval_template(self, ctx: SimpleTemplateContext) -> None:
        """Soft-delete the evaluation template."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
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

    def test_get_deleted_template_404(self, ctx: SimpleTemplateContext) -> None:
        """Confirm the soft-deleted template is no longer readable."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}"
        )
        resp = ctx.config_client.get_evaluation_template_details(
            ctx.project_id, ctx.template_id
        )
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 404, resp.text
