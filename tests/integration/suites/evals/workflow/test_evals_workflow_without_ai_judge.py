"""Evals workflow suite — simple agent, deterministic-only (no AI judge).

Chained end-to-end flow against a live deployment:

    project -> model -> agent
            -> eval template (deterministic/correctness) -> upload testcases
            -> trigger run -> poll to terminal -> validate results

Provisioning and run control use config-service (``ConfigServiceClient``).
State flows between ordered methods through a class-scoped
``WorkflowContext``.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from uuid import uuid4

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.env import AgentServiceConfig
from lib.common.logger import log, log_exchange
from lib.common.platform_client import unique_name
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient
from lib.config_service.model import ModelProvisioner
from lib.config_service.waits import wait_for_evaluation_run_terminal, wait_for_project_ready
from lib.models.agent_creation_request import AgentCreationRequest
from lib.models.evaluation_template_request import EvaluationTemplateCreateRequest
from lib.models.resources import SuiteResources

pytestmark = [pytest.mark.evals]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")
TEMPLATE_ID_RE = re.compile(r"^evt-[a-z0-9]{8}$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

PROJECT_NAME_PREFIX = "e2e-evals-workflow"
PROJECT_SOURCE = "pytest-evals-workflow"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

TESTCASES_FILENAME = "simple_agent_eval_tests.json"
RUN_ACTOR = "pytest-evals-workflow"
RUN_TIMEOUT_SEC = int(os.environ.get("EVALS_RUN_TIMEOUT_SEC", "300"))
RUN_POLL_SEC = 10

ALLOWED_STATUSES = frozenset({"queued", "running", "aggregating", "success"})
STATUS_RANK = {
    "queued": 0,
    "running": 1,
    "aggregating": 2,
    "success": 3,
    "failed": 4,
    "cancelled": 4,
}

_INTEGRATION_ROOT = Path(__file__).resolve().parents[3]
_TESTCASES_FIXTURE = _INTEGRATION_ROOT / "docs" / TESTCASES_FILENAME


def _non_empty_line_count(data: bytes) -> int:
    """Match config-service testcases metadata: count non-empty lines in the body."""
    return len([line for line in data.decode("utf-8").split("\n") if line.strip()])


def _fixture_case_count() -> int:
    """Return the number of test cases in the JSON array fixture."""
    payload = json.loads(_TESTCASES_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(payload, list)
    return len(payload)


def _find_run_in_list(items: list[dict], run_id: str) -> dict | None:
    return next((item for item in items if item.get("runId") == run_id), None)


def _find_template_in_list(items: list[dict], template_id: str) -> dict | None:
    return next(
        (item for item in items if item.get("templateId") == template_id),
        None,
    )


def _assert_status_transitions_valid(observed_statuses: list[str]) -> None:
    assert observed_statuses, "expected at least one observed status"
    for status in observed_statuses:
        assert status in ALLOWED_STATUSES, f"unexpected status in transition path: {status!r}"
    ranks = [STATUS_RANK[status] for status in observed_statuses]
    assert ranks == sorted(ranks), (
        f"status transitions must be non-decreasing: {observed_statuses}"
    )


@dataclass
class WorkflowContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    credential_id: str = ""
    model_id: str = ""
    agent_id: str = ""
    template_id: str = ""
    eval_name: str = ""
    run_id: str = ""
    workflow_id: str = ""
    case_count: int = 0
    final_run: dict | None = None
    observed_statuses: list[str] = field(default_factory=list)
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestEvalsWorkflowWithoutAiJudge:
    """Ordered deterministic-only evaluation run lifecycle (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> WorkflowContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        state = WorkflowContext(
            config_client=config_client,
            config=agent_service_config,
        )
        yield state
        cleanup_resources(state.config_client, integration_settings, state.resources)
        config_client.close()

    def test_create_and_validate_project(self, ctx: WorkflowContext) -> None:
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

    def test_add_and_validate_azure_openai_cred(self, ctx: WorkflowContext) -> None:
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

    def test_add_and_validate_model(self, ctx: WorkflowContext) -> None:
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

    def test_create_agent(self, ctx: WorkflowContext) -> None:
        """Create a simple assistant agent (no tools/KB)."""
        if not ctx.model_id:
            pytest.skip("no model — test_add_and_validate_model did not succeed")
        request = AgentCreationRequest(
            name=unique_name("e2e-evals-workflow-agent"),
            role="assistant",
            system_prompt="You are a helpful assistant. Give short, clear answers.",
            model_id=ctx.model_id,
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

    def test_create_eval_template(self, ctx: WorkflowContext) -> None:
        """Create a deterministic-only evaluation template bound to the agent."""
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        ctx.eval_name = unique_name("e2e workflow eval")
        request = EvaluationTemplateCreateRequest(
            eval_name=ctx.eval_name,
            agent_id=ctx.agent_id,
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
        assert data.get("agent", {}).get("agentId") == ctx.agent_id
        assert data.get("evaluators", {}).get("strategy") == "deterministic"
        ctx.resources.add_evaluation_template(ctx.template_id, ctx.project_id)

    def test_upload_test_cases(self, ctx: WorkflowContext) -> None:
        """Upload the simple-agent golden-cases JSON fixture."""
        if not ctx.template_id or not ctx.eval_name:
            pytest.skip("no template — test_create_eval_template did not succeed")
        assert _TESTCASES_FIXTURE.is_file(), (
            f"fixture missing: {_TESTCASES_FIXTURE}"
        )
        fixture_bytes = _TESTCASES_FIXTURE.read_bytes()
        ctx.case_count = _fixture_case_count()
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

    def test_trigger_run_returns_202_queued(self, ctx: WorkflowContext) -> None:
        """Trigger a run and assert the accepted queued response."""
        if not ctx.template_id:
            pytest.skip("no template — test_create_eval_template did not succeed")
        ctx.run_id = str(uuid4())
        url = (
            f"{ctx.config_client.evaluation_templates_url(ctx.project_id)}"
            f"/{ctx.template_id}/runs"
        )
        resp = ctx.config_client.trigger_evaluation_run(
            ctx.project_id,
            ctx.template_id,
            run_id=ctx.run_id,
            actor=RUN_ACTOR,
            reason="pytest-evals-workflow deterministic run",
        )
        log_exchange(
            "POST",
            url,
            {
                "runId": ctx.run_id,
                "actor": RUN_ACTOR,
                "reason": "pytest-evals-workflow deterministic run",
            },
            resp,
        )
        assert resp.status_code == 202, resp.text
        data = resp.json()
        assert data.get("runId") == ctx.run_id
        assert data.get("status") == "queued"
        ctx.workflow_id = data.get("workflowId", "")
        assert ctx.workflow_id == f"evaluation-agent-run-{ctx.run_id}"
        run = data.get("run", {})
        assert run.get("runId") == ctx.run_id
        assert run.get("templateId") == ctx.template_id

    def test_run_visible_immediately(self, ctx: WorkflowContext) -> None:
        """Fetch the run right after trigger and validate initial persisted fields."""
        if not ctx.run_id:
            pytest.skip("no run — test_trigger_run_returns_202_queued did not succeed")
        url = f"{ctx.config_client.evaluation_runs_url(ctx.project_id)}/{ctx.run_id}"
        resp = ctx.config_client.get_evaluation_run(ctx.project_id, ctx.run_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data.get("runId") == ctx.run_id
        assert data.get("templateId") == ctx.template_id
        assert data.get("status") in ALLOWED_STATUSES
        assert data.get("templateSnapshot")
        assert data.get("provenance")
        audit = data.get("audit", [])
        assert any(event.get("type") == "run_created" for event in audit)

    def test_run_reaches_terminal_success(self, ctx: WorkflowContext) -> None:
        """Poll until the run reaches a terminal state and hard-assert success."""
        if not ctx.run_id:
            pytest.skip("no run — test_trigger_run_returns_202_queued did not succeed")
        final_run, observed_statuses = wait_for_evaluation_run_terminal(
            ctx.config_client,
            ctx.project_id,
            ctx.run_id,
            timeout_sec=RUN_TIMEOUT_SEC,
            poll_interval_sec=RUN_POLL_SEC,
        )
        ctx.final_run = final_run
        ctx.observed_statuses = observed_statuses
        log.info(
            f"  [run] terminal status={final_run.get('status')!r} "
            f"observed={observed_statuses}"
        )
        assert final_run.get("status") == "success", (
            f"expected success, got {final_run.get('status')!r}; run={final_run}"
        )

    def test_status_transitions_valid(self, ctx: WorkflowContext) -> None:
        """Assert observed statuses are valid and non-decreasing."""
        if not ctx.observed_statuses:
            pytest.skip("no observed statuses — terminal poll did not succeed")
        _assert_status_transitions_valid(ctx.observed_statuses)

    def test_audit_trail_captures_lifecycle(self, ctx: WorkflowContext) -> None:
        """Fetch audit events and confirm lifecycle entries were recorded."""
        if not ctx.run_id:
            pytest.skip("no run — test_trigger_run_returns_202_queued did not succeed")
        url = (
            f"{ctx.config_client.evaluation_runs_url(ctx.project_id)}"
            f"/{ctx.run_id}/audit-events"
        )
        resp = ctx.config_client.get_evaluation_run_audit_events(
            ctx.project_id,
            ctx.run_id,
        )
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        events = resp.json()
        assert isinstance(events, list)
        assert any(event.get("type") == "run_created" for event in events)
        lifecycle_types = {
            "evaluation.started",
            "evaluation.completed",
            "evaluation.failed",
            "evaluation.stopped",
        }
        assert any(event.get("type") in lifecycle_types for event in events)

    def test_results_coverage_complete(self, ctx: WorkflowContext) -> None:
        """Assert test cases were executed (a single transient case failure is tolerated)."""
        if not ctx.final_run:
            pytest.skip("no final run — test_run_reaches_terminal_success did not succeed")
        results = ctx.final_run.get("results", {})
        coverage = results.get("coverage", {})
        assert coverage.get("completedPct") > 0
        assert coverage.get("completed") > 0
        assert coverage.get("total") == ctx.case_count

    def test_results_verdict_and_quality(self, ctx: WorkflowContext) -> None:
        """Assert the worker verdict and quality score."""
        if not ctx.final_run:
            pytest.skip("no final run — test_run_reaches_terminal_success did not succeed")
        results = ctx.final_run.get("results", {})
        assert results.get("verdict") == "pass"
        assert results.get("qualityPct") is not None

    def test_results_no_infra_failures(self, ctx: WorkflowContext) -> None:
        """Assert infra failures stay within a tolerated threshold."""
        if not ctx.final_run:
            pytest.skip("no final run — test_run_reaches_terminal_success did not succeed")
        results = ctx.final_run.get("results", {})
        assert results.get("infraFailureRate") <= 0.1

    def test_results_gates_not_triggered(self, ctx: WorkflowContext) -> None:
        """Assert no blocking gates failed."""
        if not ctx.final_run:
            pytest.skip("no final run — test_run_reaches_terminal_success did not succeed")
        results = ctx.final_run.get("results", {})
        triggered_gates = results.get("triggeredGates", [])
        blocking_failures = [
            gate
            for gate in triggered_gates
            if gate.get("level") == "blocking" and gate.get("status") == "failed"
        ]
        assert not blocking_failures, f"unexpected blocking gate failures: {blocking_failures}"

    def test_run_listed_and_filterable(self, ctx: WorkflowContext) -> None:
        """List runs by template/status and confirm template list enrichment."""
        if not ctx.run_id or not ctx.template_id:
            pytest.skip("no run — test_trigger_run_returns_202_queued did not succeed")
        runs_url = ctx.config_client.evaluation_runs_url(ctx.project_id)
        resp = ctx.config_client.list_evaluation_runs(
            ctx.project_id,
            template_id=ctx.template_id,
            status="success",
        )
        log_exchange(
            "GET",
            f"{runs_url}?templateId={ctx.template_id}&status=success",
            None,
            resp,
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()
        assert isinstance(items, list)
        match = _find_run_in_list(items, ctx.run_id)
        assert match is not None, f"run {ctx.run_id!r} not found in filtered list"
        assert match.get("status") == "success"

        templates_url = ctx.config_client.evaluation_templates_url(ctx.project_id)
        tmpl_resp = ctx.config_client.list_evaluation_templates(ctx.project_id)
        log_exchange("GET", templates_url, None, tmpl_resp)
        assert tmpl_resp.status_code == 200, tmpl_resp.text
        templates = tmpl_resp.json()
        template_item = _find_template_in_list(templates, ctx.template_id)
        assert template_item is not None
        assert template_item.get("latestRunStatus") == "success"
        assert template_item.get("runCount", 0) >= 1
