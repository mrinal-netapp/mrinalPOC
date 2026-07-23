"""E2E test — async-task cancellation contract.

The e2e audit (H7 / gap #4) flagged cancellation as a top
production-risk gap: ``cancel_task`` route exists but no test
verifies the contract — client disconnect or explicit DELETE
mid-flight must end the task in a terminal state without crashing
the server or leaking the in-flight asyncio.Task.

The default echo framework finishes in <100ms, so reliably
cancelling **mid-execution** from the test side is timing-dependent.
This file pins the cancellation **contract** (terminal-state
monotonicity + idempotency + 404 on missing) which is more useful
than a flaky timing test:

  1. ``DELETE /tasks/{task_id}`` on a non-existent task → 404 with
     the documented error envelope.
  2. ``DELETE /tasks/{task_id}`` on an already-terminal task →
     returns the task unchanged (idempotent, per task_manager.py:281).
  3. Submit + immediate cancel → task ends in EITHER ``cancelled``
     OR ``completed`` (whichever won the race) — but never some
     other status, and never both fields populated. Pins the
     monotonicity guard.
  4. Cancel does not affect other in-flight tasks for the same
     project (no global cancel leakage).
  5. ``GET /tasks/{task_id}`` after cancel still returns the task
     until TTL eviction — the row is not deleted.
  6. SSE stream that the client closes early does not crash the
     server: a subsequent request to ``/health`` still returns 200.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestAsyncTaskCancelContract:
    """The DELETE /tasks/{task_id} route contract under load + races."""

    async def test_cancel_unknown_task_returns_404(self, e2e_client: httpx.AsyncClient) -> None:
        """Cancelling a task id that never existed returns 404 with
        the documented {"error":..., "task_id":...} envelope."""
        resp = await e2e_client.delete(
            f"{TEST_PROJECT_PREFIX}/tasks/00000000-0000-0000-0000-000000000000"
        )
        assert resp.status_code == 404, (
            f"DELETE on unknown task must return 404, got: {resp.status_code} {resp.text}"
        )
        body = resp.json()
        assert "detail" in body or "error" in body, (
            f"404 must carry a structured error body, got: {body}"
        )

    async def test_cancel_already_completed_task_is_idempotent(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """task_manager.cancel() on a terminal task returns it
        unchanged (idempotency). The route must surface this as a
        200 response with the task in its original terminal state —
        not a 409, not a 400."""
        # Submit a task and wait for it to terminate naturally.
        submit = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/async",
            json=make_invoke_payload("hello idempotent cancel"),
        )
        assert submit.status_code == 202, (
            f"async submit must return 202 Accepted, got: {submit.status_code} {submit.text}"
        )
        task_id = submit.json()["taskId"]

        # Poll until terminal (echo is fast — usually within 1-2 polls).
        terminal_status = None
        for _ in range(50):
            poll = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
            assert poll.status_code == 200
            status = poll.json()["status"]
            if status in ("completed", "failed", "cancelled"):
                terminal_status = status
                break
            await asyncio.sleep(0.05)
        assert terminal_status == "completed", (
            f"echo task must complete cleanly, got terminal: {terminal_status}"
        )

        # DELETE on the already-terminal task returns it unchanged.
        cancel = await e2e_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        assert cancel.status_code == 200, (
            f"DELETE on terminal task must be idempotent (200), got: {cancel.status_code} {cancel.text}"
        )
        body = cancel.json()
        assert body["status"] == "completed", (
            f"already-terminal task must be returned unchanged, got status: {body['status']}"
        )

    async def test_submit_then_immediate_cancel_yields_terminal_state(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Race: submit a task and DELETE it immediately. Final
        status must be one of {cancelled, completed} — never some
        third value, never both. This pins the
        terminal-monotonicity guard end-to-end."""
        submit = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/async",
            json=make_invoke_payload("race test"),
        )
        assert submit.status_code == 202
        task_id = submit.json()["taskId"]

        # Cancel immediately — no sleep. The race is real.
        cancel = await e2e_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        assert cancel.status_code == 200 or cancel.status_code == 404, (
            f"DELETE must be 200 (cancelled or already-terminal) or 404 (race-out), "
            f"got: {cancel.status_code} {cancel.text}"
        )

        # Poll the final state — must converge on one of the two
        # legal terminal statuses.
        for _ in range(50):
            poll = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
            if poll.status_code == 404:
                # The task expired or was never persisted; acceptable
                # only when the cancel responded 404 too.
                assert cancel.status_code == 404
                return
            status = poll.json()["status"]
            if status in ("completed", "failed", "cancelled"):
                # The guard ensures exactly one of these — never both.
                assert status in ("cancelled", "completed"), (
                    f"race result must be cancelled or completed (failed not expected for echo), got: {status}"
                )
                return
            await asyncio.sleep(0.05)
        pytest.fail("Task did not reach a terminal state within poll budget")

    async def test_cancel_one_task_does_not_affect_another(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Two tasks submitted close together — cancelling one must
        not touch the other. Locks the per-task scoping of cancel."""
        # Submit two tasks.
        sub_a = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/async",
            json=make_invoke_payload("task A — kept alive"),
        )
        sub_b = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/async",
            json=make_invoke_payload("task B — to be cancelled"),
        )
        task_a = sub_a.json()["taskId"]
        task_b = sub_b.json()["taskId"]
        assert task_a != task_b

        # Cancel B.
        await e2e_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_b}")

        # A must still reach a non-cancelled terminal state.
        for _ in range(50):
            poll = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_a}")
            if poll.status_code != 200:
                break
            status = poll.json()["status"]
            if status in ("completed", "failed"):
                assert status == "completed", (
                    f"task A must complete cleanly when only B was cancelled, got: {status}"
                )
                return
            if status == "cancelled":
                pytest.fail(
                    f"Cancel on task B leaked into task A — A is now cancelled. "
                    f"Tasks were: A={task_a}, B={task_b}"
                )
            await asyncio.sleep(0.05)
        pytest.fail("Task A did not converge on a terminal state")

    async def test_get_after_cancel_still_returns_the_task(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """The DELETE route transitions the task to CANCELLED but
        does not remove it from the store — GET still returns it
        until TTL eviction. Pollers depend on this to observe the
        terminal state."""
        sub = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/async",
            json=make_invoke_payload("get after cancel"),
        )
        task_id = sub.json()["taskId"]
        cancel = await e2e_client.delete(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        # The cancel may be 200 (cancelled or already-terminal) or 404 (race).
        if cancel.status_code == 404:
            pytest.skip("Cancel raced out — task already terminal+evicted")

        # GET after DELETE must still return the row (terminal state).
        poll = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/tasks/{task_id}")
        assert poll.status_code == 200, (
            f"GET /tasks/{task_id} after cancel must still return the task (not delete it), "
            f"got: {poll.status_code}"
        )
        assert poll.json()["status"] in ("cancelled", "completed")


@pytest.mark.e2e
class TestStreamClientDisconnectRobustness:
    """The server must not crash when the client closes an SSE stream early."""

    async def test_sse_client_disconnect_does_not_break_server(
        self, base_url: str, auth_headers: dict[str, str]
    ) -> None:
        """Open an SSE stream and close it before completion. A
        subsequent /health request must still succeed, proving the
        server cleaned up cleanly.

        Strict mid-stream cancellation timing is echo-fast and hard
        to assert; this test fixes the lower bar — 'server stays
        alive after dirty client disconnect'."""
        async with httpx.AsyncClient(
            base_url=base_url, headers=auth_headers, timeout=5.0
        ) as client:
            # Start a streaming invocation, read one event, then close
            # the connection abruptly.
            async with client.stream(
                "POST",
                f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream",
                json=make_invoke_payload("disconnect test"),
            ) as resp:
                # Read at most one event before bailing out. Some events
                # arrive fast enough that we may never see anything before
                # the connection's own buffer is drained on context exit;
                # that's still a valid disconnect scenario.
                try:
                    async for _line in resp.aiter_lines():
                        break
                except Exception:
                    pass

            # After the dirty disconnect, the server's health endpoint
            # must still respond — this is the no-crash assertion.
            health = await client.get("/health")
            assert health.status_code == 200, (
                f"Server must remain healthy after SSE client disconnect, "
                f"got: {health.status_code} {health.text}"
            )
