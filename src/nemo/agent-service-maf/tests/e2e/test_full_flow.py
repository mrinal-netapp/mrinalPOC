"""End-to-end tests for the full agent invocation flow.

Tests the complete request lifecycle through the real HTTP stack:
request -> config merge -> guardrails -> agent -> response.
"""

from __future__ import annotations

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestFullInvocationFlow:
    """Test the complete flow: request -> config merge -> agent -> response."""

    async def test_invoke_with_config_overrides(self, e2e_client: httpx.AsyncClient) -> None:
        """Full flow: POST with config overrides -> mock agent -> response."""
        payload = make_invoke_payload(
            input_text="E2E full flow test",
            context={"test_mode": True},
            config_overrides={"agent": {"temperature": 0.1}},
            metadata={"test": "e2e"},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/e2e-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for full flow, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["agent_id"] == "e2e-agent", (
            f"Expected agent_id 'e2e-agent', got '{data['agent_id']}'"
        )
        assert data["output"], "Response output must not be empty"

    async def test_health_check(self, base_url: str) -> None:
        """Verify the health endpoint works in E2E context."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/health")

        assert response.status_code == 200, f"Expected 200 from health, got {response.status_code}"
        data = response.json()
        assert data["status"] == "ok", f"Expected 'ok' (§5.8.2), got '{data['status']}'"

    async def test_full_flow_with_streaming(self, e2e_client: httpx.AsyncClient) -> None:
        """Full flow: POST stream -> SSE events -> completed."""
        payload = make_invoke_payload(input_text="Stream full flow test")

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/e2e-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, f"Expected at least 2 events, got {len(event_types)}"
        assert event_types[0] == "started", f"First event must be 'started', got '{event_types[0]}'"

    async def test_full_flow_list_then_invoke(self, e2e_client: httpx.AsyncClient) -> None:
        """List agents, then invoke one -- simulates real client usage."""
        # List agents.
        list_response = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        assert list_response.status_code == 200, (
            f"Expected 200 from /agents, got {list_response.status_code}"
        )

        # Invoke an agent.
        payload = make_invoke_payload(input_text="Client flow test")
        invoke_response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )
        assert invoke_response.status_code == 200, (
            f"Expected 200 from invoke, got {invoke_response.status_code}"
        )
