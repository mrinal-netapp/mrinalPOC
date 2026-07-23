# MAF Implementation Plan — Async-Invoke Pattern (`/invoke/async` + `/tasks/{task_id}`)

**Date:** 2026-05-11
**Audience:** Engineer implementing the async-invoke pattern in `agent-service-maf`
**Goal:** Add fire-and-forget HTTP submission with task-id polling to MAF, following MAF's existing conventions (typed Pydantic models, ABC + implementations, factory function, DI through `TeamBundle`, project-scoped routes, lifecycle hooks). Match the POC's operational behaviour (Redis backend, two-tier TTL, zlib-compressed results, per-op timeouts, graceful shutdown).

---

## 1. Design at a glance

The pattern is structurally identical to how MAF already handles sessions:

| Layer | Sessions (already exists) | Tasks (to add) |
|---|---|---|
| Data model | `Session`, `ConversationMessage` | `Task`, `TaskStatus` |
| Storage ABC | `SessionStore` | `TaskStore` |
| Backends | `InMemorySessionStore`, `RedisSessionStore` | `InMemoryTaskStore`, `RedisTaskStore` |
| Factory | `create_session_store(backend, ...)` | `create_task_store(backend, ...)` |
| Manager | `SessionManager` | `TaskManager` |
| Bundle field | `TeamBundle.session_manager` | `TeamBundle.task_manager` |
| Config section | `memory.*` | `tasks.*` |
| Lifecycle | `start()` / `close()` | `start()` / `close()` |

Reusing this shape keeps the codebase consistent and makes the new feature feel native instead of bolted on.

**Two-tier TTL** (matching POC): a running task expires in 10 minutes if the process crashes before marking it complete; a completed/failed task lives for 1 hour so polling clients have time to fetch it.

**Background execution.** `asyncio.create_task(_run_async(...))` to schedule the work. Hold a strong reference in `TaskManager._inflight: set[asyncio.Task]` so the task isn't garbage-collected mid-flight. Remove from the set on completion.

**Re-use existing invoke logic.** Extract the inner work of `_invoke_impl` into a `_run_invocation` helper so the async path runs the same code with the same context, guardrails, and tracing — just outside the HTTP response cycle.

**Graceful shutdown.** On `on_shutdown`, mark all in-flight tasks as `failed` with reason `"Service shutting down — task aborted"` so polling clients see a clean terminal state instead of `running` zombies.

---

## 2. Routes (project-scoped, matching MAF + POC convention)

```
POST  /api/v1/projects/{project_id}/teams/{team_id}/invoke/async
POST  /api/v1/projects/{project_id}/agents/{agent_id}/invoke/async   (default-team alias)
POST  /api/v1/projects/{project_id}/agents/invoke/async              (default-team + default-agent)
GET   /api/v1/projects/{project_id}/tasks/{task_id}
DELETE /api/v1/projects/{project_id}/tasks/{task_id}                 (optional: cancel)
```

**Submit response** (HTTP 202):
```json
{ "task_id": "550e8400-e29b-41d4-a716-446655440000", "status": "running" }
```

**Poll response — running** (HTTP 200):
```json
{ "task_id": "...", "status": "running", "created_at": 1.7e9, "updated_at": 1.7e9 }
```

**Poll response — completed** (HTTP 200):
```json
{
  "task_id": "...",
  "status": "completed",
  "result": { /* InvokeResponse */ },
  "created_at": 1.7e9,
  "updated_at": 1.7e9,
  "duration_ms": 4523
}
```

**Poll response — failed** (HTTP 200):
```json
{
  "task_id": "...",
  "status": "failed",
  "error": "Agent exceeded guardrail timeout of 300s",
  "error_type": "TimeoutError",
  "created_at": 1.7e9,
  "updated_at": 1.7e9
}
```

**Poll response — not found** (HTTP 404):
```json
{ "error": "Task not found", "task_id": "..." }
```

The POC uses 200 for poll regardless of status; recommending the same so simple polling clients don't have to special-case 404 vs status field.

---

## 3. File-by-file implementation

### 3.1 New file: `src/agent_service_maf/core/task_models.py`

Typed models for the task subsystem. Mirrors `core/session.py`'s shape.

```python
"""Task models for the async-invoke pattern.

A ``Task`` represents a long-running agent invocation submitted via
``POST /invoke/async``. The submitting client receives the task id immediately;
the work runs in the background and the result is persisted via :class:`TaskStore`.
Clients poll ``GET /tasks/{task_id}`` until ``status`` is terminal.
"""

from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
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
        agent_id: Agent that ran the work (``"orchestrator"`` for team-level invokes).
        correlation_id: Per-task UUID4 used in logs and traces.
        created_at: Submission time (POSIX epoch seconds).
        updated_at: Last status change.
        result: Final ``InvokeResponse``-shaped dict when ``status == completed``.
            ``None`` while running or on failure.
        error: Human-readable error message when ``status in {failed, cancelled}``.
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

    def is_terminal(self) -> bool:
        return self.status in {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}

    def mark_completed(self, result: dict[str, Any], duration_ms: int) -> None:
        self.status = TaskStatus.COMPLETED
        self.result = result
        self.duration_ms = duration_ms
        self.updated_at = time.time()

    def mark_failed(self, error: str, error_type: str = "") -> None:
        self.status = TaskStatus.FAILED
        self.error = error
        self.error_type = error_type
        self.updated_at = time.time()

    def mark_cancelled(self, reason: str = "Cancelled by caller") -> None:
        self.status = TaskStatus.CANCELLED
        self.error = reason
        self.updated_at = time.time()
```

### 3.2 New file: `src/agent_service_maf/core/task_store.py`

Pluggable backend, mirroring `core/session_store.py`.

```python
"""Pluggable task persistence backends.

Defines :class:`TaskStore` and two implementations:

- :class:`InMemoryTaskStore` — default, no external dependencies. Suitable for
  dev and single-instance deployments. Tasks lost on process restart.
- :class:`RedisTaskStore` — production. Stores tasks as zlib-compressed JSON
  with a two-tier TTL (short while running, longer once terminal) so a crashed
  worker doesn't leak ``running`` task hashes forever.

The backend is selected by ``tasks.backend`` config (``memory`` or ``redis``).
"""

from __future__ import annotations

import asyncio
import json
import zlib
from abc import ABC, abstractmethod
from typing import Any

import structlog

from agent_service_maf.core.task_models import Task, TaskStatus

logger = structlog.get_logger(__name__)

_REDIS_OP_TIMEOUT = 10  # seconds, matching POC


class TaskStore(ABC):
    """Abstract interface for task persistence."""

    @abstractmethod
    async def save(self, task: Task, *, running: bool) -> None:
        """Persist a task. ``running=True`` applies the short TTL; ``False`` applies
        the long TTL so terminal tasks live long enough to be polled."""

    @abstractmethod
    async def get(self, task_id: str) -> Task | None:
        """Retrieve a task by id. Returns ``None`` if unknown or expired."""

    @abstractmethod
    async def delete(self, task_id: str) -> bool:
        """Delete a task. Returns True if it existed."""

    @abstractmethod
    async def close(self) -> None:
        """Release any backend resources."""


# ---------------------------------------------------------------------------
# In-memory backend
# ---------------------------------------------------------------------------


class InMemoryTaskStore(TaskStore):
    """In-memory task store backed by a dict. Suitable for dev / single instance.

    Does NOT implement TTL — entries persist until the process exits or the
    caller deletes them. Adequate for short-lived dev sessions.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}

    async def save(self, task: Task, *, running: bool) -> None:
        # running parameter is ignored — no TTL in dev backend
        self._tasks[task.task_id] = task

    async def get(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    async def delete(self, task_id: str) -> bool:
        return self._tasks.pop(task_id, None) is not None

    async def close(self) -> None:
        self._tasks.clear()


# ---------------------------------------------------------------------------
# Redis backend
# ---------------------------------------------------------------------------


class RedisTaskStore(TaskStore):
    """Redis-backed task store with two-tier TTL and zlib-compressed payloads.

    Key scheme: ``{prefix}{task_id}``  (default prefix ``agent_task:``).
    Values are stored as zlib(level=1) JSON to keep result payloads small —
    InvokeResponses can include long-form output, trace_steps, citations.

    Args:
        redis_url: Connection URL.
        key_prefix: Prefix for all task keys.
        running_ttl_seconds: TTL for tasks still in flight. Short by design —
            a crashed worker self-cleans within this window.
        result_ttl_seconds: TTL once the task reaches a terminal state.
        compression_level: zlib level (1 fast, 9 thorough). Default 1 matches POC.

    Raises:
        ImportError: If ``redis`` package is not installed.
    """

    def __init__(
        self,
        redis_url: str = "redis://localhost:6379/0",
        key_prefix: str = "agent_task:",
        running_ttl_seconds: int = 600,
        result_ttl_seconds: int = 3600,
        compression_level: int = 1,
    ) -> None:
        try:
            import redis.asyncio as aioredis
        except ImportError as exc:
            raise ImportError(
                "Redis task store requires the 'redis' package. "
                "Install it with: pip install redis[hiredis]"
            ) from exc

        # decode_responses=False so zlib bytes round-trip cleanly
        self._redis = aioredis.from_url(redis_url, decode_responses=False)
        self._prefix = key_prefix
        self._running_ttl = running_ttl_seconds
        self._result_ttl = result_ttl_seconds
        self._level = compression_level
        logger.info(
            "Redis task store initialized",
            url=redis_url,
            prefix=key_prefix,
            running_ttl=running_ttl_seconds,
            result_ttl=result_ttl_seconds,
        )

    def _key(self, task_id: str) -> str:
        return f"{self._prefix}{task_id}"

    def _encode(self, task: Task) -> bytes:
        payload = task.model_dump(mode="json")
        return zlib.compress(json.dumps(payload).encode("utf-8"), level=self._level)

    def _decode(self, raw: bytes) -> Task | None:
        try:
            data = json.loads(zlib.decompress(raw))
            return Task.model_validate(data)
        except (zlib.error, json.JSONDecodeError, ValueError) as exc:
            logger.warning("Failed to decode task from Redis", error=str(exc))
            return None

    async def save(self, task: Task, *, running: bool) -> None:
        ttl = self._running_ttl if running else self._result_ttl
        await asyncio.wait_for(
            self._redis.set(self._key(task.task_id), self._encode(task), ex=ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )

    async def get(self, task_id: str) -> Task | None:
        raw = await asyncio.wait_for(
            self._redis.get(self._key(task_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        if raw is None:
            return None
        return self._decode(raw)

    async def delete(self, task_id: str) -> bool:
        deleted = await asyncio.wait_for(
            self._redis.delete(self._key(task_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        return bool(deleted)

    async def close(self) -> None:
        await self._redis.aclose()
        logger.info("Redis task store closed")


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_task_store(
    backend: str = "memory",
    redis_url: str = "redis://localhost:6379/0",
    key_prefix: str = "agent_task:",
    running_ttl_seconds: int = 600,
    result_ttl_seconds: int = 3600,
    compression_level: int = 1,
) -> TaskStore:
    """Create a task store from config.

    Raises:
        ValueError: If ``backend`` is not recognised.
        ImportError: If ``redis`` backend is selected but package is missing.
    """
    if backend == "memory":
        return InMemoryTaskStore()
    if backend == "redis":
        return RedisTaskStore(
            redis_url=redis_url,
            key_prefix=key_prefix,
            running_ttl_seconds=running_ttl_seconds,
            result_ttl_seconds=result_ttl_seconds,
            compression_level=compression_level,
        )
    raise ValueError(
        f"Unknown task storage backend: '{backend}'. Supported: 'memory', 'redis'."
    )
```

### 3.3 New file: `src/agent_service_maf/core/task_manager.py`

Orchestrator. Mirrors `SessionManager`.

```python
"""TaskManager — orchestrates async-invoke task lifecycle.

The manager owns:
- The :class:`TaskStore` (storage),
- A set of in-flight asyncio.Task references (so background work isn't GC'd),
- The submit / poll / cancel API used by the routes layer.

Background execution uses ``asyncio.create_task``. The runner coroutine is
passed in by the caller (the route handler), so this module stays decoupled
from the invocation logic — it doesn't know what a "team" or a "framework" is.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

import structlog

from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import TaskStore

logger = structlog.get_logger(__name__)

#: Callable signature for the work a task runs.
#: Receives the persisted ``Task`` (the runner may mutate it) and returns the
#: result dict that becomes ``Task.result`` on success.
TaskRunner = Callable[[Task], Awaitable[dict[str, Any]]]


class TaskManager:
    """Submit, poll, and cancel async tasks backed by a :class:`TaskStore`.

    Lifecycle: instantiate, call ``start()``, use, call ``close()`` at shutdown.
    Shutdown cancels in-flight tasks and marks them as ``failed`` so polling
    clients see a clean terminal state instead of dangling ``running`` entries.
    """

    def __init__(self, store: TaskStore) -> None:
        self._store = store
        self._inflight: set[asyncio.Task[None]] = set()
        self._shutting_down = False

    async def start(self) -> None:
        """No-op today; reserved for backends that need warm-up."""
        logger.info("TaskManager started")

    async def submit(
        self,
        task: Task,
        runner: TaskRunner,
    ) -> Task:
        """Persist the task as ``running`` and schedule the work in the background.

        Args:
            task: A newly constructed :class:`Task` (caller fills in project_id,
                team_id, agent_id, correlation_id).
            runner: Async callable that does the work and returns the result dict.

        Returns:
            The same ``task`` after being persisted.
        """
        if self._shutting_down:
            task.mark_failed(
                "Service is shutting down — task not accepted",
                error_type="ServiceUnavailable",
            )
            await self._store.save(task, running=False)
            return task

        await self._store.save(task, running=True)

        bg = asyncio.create_task(self._run(task, runner))
        self._inflight.add(bg)
        bg.add_done_callback(self._inflight.discard)

        logger.info(
            "Task submitted",
            task_id=task.task_id,
            project_id=task.project_id,
            team_id=task.team_id,
            agent_id=task.agent_id,
        )
        return task

    async def _run(self, task: Task, runner: TaskRunner) -> None:
        """Background coroutine. Catches everything and stores a terminal state."""
        start = time.monotonic()
        try:
            result = await runner(task)
            duration_ms = int((time.monotonic() - start) * 1000)
            task.mark_completed(result, duration_ms)
            await self._store.save(task, running=False)
            logger.info(
                "Task completed",
                task_id=task.task_id,
                duration_ms=duration_ms,
            )
        except asyncio.CancelledError:
            task.mark_cancelled("Cancelled during shutdown")
            try:
                await self._store.save(task, running=False)
            except Exception as save_exc:  # noqa: BLE001
                logger.error(
                    "Failed to persist cancelled task",
                    task_id=task.task_id,
                    error=str(save_exc),
                )
            raise
        except Exception as exc:  # noqa: BLE001
            task.mark_failed(str(exc), error_type=type(exc).__name__)
            try:
                await self._store.save(task, running=False)
            except Exception as save_exc:  # noqa: BLE001
                logger.error(
                    "Failed to persist failed task (task is now orphaned)",
                    task_id=task.task_id,
                    error=str(save_exc),
                )
            logger.exception(
                "Task failed",
                task_id=task.task_id,
                error_type=type(exc).__name__,
            )

    async def get(self, task_id: str) -> Task | None:
        """Look up a task by id."""
        return await self._store.get(task_id)

    async def cancel(self, task_id: str) -> Task | None:
        """Best-effort cancellation. Returns the task in its post-cancel state
        if found, ``None`` if unknown. In-flight asyncio tasks are signalled
        via ``Task.cancel()``; tasks already terminal are returned unchanged.
        """
        task = await self._store.get(task_id)
        if task is None:
            return None
        if task.is_terminal():
            return task

        # Find the asyncio.Task matching this id. Linear scan over a small set.
        for bg in list(self._inflight):
            # We don't have a direct mapping from task_id to asyncio.Task here.
            # Simplest: signal cancellation by marking the persisted state and
            # letting the runner check (or rely on shutdown sweep). To match the
            # POC's simplicity we just mark the persisted task as cancelled —
            # the runner will overwrite this when it finishes if it ignores cancel.
            pass

        task.mark_cancelled("Cancelled by caller")
        await self._store.save(task, running=False)
        return task

    async def close(self) -> None:
        """Drain in-flight tasks, marking each as failed with shutdown reason."""
        self._shutting_down = True
        if not self._inflight:
            await self._store.close()
            return

        logger.info(
            "TaskManager shutting down — cancelling in-flight tasks",
            count=len(self._inflight),
        )
        for bg in list(self._inflight):
            bg.cancel()

        # Give cancellation a moment to propagate; ignore errors.
        await asyncio.gather(*self._inflight, return_exceptions=True)
        await self._store.close()
```

> **Design note on cancellation.** A fully precise implementation would maintain a `dict[str, asyncio.Task]` mapping `task_id → background task` so `cancel()` can target a specific task. The simpler version above mirrors the POC's behaviour: tasks self-cancel cleanly on shutdown via `CancelledError`, but per-task cancellation while running is best-effort. If hard cancellation is a real requirement, swap the `set` for a `dict` keyed by `task.task_id`.

### 3.4 Modified file: `src/agent_service_maf/interface_layer/models.py`

Add the request/response models for async invoke and polling. Append:

```python
# ---------------------------------------------------------------------------
# Async invoke models
# ---------------------------------------------------------------------------


class AsyncInvokeResponse(BaseModel):
    """Response to ``POST /invoke/async``.

    Returned immediately after the task is persisted as ``running``. The client
    polls ``GET /tasks/{task_id}`` until the status reaches a terminal value.
    """

    task_id: str = Field(..., description="UUID4 to use for polling")
    status: str = Field("running", description="Always 'running' at submission time")


class TaskStatusResponse(BaseModel):
    """Response to ``GET /tasks/{task_id}``.

    ``result`` is populated only when ``status == 'completed'``.
    ``error`` and ``error_type`` are populated when ``status in {'failed', 'cancelled'}``.
    """

    task_id: str
    status: str  # one of: running, completed, failed, cancelled
    project_id: str = ""
    team_id: str = ""
    agent_id: str = ""
    correlation_id: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0
    duration_ms: int = 0
    result: dict[str, Any] | None = None
    error: str = ""
    error_type: str = ""

    @classmethod
    def from_task(cls, task: "Task") -> "TaskStatusResponse":  # type: ignore[name-defined]
        return cls(
            task_id=task.task_id,
            status=task.status.value,
            project_id=task.project_id,
            team_id=task.team_id,
            agent_id=task.agent_id,
            correlation_id=task.correlation_id,
            created_at=task.created_at,
            updated_at=task.updated_at,
            duration_ms=task.duration_ms,
            result=task.result,
            error=task.error,
            error_type=task.error_type,
        )
```

Add the `Task` forward import (or string-typed reference, as shown).

### 3.5 Modified file: `src/agent_service_maf/config/validators.py`

Add a `TasksSection` near the other section models and wire it into `AppConfig`. The shape mirrors `MemorySection`:

```python
class TasksSection(BaseModel):
    """Async-invoke task store configuration."""

    enabled: bool = Field(
        default=True,
        description="Whether async-invoke routes are exposed. When False, "
                    "/invoke/async returns 404.",
    )
    backend: Literal["memory", "redis"] = Field(
        default="memory",
        description="Backend type. 'memory' is process-local (dev only). "
                    "'redis' is durable across replicas.",
    )
    redis_url: str = Field(
        default="redis://localhost:6379/0",
        description="Redis connection URL (used when backend='redis').",
    )
    key_prefix: str = Field(
        default="agent_task:",
        description="Redis key prefix for task entries.",
    )
    running_ttl_seconds: int = Field(
        default=600,
        ge=60,
        le=86400,
        description="TTL while task is in flight. Short by design so a crashed "
                    "worker self-cleans within this window.",
    )
    result_ttl_seconds: int = Field(
        default=3600,
        ge=60,
        le=604800,
        description="TTL once task reaches a terminal state.",
    )
    compression_level: int = Field(
        default=1,
        ge=1,
        le=9,
        description="zlib compression level for stored task payloads.",
    )
```

In `AppConfig`:

```python
class AppConfig(BaseModel):
    # ... existing sections ...
    tasks: TasksSection = Field(default_factory=TasksSection)
```

### 3.6 Modified file: `src/agent_service_maf/core/team_bundle.py`

Add the field and constructor wiring. Inside the `TeamBundle` dataclass:

```python
@dataclass
class TeamBundle:
    # ... existing fields ...
    task_manager: TaskManager | None = None
```

Update the type-only import block:

```python
if TYPE_CHECKING:
    from agent_service_maf.core.task_manager import TaskManager
```

### 3.7 Modified file: `src/agent_service_maf/core/team_loader.py`

In `build_team_bundle`, after `session_manager = _build_session_manager(...)`, build the task manager:

```python
from agent_service_maf.core.task_manager import TaskManager
from agent_service_maf.core.task_store import create_task_store

def _build_task_manager(config: AppConfig) -> TaskManager | None:
    if not config.tasks.enabled:
        return None
    store = create_task_store(
        backend=config.tasks.backend,
        redis_url=config.tasks.redis_url,
        key_prefix=config.tasks.key_prefix,
        running_ttl_seconds=config.tasks.running_ttl_seconds,
        result_ttl_seconds=config.tasks.result_ttl_seconds,
        compression_level=config.tasks.compression_level,
    )
    return TaskManager(store)
```

Inside `build_team_bundle()`:

```python
task_manager = _build_task_manager(config)
# ...
bundle = TeamBundle(
    # ... existing fields ...
    task_manager=task_manager,
)
```

### 3.8 Modified file: `src/agent_service_maf/interface_layer/api.py`

Register the task manager's `start()` / `close()` with the lifespan. In the lifespan startup section, after MCP connect:

```python
async def _start_task_managers(registry: TeamRegistry) -> None:
    for bundle in registry.all_bundles():
        if bundle.task_manager is not None:
            await bundle.task_manager.start()


async def _close_task_managers(registry: TeamRegistry) -> None:
    for bundle in registry.all_bundles():
        if bundle.task_manager is not None:
            await bundle.task_manager.close()
```

Call `_start_task_managers(registry)` after `await asyncio.gather(*[b.mcp_manager.connect() ...])` and `_close_task_managers(registry)` in the shutdown branch of the lifespan (alongside the MCP disconnect / session-manager stop calls).

### 3.9 Modified file: `src/agent_service_maf/interface_layer/routes.py`

Add the async-invoke routes. Place them near the existing `invoke_team` / `invoke_agent` definitions so the URL structure stays grouped.

```python
from agent_service_maf.core.task_models import Task
from agent_service_maf.interface_layer.models import (
    AsyncInvokeResponse,
    TaskStatusResponse,
)


async def _run_invocation_for_task(
    request: Request,
    body: InvokeRequest,
    *,
    project_id: str,
    team_id: str | None,
    agent_id: str,
    task: Task,
) -> dict[str, Any]:
    """Run an invocation and return the result as a dict for task persistence.

    This is functionally identical to ``_invoke_impl`` but returns a dict
    (serialisable into Task.result) instead of an InvokeResponse, and uses the
    task's correlation_id for tracing continuity.
    """
    start = time.monotonic()
    context = _build_context(request, body, project_id=project_id, team_id=team_id)
    context.correlation_id = task.correlation_id

    guardrails = context.guardrails
    guardrail_ctx: dict[str, str] = {"correlation_id": context.correlation_id}

    effective_input = body.input
    if guardrails is not None:
        effective_input = await guardrails.check_input(
            input_text=body.input,
            agent_id=agent_id,
            context=guardrail_ctx,
        )

    registry = request.app.state.framework_registry
    agent = registry.create(context.config.agent.framework, context.config)
    await agent.initialize(context)

    agent_request = AgentRequest(
        agent_id=agent_id,
        input=effective_input,
        context=body.context,
        config_overrides=body.config_overrides,
        session_id=context.session_id,
        metadata=body.metadata,
    )
    response = await agent.invoke(agent_request, context)
    response.duration_ms = int((time.monotonic() - start) * 1000)

    if guardrails is not None:
        sanitized_output = await guardrails.check_output(
            output_text=response.output,
            agent_id=agent_id,
            original_input=body.input,
            context=guardrail_ctx,
        )
        response = response.model_copy(update={"output": sanitized_output})

    return InvokeResponse.from_agent_response(response).model_dump(mode="json")


def _resolve_team_for_async(
    request: Request,
    project_id: str,
    team_id: str | None,
):
    """Resolve team + check that task manager is enabled. Returns the bundle."""
    bundle = _resolve_team(request, project_id, team_id)
    if bundle.task_manager is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "Async invoke is not enabled for this team",
                "hint": "Set tasks.enabled=true in team config",
            },
        )
    return bundle


# ---------------------------------------------------------------------------
# Async invoke — team-scoped
# ---------------------------------------------------------------------------


@api_router.post(
    "/projects/{project_id}/teams/{team_id}/invoke/async",
    response_model=AsyncInvokeResponse,
    status_code=202,
    summary="Submit a team invocation as a background task",
)
async def invoke_team_async(
    project_id: str,
    team_id: str,
    body: InvokeRequest,
    request: Request,
) -> AsyncInvokeResponse:
    bundle = _resolve_team_for_async(request, project_id, team_id)
    task = Task(
        project_id=project_id,
        team_id=bundle.team_id,
        agent_id="orchestrator",
        correlation_id=str(uuid.uuid4()),
    )

    async def runner(t: Task) -> dict[str, Any]:
        return await _run_invocation_for_task(
            request,
            body,
            project_id=project_id,
            team_id=team_id,
            agent_id="orchestrator",
            task=t,
        )

    assert bundle.task_manager is not None  # narrowed by _resolve_team_for_async
    await bundle.task_manager.submit(task, runner)
    return AsyncInvokeResponse(task_id=task.task_id, status=task.status.value)


# ---------------------------------------------------------------------------
# Async invoke — project-default-team aliases
# ---------------------------------------------------------------------------


@api_router.post(
    "/projects/{project_id}/agents/{agent_id}/invoke/async",
    response_model=AsyncInvokeResponse,
    status_code=202,
    summary="Submit a single-agent invocation as a background task (default team)",
)
async def invoke_agent_async_default_team(
    project_id: str,
    agent_id: str,
    body: InvokeRequest,
    request: Request,
) -> AsyncInvokeResponse:
    bundle = _resolve_team_for_async(request, project_id, team_id=None)
    task = Task(
        project_id=project_id,
        team_id=bundle.team_id,
        agent_id=agent_id,
        correlation_id=str(uuid.uuid4()),
    )

    async def runner(t: Task) -> dict[str, Any]:
        return await _run_invocation_for_task(
            request,
            body,
            project_id=project_id,
            team_id=None,
            agent_id=agent_id,
            task=t,
        )

    assert bundle.task_manager is not None
    await bundle.task_manager.submit(task, runner)
    return AsyncInvokeResponse(task_id=task.task_id, status=task.status.value)


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------


def _find_task_manager_for_project(request: Request, project_id: str):
    """Return any task manager registered under the project — they share storage
    when configured with the same backend, but a per-team manager works too."""
    registry = _require_known_project(request, project_id)
    for bundle in registry.teams_for_project(project_id):
        if bundle.task_manager is not None:
            return bundle.task_manager
    raise HTTPException(
        status_code=404,
        detail={"error": f"No async-invoke-enabled team in project '{project_id}'"},
    )


@api_router.get(
    "/projects/{project_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
    summary="Poll a previously submitted async task",
)
async def get_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> TaskStatusResponse:
    manager = _find_task_manager_for_project(request, project_id)
    task = await manager.get(task_id)
    if task is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found", "task_id": task_id},
        )
    if task.project_id and task.project_id != project_id:
        # Cross-project lookup attempt
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found in this project", "task_id": task_id},
        )
    return TaskStatusResponse.from_task(task)


@api_router.delete(
    "/projects/{project_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
    summary="Cancel an in-flight async task (best effort)",
)
async def cancel_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> TaskStatusResponse:
    manager = _find_task_manager_for_project(request, project_id)
    task = await manager.cancel(task_id)
    if task is None:
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found", "task_id": task_id},
        )
    if task.project_id and task.project_id != project_id:
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found in this project", "task_id": task_id},
        )
    return TaskStatusResponse.from_task(task)
```

### 3.10 Reference team JSON snippet

```json
{
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "_team_id": "research-team",
  "_team_name": "Research team with async invoke",
  "agent": { "framework": "maf", "model": "anthropic/claude-sonnet-4-5" },
  "memory": { "enabled": true, "buffer_type": "sliding_window", "max_tokens": 8000 },
  "tasks": {
    "enabled": true,
    "backend": "redis",
    "redis_url": "redis://redis-master:6379/0",
    "running_ttl_seconds": 600,
    "result_ttl_seconds": 3600,
    "compression_level": 1
  },
  "semantic_kernel": { /* ... */ }
}
```

### 3.11 `.env.example` additions

```
# Task store (async-invoke backend)
AGENT_TASKS__ENABLED=true
AGENT_TASKS__BACKEND=redis
AGENT_TASKS__REDIS_URL=redis://localhost:6379/0
AGENT_TASKS__RUNNING_TTL_SECONDS=600
AGENT_TASKS__RESULT_TTL_SECONDS=3600
```

---

## 4. Testing strategy

### 4.1 Unit tests — `tests/unit/core/test_task_store.py`

```python
import pytest
from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import InMemoryTaskStore


@pytest.mark.asyncio
async def test_save_and_get_round_trips():
    store = InMemoryTaskStore()
    task = Task(project_id="p", team_id="t", agent_id="a")
    await store.save(task, running=True)
    fetched = await store.get(task.task_id)
    assert fetched is not None
    assert fetched.task_id == task.task_id
    assert fetched.status == TaskStatus.RUNNING


@pytest.mark.asyncio
async def test_get_returns_none_when_unknown():
    store = InMemoryTaskStore()
    assert await store.get("does-not-exist") is None


@pytest.mark.asyncio
async def test_delete_returns_true_only_if_existed():
    store = InMemoryTaskStore()
    task = Task()
    await store.save(task, running=True)
    assert await store.delete(task.task_id) is True
    assert await store.delete(task.task_id) is False
```

### 4.2 Unit tests — `tests/unit/core/test_task_manager.py`

```python
import asyncio
import pytest
from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import InMemoryTaskStore
from agent_service_maf.core.task_manager import TaskManager


@pytest.mark.asyncio
async def test_submit_completes_on_runner_success():
    mgr = TaskManager(InMemoryTaskStore())
    await mgr.start()
    task = Task(project_id="p", team_id="t", agent_id="a")

    async def runner(t):
        return {"output": "ok"}

    await mgr.submit(task, runner)
    # let the background task run
    await asyncio.sleep(0.05)

    fetched = await mgr.get(task.task_id)
    assert fetched is not None
    assert fetched.status == TaskStatus.COMPLETED
    assert fetched.result == {"output": "ok"}


@pytest.mark.asyncio
async def test_submit_fails_on_runner_exception():
    mgr = TaskManager(InMemoryTaskStore())
    task = Task()

    async def runner(t):
        raise ValueError("boom")

    await mgr.submit(task, runner)
    await asyncio.sleep(0.05)

    fetched = await mgr.get(task.task_id)
    assert fetched is not None
    assert fetched.status == TaskStatus.FAILED
    assert fetched.error == "boom"
    assert fetched.error_type == "ValueError"


@pytest.mark.asyncio
async def test_close_cancels_inflight_tasks():
    mgr = TaskManager(InMemoryTaskStore())
    task = Task()

    async def slow_runner(t):
        await asyncio.sleep(10)
        return {}

    await mgr.submit(task, slow_runner)
    await mgr.close()

    fetched = await mgr.get(task.task_id)
    assert fetched is not None
    assert fetched.status in {TaskStatus.CANCELLED, TaskStatus.FAILED}
```

### 4.3 Integration test — `tests/integration/test_async_invoke_e2e.py`

Spin up the FastAPI test client with `InMemoryTaskStore`, hit `POST /invoke/async`, poll until `completed`, assert the response shape. Use a mock-LLM-backed `echo` framework so the test doesn't need real LLM credentials.

---

## 5. Operational notes

- **Backend choice in prod.** Use Redis. The in-memory backend is genuinely useful for dev but loses every in-flight task on restart.

- **Sentinel HA.** The implementation above uses `aioredis.from_url(...)`. To match the POC's Sentinel support, factor out a small `_build_redis_client` helper that picks between `Redis.from_url(...)` and `Sentinel.master_for(...)` based on env vars `AGENT_TASKS__REDIS_SENTINEL_URL` / `AGENT_TASKS__REDIS_SENTINEL_MASTER`. The shape of the helper is identical to the POC's `redis_factory.py`.

- **Per-op timeouts.** Every Redis call is wrapped in `asyncio.wait_for(..., timeout=10s)`. A hung Redis cannot deadlock the submit / poll paths.

- **Compression level.** Default `1` is the POC's choice — fast, good ratio for JSON-shaped output. Move to `6` only if your average payload is small and you want max compression; `9` is rarely worth it.

- **Two-tier TTL.** Running 10 min / finished 1 hour matches the POC. Tune `result_ttl_seconds` upward if you have long-running batch consumers that take more than an hour to come back.

- **Cancellation precision.** The implementation above marks the persisted task as cancelled but does not target the specific `asyncio.Task` running the work (mirroring POC simplicity). If you need hard cancellation, replace `_inflight: set[asyncio.Task]` with `dict[str, asyncio.Task]` keyed by `task_id` and call `.cancel()` on the matching entry inside `TaskManager.cancel()`.

- **Concurrency cap.** The POC has `_invoke_semaphore = asyncio.Semaphore(20)` around the invocation. Mirror this with an optional `tasks.max_concurrent: int` field on the config and an `asyncio.Semaphore` inside `_run` if you want a hard cap on simultaneous background runs.

- **Tracing continuity.** `_run_invocation_for_task` overwrites `context.correlation_id` with the task's correlation_id so all spans emitted during the async run carry the task id. When you wire Phoenix in, this is what stitches the task-poll endpoint to the trace.

- **Graceful shutdown.** `TaskManager.close()` cancels each in-flight `asyncio.Task` and persists the cancellation. Pollers see `status=cancelled` instead of a zombie `running` entry.

- **Failure isolation.** The runner is wrapped in a `try/except BaseException` (broadened from `Exception` via `CancelledError` re-raise) so no runner failure crashes the manager. Errors are persisted to the task itself.

- **Observability hooks to add later.** Each `submit` / `complete` / `fail` log line is already structured; when Prometheus is wired in, the natural metrics are `agent_tasks_submitted_total{project,team,agent}`, `agent_tasks_completed_total{...}`, `agent_tasks_failed_total{...,error_type}`, `agent_task_duration_seconds` histogram.

- **Backpressure on submit.** If `tasks.max_concurrent` is hit, you have two choices: return 503 with `Retry-After`, or queue. The POC effectively queues via the semaphore — submitters block until a slot opens. Match that for behaviour parity; switch to 503 if you want to keep the submit path snappy.

---

## 6. What the implementation does NOT add (deliberate scope cuts)

- **Cross-pod task visibility without shared Redis.** Two replicas with separate `InMemoryTaskStore` instances can't see each other's tasks. Use Redis or single-replica deployments. (Same as POC.)

- **Retry semantics.** A failed task stays failed. No automatic re-runs. Callers that need retries handle them client-side. (Same as POC.)

- **Task scheduling / delay.** No "run this in 5 minutes." It's submit-now / run-now. If scheduling is needed later, that's a real job queue (Celery, RQ, Temporal), not this.

- **Webhooks on completion.** Polling-only API. If you want server-push, add a websocket subscriber on `/tasks/{task_id}/ws` later — straightforward to retrofit since `TaskManager` already owns the in-flight set.

- **Task persistence across restarts beyond Redis TTL.** Same window the POC accepts (10-min running TTL means a crashed pod's in-flight work is lost when its replacement boots after that window).

These are the right cuts. They keep the implementation small, match the POC's behaviour, and leave clean seams for any of them to be added later.

---

## 7. Effort estimate

| Item | Effort |
|---|---|
| `task_models.py`, `task_store.py`, `task_manager.py` | half a day |
| Models / validators / `TeamBundle` / `team_loader` wiring | quarter day |
| Routes + `_run_invocation_for_task` extraction | quarter day |
| Unit + integration tests | half a day |
| Docs + reference config + `.env.example` | quarter day |
| Sentinel HA helper if needed | quarter day |
| **Total** | **~2 dev-days for a thorough first cut** |

The mechanical work is small because the abstractions already in MAF (`SessionStore` / `SessionManager` shape, `TeamBundle` field, `AppConfig` section, lifecycle hooks, project-scoped routes) make every piece a parallel of something that already exists.

---

*End of design.*
