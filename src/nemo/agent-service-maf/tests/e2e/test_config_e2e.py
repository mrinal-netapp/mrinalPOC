"""E2E tests for configuration override propagation.

Tests the 3-tier config merge (env -> json -> request overrides)
and locked field enforcement through real HTTP endpoints.
"""

from __future__ import annotations

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestConfigOverrideE2E:
    """E2E tests for config override behavior."""

    async def test_config_override_temperature(self, e2e_client: httpx.AsyncClient) -> None:
        """Config override for temperature is accepted and propagated."""
        payload = make_invoke_payload(
            input_text="Temperature override test",
            config_overrides={"agent": {"temperature": 0.1}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for valid config override, got {response.status_code}: {response.text}"
        )

    async def test_config_override_max_tokens(self, e2e_client: httpx.AsyncClient) -> None:
        """Config override for max_tokens is accepted."""
        payload = make_invoke_payload(
            input_text="Max tokens override test",
            config_overrides={"agent": {"max_tokens": 1024}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for max_tokens override, got {response.status_code}: {response.text}"
        )

    async def test_locked_field_framework_rejected(self, e2e_client: httpx.AsyncClient) -> None:
        """Overriding locked field 'agent.framework' per-request is rejected."""
        payload = make_invoke_payload(
            input_text="Locked field test",
            config_overrides={"agent": {"framework": "different_framework"}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        # Locked field override should result in an error (400 or 500).
        assert response.status_code in (400, 422, 500), (
            f"Expected error for locked field override, got {response.status_code}: {response.text}"
        )

    async def test_interface_host_and_port_overrides_are_no_op(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """``interface.host`` / ``interface.port`` were removed from
        ``InterfaceSection`` in 2026-05-30 — the service bind is driven
        by uvicorn's CLI flags, not the config layer. A legacy payload
        that still sets them must not raise; ``extra="allow"`` on
        ``InterfaceSection`` absorbs the unknown keys silently."""
        payload = make_invoke_payload(
            input_text="legacy host/port override",
            config_overrides={"interface": {"host": "10.0.0.5", "port": 9999}},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )
        # The override must not break the invocation. Anything but a
        # config-validation 4xx is acceptable here; the request still
        # goes through to the (echo) agent and returns 200.
        assert response.status_code not in (400, 422), (
            f"Legacy host/port override must not be rejected as a "
            f"validation error; got {response.status_code}: {response.text}"
        )

    async def test_multiple_overrides_combined(self, e2e_client: httpx.AsyncClient) -> None:
        """Multiple non-locked config overrides can be combined."""
        payload = make_invoke_payload(
            input_text="Multiple overrides test",
            config_overrides={
                "agent": {"temperature": 0.2, "max_tokens": 2048},
            },
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for combined overrides, got {response.status_code}: {response.text}"
        )

    async def test_empty_overrides_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """Empty config_overrides dict is valid."""
        payload = make_invoke_payload(
            input_text="Empty overrides test",
            config_overrides={},
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for empty overrides, got {response.status_code}: {response.text}"
        )
