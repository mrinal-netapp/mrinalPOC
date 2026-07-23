"""E2E tests for ENH-003 MAF Pattern Alignment orchestration features.

Exercises the orchestration-related HTTP endpoints through the full stack:
graph orchestration, new termination strategies (keyword, approval, timeout),
new selection strategies (round_robin, auto, candidate_agents), sequential
with agent_order, handoff to human, and streaming for new orchestration types.

These tests run against the E2E HTTP stack. Because the default E2E stack uses
the ``echo`` framework (which does not execute orchestration logic), tests verify
that the API layer correctly accepts orchestration-related config overrides in
the ``semantic_kernel`` section, returns well-formed responses, and does not
reject valid orchestration configurations. Behavioral orchestration logic is
validated by unit and integration tests under ``tests/unit/`` and
``tests/integration/``.

When the E2E stack is configured with the ``semantic_kernel`` framework (and a
functioning gateway), the same tests will exercise the full orchestration
runtime end-to-end.
"""

from __future__ import annotations

import time
from typing import Any

import httpx
import pytest

from tests.conftest import TEST_PROJECT_PREFIX
from tests.e2e.conftest import make_invoke_payload

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sk_group_chat_overrides(
    selection_type: str = "sequential",
    termination_type: str = "default",
    max_rounds: int = 3,
    extra_selection: dict[str, Any] | None = None,
    extra_termination: dict[str, Any] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build config_overrides for a group_chat orchestration.

    Args:
        selection_type: Selection strategy type.
        termination_type: Termination strategy type.
        max_rounds: Maximum orchestration rounds.
        extra_selection: Additional fields for selection_strategy.
        extra_termination: Additional fields for termination_strategy.
        agents: Agent definitions (defaults to two test agents).

    Returns:
        Config overrides dict targeting semantic_kernel section.
    """
    selection: dict[str, Any] = {"type": selection_type}
    if extra_selection:
        selection.update(extra_selection)

    termination: dict[str, Any] = {"type": termination_type, "maximum_iterations": max_rounds}
    if extra_termination:
        termination.update(extra_termination)

    if agents is None:
        agents = [
            {"name": "agent_a", "instructions": "You are agent A."},
            {"name": "agent_b", "instructions": "You are agent B."},
        ]

    return {
        "semantic_kernel": {
            "agents": agents,
            "orchestration": {
                "type": "group_chat",
                "max_rounds": max_rounds,
                "selection_strategy": selection,
                "termination_strategy": termination,
            },
        },
    }


def _sk_sequential_overrides(
    agent_order: list[str] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build config_overrides for sequential orchestration with agent_order.

    Args:
        agent_order: Custom agent execution order.
        agents: Agent definitions.

    Returns:
        Config overrides dict.
    """
    if agents is None:
        agents = [
            {"name": "writer", "instructions": "You are a writer."},
            {"name": "reviewer", "instructions": "You are a reviewer."},
            {"name": "editor", "instructions": "You are an editor."},
        ]

    orch: dict[str, Any] = {"type": "sequential", "max_rounds": 5}
    if agent_order:
        orch["agent_order"] = agent_order

    return {
        "semantic_kernel": {
            "agents": agents,
            "orchestration": orch,
        },
    }


def _sk_graph_overrides(
    edges: list[dict[str, str]] | None = None,
    agents: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build config_overrides for graph orchestration.

    Args:
        edges: Directed edges between agents.
        agents: Agent definitions.

    Returns:
        Config overrides dict.
    """
    if agents is None:
        agents = [
            {"name": "planner", "instructions": "You plan tasks."},
            {"name": "executor", "instructions": "You execute tasks."},
            {"name": "verifier", "instructions": "You verify results."},
        ]

    if edges is None:
        edges = [
            {"source": "planner", "target": "executor"},
            {"source": "executor", "target": "verifier"},
        ]

    return {
        "semantic_kernel": {
            "agents": agents,
            "orchestration": {
                "type": "graph",
                "max_rounds": 10,
                "edges": edges,
                "selection_strategy": {"type": "sequential", "initial_agent": "planner"},
            },
        },
    }


def _sk_handoff_overrides(
    target: str = "__human__",
) -> dict[str, Any]:
    """Build config_overrides for handoff orchestration with a human target.

    Args:
        target: Handoff target agent name.

    Returns:
        Config overrides dict.
    """
    return {
        "semantic_kernel": {
            "agents": [
                {"name": "assistant", "instructions": "You are an assistant."},
                {"name": "specialist", "instructions": "You are a specialist."},
            ],
            "orchestration": {
                "type": "handoff",
                "max_rounds": 5,
                "handoffs": [
                    {"source": "assistant", "target": "specialist", "description": "Escalate"},
                    {"source": "specialist", "target": target, "description": "Hand off to human"},
                ],
                "termination_strategy": {"type": "default", "maximum_iterations": 5},
            },
        },
    }


# ===========================================================================
# 1. Graph orchestration via HTTP
# ===========================================================================


@pytest.mark.e2e
class TestGraphOrchestrationE2E:
    """E2E tests for graph orchestration (ENH-003 Task G.1/G.2)."""

    async def test_invoke_with_graph_orchestration_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke with graph orchestration config returns 200."""
        payload = make_invoke_payload(
            input_text="Plan and execute a task using the graph",
            config_overrides=_sk_graph_overrides(),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for graph orchestration invoke, got {response.status_code}: "
            f"{response.text}"
        )
        data = response.json()
        assert "output" in data, "Graph orchestration response must contain 'output' field"
        assert data["output"], "Graph orchestration response output must not be empty"

    async def test_invoke_graph_with_custom_edges(self, e2e_client: httpx.AsyncClient) -> None:
        """Graph orchestration with custom edge topology is accepted."""
        agents = [
            {"name": "start", "instructions": "Start node."},
            {"name": "middle", "instructions": "Middle node."},
            {"name": "end", "instructions": "End node."},
        ]
        edges = [
            {"source": "start", "target": "middle"},
            {"source": "middle", "target": "end"},
        ]
        payload = make_invoke_payload(
            input_text="Traverse the custom graph",
            config_overrides=_sk_graph_overrides(edges=edges, agents=agents),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for custom graph edges, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Response must include 'output' for graph with custom edges"

    async def test_stream_with_graph_orchestration(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke/stream with graph orchestration returns SSE events."""
        payload = make_invoke_payload(
            input_text="Stream through graph nodes",
            config_overrides=_sk_graph_overrides(),
        )

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for graph stream, got {response.status_code}"
            )
            content_type = response.headers.get("content-type", "")
            assert "text/event-stream" in content_type, (
                f"Expected text/event-stream, got '{content_type}'"
            )
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, (
            f"Graph stream must produce at least 2 events (started + completed), "
            f"got {len(event_types)}: {event_types}"
        )
        assert event_types[0] == "started", (
            f"First graph stream event must be 'started', got '{event_types[0]}'"
        )
        assert event_types[-1] in ("completed", "error"), (
            f"Last graph stream event must be 'completed' or 'error', got '{event_types[-1]}'"
        )

    async def test_invoke_graph_response_within_sla(self, e2e_client: httpx.AsyncClient) -> None:
        """Graph orchestration invoke must respond within 2 second SLA."""
        payload = make_invoke_payload(
            input_text="Graph SLA test",
            config_overrides=_sk_graph_overrides(),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        duration_ms = data.get("duration_ms", 0)
        assert duration_ms < 2000, f"Graph invoke exceeded 2s SLA: duration_ms={duration_ms}"


# ===========================================================================
# 2. New termination strategies via HTTP
# ===========================================================================


@pytest.mark.e2e
class TestTerminationStrategiesE2E:
    """E2E tests for keyword, approval, and timeout termination (ENH-003 T.1-T.3)."""

    async def test_invoke_keyword_termination_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke with keyword termination config returns 200."""
        payload = make_invoke_payload(
            input_text="Discuss until consensus is reached",
            config_overrides=_sk_group_chat_overrides(
                termination_type="keyword",
                extra_termination={"keywords": ["CONSENSUS REACHED", "DONE"]},
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for keyword termination, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Keyword termination response must contain 'output'"

    async def test_invoke_keyword_termination_case_insensitive_config(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Keyword termination config with mixed-case keywords is accepted."""
        payload = make_invoke_payload(
            input_text="Work on this until done",
            config_overrides=_sk_group_chat_overrides(
                termination_type="keyword",
                extra_termination={"keywords": ["Final Answer", "COMPLETE", "done"]},
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for case-insensitive keyword config, "
            f"got {response.status_code}: {response.text}"
        )

    async def test_invoke_approval_termination_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke with approval termination config returns 200."""
        payload = make_invoke_payload(
            input_text="Prepare a report for approval",
            config_overrides=_sk_group_chat_overrides(
                termination_type="approval",
                extra_termination={"agents": ["agent_b"]},
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for approval termination, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Approval termination response must contain 'output'"

    async def test_invoke_timeout_termination_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke with timeout termination config returns 200."""
        payload = make_invoke_payload(
            input_text="Discuss briefly with timeout",
            config_overrides=_sk_group_chat_overrides(
                termination_type="timeout",
                extra_termination={"timeout_seconds": 10.0},
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for timeout termination, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Timeout termination response must contain 'output'"

    async def test_invoke_timeout_termination_has_valid_duration(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Timeout termination response completes within configured timeout + buffer."""
        timeout_seconds = 15.0
        payload = make_invoke_payload(
            input_text="Timeout duration check",
            config_overrides=_sk_group_chat_overrides(
                termination_type="timeout",
                extra_termination={"timeout_seconds": timeout_seconds},
            ),
        )
        start = time.monotonic()
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )
        elapsed = time.monotonic() - start

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        # Response should not take longer than timeout + reasonable buffer.
        assert elapsed < timeout_seconds + 5.0, (
            f"Response took {elapsed:.2f}s which exceeds timeout of {timeout_seconds}s + 5s buffer"
        )

    async def test_invoke_aggregator_keyword_and_timeout(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Aggregator termination combining keyword and timeout is accepted."""
        payload = make_invoke_payload(
            input_text="Compound termination test",
            config_overrides=_sk_group_chat_overrides(
                termination_type="aggregator",
                extra_termination={
                    "condition": "any",
                    "sub_strategies": [
                        {"type": "keyword", "keywords": ["DONE"], "maximum_iterations": 5},
                        {"type": "timeout", "timeout_seconds": 30.0, "maximum_iterations": 5},
                    ],
                },
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for aggregator termination, got {response.status_code}: {response.text}"
        )


# ===========================================================================
# 3. New selection strategies via HTTP
# ===========================================================================


@pytest.mark.e2e
class TestSelectionStrategiesE2E:
    """E2E tests for round_robin, auto, and candidate_agents selection (ENH-003 S.1-S.3)."""

    async def test_invoke_round_robin_selection_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke with round_robin selection returns 200."""
        payload = make_invoke_payload(
            input_text="Discuss in round robin order",
            config_overrides=_sk_group_chat_overrides(selection_type="round_robin"),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for round_robin selection, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Round-robin selection response must contain 'output'"

    async def test_invoke_auto_selection_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke with auto selection returns 200."""
        payload = make_invoke_payload(
            input_text="Auto-select the best agent to speak",
            config_overrides=_sk_group_chat_overrides(selection_type="auto"),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for auto selection, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Auto selection response must contain 'output'"

    async def test_invoke_auto_selection_with_prompt(self, e2e_client: httpx.AsyncClient) -> None:
        """Auto selection with function_prompt falls back to LLM-based selection."""
        payload = make_invoke_payload(
            input_text="Auto-select with a custom prompt",
            config_overrides=_sk_group_chat_overrides(
                selection_type="auto",
                extra_selection={
                    "function_prompt": "Pick the agent with the most relevant expertise.",
                },
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for auto selection with prompt, "
            f"got {response.status_code}: {response.text}"
        )

    async def test_invoke_candidate_agents_filtering_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Config with candidate_agents restricting eligible agents is accepted."""
        agents = [
            {"name": "agent_a", "instructions": "You are agent A."},
            {"name": "agent_b", "instructions": "You are agent B."},
            {"name": "agent_c", "instructions": "You are agent C."},
        ]
        payload = make_invoke_payload(
            input_text="Only let A and C participate",
            config_overrides=_sk_group_chat_overrides(
                selection_type="round_robin",
                extra_selection={"candidate_agents": ["agent_a", "agent_c"]},
                agents=agents,
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for candidate_agents filtering, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Candidate_agents filtered response must contain 'output'"

    async def test_invoke_empty_candidate_agents_uses_all(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Empty candidate_agents list means all agents are eligible (default)."""
        payload = make_invoke_payload(
            input_text="All agents eligible",
            config_overrides=_sk_group_chat_overrides(
                selection_type="kernel_function",
                extra_selection={
                    "candidate_agents": [],
                    "function_prompt": "Choose the most relevant agent.",
                },
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for empty candidate_agents, got {response.status_code}: {response.text}"
        )


# ===========================================================================
# 4. Sequential with agent_order via HTTP
# ===========================================================================


@pytest.mark.e2e
class TestSequentialAgentOrderE2E:
    """E2E tests for sequential orchestration with agent_order (ENH-003 Q.1)."""

    async def test_invoke_sequential_with_custom_order_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke with sequential + custom agent_order returns 200."""
        payload = make_invoke_payload(
            input_text="Execute in custom order: reviewer then writer then editor",
            config_overrides=_sk_sequential_overrides(
                agent_order=["reviewer", "writer", "editor"],
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for sequential with custom agent_order, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Sequential agent_order response must contain 'output'"

    async def test_invoke_sequential_without_order_uses_definition_order(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Sequential without agent_order uses definition order (default behavior)."""
        payload = make_invoke_payload(
            input_text="Execute in definition order",
            config_overrides=_sk_sequential_overrides(agent_order=None),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for sequential without agent_order, "
            f"got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Sequential default order response must contain 'output'"

    async def test_invoke_sequential_partial_order_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Sequential with partial agent_order (subset of agents) is accepted."""
        payload = make_invoke_payload(
            input_text="Execute only editor then writer",
            config_overrides=_sk_sequential_overrides(
                agent_order=["editor", "writer"],
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for partial agent_order, got {response.status_code}: {response.text}"
        )


# ===========================================================================
# 5. Handoff to human via HTTP
# ===========================================================================


@pytest.mark.e2e
class TestHandoffToHumanE2E:
    """E2E tests for handoff orchestration targeting __human__ (ENH-003 H.1)."""

    async def test_invoke_handoff_to_human_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke with handoff to __human__ returns 200."""
        payload = make_invoke_payload(
            input_text="I need to speak with a human please",
            config_overrides=_sk_handoff_overrides(target="__human__"),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for handoff to human, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Handoff-to-human response must contain 'output'"

    async def test_invoke_handoff_to_user_alias_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Handoff targeting 'user' alias (synonym for __human__) is accepted."""
        payload = make_invoke_payload(
            input_text="Escalate to user",
            config_overrides=_sk_handoff_overrides(target="user"),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for handoff to 'user', got {response.status_code}: {response.text}"
        )

    async def test_invoke_handoff_normal_delegation_accepted(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Normal handoff between agents (not to human) is accepted."""
        overrides = {
            "semantic_kernel": {
                "agents": [
                    {"name": "triage", "instructions": "Route requests."},
                    {"name": "billing", "instructions": "Handle billing."},
                ],
                "orchestration": {
                    "type": "handoff",
                    "max_rounds": 5,
                    "handoffs": [
                        {
                            "source": "triage",
                            "target": "billing",
                            "description": "Route to billing",
                        },
                    ],
                    "termination_strategy": {
                        "type": "default",
                        "maximum_iterations": 5,
                    },
                },
            },
        }
        payload = make_invoke_payload(
            input_text="I have a billing question",
            config_overrides=overrides,
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for normal handoff, got {response.status_code}: {response.text}"
        )

    async def test_invoke_handoff_response_has_required_fields(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Handoff response includes all standard response fields."""
        payload = make_invoke_payload(
            input_text="Check handoff response structure",
            config_overrides=_sk_handoff_overrides(target="__human__"),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        required_fields = {"agent_id", "output"}
        missing = required_fields - set(data.keys())
        assert not missing, (
            f"Handoff response missing required fields: {missing}. "
            f"Available fields: {sorted(data.keys())}"
        )


# ===========================================================================
# 6. Streaming for new orchestration types
# ===========================================================================


@pytest.mark.e2e
class TestOrchestrationStreamingE2E:
    """E2E tests for SSE streaming with new orchestration types."""

    async def test_stream_group_chat_with_keyword_termination(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """POST /agents/test-agent/invoke/stream with group_chat + keyword termination returns SSE."""
        payload = make_invoke_payload(
            input_text="Stream a group chat until DONE keyword",
            config_overrides=_sk_group_chat_overrides(
                termination_type="keyword",
                extra_termination={"keywords": ["DONE", "FINISHED"]},
            ),
        )

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for group_chat stream, got {response.status_code}"
            )
            content_type = response.headers.get("content-type", "")
            assert "text/event-stream" in content_type, (
                f"Expected text/event-stream content type, got '{content_type}'"
            )
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, (
            f"Group chat stream must produce at least 2 events, "
            f"got {len(event_types)}: {event_types}"
        )
        assert event_types[0] == "started", f"First event must be 'started', got '{event_types[0]}'"

    async def test_stream_graph_orchestration_events(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/test-agent/invoke/stream with graph orchestration produces SSE events."""
        payload = make_invoke_payload(
            input_text="Stream graph node execution",
            config_overrides=_sk_graph_overrides(),
        )

        events: list[dict[str, str]] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for graph stream, got {response.status_code}"
            )
            current_event: dict[str, str] = {}
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    if current_event:
                        events.append(current_event)
                    current_event = {"event": line.split(":", 1)[1].strip()}
                elif line.startswith("data:") and current_event:
                    current_event["data"] = line.split(":", 1)[1].strip()
                elif line == "" and current_event:
                    events.append(current_event)
                    current_event = {}
            if current_event:
                events.append(current_event)

        assert len(events) >= 1, f"Graph stream must produce at least 1 event, got {len(events)}"

    async def test_stream_sequential_with_agent_order(self, e2e_client: httpx.AsyncClient) -> None:
        """Streaming sequential orchestration with custom agent_order works."""
        payload = make_invoke_payload(
            input_text="Stream sequential with custom order",
            config_overrides=_sk_sequential_overrides(
                agent_order=["editor", "reviewer", "writer"],
            ),
        )

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for sequential stream, got {response.status_code}"
            )
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, (
            f"Sequential stream must produce at least 2 events, "
            f"got {len(event_types)}: {event_types}"
        )

    async def test_stream_round_robin_group_chat(self, e2e_client: httpx.AsyncClient) -> None:
        """Streaming group_chat with round_robin selection produces events."""
        payload = make_invoke_payload(
            input_text="Stream round-robin discussion",
            config_overrides=_sk_group_chat_overrides(selection_type="round_robin"),
        )

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for round_robin stream, got {response.status_code}"
            )
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, (
            f"Round-robin stream must produce at least 2 events, "
            f"got {len(event_types)}: {event_types}"
        )

    async def test_stream_start_within_sla_for_orchestration(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """First SSE event for orchestration stream must arrive within 5 second SLA."""
        payload = make_invoke_payload(
            input_text="Latency test for orchestrated stream",
            config_overrides=_sk_group_chat_overrides(selection_type="round_robin"),
        )

        start = time.monotonic()
        first_event_time: float | None = None

        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, f"Expected 200, got {response.status_code}"
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    first_event_time = time.monotonic()
                    break

        assert first_event_time is not None, "No SSE events received from orchestrated stream"
        latency = first_event_time - start
        assert latency < 5.0, (
            f"First event latency {latency:.2f}s exceeded 5s SLA for orchestrated stream"
        )


# ===========================================================================
# 7. Agent-less orchestrated endpoints
# ===========================================================================


@pytest.mark.e2e
class TestAgentlessOrchestrationE2E:
    """E2E tests for POST /agents/invoke and /agents/invoke/stream (no agent_id)."""

    async def test_agentless_invoke_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/invoke (no agent_id) returns 200."""
        payload = make_invoke_payload(
            input_text="Agent-less orchestrated invocation",
        )
        response = await e2e_client.post(f"{TEST_PROJECT_PREFIX}/agents/invoke", json=payload)

        assert response.status_code == 200, (
            f"Expected 200 for agent-less invoke, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert "output" in data, "Agent-less invoke response must contain 'output'"

    async def test_agentless_invoke_with_orchestration_config(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Agent-less invoke with orchestration config overrides is accepted."""
        payload = make_invoke_payload(
            input_text="Agent-less with group_chat config",
            config_overrides=_sk_group_chat_overrides(selection_type="round_robin"),
        )
        response = await e2e_client.post(f"{TEST_PROJECT_PREFIX}/agents/invoke", json=payload)

        assert response.status_code == 200, (
            f"Expected 200 for agent-less invoke with overrides, "
            f"got {response.status_code}: {response.text}"
        )

    async def test_agentless_stream_accepted(self, e2e_client: httpx.AsyncClient) -> None:
        """POST /agents/invoke/stream (no agent_id) returns SSE events."""
        payload = make_invoke_payload(
            input_text="Agent-less orchestrated stream",
        )

        event_types: list[str] = []
        async with e2e_client.stream(
            "POST", f"{TEST_PROJECT_PREFIX}/agents/invoke/stream", json=payload
        ) as response:
            assert response.status_code == 200, (
                f"Expected 200 for agent-less stream, got {response.status_code}"
            )
            async for line in response.aiter_lines():
                if line.startswith("event:"):
                    event_types.append(line.split(":", 1)[1].strip())

        assert len(event_types) >= 2, (
            f"Agent-less stream must produce at least 2 events, "
            f"got {len(event_types)}: {event_types}"
        )

    async def test_agentless_invoke_response_structure(self, e2e_client: httpx.AsyncClient) -> None:
        """Agent-less invoke response has all required fields."""
        payload = make_invoke_payload(input_text="Check response structure")
        response = await e2e_client.post(f"{TEST_PROJECT_PREFIX}/agents/invoke", json=payload)

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        required_fields = {"agent_id", "output", "artifacts", "metadata", "duration_ms"}
        missing = required_fields - set(data.keys())
        assert not missing, (
            f"Agent-less response missing required fields: {missing}. Got: {sorted(data.keys())}"
        )


# ===========================================================================
# 8. Combined / cross-cutting orchestration E2E tests
# ===========================================================================


@pytest.mark.e2e
class TestOrchestrationCrossCuttingE2E:
    """Cross-cutting E2E tests combining multiple ENH-003 features."""

    async def test_group_chat_round_robin_with_keyword_termination(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Group chat with round_robin + keyword termination is accepted."""
        payload = make_invoke_payload(
            input_text="Discuss and conclude with FINAL ANSWER",
            config_overrides=_sk_group_chat_overrides(
                selection_type="round_robin",
                termination_type="keyword",
                extra_termination={"keywords": ["FINAL ANSWER"]},
                max_rounds=5,
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for round_robin + keyword, got {response.status_code}: {response.text}"
        )

    async def test_group_chat_with_candidate_agents_and_approval(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Group chat combining candidate_agents filtering with approval termination."""
        agents = [
            {"name": "analyst", "instructions": "You analyze data."},
            {"name": "reviewer", "instructions": "You review and approve."},
            {"name": "presenter", "instructions": "You present findings."},
        ]
        payload = make_invoke_payload(
            input_text="Analyze data and get approval",
            config_overrides=_sk_group_chat_overrides(
                selection_type="round_robin",
                termination_type="approval",
                extra_selection={"candidate_agents": ["analyst", "reviewer"]},
                extra_termination={"agents": ["reviewer"]},
                agents=agents,
            ),
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for candidate_agents + approval, "
            f"got {response.status_code}: {response.text}"
        )

    async def test_graph_with_initial_agent_selection(self, e2e_client: httpx.AsyncClient) -> None:
        """Graph orchestration with initial_agent in selection_strategy is accepted."""
        agents = [
            {"name": "intake", "instructions": "Intake requests."},
            {"name": "processor", "instructions": "Process requests."},
            {"name": "output", "instructions": "Produce output."},
        ]
        edges = [
            {"source": "intake", "target": "processor"},
            {"source": "processor", "target": "output"},
        ]
        overrides = {
            "semantic_kernel": {
                "agents": agents,
                "orchestration": {
                    "type": "graph",
                    "max_rounds": 10,
                    "edges": edges,
                    "selection_strategy": {
                        "type": "sequential",
                        "initial_agent": "intake",
                    },
                },
            },
        }
        payload = make_invoke_payload(
            input_text="Start from intake node",
            config_overrides=overrides,
        )
        response = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload
        )

        assert response.status_code == 200, (
            f"Expected 200 for graph with initial_agent, "
            f"got {response.status_code}: {response.text}"
        )

    async def test_multiple_orchestration_invokes_isolated(
        self, e2e_client: httpx.AsyncClient
    ) -> None:
        """Consecutive invocations with different orchestration configs are isolated."""
        # First call: group_chat with round_robin
        payload_1 = make_invoke_payload(
            input_text="First call: round robin discussion",
            config_overrides=_sk_group_chat_overrides(selection_type="round_robin"),
        )
        response_1 = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload_1
        )
        assert response_1.status_code == 200, (
            f"First invoke failed: {response_1.status_code}: {response_1.text}"
        )

        # Second call: sequential with custom order
        payload_2 = make_invoke_payload(
            input_text="Second call: sequential",
            config_overrides=_sk_sequential_overrides(
                agent_order=["reviewer", "writer", "editor"],
            ),
        )
        response_2 = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload_2
        )
        assert response_2.status_code == 200, (
            f"Second invoke failed: {response_2.status_code}: {response_2.text}"
        )

        # Third call: graph
        payload_3 = make_invoke_payload(
            input_text="Third call: graph traversal",
            config_overrides=_sk_graph_overrides(),
        )
        response_3 = await e2e_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke", json=payload_3
        )
        assert response_3.status_code == 200, (
            f"Third invoke failed: {response_3.status_code}: {response_3.text}"
        )

        # All three should have independent outputs.
        data_1 = response_1.json()
        data_2 = response_2.json()
        data_3 = response_3.json()
        assert data_1["output"], "First response output must not be empty"
        assert data_2["output"], "Second response output must not be empty"
        assert data_3["output"], "Third response output must not be empty"
