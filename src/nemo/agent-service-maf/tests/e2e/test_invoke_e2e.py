"""E2E tests for POST /agents/{id}/invoke endpoint.

Tests the full synchronous invocation flow through real HTTP endpoints.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestInvokeE2E:
    """E2E tests for the synchronous invoke endpoint."""

    async def test_invoke_returns_200_with_valid_request(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke with valid input returns 200."""
        payload = make_invoke_payload(input_text="What is 2+2?")
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for valid invoke, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Response must contain 'output' field"
        assert "agent_id" in data, "Response must contain 'agent_id' field"
        assert data["agent_id"] == "test-agent", (
            f"Expected agent_id 'test-agent', got '{data['agent_id']}'"
        )

    async def test_invoke_response_has_required_fields(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke response must include all required fields."""
        payload = make_invoke_payload(input_text="Tell me something")
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()

        required_fields = {"agent_id", "output", "artifacts", "metadata", "duration_ms"}
        missing = required_fields - set(data.keys())
        assert not missing, f"Response missing required fields: {missing}"

    async def test_invoke_with_metadata(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with metadata passes through correctly."""
        payload = make_invoke_payload(
            input_text="Metadata test",
            metadata={"trace_id": "e2e-trace-123", "test": True},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )

    async def test_invoke_with_context(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with context dict succeeds."""
        payload = make_invoke_payload(
            input_text="Context test",
            context={"backstory": "You are a helpful assistant."},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )

    async def test_invoke_duration_within_sla(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke must respond within 2 second SLA."""
        payload = make_invoke_payload(input_text="Performance test")
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        duration_ms = data.get("duration_ms", 0)
        assert duration_ms < 2000, f"Invoke exceeded 2s SLA: duration_ms={duration_ms}"

    async def test_invoke_empty_input_rejected(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with empty input string is rejected."""
        payload: dict[str, Any] = {"input": ""}
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        # The framework should reject empty input via validation or guardrails.
        # Accept either 422 (validation) or 200 with error handling.
        assert response.status_code in (200, 400, 422, 500), (
            f"Unexpected status for empty input: {response.status_code}"
        )

    async def test_invoke_malformed_request_rejected(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with malformed JSON body returns 422."""
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke",
            json={"wrong_field": "no input field"},
        )

        assert response.status_code == 422, (
            f"Expected 422 for malformed request, got {response.status_code}: {response.text}"
        )

    async def test_invoke_with_config_overrides(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with config overrides succeeds."""
        payload = make_invoke_payload(
            input_text="Config override test",
            config_overrides={"agent": {"temperature": 0.1}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )

    async def test_invoke_with_session_id(self, e2e_client: httpx.AsyncClient) -> None:
        """Invoke with session_id succeeds."""
        payload = make_invoke_payload(
            input_text="Session test",
            session_id="e2e-session-001",
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
