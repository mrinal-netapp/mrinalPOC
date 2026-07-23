"""Unit tests for the in-memory task store backend.

Redis is covered separately by integration tests against a live Redis
instance. Here we verify the ABC contract via :class:`InMemoryTaskStore`:
save/get round-trip, miss returns None, delete behaviour, and that the
``running`` flag is accepted (ignored, by design, for the in-memory backend).
The :func:`create_task_store` factory is also exercised for invalid backend
strings.
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import InMemoryTaskStore, create_task_store


class TestInMemoryTaskStore:
    """Behaviour of the in-memory backend."""

    async def test_save_and_get_round_trips(self) -> None:
        store = InMemoryTaskStore()
        task = Task(project_id="p", team_id="t", agent_id="a")
        await store.save(task, running=True)

        fetched = await store.get(task.task_id)
        assert fetched is not None
        assert fetched.task_id == task.task_id
        assert fetched.status == TaskStatus.RUNNING

    async def test_get_returns_none_when_unknown(self) -> None:
        store = InMemoryTaskStore()
        assert await store.get("does-not-exist") is None

    async def test_delete_returns_true_only_if_existed(self) -> None:
        store = InMemoryTaskStore()
        task = Task()
        await store.save(task, running=True)
        assert await store.delete(task.task_id) is True
        assert await store.delete(task.task_id) is False

    async def test_running_flag_is_accepted_for_both_values(self) -> None:
        """``running=False`` should overwrite the prior ``running=True`` entry."""
        store = InMemoryTaskStore()
        task = Task()
        await store.save(task, running=True)
        task.mark_completed({"output": "ok"}, duration_ms=1)
        await store.save(task, running=False)
        fetched = await store.get(task.task_id)
        assert fetched is not None
        assert fetched.status == TaskStatus.COMPLETED

    async def test_close_clears_state(self) -> None:
        store = InMemoryTaskStore()
        task = Task()
        await store.save(task, running=True)
        await store.close()
        assert await store.get(task.task_id) is None


class TestFactory:
    """Factory dispatch for backend selection."""

    def test_memory_backend(self) -> None:
        store = create_task_store(backend="memory")
        assert isinstance(store, InMemoryTaskStore)

    def test_unknown_backend_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown task storage backend"):
            create_task_store(backend="postgres")
