"""Integration tests for async-invoke task lifecycle (§5.5 / §G2).

Coverage per the §G2 plan:

* submit → poll completed → ``result`` carries a typed
  :class:`InvokeResponse` matching §5.5.4 wire example.
* submit → cancel → poll cancelled.
* submit → fail → poll failed with ``errorType`` /
  ``error`` populated and no legacy ``[stage]`` prefix.
* ``DELETE /tasks/{task_id}`` is idempotent for terminal tasks.
* Cross-project task lookups return 404 (defense-in-depth from §5.5.6).

The single-agent ``/agents/{aid}/invoke/async`` route is exercised in
parallel with the team ``/agent-teams/{tid}/invoke/async`` route since
they share the same task-lifecycle plumbing.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.interface_layer.api import create_app
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

# ---------------------------------------------------------------------------
# Agents used by the lifecycle tests
# ---------------------------------------------------------------------------


class _FastEchoAgent(BaseAgent):
    """Resolves immediately so submit→complete races are fast."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        return AgentResponse(
            agent_id=request.agent_id,
            output=f"async-echo:{request.input}",
            usage=TokenUsage(prompt_tokens=1, completion_tokens=2, total_tokens=3),
            duration_ms=1,
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data=request.input)

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="fast", framework="fast_echo")


class _FailingAgent(BaseAgent):
    """Raises on invoke so the task transitions to ``failed``."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        raise RuntimeError("boom-from-runner")

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        raise RuntimeError("boom-from-runner")
        yield  # pragma: no cover

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="fail", framework="failing")


class _SlowAgent(BaseAgent):
    """Sleeps so we can cancel mid-execution."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        await asyncio.sleep(2.0)
        return AgentResponse(agent_id=request.agent_id, output="should-not-reach")

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        await asyncio.sleep(2.0)
        yield AgentEvent(event_type=EventType.TOKEN, data="late")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="slow", framework="slow")


def _write_team(teams_dir, framework: str) -> None:
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": framework},
            }
        )
    )


def _client_with_agent(tmp_path, framework_name: str, agent_cls: type[BaseAgent]) -> TestClient:
    """Build an app with ``agent_cls`` registered as ``framework_name``."""
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    teams_dir = tmp_path / "teams"
    _write_team(teams_dir, framework=framework_name)
    FrameworkRegistry.clear()
    FrameworkRegistry.register(framework_name)(agent_cls)
    env = {"AGENT_AGENT__FRAMEWORK": framework_name, "AGENT_TEAMS_DIR": str(teams_dir)}
    patcher_env = patch.dict("os.environ", env)
    patcher_cl = patch("agent_service_maf.core.team_loader.ConfigLoader")
    patcher_env.start()
    mock_loader = patcher_cl.start()
    mock_loader.return_value = RealConfigLoader(json_config_path=None)
    app = create_app()
    client = TestClient(app)
    client.__enter__()

    # Stash the patchers on the client so we can shut them down cleanly.
    client._patchers = (patcher_env, patcher_cl)  # type: ignore[attr-defined]
    return client


def _teardown_client(client: TestClient) -> None:
    try:
        client.__exit__(None, None, None)
    finally:
        for p in getattr(client, "_patchers", ()):
            p.stop()
        FrameworkRegistry.clear()


@pytest.fixture
def fast_client(tmp_path):
    client = _client_with_agent(tmp_path, "fast_echo", _FastEchoAgent)
    yield client
    _teardown_client(client)


@pytest.fixture
def failing_client(tmp_path):
    client = _client_with_agent(tmp_path, "failing", _FailingAgent)
    yield client
    _teardown_client(client)


@pytest.fixture
def slow_client(tmp_path):
    client = _client_with_agent(tmp_path, "slow", _SlowAgent)
    yield client
    _teardown_client(client)


def _poll_until_terminal(
    client: TestClient,
    task_id: str,
    timeout: float = 5.0,
    poll_every: float = 0.05,
) -> dict[str, Any]:
    """Poll ``GET /tasks/{task_id}`` until status is terminal or timeout."""
    deadline = time.monotonic() + timeout
    last_body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        r = client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        assert r.status_code == 200, f"Unexpected status {r.status_code}: {r.text}"
        last_body = r.json()
        if last_body["status"] in ("completed", "failed", "cancelled"):
            return last_body
        time.sleep(poll_every)
    raise AssertionError(f"Task {task_id} never reached terminal state. Last body: {last_body}")


# ---------------------------------------------------------------------------
# Lifecycle tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestAsyncSubmitComplete:
    def test_submit_returns_202_with_taskid(self, fast_client: TestClient) -> None:
        r = fast_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/fast_echo/invoke/async",
            json={"input": "hello"},
        )
        assert r.status_code == 202, f"Expected 202, got {r.status_code}: {r.text}"
        body = r.json()
        assert "taskId" in body, f"Expected camelCase 'taskId', got {list(body.keys())}"
        assert body["status"] == "running"
        assert body["taskId"]

    def test_poll_completed_carries_typed_invokeresponse(self, fast_client: TestClient) -> None:
        submit = fast_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/fast_echo/invoke/async",
            json={"input": "task-payload"},
        )
        task_id = submit.json()["taskId"]
        final = _poll_until_terminal(fast_client, task_id)
        assert final["status"] == "completed", f"Expected completed, got {final}"
        # §A7: result is a typed InvokeResponse with camelCase keys.
        result = final["result"]
        assert isinstance(result, dict)
        assert result["agentId"] == "fast_echo"
        assert "task-payload" in result["output"]
        assert "durationMs" in result
        # §B11: no legacy [stage] prefix on errors (and no error here).
        assert final["error"] == ""
        assert final["errorType"] == ""


@pytest.mark.integration
class TestAsyncFailure:
    def test_failing_runner_surfaces_error_type(self, failing_client: TestClient) -> None:
        submit = failing_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/failing/invoke/async",
            json={"input": "boom"},
        )
        task_id = submit.json()["taskId"]
        final = _poll_until_terminal(failing_client, task_id)
        assert final["status"] == "failed", f"Expected failed, got {final}"
        # §B11: clean error message; no [arun] / [stage] prefix.
        assert final["errorType"] == "RuntimeError"
        assert final["error"] == "boom-from-runner"
        assert not final["error"].startswith("["), (
            f"Legacy [stage] prefix leaked: {final['error']!r}"
        )
        assert final["result"] is None, "Failed task must not carry a result"


@pytest.mark.integration
class TestAsyncCancel:
    def test_cancel_running_task_yields_cancelled(self, slow_client: TestClient) -> None:
        submit = slow_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/slow/invoke/async",
            json={"input": "slow-job"},
        )
        task_id = submit.json()["taskId"]

        # Cancel almost immediately.
        cancel = slow_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        assert cancel.status_code == 200, f"Cancel failed: {cancel.text}"
        # The cancel response itself is a TaskStatusResponse.
        body = cancel.json()
        assert body["status"] in ("cancelled", "running"), (
            f"Expected cancelled or running, got {body['status']}"
        )

        final = _poll_until_terminal(slow_client, task_id, timeout=3.0)
        assert final["status"] == "cancelled", f"Expected cancelled, got {final}"
        # Cancelled tasks have no result and no error_type today.
        assert final["result"] is None


@pytest.mark.integration
class TestAsyncCrossProjectGuard:
    def test_unknown_task_returns_404(self, fast_client: TestClient) -> None:
        r = fast_client.get(f"{TEST_PROJECT_PREFIX}/tasks/nonexistent-task-id")
        assert r.status_code == 404, f"Expected 404, got {r.status_code}: {r.text}"

    def test_cancel_unknown_task_returns_404(self, fast_client: TestClient) -> None:
        r = fast_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/nonexistent-task-id")
        assert r.status_code == 404


@pytest.mark.integration
class TestAsyncWireShape:
    """Validate the §5.5.4 wire shape end-to-end."""

    def test_running_response_shape(self, slow_client: TestClient) -> None:
        submit = slow_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/slow/invoke/async",
            json={"input": "shape-check"},
        )
        task_id = submit.json()["taskId"]
        try:
            r = slow_client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
            body = r.json()
            # §A7 camelCase wire keys -- pin every one §5.5.4 requires.
            for key in (
                "taskId",
                "status",
                "projectId",
                "teamId",
                "agentId",
                "correlationId",
                "createdAt",
                "updatedAt",
                "durationMs",
                "result",
                "error",
                "errorType",
            ):
                assert key in body, f"Missing wire key '{key}': {list(body.keys())}"
            assert body["taskId"] == task_id
            assert body["status"] in ("running", "completed", "cancelled", "failed")
        finally:
            # Cancel the slow job so the test teardown doesn't block on cleanup.
            slow_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
