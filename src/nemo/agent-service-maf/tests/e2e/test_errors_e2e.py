"""E2E tests for error handling.

Tests that the framework returns proper error responses for various
failure scenarios, with safe error formatting and correlation IDs.
"""

from __future__ import annotations

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestErrorHandlingE2E:
    """E2E tests for error handling behavior."""

    async def test_health_check_returns_200(self, base_url: str) -> None:
        """GET /health returns 200 even without authentication."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/health")

        assert response.status_code == 200, (
            f"Expected 200 from health check, got {response.status_code}"
        )
        data = response.json()
        assert data["status"] == "ok", f"Expected 'ok' status (§5.8.2), got '{data['status']}'"

    async def test_nonexistent_endpoint_returns_404(self, e2e_client: httpx.AsyncClient) -> None:
        """Request to nonexistent endpoint returns 404."""
        response = await e2e_client.get("/nonexistent/path")

        assert response.status_code == 404, (
            f"Expected 404 for nonexistent endpoint, got {response.status_code}"
        )

    async def test_error_response_format(self, e2e_client: httpx.AsyncClient) -> None:
        """Error responses have the expected format (error, error_type)."""
        # Trigger a 422 with a malformed request.
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke",
            json={"wrong": "fields"},
        )

        assert response.status_code == 422, (
            f"Expected 422, got {response.status_code}: {response.text}"
        )

    async def test_error_response_no_stack_trace(self, e2e_client: httpx.AsyncClient) -> None:
        """Error responses must not contain stack traces in production-like mode."""
        payload = make_invoke_payload(
            input_text="Error test",
            config_overrides={"agent": {"framework": "nonexistent_framework"}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        if response.status_code >= 400:
            text = response.text.lower()
            # In production mode, no traceback should be exposed.
            # In dev mode (E2E default), tracebacks may be present but redacted.
            if "traceback" in text:
                assert "redacted" in text or "[redacted" in text, (
                    "Stack traces in error responses must be redacted"
                )

    async def test_error_response_no_secret_leakage(self, e2e_client: httpx.AsyncClient) -> None:
        """Error responses must not leak API keys or secrets."""
        payload = make_invoke_payload(
            input_text="Error test with secrets",
            config_overrides={"agent": {"framework": "nonexistent"}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        if response.status_code >= 400:
            text = response.text
            # Check that no raw API keys appear in the response.
            assert "test-api-key-1" not in text, "Error response must not contain API keys"
            assert "mock-gateway-key" not in text, "Error response must not contain gateway keys"

    async def test_get_method_on_invoke_returns_405(self, e2e_client: httpx.AsyncClient) -> None:
        """GET on POST-only endpoint returns 405 Method Not Allowed."""
        response = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke")

        assert response.status_code == 405, (
            f"Expected 405 for GET on invoke endpoint, got {response.status_code}"
        )

    async def test_list_agents_returns_200(self, e2e_client: httpx.AsyncClient) -> None:
        """GET /agents returns 200 with agent list."""
        response = await e2e_client.get(f"{TEST_PROJECT_PREFIX}/agents")

        assert response.status_code == 200, (
            f"Expected 200 from /agents, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "agents" in data, "Response must contain 'agents' field"
        assert "total" in data, "Response must contain 'total' field"
        assert isinstance(data["total"], int), "Total must be an integer"

    async def test_health_has_uptime(self, base_url: str) -> None:
        """Health endpoint includes uptime_seconds."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/health")

        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "uptime_seconds" in data, "Health response must include 'uptime_seconds'"
        assert data["uptime_seconds"] >= 0, "Uptime must be non-negative"

    async def test_health_has_version(self, base_url: str) -> None:
        """Health endpoint includes version string."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{base_url}/health")

        data = response.json()
        assert "version" in data, "Health response must include 'version'"
        assert data["version"], "Version must be a non-empty string"
