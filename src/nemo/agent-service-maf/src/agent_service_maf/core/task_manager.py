"""TaskManager -- orchestrates async-invoke task lifecycle.

The manager owns:

- The :class:`~agent_service_maf.core.task_store.TaskStore` (storage),
- A dict of in-flight ``asyncio.Task`` references keyed by ``task_id`` (so
  background work is not garbage-collected mid-flight and can be cancelled
  precisely on shutdown / explicit ``cancel`` calls),
- The submit / poll / cancel API used by the routes layer.

Background execution uses :func:`asyncio.create_task`. The runner coroutine is
passed in by the caller (the route handler), so this module stays decoupled
from the invocation logic -- it does not know what a "team" or "framework" is.

Graceful shutdown: on :meth:`TaskManager.close` every in-flight task is
cancelled, the cancellation is awaited, and the persisted state is overwritten
with :attr:`~agent_service_maf.core.task_models.TaskStatus.CANCELLED` so polling
clients see a clean terminal state rather than dangling ``running`` entries.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

from agent_service_maf.core.task_models import Task
from agent_service_maf.core.task_store import TaskStore

logger = structlog.get_logger(__name__)

#: Callable signature for the work a task runs.
#:
#: Receives the persisted :class:`~agent_service_maf.core.task_models.Task`
#: (the runner may read fields like ``correlation_id`` but should not mutate
#: status -- the manager handles state transitions) and returns the result
#: dict that becomes :attr:`Task.result` on success.
TaskRunner = Callable[[Task], Awaitable[dict[str, Any]]]


class TaskManager:
    """Submit, poll, and cancel async tasks backed by a :class:`TaskStore`.

    Lifecycle: instantiate, call :meth:`start`, use, call :meth:`close` at
    shutdown. Shutdown cancels in-flight tasks and persists each as
    ``CANCELLED`` so polling clients see a clean terminal state instead of
    dangling ``RUNNING`` entries.

    Args:
        store: The backend used to persist task state.
    """

    def __init__(self, store: TaskStore) -> None:
        self._store = store
        # Keyed by task_id so cancel() can target a specific in-flight task.
        self._inflight: dict[str, asyncio.Task[None]] = {}
        self._shutting_down = False

    @property
    def store(self) -> TaskStore:
        """The underlying task store (for testing / inspection)."""
        return self._store

    async def start(self) -> None:
        """Start the manager. No-op today; reserved for backends that need
        warm-up (e.g. dialing Redis Sentinel).
        """
        logger.info("TaskManager started")

    async def submit(
        self,
        task: Task,
        runner: TaskRunner,
    ) -> Task:
        """Persist the task as ``RUNNING`` and schedule the work in the background.

        Args:
            task: A newly constructed :class:`Task` (caller fills in
                ``project_id``, ``team_id``, ``agent_id``, ``correlation_id``).
            runner: Async callable that does the work and returns the result
                dict to persist as :attr:`Task.result` on success.

        Returns:
            The same ``task`` after being persisted. Mutated in place so the
            caller can read ``task_id`` / ``status`` directly.
        """
        if self._shutting_down:
            task.mark_failed(
                "Service is shutting down -- task not accepted",
                error_type="ServiceUnavailable",
            )
            await self._store.save(task, running=False)
            return task

        await self._store.save(task, running=True)

        task_id = task.task_id

        def _drop_inflight(_done: asyncio.Task[None]) -> None:
            # Discard the strong reference once the runner finishes so the
            # inflight map does not grow unboundedly. ``pop(..., None)``
            # tolerates double-completion (e.g. cancel + natural finish).
            self._inflight.pop(task_id, None)

        bg = asyncio.create_task(self._run(task, runner))
        self._inflight[task_id] = bg
        bg.add_done_callback(_drop_inflight)

        logger.info(
            "Task submitted",
            task_id=task.task_id,
            project_id=task.project_id,
            team_id=task.team_id,
            agent_id=task.agent_id,
            correlation_id=task.correlation_id,
        )
        return task

    async def _run(self, task: Task, runner: TaskRunner) -> None:
        """Background coroutine.

        Catches everything and persists a terminal state. ``CancelledError``
        is re-raised after persisting so the asyncio task itself ends in
        ``CANCELLED`` state (visible via ``Task.cancelled()`` on the
        ``asyncio.Task`` if anyone awaits it).

        **Terminal-state monotonicity.** Once a task is in any terminal
        state in the store (``CANCELLED`` / ``FAILED`` / ``COMPLETED``)
        we must never overwrite it with another terminal value. The
        classic race is:

        1. ``runner(task)`` returns successfully.
        2. Before this coroutine calls ``mark_completed`` + ``save``, a
           concurrent :meth:`cancel` reads the (still-RUNNING) task,
           writes ``CANCELLED`` to the store, and cancels the asyncio
           task. But ``await runner(task)`` has already returned -- there
           is no suspension point left to inject the cancellation.
        3. This coroutine would then save ``COMPLETED``, overwriting the
           ``CANCELLED`` the caller just observed.

        The success branch re-fetches the persisted task immediately
        before saving and refuses to overwrite a terminal state. The
        ``CancelledError`` branch already does the right thing because
        :meth:`cancel` sets the state before signalling. The exception
        branch follows the same re-check for symmetry.
        """
        start = time.monotonic()
        try:
            result = await runner(task)
            duration_ms = int((time.monotonic() - start) * 1000)
            task.mark_completed(result, duration_ms)
            if await self._persist_unless_already_terminal(task, transition="completed"):
                logger.info(
                    "Task completed",
                    task_id=task.task_id,
                    duration_ms=duration_ms,
                    correlation_id=task.correlation_id,
                )
            return
        except asyncio.CancelledError:
            # Preserve any pre-existing terminal state set by cancel() so we
            # do not overwrite a more specific "Cancelled by caller" message
            # with the shutdown reason.
            if not task.is_terminal():
                task.mark_cancelled("Cancelled during shutdown")
            # Even though cancel() typically saves CANCELLED before we get
            # here, route the save through the monotonic helper for
            # symmetry — a cross-replica cancel could land between
            # mark_cancelled and this save with a different reason string.
            await self._persist_unless_already_terminal(task, transition="cancelled")
            raise
        except Exception as exc:  # noqa: BLE001
            task.mark_failed(str(exc), error_type=type(exc).__name__)
            await self._persist_unless_already_terminal(task, transition="failed")
            logger.exception(
                "Task failed",
                task_id=task.task_id,
                error_type=type(exc).__name__,
                correlation_id=task.correlation_id,
            )

    async def _persist_unless_already_terminal(
        self,
        task: Task,
        *,
        transition: str,
    ) -> bool:
        """Save ``task`` to the store iff the **persisted** state is non-
        terminal.

        Guards against the win-overwrites-loss race in the class docstring:
        if a concurrent :meth:`cancel` (or a peer replica) has already
        committed a terminal state, we keep their decision instead of
        stomping it with this coroutine's outcome. The in-memory ``task``
        object's status is **not** reverted -- only the persistence is
        skipped, so the caller's local view is unchanged.

        Returns ``True`` when the save happened, ``False`` when the save
        was skipped because the persisted state was already terminal (or
        when the store read itself failed -- in that case we fall through
        and attempt the save anyway, since refusing to write would mean
        losing the outcome entirely).
        """
        try:
            persisted = await self._store.get(task.task_id)
        except Exception as exc:  # noqa: BLE001
            # Store read failed -- best-effort path: attempt the write so
            # we don't drop the outcome on the floor. Save errors are
            # caught below.
            logger.warning(
                "task_persist_state_check_failed",
                task_id=task.task_id,
                transition=transition,
                error=str(exc),
            )
            persisted = None

        if persisted is not None and persisted.is_terminal():
            # The competing terminal state wins. Log the divergence so
            # operators can correlate "I saw cancelled then polled and got
            # completed-like output" if it ever surfaces.
            logger.info(
                "task_terminal_state_preserved",
                task_id=task.task_id,
                attempted_transition=transition,
                persisted_status=persisted.status.value,
                correlation_id=task.correlation_id,
            )
            return False

        try:
            await self._store.save(task, running=False)
        except Exception as save_exc:  # noqa: BLE001
            logger.error(
                "task_persist_failed",
                task_id=task.task_id,
                transition=transition,
                error=str(save_exc),
            )
            return False
        return True

    async def get(self, task_id: str) -> Task | None:
        """Look up a task by id. Returns ``None`` if unknown or expired."""
        return await self._store.get(task_id)

    def owns_inflight(self, task_id: str) -> bool:
        """Return ``True`` iff this manager is currently running the task.

        Used by the routes-layer task router to pick the correct manager
        for ``cancel`` in multi-team projects: only the manager that
        scheduled the runner can actually interrupt the live asyncio
        task. Polling a non-owning manager still reads the persisted
        state (the store may be shared across managers), but cancelling
        through a non-owning manager only updates the store -- the live
        coroutine on the owning manager keeps running and would
        otherwise race the cancel by stamping ``COMPLETED`` on top.
        """
        bg = self._inflight.get(task_id)
        return bg is not None and not bg.done()

    async def cancel(self, task_id: str) -> Task | None:
        """Cancel an in-flight task.

        Targets the specific ``asyncio.Task`` via the inflight index so the
        background coroutine receives ``CancelledError`` and stops promptly.
        Already-terminal tasks are returned unchanged.

        Args:
            task_id: The task to cancel.

        Returns:
            The task in its post-cancel state, or ``None`` if unknown.
        """
        task = await self._store.get(task_id)
        if task is None:
            return None
        if task.is_terminal():
            return task

        # Mark cancelled before signalling so _run sees a non-terminal -> CANCELLED
        # transition that it preserves instead of stamping "Cancelled during
        # shutdown" on top.
        task.mark_cancelled("Cancelled by caller")
        await self._store.save(task, running=False)

        bg = self._inflight.get(task_id)
        if bg is not None and not bg.done():
            bg.cancel()

        return task

    async def close(self) -> None:
        """Drain in-flight tasks, marking each as cancelled with a shutdown reason."""
        self._shutting_down = True
        if not self._inflight:
            await self._store.close()
            return

        logger.info(
            "TaskManager shutting down -- cancelling in-flight tasks",
            count=len(self._inflight),
        )
        pending = list(self._inflight.values())
        for bg in pending:
            bg.cancel()

        # Give cancellation a moment to propagate; ignore errors.
        await asyncio.gather(*pending, return_exceptions=True)
        await self._store.close()
