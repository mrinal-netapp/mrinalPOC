"""Agent-service interface suite — async invoke (``/invoke/async`` + ``/tasks``).

Two chained flows against a live deployment, both exercising the fire-and-forget
async transport:

Agent flow:
    project -> model -> agent -> GET agent details
            -> POST agents/{id}/invoke/async  (202, task_id captured)
            -> GET /tasks/{task_id}  immediately   (status == running)
            -> poll every 5 s up to 60 s        (status == completed, result validated)

Team flow (routing, inline manager):
    science agent + math agent -> POST route team with manager config
            -> GET team details (validate all fields)
            -> POST agent-teams/{id}/invoke/async  (202, team_task_id captured)
            -> GET /tasks/{task_id}  immediately   (status == running)
            -> poll every 5 s up to 60 s        (status == completed, result validated)

Provisioning uses config-service (``ConfigServiceClient``); async invokes and
task polling use agent-service (``AgentServiceClient``). State flows between
the ordered methods through the class-scoped ``AsyncInterfaceContext``.

This file is fully self-contained: it provisions its own project, model,
agents, and team in the ``ctx`` fixture and cleans them up on teardown.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

import pytest

from lib.agent_service.cleanup import cleanup_resources
from lib.agent_service.client import AgentServiceClient
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
    pytest.mark.interface,
]

AGENT_ID_RE = re.compile(r"^ag-[a-z0-9]{8}$")

# Provisioning identity used by the ordered prerequisite tests.
PROJECT_NAME_PREFIX = "e2e-interface-async"
PROJECT_SOURCE = "pytest-agent-interface-async"
PROJECT_READY_TIMEOUT_SEC = 60
PROJECT_READY_POLL_SEC = 5

# UUID shape config-service returns for created models/credentials.
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
TEAM_ID_RE = re.compile(r"^agr-[a-z0-9]{8}$")

# Terminal task statuses — polling stops here.
_TERMINAL_STATUSES = {"completed", "failed", "cancelled"}

# Polling loop: probe every 5 s, give up after 60 s.
_POLL_INTERVAL_SECONDS = 5
_POLL_TIMEOUT_SECONDS = 60

# Inline router manager name used in the routing team.
_ROUTER_NAME = "async-interface-router"


def _poll_to_terminal(
    agent_client: AgentServiceClient,
    project_id: str,
    task_id: str,
    log_url: str,
) -> dict:
    """Poll ``GET /tasks/{task_id}`` every ``_POLL_INTERVAL_SECONDS`` until terminal.

    Sleeps ``_POLL_INTERVAL_SECONDS`` between probes and stops as soon as
    ``status`` leaves ``"running"`` or ``_POLL_TIMEOUT_SECONDS`` has elapsed.
    Each probe response is logged via ``log_exchange``. Returns the last
    response JSON dict so callers can assert on the final state.
    """
    deadline = time.time() + _POLL_TIMEOUT_SECONDS
    data: dict = {}
    while True:
        time.sleep(_POLL_INTERVAL_SECONDS)
        resp = agent_client.get_task_details(project_id, task_id)
        log_exchange("GET", log_url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        if data.get("status") in _TERMINAL_STATUSES or time.time() >= deadline:
            break
    return data


@dataclass
class AsyncInterfaceContext:
    """Mutable state shared across the ordered test methods in this suite."""

    config_client: ConfigServiceClient
    agent: AgentServiceClient
    config: AgentServiceConfig
    project_id: str = ""
    project_name: str = ""
    credential_id: str = ""
    model_ids: list[str] = field(default_factory=list)
    agent_id: str = ""
    task_id: str = ""
    science_agent_id: str = ""
    math_agent_id: str = ""
    team_id: str = ""
    team_task_id: str = ""
    cancel_agent_task_id: str = ""
    cancel_team_task_id: str = ""
    resources: SuiteResources = field(default_factory=SuiteResources)


class TestAsyncInvokeProtocol:
    """Ordered async-invoke flow (methods run in definition order)."""

    @pytest.fixture(scope="class")
    def ctx(
        self,
        integration_settings: IntegrationSettings,
        agent_service_config: AgentServiceConfig,
    ) -> AsyncInterfaceContext:
        """Before/after class: build clients + shared context."""
        config_client = ConfigServiceClient(agent_service_config, integration_settings)
        agent = AgentServiceClient(agent_service_config, integration_settings)
        state = AsyncInterfaceContext(
            config_client=config_client,
            agent=agent,
            config=agent_service_config,
        )


        yield state

        cleanup_resources(state.config_client, integration_settings, state.resources)
        agent.close()
        config_client.close()

    def test_create_and_validate_project(self, ctx: AsyncInterfaceContext) -> None:
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
        self, ctx: AsyncInterfaceContext
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

    def test_add_and_validate_model(self, ctx: AsyncInterfaceContext) -> None:
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

    def test_create_agent(self, ctx: AsyncInterfaceContext) -> None:
        """Create the assistant agent used by the async invoke tests.

        Test scenario:
            Skip if no models exist. POST an AgentCreationRequest with role
            assistant bound to the provisioned model and store the agent id on
            the context.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, and the
            echoed ``modelId`` and ``role`` match what was requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        name = unique_name("e2e-interface-async-agent")
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

    # ------------------------------------------------------------------
    # GET agent details
    # ------------------------------------------------------------------

    def test_get_agent_details(self, ctx: AsyncInterfaceContext) -> None:
        """Fetch the created agent from config-service and validate all fields.

        Test scenario:
            Skip if no agent exists. GET the agent by id from config-service
            and assert that every field echoed in the response matches the
            creation request: id, name, role, modelId, and systemPrompt.

        Validation we are covering:
            HTTP 200; ``id`` matches the stored agent id; ``name`` is
            non-empty; ``role`` is ``assistant``; ``modelId`` matches the
            provisioned model; and ``systemPrompt`` is echoed back as
            non-empty.
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

    # ------------------------------------------------------------------
    # Async invoke — submit
    # ------------------------------------------------------------------

    def test_invoke_agent_async(self, ctx: AsyncInterfaceContext) -> None:
        """Submit the agent invocation via the async endpoint and capture task_id.

        Test scenario:
            Skip if no agent exists. POST a prompt to ``/invoke/async`` and
            assert that the service returns HTTP 202 with a non-empty
            ``taskId`` and ``status == "running"``. The task id is stored on
            the context for the subsequent polling tests.

        Validation we are covering:
            HTTP 202; response body contains a non-empty ``taskId`` string;
            ``status`` is ``"running"`` at submission time.
        """
        if not ctx.agent_id:
            pytest.skip("no agent — test_create_agent did not succeed")
        body = {"input": "Explain what Artificial Intelligence is in exactly 100 words."}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/async"
        )
        resp = ctx.agent.invoke_agent_async(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 202, resp.text
        data = resp.json()
        ctx.task_id = data.get("taskId") or data.get("task_id", "")
        assert ctx.task_id, "taskId missing in async invoke response"
        assert data.get("status") == "running", (
            f"expected status 'running' at submission, got {data.get('status')!r}"
        )

    # ------------------------------------------------------------------
    # Async invoke — immediate poll (should be running)
    # ------------------------------------------------------------------

    def test_poll_task_running(self, ctx: AsyncInterfaceContext) -> None:
        """Poll the task immediately after submission; expect status == running.

        Test scenario:
            Skip if no task was captured. GET ``/tasks/{taskId}`` without any
            delay. The LLM call is still in flight, so the task should be in
            the ``running`` state. The test validates the full
            ``TaskStatusResponse`` shape even before completion.

        Validation we are covering:
            HTTP 200; ``taskId`` echoed back correctly; ``status`` is
            ``"running"``; ``projectId`` matches the test project; ``agentId``
            matches the test agent; ``result`` is absent/null (task not yet
            done); ``error`` and ``errorType`` are empty strings.
        """
        if not ctx.task_id:
            pytest.skip("no task — test_invoke_agent_async did not succeed")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.task_id}"
        )
        resp = ctx.agent.get_task_details(ctx.project_id, ctx.task_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # Shape assertions (apply regardless of status).
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.task_id, (
            f"taskId mismatch: {task_id!r} != {ctx.task_id!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == ctx.agent_id, (
            f"agentId mismatch: {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from task response"
        assert "updatedAt" in data, "updatedAt missing from task response"

        # Status assertion — should still be running immediately after submit.
        status = data.get("status")
        assert status == "running", (
            f"expected status 'running' on immediate poll, got {status!r}. "
            "The LLM completed faster than expected; consider relaxing this "
            "to 'status in {\"running\", \"completed\"}'."
        )
        if status == "running":
            assert data.get("result") is None, "result should be null while task is still running"
        assert data.get("error", "") == "", (
            f"unexpected error on running task: {data.get('error')!r}"
        )
        assert data.get("errorType", "") == "", (
            f"unexpected errorType on running task: {data.get('errorType')!r}"
        )

    # ------------------------------------------------------------------
    # Async invoke — completion poll (after sleep)
    # ------------------------------------------------------------------

    @pytest.mark.xfail(
        reason=(
            "Intermittent 'Task not found' on poll: agent-service-maf runs "
            "multiple replicas with a non-shared (in-memory) task store, so the "
            "async submit and the later poll can land on different pods. Remove "
            "this marker once a shared task store (Redis) or sticky routing is "
            "configured."
        ),
        strict=False,
    )
    def test_poll_task_completed(self, ctx: AsyncInterfaceContext) -> None:
        """Poll the agent task every 5 s until completed (max 60 s) and validate result.

        Test scenario:
            Skip if no task was captured. Call ``_poll_to_terminal`` which
            sleeps ``_POLL_INTERVAL_SECONDS`` between probes and stops as soon
            as the status leaves ``"running"`` or ``_POLL_TIMEOUT_SECONDS``
            has elapsed. Then assert the task is ``completed`` and validate
            the full ``TaskStatusResponse`` shape including the nested
            ``InvokeResponse`` in ``result``.

        Validation we are covering:
            HTTP 200 on every probe; final ``status`` is ``"completed"``;
            ``durationMs`` is positive; ``result`` is present and non-null;
            ``result.output`` is a non-empty string; ``result.durationMs``
            is positive; ``result.agentId`` matches the test agent; ``error``
            and ``errorType`` are empty on success.
        """
        if not ctx.task_id:
            pytest.skip("no task — test_invoke_agent_async did not succeed")

        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.task_id}"
        )
        data = _poll_to_terminal(ctx.agent, ctx.project_id, ctx.task_id, url)

        # --- Task envelope ---
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.task_id, f"taskId mismatch: {task_id!r}"
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == ctx.agent_id, (
            f"agentId mismatch: {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from task response"
        assert "updatedAt" in data, "updatedAt missing from task response"

        status = data.get("status")
        assert status == "completed", (
            f"expected status 'completed' after polling up to {_POLL_TIMEOUT_SECONDS}s, "
            f"got {status!r}. "
            f"error={data.get('error')!r}, errorType={data.get('errorType')!r}"
        )
        assert data.get("durationMs", 0) > 0, (
            "durationMs should be positive on a completed task"
        )
        assert data.get("error", "") == "", (
            f"unexpected error on completed task: {data.get('error')!r}"
        )
        assert data.get("errorType", "") == "", (
            f"unexpected errorType on completed task: {data.get('errorType')!r}"
        )

        # --- Nested InvokeResponse (result) ---
        result = data.get("result")
        assert result is not None, (
            "result must be populated when status == 'completed'"
        )
        assert isinstance(result, dict), (
            f"result should be a dict, got {type(result).__name__!r}"
        )
        assert result.get("output"), (
            "result.output is empty — expected the 100-word AI explanation"
        )
        result_duration = result.get("durationMs") or result.get("duration_ms")
        assert result_duration and result_duration > 0, (
            "result.durationMs should be positive"
        )
        result_agent_id = result.get("agentId") or result.get("agent_id", "")
        assert result_agent_id == ctx.agent_id, (
            f"result.agentId mismatch: {result_agent_id!r} != {ctx.agent_id!r}"
        )

    # ------------------------------------------------------------------
    # Team async flow — provisioning
    # ------------------------------------------------------------------

    def test_create_science_agent(self, ctx: AsyncInterfaceContext) -> None:
        """Create the science-specialist agent used in the routing team.

        Test scenario:
            Skip if no models exist. POST an AgentCreationRequest with a
            science-focused system prompt and store the agent id on the
            context.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, and the
            echoed ``modelId`` and ``role`` match what was requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        name = unique_name("e2e-interface-async-science")
        request = AgentCreationRequest(
            name=name,
            role="science specialist",
            system_prompt=(
                "You are a science specialist. Answer only science-related questions "
                "with accurate, concise explanations. Do not answer math questions."
            ),
            model_id=ctx.model_ids[0],
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.science_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.science_agent_id), (
            f"unexpected science agent id: {ctx.science_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_ids[0]
        assert data.get("role") == "science specialist"
        ctx.resources.add_agent(ctx.science_agent_id, ctx.project_id)

    def test_create_math_agent(self, ctx: AsyncInterfaceContext) -> None:
        """Create the math-specialist agent used in the routing team.

        Test scenario:
            Skip if no models exist. POST an AgentCreationRequest with a
            math-focused system prompt and store the agent id on the context.

        Validation we are covering:
            HTTP 201, the agent id matches the ag-xxxxxxxx pattern, and the
            echoed ``modelId`` and ``role`` match what was requested.
        """
        if not ctx.model_ids:
            pytest.skip("no models — test_add_models did not succeed")
        name = unique_name("e2e-interface-async-math")
        request = AgentCreationRequest(
            name=name,
            role="math specialist",
            system_prompt=(
                "You are a math specialist. Answer only mathematics-related questions "
                "with precise, step-by-step reasoning. Do not answer science questions."
            ),
            model_id=ctx.model_ids[0],
        )
        url = ctx.config_client.agents_url(ctx.project_id)
        resp = ctx.config_client.create_agent(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.math_agent_id = data["id"]
        assert AGENT_ID_RE.match(ctx.math_agent_id), (
            f"unexpected math agent id: {ctx.math_agent_id!r}"
        )
        assert data.get("modelId") == ctx.model_ids[0]
        assert data.get("role") == "math specialist"
        ctx.resources.add_agent(ctx.math_agent_id, ctx.project_id)

    def test_create_routing_team(self, ctx: AsyncInterfaceContext) -> None:
        """Create a routing team backed by an inline manager that routes between the two agents.

        Test scenario:
            Skip if the science or math agent is missing. POST a
            ``TeamCreationRequest`` with ``orchestrationPolicy == "route"`` and
            an inline ``manager`` config (name, system prompt, modelId) that
            instructs the router to send science questions to the science agent
            and math questions to the math agent.

        Validation we are covering:
            HTTP 201; the team id matches the agr-xxxxxxxx pattern;
            ``orchestrationPolicy`` is ``"route"``; ``members`` has exactly
            two entries; the echoed ``manager.name`` matches ``_ROUTER_NAME``.
        """
        if not ctx.science_agent_id or not ctx.math_agent_id:
            pytest.skip(
                "no agents — test_create_science_agent / test_create_math_agent "
                "did not succeed"
            )
        team_name = unique_name("e2e-interface-async-team")
        request = TeamCreationRequest(
            name=team_name,
            orchestration_policy="route",
            members=[
                TeamMemberRef.agent(ctx.science_agent_id),
                TeamMemberRef.agent(ctx.math_agent_id),
            ],
            manager=TeamManagerConfig(
                name=_ROUTER_NAME,
                system_prompt=(
                    "You are a routing manager. "
                    "Delegate questions about physics, chemistry, biology, or any "
                    "natural science to the science specialist. "
                    "Delegate questions about arithmetic, algebra, calculus, or any "
                    "mathematics to the math specialist. "
                    "Do not answer questions yourself."
                ),
                model_id=ctx.model_ids[0],
            ),
        )
        url = ctx.config_client.agent_teams_url(ctx.project_id)
        resp = ctx.config_client.create_team(ctx.project_id, request)
        log_exchange("POST", url, request.to_body(), resp)
        assert resp.status_code == 201, resp.text
        data = resp.json()
        ctx.team_id = data["id"]
        assert TEAM_ID_RE.match(ctx.team_id), f"unexpected team id: {ctx.team_id!r}"
        assert data.get("orchestrationPolicy") == "route", (
            f"unexpected orchestrationPolicy: {data.get('orchestrationPolicy')!r}"
        )
        assert len(data.get("members", [])) == 2, (
            f"expected 2 members, got {len(data.get('members', []))}"
        )
        manager = data.get("manager") or {}
        assert manager.get("name") == _ROUTER_NAME, (
            f"expected manager name {_ROUTER_NAME!r} echoed back; got {manager!r}"
        )
        ctx.resources.add_team(ctx.team_id, ctx.project_id)

    def test_get_team_details(self, ctx: AsyncInterfaceContext) -> None:
        """Fetch the created routing team from config-service and validate all fields.

        Test scenario:
            Skip if no team exists. GET the team by id from config-service
            and assert every field matches the creation request.

        Validation we are covering:
            HTTP 200; ``id`` matches ``ctx.team_id``; ``name`` is non-empty;
            ``orchestrationPolicy`` is ``"route"``; ``members`` has exactly
            two entries containing both agent ids; ``manager.name`` is
            ``_ROUTER_NAME``; ``manager.modelId`` matches the provisioned
            model.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_routing_team did not succeed")
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
        assert data.get("orchestrationPolicy") == "route", (
            f"unexpected orchestrationPolicy: {data.get('orchestrationPolicy')!r}"
        )
        members = data.get("members") or []
        assert len(members) == 2, f"expected 2 members, got {len(members)}"
        member_ids = {m.get("memberId") for m in members}
        assert ctx.science_agent_id in member_ids, (
            f"science agent {ctx.science_agent_id!r} missing in team members {member_ids!r}"
        )
        assert ctx.math_agent_id in member_ids, (
            f"math agent {ctx.math_agent_id!r} missing in team members {member_ids!r}"
        )
        manager = data.get("manager") or {}
        assert manager.get("name") == _ROUTER_NAME, (
            f"expected manager name {_ROUTER_NAME!r}; got {manager!r}"
        )
        assert manager.get("modelId") == ctx.model_ids[0], (
            f"manager modelId mismatch: {manager.get('modelId')!r}"
        )

    # ------------------------------------------------------------------
    # Team async flow — submit
    # ------------------------------------------------------------------

    def test_invoke_team_async(self, ctx: AsyncInterfaceContext) -> None:
        """Submit the team invocation via the async endpoint and capture team_task_id.

        Test scenario:
            Skip if no team exists. POST a science prompt to
            ``/agent-teams/{teamId}/invoke/async`` and assert the service
            returns HTTP 202 with a non-empty ``taskId`` and
            ``status == "running"``. The task id is stored on the context for
            the subsequent polling tests.

        Validation we are covering:
            HTTP 202; response body contains a non-empty ``taskId`` string;
            ``status`` is ``"running"`` at submission time.
        """
        if not ctx.team_id:
            pytest.skip("no team — test_create_routing_team did not succeed")
        body = {
            "input": (
                "Explain the concept of gravity in exactly 500 words, covering its "
                "definition, Newton's law of universal gravitation, Einstein's "
                "general relativity perspective, and real-world examples."
            )
        }
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke/async"
        )
        resp = ctx.agent.invoke_team_async(ctx.project_id, ctx.team_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 202, resp.text
        data = resp.json()
        ctx.team_task_id = data.get("taskId") or data.get("task_id", "")
        assert ctx.team_task_id, "taskId missing in team async invoke response"
        assert data.get("status") == "running", (
            f"expected status 'running' at submission, got {data.get('status')!r}"
        )

    # ------------------------------------------------------------------
    # Team async flow — immediate poll (should be running)
    # ------------------------------------------------------------------

    def test_poll_team_task_running(self, ctx: AsyncInterfaceContext) -> None:
        """Poll the team task immediately after submission; expect status == running.

        Test scenario:
            Skip if no team task was captured. GET ``/tasks/{taskId}``
            without any delay and validate the full ``TaskStatusResponse``
            shape. The orchestration pipeline is still in flight so the task
            should be ``running``.

        Validation we are covering:
            HTTP 200; ``taskId`` echoed back correctly; ``status`` is
            ``"running"``; ``projectId`` matches the test project; ``agentId``
            is ``"orchestrator"`` (set by the team async route); ``result``
            is null while running; ``error`` and ``errorType`` are empty.
        """
        if not ctx.team_task_id:
            pytest.skip("no team task — test_invoke_team_async did not succeed")
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.team_task_id}"
        )
        resp = ctx.agent.get_task_details(ctx.project_id, ctx.team_task_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()

        # Shape assertions (apply regardless of status).
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.team_task_id, (
            f"taskId mismatch: {task_id!r} != {ctx.team_task_id!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        # Team-level async tasks always record agentId as "orchestrator".
        assert data.get("agentId") == "orchestrator", (
            f"expected agentId 'orchestrator' for team task, got {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from task response"
        assert "updatedAt" in data, "updatedAt missing from task response"

        status = data.get("status")
        assert status == "running", (
            f"expected status 'running' on immediate poll, got {status!r}. "
            "The team completed faster than expected."
        )
        assert data.get("result") is None, (
            "result should be null while task is still running"
        )
        assert data.get("error", "") == "", (
            f"unexpected error on running team task: {data.get('error')!r}"
        )
        assert data.get("errorType", "") == "", (
            f"unexpected errorType on running team task: {data.get('errorType')!r}"
        )

    # ------------------------------------------------------------------
    # Team async flow — completion poll (loop)
    # ------------------------------------------------------------------

    @pytest.mark.xfail(
        reason=(
            "Intermittent 'Task not found' on poll: agent-service-maf runs "
            "multiple replicas with a non-shared (in-memory) task store, so the "
            "async submit and the later poll can land on different pods. Remove "
            "this marker once a shared task store (Redis) or sticky routing is "
            "configured."
        ),
        strict=False,
    )
    def test_poll_team_task_completed(self, ctx: AsyncInterfaceContext) -> None:
        """Poll the team task every 5 s until completed (max 60 s) and validate result.

        Test scenario:
            Skip if no team task was captured. Call ``_poll_to_terminal``
            which probes every ``_POLL_INTERVAL_SECONDS`` and stops when the
            status leaves ``"running"`` or ``_POLL_TIMEOUT_SECONDS`` elapses.
            Then assert the team task is ``completed`` and validate the full
            ``TaskStatusResponse`` shape including the nested
            ``InvokeResponse`` in ``result``.

        Validation we are covering:
            HTTP 200 on every probe; final ``status`` is ``"completed"``;
            ``agentId`` is ``"orchestrator"``; ``durationMs`` is positive;
            ``result`` is present; ``result.output`` is a non-empty string
            (the gravity explanation); ``result.durationMs`` is positive;
            ``error`` and ``errorType`` are empty on success.
        """
        if not ctx.team_task_id:
            pytest.skip("no team task — test_invoke_team_async did not succeed")

        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.team_task_id}"
        )
        data = _poll_to_terminal(ctx.agent, ctx.project_id, ctx.team_task_id, url)

        # --- Task envelope ---
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.team_task_id, f"taskId mismatch: {task_id!r}"
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == "orchestrator", (
            f"expected agentId 'orchestrator' for team task, got {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from task response"
        assert "updatedAt" in data, "updatedAt missing from task response"

        status = data.get("status")
        assert status == "completed", (
            f"expected status 'completed' after polling up to {_POLL_TIMEOUT_SECONDS}s, "
            f"got {status!r}. "
            f"error={data.get('error')!r}, errorType={data.get('errorType')!r}"
        )
        assert data.get("durationMs", 0) > 0, (
            "durationMs should be positive on a completed team task"
        )
        assert data.get("error", "") == "", (
            f"unexpected error on completed team task: {data.get('error')!r}"
        )
        assert data.get("errorType", "") == "", (
            f"unexpected errorType on completed team task: {data.get('errorType')!r}"
        )

        # --- Nested InvokeResponse (result) ---
        result = data.get("result")
        assert result is not None, (
            "result must be populated when status == 'completed'"
        )
        assert isinstance(result, dict), (
            f"result should be a dict, got {type(result).__name__!r}"
        )
        assert result.get("output"), (
            "result.output is empty — expected the 500-word gravity explanation"
        )
        result_duration = result.get("durationMs") or result.get("duration_ms")
        assert result_duration and result_duration > 0, (
            "result.durationMs should be positive"
        )

    # ------------------------------------------------------------------
    # Agent cancel flow
    # ------------------------------------------------------------------

    def test_invoke_agent_async_for_cancel(self, ctx: AsyncInterfaceContext) -> None:
        """Submit an agent invocation that will be cancelled immediately.

        Test scenario:
            Skip if no agent exists. POST a long prompt to
            ``/agents/{agentId}/invoke/async`` so the LLM call is still in
            flight when the cancel arrives. Capture the task id as
            ``cancel_agent_task_id`` for the next two tests.

        Validation we are covering:
            HTTP 202; non-empty ``taskId`` in the response body;
            ``status == "running"`` at submission time.
        """
        if not ctx.agent_id:
            pytest.skip("no agent -- test_create_agent did not succeed")
        body = {"input": "Explain Artificial Intelligence in exactly 500 words."}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agents/{ctx.agent_id}/invoke/async"
        )
        resp = ctx.agent.invoke_agent_async(ctx.project_id, ctx.agent_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 202, resp.text
        data = resp.json()
        ctx.cancel_agent_task_id = data.get("taskId") or data.get("task_id", "")
        assert ctx.cancel_agent_task_id, "taskId missing in async invoke response"
        assert data.get("status") == "running", (
            f"expected 'running' at submission, got {data.get('status')!r}"
        )

    def test_cancel_agent_task(self, ctx: AsyncInterfaceContext) -> None:
        """Cancel the in-flight agent task immediately and validate the response.

        Test scenario:
            Skip if no cancel task was captured. Issue
            ``DELETE /tasks/{cancel_agent_task_id}`` without any delay so the
            cancellation races the live background coroutine.

        Validation we are covering:
            HTTP 200; ``taskId`` echoed correctly; ``status == "cancelled"``;
            ``error == "Cancelled by caller"``; ``result`` is null;
            ``errorType`` is empty; ``projectId`` and ``agentId`` match.
        """
        if not ctx.cancel_agent_task_id:
            pytest.skip(
                "no cancel task -- test_invoke_agent_async_for_cancel did not succeed"
            )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.cancel_agent_task_id}"
        )
        resp = ctx.agent.cancel_task(ctx.project_id, ctx.cancel_agent_task_id)
        log_exchange("DELETE", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.cancel_agent_task_id, (
            f"taskId mismatch: {task_id!r} != {ctx.cancel_agent_task_id!r}"
        )
        assert data.get("status") == "cancelled", (
            f"expected status 'cancelled' after DELETE, got {data.get('status')!r}"
        )
        assert data.get("error") == "Cancelled by caller", (
            f"unexpected error message: {data.get('error')!r}"
        )
        assert data.get("result") is None, "result must be null on a cancelled task"
        assert data.get("errorType", "") == "", (
            f"errorType should be empty on cancel, got {data.get('errorType')!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == ctx.agent_id, (
            f"agentId mismatch: {data.get('agentId')!r}"
        )

    def test_get_cancelled_agent_task_details(self, ctx: AsyncInterfaceContext) -> None:
        """GET the cancelled agent task and confirm the state persisted correctly.

        Test scenario:
            Skip if no cancel task was captured. Poll
            ``GET /tasks/{cancel_agent_task_id}`` after the cancel and
            re-assert every field to confirm the cancelled state was written
            to the store (not just returned in-memory by the DELETE response).

        Validation we are covering:
            HTTP 200; ``status == "cancelled"``; ``error == "Cancelled by
            caller"``; ``result`` is null; ``errorType`` is empty;
            ``taskId``, ``projectId``, ``agentId``, ``createdAt``, and
            ``updatedAt`` are correct.
        """
        if not ctx.cancel_agent_task_id:
            pytest.skip(
                "no cancel task -- test_invoke_agent_async_for_cancel did not succeed"
            )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.cancel_agent_task_id}"
        )
        resp = ctx.agent.get_task_details(ctx.project_id, ctx.cancel_agent_task_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.cancel_agent_task_id, f"taskId mismatch: {task_id!r}"
        assert data.get("status") == "cancelled", (
            f"expected persisted status 'cancelled', got {data.get('status')!r}"
        )
        assert data.get("error") == "Cancelled by caller", (
            f"unexpected persisted error: {data.get('error')!r}"
        )
        assert data.get("result") is None, "result must remain null on a cancelled task"
        assert data.get("errorType", "") == "", (
            f"errorType should be empty, got {data.get('errorType')!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == ctx.agent_id, (
            f"agentId mismatch: {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from cancelled task response"
        assert "updatedAt" in data, "updatedAt missing from cancelled task response"

    # ------------------------------------------------------------------
    # Team cancel flow
    # ------------------------------------------------------------------

    def test_invoke_team_async_for_cancel(self, ctx: AsyncInterfaceContext) -> None:
        """Submit a team invocation that will be cancelled immediately.

        Test scenario:
            Skip if no routing team exists. POST a long prompt to
            ``/agent-teams/{teamId}/invoke/async`` so the orchestration
            pipeline is still in flight when the cancel arrives. Capture the
            task id as ``cancel_team_task_id``.

        Validation we are covering:
            HTTP 202; non-empty ``taskId`` in the response body;
            ``status == "running"`` at submission time.
        """
        if not ctx.team_id:
            pytest.skip("no team -- test_create_routing_team did not succeed")
        body = {"input": "Explain Artificial Intelligence in exactly 500 words."}
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/agent-teams/{ctx.team_id}/invoke/async"
        )
        resp = ctx.agent.invoke_team_async(ctx.project_id, ctx.team_id, body)
        log_exchange("POST", url, body, resp)
        assert resp.status_code == 202, resp.text
        data = resp.json()
        ctx.cancel_team_task_id = data.get("taskId") or data.get("task_id", "")
        assert ctx.cancel_team_task_id, "taskId missing in team async invoke response"
        assert data.get("status") == "running", (
            f"expected 'running' at submission, got {data.get('status')!r}"
        )

    def test_cancel_team_task(self, ctx: AsyncInterfaceContext) -> None:
        """Cancel the in-flight team task immediately and validate the response.

        Test scenario:
            Skip if no cancel team task was captured. Issue
            ``DELETE /tasks/{cancel_team_task_id}`` without any delay so the
            cancellation races the live orchestration pipeline.

        Validation we are covering:
            HTTP 200; ``taskId`` echoed correctly; ``status == "cancelled"``;
            ``error == "Cancelled by caller"``; ``result`` is null;
            ``errorType`` is empty; ``projectId`` matches; ``agentId`` is
            ``"orchestrator"`` (set by the team async route).
        """
        if not ctx.cancel_team_task_id:
            pytest.skip(
                "no cancel team task -- test_invoke_team_async_for_cancel did not succeed"
            )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.cancel_team_task_id}"
        )
        resp = ctx.agent.cancel_task(ctx.project_id, ctx.cancel_team_task_id)
        log_exchange("DELETE", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.cancel_team_task_id, (
            f"taskId mismatch: {task_id!r} != {ctx.cancel_team_task_id!r}"
        )
        assert data.get("status") == "cancelled", (
            f"expected status 'cancelled' after DELETE, got {data.get('status')!r}"
        )
        assert data.get("error") == "Cancelled by caller", (
            f"unexpected error message: {data.get('error')!r}"
        )
        assert data.get("result") is None, "result must be null on a cancelled team task"
        assert data.get("errorType", "") == "", (
            f"errorType should be empty on cancel, got {data.get('errorType')!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == "orchestrator", (
            f"expected agentId 'orchestrator' for team task, got {data.get('agentId')!r}"
        )

    def test_get_cancelled_team_task_details(self, ctx: AsyncInterfaceContext) -> None:
        """GET the cancelled team task and confirm the state persisted correctly.

        Test scenario:
            Skip if no cancel team task was captured. Poll
            ``GET /tasks/{cancel_team_task_id}`` after the cancel and
            re-assert every field to confirm the cancelled state was written
            to the store.

        Validation we are covering:
            HTTP 200; ``status == "cancelled"``; ``error == "Cancelled by
            caller"``; ``result`` is null; ``errorType`` is empty;
            ``taskId``, ``projectId``, ``agentId == "orchestrator"``,
            ``createdAt``, and ``updatedAt`` are correct.
        """
        if not ctx.cancel_team_task_id:
            pytest.skip(
                "no cancel team task -- test_invoke_team_async_for_cancel did not succeed"
            )
        url = (
            f"{ctx.config.agent_service_url}/api/v1/projects/{ctx.project_id}"
            f"/tasks/{ctx.cancel_team_task_id}"
        )
        resp = ctx.agent.get_task_details(ctx.project_id, ctx.cancel_team_task_id)
        log_exchange("GET", url, None, resp)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        task_id = data.get("taskId") or data.get("task_id", "")
        assert task_id == ctx.cancel_team_task_id, f"taskId mismatch: {task_id!r}"
        assert data.get("status") == "cancelled", (
            f"expected persisted status 'cancelled', got {data.get('status')!r}"
        )
        assert data.get("error") == "Cancelled by caller", (
            f"unexpected persisted error: {data.get('error')!r}"
        )
        assert data.get("result") is None, "result must remain null on a cancelled team task"
        assert data.get("errorType", "") == "", (
            f"errorType should be empty, got {data.get('errorType')!r}"
        )
        assert data.get("projectId") == ctx.project_id, (
            f"projectId mismatch: {data.get('projectId')!r}"
        )
        assert data.get("agentId") == "orchestrator", (
            f"expected agentId 'orchestrator', got {data.get('agentId')!r}"
        )
        assert "createdAt" in data, "createdAt missing from cancelled task response"
        assert "updatedAt" in data, "updatedAt missing from cancelled task response"
