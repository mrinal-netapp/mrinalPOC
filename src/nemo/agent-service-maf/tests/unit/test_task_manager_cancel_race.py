"""Unit test — TaskManager `_persist_unless_already_terminal` cancel race.

The unit audit (H3) flagged this as a high-risk untested branch.
Existing `tests/unit/test_task_manager.py` covers submit, poll, and
cancel on quiescent state. What it doesn't cover: the **terminal-
state monotonicity** guard at `task_manager.py:185-244` — the win-
overwrites-loss race where:

  1. The runner returns successfully.
  2. Before `_run` can call `mark_completed` + `save`, a concurrent
     `cancel()` reads the still-RUNNING task, marks it CANCELLED,
     saves it, and signals the asyncio task.
  3. `_run`'s post-runner save must NOT overwrite the CANCELLED
     state with COMPLETED.

The guard re-reads the persisted state right before save and skips
if the persisted task is already terminal. This test pins that
behavior with an asyncio gate so the race is deterministic, not
chance-dependent.
"""

from __future__ import annotations

import asyncio
from typing import Any

from agent_service_maf.core.task_manager import TaskManager
from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import InMemoryTaskStore

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _new_task() -> Task:
    return Task(
        task_id="race-task-1",
        project_id="proj-A",
        team_id="team-x",
        agent_id="agent-1",
        correlation_id="corr-race",
    )


async def _no_op_close() -> None:
    """Replacement for InMemoryTaskStore.close() in tests that need to
    read state AFTER mgr.close() (which calls store.close, which on the
    in-memory backend wipes the dict). RedisTaskStore.close() does NOT
    wipe state in production — it only releases the connection pool —
    so this no-op faithfully mirrors prod for the assertions."""
    return None


# ---------------------------------------------------------------------------
# (1) Cancel arrives WHILE the runner is mid-execution
# ---------------------------------------------------------------------------


async def test_cancel_during_runner_yields_cancelled_state() -> None:
    """Classic happy path of cancellation: cancel arrives while the
    runner is suspended on an await. The runner sees the cancel via
    `asyncio.CancelledError`, the `_run` cancel branch preserves the
    pre-existing terminal state set by `cancel()`. Final state is
    CANCELLED, not COMPLETED."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    runner_started = asyncio.Event()
    can_finish = asyncio.Event()

    async def long_runner(task: Task) -> dict[str, Any]:
        runner_started.set()
        await can_finish.wait()  # cancel arrives here
        return {"text": "should never appear"}

    submitted = await mgr.submit(_new_task(), long_runner)
    await runner_started.wait()

    # Cancel while the runner is suspended on `can_finish.wait()`.
    cancelled = await mgr.cancel(submitted.task_id)
    assert cancelled is not None
    assert cancelled.status == TaskStatus.CANCELLED

    # Let the runner observe the cancel and unwind. Without this,
    # close() races the runner's CancelledError handler.
    await asyncio.sleep(0)

    # Read final state BEFORE close() — InMemoryTaskStore.close() clears
    # the dict, so any read after close returns None.
    final = await store.get(submitted.task_id)
    await mgr.close()
    assert final is not None
    assert final.status == TaskStatus.CANCELLED, (
        f"Cancel-during-execution must yield CANCELLED, got {final.status}"
    )


# ---------------------------------------------------------------------------
# (2) Cancel arrives AFTER runner returned — terminal-monotonicity guard
# ---------------------------------------------------------------------------


async def test_cancel_after_runner_returns_does_not_overwrite_completed() -> None:
    """The post-runner-but-pre-save race. The runner has returned a
    real result, but cancel() has already committed CANCELLED to the
    store. `_persist_unless_already_terminal` must skip the
    completed-save because the persisted state is already terminal.
    Final state stays CANCELLED."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    # The gate lets the runner finish; we open it ONLY after we've
    # snuck a cancel() into the store. That's the window the guard
    # exists to protect.
    can_finish = asyncio.Event()
    runner_about_to_return = asyncio.Event()

    async def runner(task: Task) -> dict[str, Any]:
        runner_about_to_return.set()
        await can_finish.wait()
        # By the time we return, cancel has already committed CANCELLED.
        return {"text": "should be ignored by the monotonicity guard"}

    submitted = await mgr.submit(_new_task(), runner)
    await runner_about_to_return.wait()

    # Simulate the race: a peer cancels the task. Note this also
    # cancels the asyncio.Task — that's fine; we open the gate first so
    # the runner's body still runs to completion of its `return`.
    cancelled = await mgr.cancel(submitted.task_id)
    assert cancelled is not None
    assert cancelled.status == TaskStatus.CANCELLED

    # NOW let the runner return. The `_run` coroutine catches the
    # CancelledError that was injected, or returns normally — either
    # way the persisted state must remain CANCELLED.
    can_finish.set()

    # Let the runner unwind.
    await asyncio.sleep(0.05)

    # Read final state BEFORE close() — InMemoryTaskStore.close() clears
    # the dict, so any read after close returns None.
    final = await store.get(submitted.task_id)
    await mgr.close()
    assert final is not None
    assert final.status == TaskStatus.CANCELLED, (
        f"Post-cancel runner-return must NOT overwrite CANCELLED with COMPLETED, got {final.status}"
    )


# ---------------------------------------------------------------------------
# (3) Runner exception path — same monotonicity guard
# ---------------------------------------------------------------------------


async def test_cancel_then_runner_raises_preserves_cancelled() -> None:
    """Symmetric case: runner raises an exception while cancel has
    already committed CANCELLED to the store. The exception branch
    routes through the same guard; final state stays CANCELLED."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    runner_started = asyncio.Event()
    can_finish = asyncio.Event()

    async def failing_runner(task: Task) -> dict[str, Any]:
        runner_started.set()
        await can_finish.wait()
        raise RuntimeError("upstream broke after cancel")

    submitted = await mgr.submit(_new_task(), failing_runner)
    await runner_started.wait()

    cancelled = await mgr.cancel(submitted.task_id)
    assert cancelled is not None
    assert cancelled.status == TaskStatus.CANCELLED

    can_finish.set()
    await asyncio.sleep(0.05)

    final = await store.get(submitted.task_id)
    await mgr.close()
    assert final is not None
    assert final.status == TaskStatus.CANCELLED, (
        f"Runner-raises-after-cancel must preserve CANCELLED, got {final.status}"
    )


# ---------------------------------------------------------------------------
# (4) Happy path — no cancel, runner completes normally
# ---------------------------------------------------------------------------


async def test_runner_completes_normally_yields_completed() -> None:
    """Baseline: no cancellation race. Runner returns cleanly,
    persisted state is COMPLETED with the result."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    async def quick_runner(task: Task) -> dict[str, Any]:
        return {"text": "clean output", "value": 42}

    submitted = await mgr.submit(_new_task(), quick_runner)

    # Wait for the inflight task to finish naturally.
    await asyncio.sleep(0.05)
    while mgr.owns_inflight(submitted.task_id):
        await asyncio.sleep(0.01)

    final = await store.get(submitted.task_id)
    await mgr.close()
    assert final is not None
    assert final.status == TaskStatus.COMPLETED
    assert final.result == {"text": "clean output", "value": 42}


# ---------------------------------------------------------------------------
# (5) Cancel on already-terminal task is idempotent
# ---------------------------------------------------------------------------


async def test_cancel_on_already_terminal_returns_unchanged() -> None:
    """`cancel()` on a task that's already in a terminal state must
    return the task unchanged — no second persist, no transition to
    something else. Locks the idempotency contract documented in
    `cancel()`'s docstring."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    async def quick_runner(task: Task) -> dict[str, Any]:
        return {"text": "done"}

    submitted = await mgr.submit(_new_task(), quick_runner)
    # Wait for the runner to complete + persist.
    await asyncio.sleep(0.05)
    while mgr.owns_inflight(submitted.task_id):
        await asyncio.sleep(0.01)

    # First read — confirm COMPLETED.
    snapshot = await store.get(submitted.task_id)
    assert snapshot is not None and snapshot.status == TaskStatus.COMPLETED

    # Cancel must NOT overwrite COMPLETED with CANCELLED.
    result = await mgr.cancel(submitted.task_id)
    assert result is not None
    assert result.status == TaskStatus.COMPLETED, (
        f"cancel() on a COMPLETED task must return it unchanged, got {result.status}"
    )

    final = await store.get(submitted.task_id)
    assert final is not None
    assert final.status == TaskStatus.COMPLETED
    await mgr.close()


# ---------------------------------------------------------------------------
# (6) Cancel on unknown task returns None
# ---------------------------------------------------------------------------


async def test_cancel_on_unknown_task_returns_none() -> None:
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()
    assert await mgr.cancel("never-existed") is None
    await mgr.close()


# ---------------------------------------------------------------------------
# (7) close() cancels in-flight tasks and persists them
# ---------------------------------------------------------------------------


async def test_close_cancels_inflight_and_persists() -> None:
    """Shutdown path: close() must cancel every in-flight task and
    leave the store in a clean terminal state — no `running` ghosts."""
    store = InMemoryTaskStore()
    mgr = TaskManager(store)
    await mgr.start()

    started = asyncio.Event()
    never_finishes = asyncio.Event()  # intentionally never set

    async def stuck_runner(task: Task) -> dict[str, Any]:
        started.set()
        await never_finishes.wait()
        return {"unreachable": True}

    submitted = await mgr.submit(_new_task(), stuck_runner)
    await started.wait()

    # Shutdown must drain — close() cancels the in-flight task. We
    # observe the persisted state AFTER cancellation has propagated
    # but BEFORE InMemoryTaskStore.close() clears the dict, by reading
    # right after the gather inside close has finished cancelling.
    # The easiest way: replace store.close with a no-op so we can read
    # post-drain state. (Production RedisTaskStore.close() just calls
    # aclose() on the pool — it does NOT wipe state.)
    store.close = _no_op_close  # type: ignore[method-assign]
    await mgr.close()

    final = await store.get(submitted.task_id)
    assert final is not None
    assert final.is_terminal(), (
        f"After close(), in-flight task must be terminal, got {final.status}"
    )
    assert final.status == TaskStatus.CANCELLED
