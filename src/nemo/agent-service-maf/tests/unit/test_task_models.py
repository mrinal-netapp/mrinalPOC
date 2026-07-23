"""Unit tests for the Task domain model.

Tests cover:

- Default field population (UUID4 ``task_id``, ``RUNNING`` status, timestamps).
- ``is_terminal()`` semantics for every status value.
- ``mark_completed`` / ``mark_failed`` / ``mark_cancelled`` state transitions.
- ``updated_at`` advances on every transition.
- JSON round-trip (model_dump <-> model_validate) since the Redis backend
  relies on this for persistence.
"""

from __future__ import annotations

import time
import uuid

import pytest

from agent_service_maf.core.task_models import Task, TaskStatus


class TestTaskDefaults:
    """Default field values when ``Task()`` is constructed with no args."""

    def test_task_id_is_uuid4(self) -> None:
        task = Task()
        # Will raise if not a valid UUID.
        parsed = uuid.UUID(task.task_id)
        assert parsed.version == 4

    def test_default_status_is_running(self) -> None:
        assert Task().status == TaskStatus.RUNNING

    def test_default_result_is_none(self) -> None:
        assert Task().result is None

    def test_created_and_updated_at_set(self) -> None:
        before = time.time()
        task = Task()
        after = time.time()
        assert before <= task.created_at <= after
        assert before <= task.updated_at <= after

    def test_blank_scope_fields(self) -> None:
        task = Task()
        assert task.project_id == ""
        assert task.team_id == ""
        assert task.agent_id == ""
        assert task.correlation_id == ""


class TestIsTerminal:
    """``is_terminal()`` should be True for COMPLETED / FAILED / CANCELLED only."""

    @pytest.mark.parametrize(
        "status",
        [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED],
    )
    def test_terminal_states(self, status: TaskStatus) -> None:
        task = Task(status=status)
        assert task.is_terminal() is True

    def test_running_is_not_terminal(self) -> None:
        assert Task(status=TaskStatus.RUNNING).is_terminal() is False


class TestStateTransitions:
    """The mark_* helpers should update status, payload, and updated_at."""

    def test_mark_completed_sets_result_and_duration(self) -> None:
        task = Task()
        original_updated = task.updated_at
        time.sleep(0.001)
        task.mark_completed({"output": "ok"}, duration_ms=42)
        assert task.status == TaskStatus.COMPLETED
        assert task.result == {"output": "ok"}
        assert task.duration_ms == 42
        assert task.updated_at > original_updated

    def test_mark_failed_sets_error_and_error_type(self) -> None:
        task = Task()
        original_updated = task.updated_at
        time.sleep(0.001)
        task.mark_failed("boom", error_type="ValueError")
        assert task.status == TaskStatus.FAILED
        assert task.error == "boom"
        assert task.error_type == "ValueError"
        assert task.updated_at > original_updated

    def test_mark_cancelled_uses_reason(self) -> None:
        task = Task()
        original_updated = task.updated_at
        time.sleep(0.001)
        task.mark_cancelled("Cancelled during shutdown")
        assert task.status == TaskStatus.CANCELLED
        assert task.error == "Cancelled during shutdown"
        assert task.updated_at > original_updated

    def test_mark_cancelled_default_reason(self) -> None:
        task = Task()
        task.mark_cancelled()
        assert task.error == "Cancelled by caller"


class TestJsonRoundtrip:
    """The Redis backend stores tasks via ``model_dump`` then
    ``model_validate``. The round trip must preserve every field.
    """

    def test_roundtrip_preserves_fields(self) -> None:
        original = Task(
            project_id="p",
            team_id="t",
            agent_id="a",
            correlation_id="c",
        )
        original.mark_completed({"output": "hi", "duration_ms": 7}, duration_ms=7)

        data = original.model_dump(mode="json")
        revived = Task.model_validate(data)

        assert revived.task_id == original.task_id
        assert revived.status == TaskStatus.COMPLETED
        assert revived.project_id == "p"
        assert revived.team_id == "t"
        assert revived.agent_id == "a"
        assert revived.correlation_id == "c"
        assert revived.result == {"output": "hi", "duration_ms": 7}
        assert revived.duration_ms == 7

    def test_roundtrip_of_failed_task(self) -> None:
        original = Task()
        original.mark_failed("boom", error_type="RuntimeError")
        revived = Task.model_validate(original.model_dump(mode="json"))
        assert revived.status == TaskStatus.FAILED
        assert revived.error == "boom"
        assert revived.error_type == "RuntimeError"
