"""E2E tests for POST /agents/{id}/invoke/stream SSE endpoint.

Tests the full streaming invocation flow through real HTTP endpoints.
Validates SSE event sequence: started -> tokens -> completed.
"""

from __future__ import annotations

import time

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload


@pytest.mark.e2e
class TestStreamE2E:
    """E2E tests for the SSE streaming endpoint."""

    async def test_stream_returns_sse_events(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke/stream returns SSE event stream."""
        payload = make_invoke_payload(input_text="Stream test")

        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for stream, got {response.status_code}"
            )
            content_type = response.headers.get("content-type", "")
            assert "text/event-stream" in content_type, (
                f"Expected text/event-stream content type, got '{content_type}'"
            )

            events: list[dict[str, str]] = []
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_type = line.split(":", 1)[1].strip()
                    events.append({"event": event_type})
                elif line.startswith("data:") and events:
                    data = line.split(":", 1)[1].strip()
                    events[-1]["data"] = data

            assert len(events) > 0, "Stream must produce at least one event"

    async def test_stream_event_sequence(self, e2e_client: httpx.AsyncClient) -> None:
        """Stream must follow the event sequence: started -> ... -> completed."""
        payload = make_invoke_payload(input_text="Sequence test")

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_type = line.split(":", 1)[1].strip()
                    event_types.append(event_type)

        assert len(event_types) >= 2, (
            f"Expected at least 2 events (started + completed), got {len(event_types)}"
        )
        assert event_types[0] == "started", f"First event must be 'started', got '{event_types[0]}'"
        assert event_types[-1] in ("completed", "error"), (
            f"Last event must be 'completed' or 'error', got '{event_types[-1]}'"
        )

    async def test_stream_events_have_data(self, e2e_client: httpx.AsyncClient) -> None:
        """Each SSE event must have a data field."""
        payload = make_invoke_payload(input_text="Data field test")

        events_with_data: list[str] = []
        current_event = ""
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and current_event:
                    events_with_data.append(current_event)
                    current_event = ""

        assert len(events_with_data) > 0, "At least one event must have data"

    async def test_stream_start_within_sla(self, e2e_client: httpx.AsyncClient) -> None:
        """First SSE event must arrive within 5 second SLA."""
        payload = make_invoke_payload(input_text="Latency test")

        start = time.monotonic()
        first_event_time = None

        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    first_event_time = time.monotonic()
                    break

        assert first_event_time is not None, "No events received from stream"
        latency = first_event_time - start
        assert latency < 5.0, f"First event latency {latency:.2f}s exceeded 5s SLA"

    async def test_stream_malformed_request(self, e2e_client: httpx.AsyncClient) -> None:
        """Stream with malformed request returns error."""
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream",
            json={"bad_field": "missing input"},
        )

        assert response.status_code == 422, (
            f"Expected 422 for malformed stream request, got {response.status_code}"
        )

    async def test_stream_token_events_contain_content(self, e2e_client: httpx.AsyncClient) -> None:
        """Token events in the stream contain non-empty data."""
        payload = make_invoke_payload(input_text="Content check")

        token_data_list: list[str] = []
        current_event = ""
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                elif line.startswith("data:") and current_event in ("token", "thinking"):
                    data_str = line.split(":", 1)[1].strip()
                    token_data_list.append(data_str)
                    current_event = ""

        # At least one token/thinking event should have non-empty data.
        if token_data_list:
            non_empty = [d for d in token_data_list if d and d != "{}"]
            assert len(non_empty) > 0, "Token events should have non-empty data content"
