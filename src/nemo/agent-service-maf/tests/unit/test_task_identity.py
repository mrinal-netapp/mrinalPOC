"""Unit tests for §D1/D2/D3 — Task carries identity but never serializes it.

Covers test plan item I4 — the async task lifecycle re-binds the
ContextVar from the captured identity at runner entry and erases it on
exit, with strict non-serialization of the carried identity / user JWT.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from agent_service_maf.core.identity import (
    IdentityContext,
    get_current_identity,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.core.task_models import Task, TaskStatus


def _make_task(*, identity: IdentityContext | None = None, task_id: str = "task-1") -> Task:
    return Task(
        task_id=task_id,
        status=TaskStatus.RUNNING,
        team_id="team-A",
        agent_id="agent-1",
        project_id="proj-A",
        identity=identity,
    )


# ---------------------------------------------------------------------------
# §D3 -- Task.identity (and Task.identity.user_token) never serialized
# ---------------------------------------------------------------------------


class TestTaskIdentityNotSerialized:
    def test_model_dump_excludes_identity(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="proj-A",
            user_token="raw-jwt-token-secret",
        )
        task = _make_task(identity=identity)
        dump = task.model_dump()
        assert "identity" not in dump
        # And the JWT is definitely not anywhere in the dump.
        assert "raw-jwt-token-secret" not in json.dumps(dump, default=str)

    def test_model_dump_json_excludes_identity_and_token(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="proj-A",
            user_email="alice@example.com",
            user_token="raw-jwt-token-secret",
        )
        task = _make_task(identity=identity)
        blob = task.model_dump_json()
        assert "raw-jwt-token-secret" not in blob
        assert '"identity"' not in blob

    def test_repr_does_not_leak_identity(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            user_token="raw-jwt-token-secret",
        )
        task = _make_task(identity=identity)
        r = repr(task)
        # repr=False on the field means it's not in __repr__.
        assert "raw-jwt-token-secret" not in r
        assert "identity=" not in r

    def test_identity_accessible_via_typed_attribute(self) -> None:
        identity = IdentityContext(user_id="alice", user_token="raw-jwt")
        task = _make_task(identity=identity)
        assert task.identity is identity
        # Typed accessor still gives the JWT for transport-layer use.
        assert task.identity.user_token == "raw-jwt"


# ---------------------------------------------------------------------------
# §D1+D2 -- runner pattern re-binds and resets the identity ContextVar
# ---------------------------------------------------------------------------


class TestRunnerIdentityRebind:
    """The routes.py async-task runner wrap follows this exact shape:

        async def runner(t: Task) -> dict[str, Any]:
            tok = set_current_identity(t.identity) if t.identity is not None else None
            try:
                return await _run_invocation_for_task(...)
            finally:
                if tok is not None:
                    reset_current_identity(tok)

    This test exercises that pattern directly so it stays correct even
    if the routes.py call site moves.
    """

    async def test_runner_binds_task_identity_during_invocation(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        task = _make_task(identity=identity)
        seen: list[IdentityContext | None] = []

        async def inner_invocation() -> None:
            seen.append(get_current_identity())

        async def runner(t: Task) -> None:
            tok = set_current_identity(t.identity) if t.identity is not None else None
            try:
                await inner_invocation()
            finally:
                if tok is not None:
                    reset_current_identity(tok)

        # The outer (request) ContextVar is empty.
        assert get_current_identity() is None
        await runner(task)
        # The runner-bound identity is visible to inner_invocation.
        assert seen == [identity]
        # The outer ContextVar is restored after the runner finishes.
        assert get_current_identity() is None

    async def test_two_concurrent_tasks_see_distinct_identities(self) -> None:
        """§I3 mirror at the task layer -- runners on the same loop don't leak."""
        identity_alice = IdentityContext(user_id="alice", project_id="p1")
        identity_bob = IdentityContext(user_id="bob", project_id="p2")
        task_alice = _make_task(identity=identity_alice, task_id="t-alice")
        task_bob = _make_task(identity=identity_bob, task_id="t-bob")

        async def runner(t: Task, seen: list[str]) -> None:
            tok = set_current_identity(t.identity) if t.identity is not None else None
            try:
                await asyncio.sleep(0)
                current = get_current_identity()
                assert current is not None
                seen.append(current.user_id)
            finally:
                if tok is not None:
                    reset_current_identity(tok)

        seen_a: list[str] = []
        seen_b: list[str] = []
        await asyncio.gather(
            runner(task_alice, seen_a),
            runner(task_bob, seen_b),
        )
        assert seen_a == ["alice"]
        assert seen_b == ["bob"]

    async def test_runner_with_no_identity_passes_through(self) -> None:
        """Task.identity=None -> no rebind, no error."""
        task = _make_task(identity=None)
        seen: list[IdentityContext | None] = []

        async def runner(t: Task) -> None:
            tok = set_current_identity(t.identity) if t.identity is not None else None
            try:
                seen.append(get_current_identity())
            finally:
                if tok is not None:
                    reset_current_identity(tok)

        # Pre-bind an unrelated identity to prove the runner did NOT touch it.
        outer = IdentityContext(user_id="outer-user")
        outer_tok = set_current_identity(outer)
        try:
            await runner(task)
        finally:
            reset_current_identity(outer_tok)

        assert seen == [outer], "runner clobbered the outer identity when Task.identity was None"

    async def test_runner_resets_identity_on_exception(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="proj-A")
        task = _make_task(identity=identity)

        async def runner(t: Task) -> None:
            tok = set_current_identity(t.identity) if t.identity is not None else None
            try:
                raise RuntimeError("boom")
            finally:
                if tok is not None:
                    reset_current_identity(tok)

        with pytest.raises(RuntimeError, match="boom"):
            await runner(task)
        # Outer ContextVar still clean after the exception path.
        assert get_current_identity() is None
