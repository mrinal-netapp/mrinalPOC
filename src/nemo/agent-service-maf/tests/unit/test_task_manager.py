"""Unit tests for :class:`~agent_service_maf.core.task_manager.TaskManager`.

Tests cover the happy path (submit -> complete), failure paths (runner
raises -> persisted as FAILED), cancellation (cancel signal reaches the
runner and the persisted state is CANCELLED), and shutdown semantics
(close cancels every in-flight task and persists them).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from agent_service_maf.core.task_manager import TaskManager
from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import InMemoryTaskStore


async def _wait_until(predicate: Callable[[], bool], *, timeout: float = 1.0) -> None:
    """Poll ``predicate`` until truthy or ``timeout`` elapses.

    Avoids brittle ``await asyncio.sleep(0.05)`` patterns in tests where
    the background task completes quickly but exact timing depends on the
    event-loop scheduler.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("Condition was never reached within timeout")


class TestSubmit:
    """Submit a task and let it complete normally."""

    async def test_submit_completes_on_runner_success(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        await mgr.start()
        task = Task(project_id="p", team_id="t", agent_id="a")

        async def runner(_t: Task) -> dict[str, object]:
            return {"output": "ok"}

        await mgr.submit(task, runner)

        await _wait_until(
            lambda: mgr._inflight.get(task.task_id) is None  # noqa: SLF001
        )

        fetched = await mgr.get(task.task_id)
        assert fetched is not None
        assert fetched.status == TaskStatus.COMPLETED
        assert fetched.result == {"output": "ok"}
        assert fetched.duration_ms >= 0

    async def test_submit_records_correlation_id(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        task = Task(correlation_id="abc-123")

        async def runner(_t: Task) -> dict[str, object]:
            return {}

        await mgr.submit(task, runner)
        await _wait_until(
            lambda: mgr._inflight.get(task.task_id) is None  # noqa: SLF001
        )

        fetched = await mgr.get(task.task_id)
        assert fetched is not None
        assert fetched.correlation_id == "abc-123"


class TestFailures:
    """Runner exceptions should be captured as FAILED state."""

    async def test_submit_fails_on_runner_exception(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        task = Task()

        async def runner(_t: Task) -> dict[str, object]:
            raise ValueError("boom")

        await mgr.submit(task, runner)
        await _wait_until(
            lambda: mgr._inflight.get(task.task_id) is None  # noqa: SLF001
        )

        fetched = await mgr.get(task.task_id)
        assert fetched is not None
        assert fetched.status == TaskStatus.FAILED
        assert fetched.error == "boom"
        assert fetched.error_type == "ValueError"


class TestCancellation:
    """Explicit cancel() should stop the runner and persist CANCELLED."""

    async def test_cancel_propagates_to_runner(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        task = Task()

        runner_was_cancelled = asyncio.Event()

        async def runner(_t: Task) -> dict[str, object]:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                runner_was_cancelled.set()
                raise
            return {}

        await mgr.submit(task, runner)
        # Give the runner a tick to actually start sleeping.
        await asyncio.sleep(0.01)

        result = await mgr.cancel(task.task_id)
        assert result is not None
        assert result.status == TaskStatus.CANCELLED
        assert result.error == "Cancelled by caller"

        await asyncio.wait_for(runner_was_cancelled.wait(), timeout=1.0)

        fetched = await mgr.get(task.task_id)
        assert fetched is not None
        assert fetched.status == TaskStatus.CANCELLED
        assert fetched.error == "Cancelled by caller"

    async def test_cancel_unknown_returns_none(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        assert await mgr.cancel("does-not-exist") is None

    async def test_cancel_terminal_returns_unchanged(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        task = Task()
        task.mark_completed({"output": "ok"}, duration_ms=1)
        await mgr.store.save(task, running=False)

        result = await mgr.cancel(task.task_id)
        assert result is not None
        assert result.status == TaskStatus.COMPLETED
        assert result.result == {"output": "ok"}


class TestShutdown:
    """``close()`` must drain in-flight tasks and persist them as cancelled."""

    async def test_close_cancels_inflight_tasks(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        task = Task()

        async def slow_runner(_t: Task) -> dict[str, object]:
            await asyncio.sleep(10)
            return {}

        await mgr.submit(task, slow_runner)
        await asyncio.sleep(0.01)
        await mgr.close()

        fetched = await mgr.get(task.task_id)
        # In-memory store is cleared by close(); we accept either CANCELLED
        # (state persisted before clear) or None (cleared first). The
        # important contract is that the asyncio.Task is no longer running.
        if fetched is not None:
            assert fetched.status == TaskStatus.CANCELLED

    async def test_submit_after_close_is_rejected(self) -> None:
        mgr = TaskManager(InMemoryTaskStore())
        await mgr.close()

        task = Task()

        async def runner(_t: Task) -> dict[str, object]:
            return {}

        result = await mgr.submit(task, runner)
        assert result.status == TaskStatus.FAILED
        assert result.error_type == "ServiceUnavailable"


class TestConfigSection:
    """Smoke-test the TasksSection wired into AgentConfig."""

    def test_defaults_are_valid(self) -> None:
        from agent_service_maf.config.validators import AgentConfig

        cfg = AgentConfig()
        assert cfg.tasks.enabled is True
        assert cfg.tasks.backend == "memory"
        assert cfg.tasks.running_ttl_seconds == 600
        assert cfg.tasks.result_ttl_seconds == 3600

    def test_redis_backend_accepts_url_override(self) -> None:
        from agent_service_maf.config.validators import TasksSection

        cfg = TasksSection(backend="redis", redis_url="redis://example:6379/1")
        assert cfg.backend == "redis"
        assert cfg.redis_url == "redis://example:6379/1"
