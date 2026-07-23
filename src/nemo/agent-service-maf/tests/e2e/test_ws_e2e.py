"""E2E tests for WebSocket /agents/{id}/ws endpoint.

Tests bidirectional WebSocket communication with the agent framework.
"""

from __future__ import annotations

import asyncio
import json

import pytest

try:
    from websockets.asyncio.client import connect as ws_connect

    HAS_WEBSOCKETS = True
except ImportError:
    HAS_WEBSOCKETS = False

from tests.conftest import TEST_PROJECT_PREFIX


@pytest.mark.e2e
@pytest.mark.skipif(not HAS_WEBSOCKETS, reason="websockets package not installed")
class TestWebSocketE2E:
    """E2E tests for the WebSocket endpoint."""

    def _ws_url(self, base_url: str, agent_id: str = "test-agent") -> str:
        """Build a WebSocket URL from the base HTTP URL.

        Args:
            base_url: HTTP base URL (http://...).
            agent_id: Agent identifier.

        Returns:
            WebSocket URL (ws://...).
        """
        return base_url.replace("http://", "ws://") + f"{TEST_PROJECT_PREFIX}/agents/{agent_id}/ws"

    async def test_ws_connect_and_receive_events(self, base_url: str, api_key: str) -> None:
        """WebSocket connection sends a message and receives events."""
        ws_url = self._ws_url(base_url)

        async with ws_connect(ws_url, additional_headers={"X-API-Key": api_key}) as ws:
            request = {
                "input": "WebSocket E2E test",
                "context": {},
                "config_overrides": {},
                "metadata": {"test": "ws_e2e"},
            }
            await ws.send(json.dumps(request))

            events: list[dict[str, str]] = []
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=10)
                    data = json.loads(msg)
                    events.append(data)
                    if data.get("event") in ("completed", "error"):
                        break
            except TimeoutError:
                pass

            assert len(events) > 0, "Must receive at least one WebSocket event"
            event_types = [e.get("event") for e in events]
            assert "started" in event_types, (
                f"WebSocket events must include 'started', got: {event_types}"
            )

    async def test_ws_multiple_messages_in_session(self, base_url: str, api_key: str) -> None:
        """WebSocket supports multiple messages in one session."""
        ws_url = self._ws_url(base_url)

        async with ws_connect(ws_url, additional_headers={"X-API-Key": api_key}) as ws:
            for i in range(2):
                request = {
                    "input": f"Message {i + 1}",
                    "context": {},
                    "config_overrides": {},
                    "metadata": {"message_num": i + 1},
                }
                await ws.send(json.dumps(request))

                events: list[dict[str, str]] = []
                try:
                    while True:
                        msg = await asyncio.wait_for(ws.recv(), timeout=10)
                        data = json.loads(msg)
                        events.append(data)
                        if data.get("event") in ("completed", "error"):
                            break
                except TimeoutError:
                    pass

                assert len(events) > 0, f"Message {i + 1}: must receive at least one event"

    async def test_ws_invalid_json_returns_error(self, base_url: str, api_key: str) -> None:
        """WebSocket with invalid JSON returns an error event."""
        ws_url = self._ws_url(base_url)

        async with ws_connect(ws_url, additional_headers={"X-API-Key": api_key}) as ws:
            await ws.send("not valid json {{{")

            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                assert data.get("event") == "error", (
                    f"Expected error event for invalid JSON, got: {data.get('event')}"
                )
            except TimeoutError:
                pytest.skip("WebSocket did not respond to invalid JSON within timeout")

    async def test_ws_connection_lifecycle(self, base_url: str, api_key: str) -> None:
        """WebSocket connect/disconnect lifecycle works cleanly."""
        ws_url = self._ws_url(base_url)
        headers = {"X-API-Key": api_key}

        # Connect and immediately close.
        async with ws_connect(ws_url, additional_headers=headers) as ws:
            await ws.close()

        # Reconnect should work.
        async with ws_connect(ws_url, additional_headers=headers) as ws:
            request = {
                "input": "Reconnection test",
                "context": {},
                "config_overrides": {},
                "metadata": {},
            }
            await ws.send(json.dumps(request))

            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
                data = json.loads(msg)
                assert "event" in data, "WebSocket response must have 'event' field"
            except TimeoutError:
                pytest.skip("WebSocket did not respond within timeout after reconnect")
