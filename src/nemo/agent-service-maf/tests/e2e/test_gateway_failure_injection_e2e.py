"""E2E test — mock-LLM fail-injection contract.

The e2e audit (#1) flagged gateway-failure propagation as the top
production-risk gap: ``mock-llm`` always returns 200, so prod
outages (Bifrost 5xx, 429 rate-limit, 4xx auth errors) are never
exercised against the framework's full HTTP/SSE/WS routing layer.

This test pins the foundation: the ``mock-llm`` server now exposes a
``POST /admin/fail-next`` admin endpoint that schedules the next N
chat-completion requests to return a configured 4xx/5xx with the
documented error envelope and (for 429) a ``Retry-After`` header.

What this test does NOT cover:
    The full agent-framework→gateway propagation path. The default
    e2e harness uses the ``echo`` framework adapter, which doesn't
    call the LLM gateway — so a fail-injection here doesn't yet
    exercise SSE/WS error-event emission downstream. Wiring a
    real-LLM-calling adapter into a parallel e2e config is the
    follow-up (one of the gaps in the audit's "Top 10 e2e gaps").

What this test DOES cover:
    1. The injection mechanism works: ``count`` requests fail, then
       normal traffic resumes.
    2. The error envelope matches the OpenAI-compatible shape that
       Bifrost / LiteLLM emit, so the framework's error handler can
       map the same shape from mock and from real.
    3. ``Retry-After`` is emitted on 429.
    4. The counter is per-request (not time-based), so tests can
       schedule "fail once, then succeed" predictably.
    5. Input validation: 2xx / 3xx values are rejected — only 4xx/5xx
       are valid fail-injection codes.
"""

from __future__ import annotations

import httpx
import pytest


def _make_completion_body() -> dict:
    return {
        "model": "mock-model",
        "messages": [{"role": "user", "content": "hello"}],
    }


@pytest.mark.e2e
class TestGatewayFailureInjection:
    """Pin the contract of the mock-llm fail-injection mechanism."""

    async def test_admin_fail_next_schedules_500(self, e2e_services: dict) -> None:
        """POST /admin/fail-next with status_code=500 returns scheduled
        failures counter; subsequent chat completion returns 500 with the
        documented error envelope."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Clear any pending failures from prior tests.
            resp = await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 1, "status_code": 500},
            )
            assert resp.status_code == 200
            assert resp.json() == {"scheduled_failures": 1, "status_code": 500}

            # The next chat-completion returns 500.
            resp = await client.post(
                f"{llm_url}/v1/chat/completions",
                json=_make_completion_body(),
            )
            assert resp.status_code == 500
            body = resp.json()
            assert "error" in body, f"500 response must carry an 'error' envelope, got: {body}"
            assert body["error"]["code"] == 500
            assert body["error"]["type"] == "mock_injected_failure"
            assert "injected upstream failure" in body["error"]["message"]

            # The next request after the counter drained returns 200 normally.
            resp = await client.post(
                f"{llm_url}/v1/chat/completions",
                json=_make_completion_body(),
            )
            assert resp.status_code == 200, (
                f"After the scheduled failure drained, traffic must resume normally, got: {resp.status_code}"
            )

    async def test_admin_fail_next_429_includes_retry_after(self, e2e_services: dict) -> None:
        """429 responses must include a Retry-After header so the
        framework can honour exponential-backoff guidance."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 1, "status_code": 429},
            )
            resp = await client.post(
                f"{llm_url}/v1/chat/completions",
                json=_make_completion_body(),
            )

            assert resp.status_code == 429
            assert resp.headers.get("Retry-After") == "1", (
                f"429 must carry Retry-After: 1, got: {resp.headers.get('Retry-After')!r}"
            )
            body = resp.json()
            assert body["error"]["code"] == 429

    async def test_admin_fail_next_counter_decrements_per_request(self, e2e_services: dict) -> None:
        """Scheduling N=3 failures must fail exactly 3 requests, no
        more, no fewer. Locks the counter semantics so tests can
        rely on 'fail once, then succeed'."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 3, "status_code": 503},
            )

            statuses = []
            for _ in range(5):
                resp = await client.post(
                    f"{llm_url}/v1/chat/completions",
                    json=_make_completion_body(),
                )
                statuses.append(resp.status_code)

            assert statuses == [503, 503, 503, 200, 200], (
                f"counter must decrement once per request — first 3 fail, rest succeed; got: {statuses}"
            )

    async def test_admin_fail_next_rejects_non_error_status_codes(self, e2e_services: dict) -> None:
        """status_code must be in [400, 599]. Lets the test catch a
        misconfigured fixture before it pretends a 200 'failure' is
        propagating correctly."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            for bad_code in [200, 301, 600, 100]:
                resp = await client.post(
                    f"{llm_url}/admin/fail-next",
                    json={"count": 1, "status_code": bad_code},
                )
                assert resp.status_code == 400, (
                    f"status_code={bad_code} must be rejected as a 400, got: {resp.status_code}"
                )

    async def test_admin_fail_next_count_zero_clears_pending(self, e2e_services: dict) -> None:
        """Scheduling count=0 must clear any pending failure. Lets
        tests reset the mock between cases without restarting it."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Stage a failure, then immediately clear it.
            await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 5, "status_code": 502},
            )
            await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 0, "status_code": 502},
            )

            # The next request returns 200 — the staged failures were cleared.
            resp = await client.post(
                f"{llm_url}/v1/chat/completions",
                json=_make_completion_body(),
            )
            assert resp.status_code == 200, (
                f"count=0 must clear pending failures, got: {resp.status_code}"
            )

    async def test_failure_response_records_history_for_assertion(self, e2e_services: dict) -> None:
        """Even failed requests must land in /history — so a test
        verifying the framework's retry behaviour can later count
        attempts via GET /history."""
        llm_url = e2e_services["llm_url"]

        async with httpx.AsyncClient(timeout=10.0) as client:
            # Reset history then stage one failure.
            await client.delete(f"{llm_url}/history")
            await client.post(
                f"{llm_url}/admin/fail-next",
                json={"count": 1, "status_code": 500},
            )
            await client.post(
                f"{llm_url}/v1/chat/completions",
                json=_make_completion_body(),
            )

            hist = await client.get(f"{llm_url}/history")
            assert hist.status_code == 200
            data = hist.json()
            assert data["total"] >= 1, (
                "failed request must be recorded in /history so retry counts can be asserted"
            )
