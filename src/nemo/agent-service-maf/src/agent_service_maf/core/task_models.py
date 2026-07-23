"""Task models for the async-invoke pattern.

A :class:`Task` represents a long-running agent invocation submitted via
``POST /invoke/async``. The submitting client receives the task id immediately;
the work runs in the background and the result is persisted via
:class:`~agent_service_maf.core.task_store.TaskStore`. Clients poll
``GET /tasks/{task_id}`` until ``status`` is terminal.

Lifecycle:
    ``RUNNING`` --> ``COMPLETED`` (runner returned a value)
    ``RUNNING`` --> ``FAILED``    (runner raised; ``error`` / ``error_type`` set)
    ``RUNNING`` --> ``CANCELLED`` (caller invoked ``cancel`` or service shut down)

Terminal states are :attr:`TaskStatus.COMPLETED`, :attr:`TaskStatus.FAILED`, and
:attr:`TaskStatus.CANCELLED`; polling clients stop once any of these is reached.
"""

from __future__ import annotations

import time
import uuid
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field

from agent_service_maf.core.identity import IdentityContext


class TaskStatus(StrEnum):
    """Lifecycle states for an async task.

    Terminal states are :attr:`COMPLETED`, :attr:`FAILED`, and :attr:`CANCELLED`.
    Polling stops once the task reaches a terminal state.
    """

    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Task(BaseModel):
    """A persisted async task.

    Attributes:
        task_id: UUID4 issued at submission time.
        status: Current lifecycle state.
        project_id: Project this task was submitted under (for scoping polls).
        team_id: Team that ran the work (may be the project's default team).
        agent_id: Agent that ran the work (``"orchestrator"`` for team-level
            invokes).
        correlation_id: Per-task UUID4 used in logs and traces. Reused by the
            background runner so all spans share the same id as the submit
            response.
        created_at: Submission time (POSIX epoch seconds).
        updated_at: Last status change.
        result: Final ``InvokeResponse``-shaped dict when ``status ==
            completed``. ``None`` while running or on failure.
        error: Human-readable error message when ``status in {failed,
            cancelled}``.
        error_type: Exception class name when ``status == failed`` (for clients
            that want to branch on error type).
        duration_ms: Total run time once terminal.
    """

    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    status: TaskStatus = TaskStatus.RUNNING
    project_id: str = ""
    team_id: str = ""
    agent_id: str = ""
    correlation_id: str = ""
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    result: dict[str, Any] | None = None
    error: str = ""
    error_type: str = ""
    duration_ms: int = 0
    # §A3 / §D1-D3 — captured at submit() time so the background
    # runner can re-bind the ContextVar at the top of :func:`_run`.
    # NEVER serialized to the wire: ``exclude=True`` keeps
    # :meth:`model_dump` / :meth:`model_dump_json` from emitting it,
    # which is the §D3 guarantee. ``user_token`` is itself
    # ``exclude=True`` on :class:`IdentityContext` for the second
    # line of defense (§H3).
    identity: IdentityContext | None = Field(default=None, exclude=True, repr=False)

    def is_terminal(self) -> bool:
        """Return ``True`` once the task has reached a terminal state."""
        return self.status in {
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }

    def mark_completed(self, result: dict[str, Any], duration_ms: int) -> None:
        """Transition the task to :attr:`TaskStatus.COMPLETED`."""
        self.status = TaskStatus.COMPLETED
        self.result = result
        self.duration_ms = duration_ms
        self.updated_at = time.time()

    def mark_failed(self, error: str, error_type: str = "") -> None:
        """Transition the task to :attr:`TaskStatus.FAILED`."""
        self.status = TaskStatus.FAILED
        self.error = error
        self.error_type = error_type
        self.updated_at = time.time()

    def mark_cancelled(self, reason: str = "Cancelled by caller") -> None:
        """Transition the task to :attr:`TaskStatus.CANCELLED`."""
        self.status = TaskStatus.CANCELLED
        self.error = reason
        self.updated_at = time.time()
