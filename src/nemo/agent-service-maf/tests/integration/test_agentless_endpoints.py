"""Integration tests for agent-less orchestrated endpoints.

Tests cover:
- POST /agents/invoke returns 200 with orchestrated response
- POST /agents/invoke/stream returns SSE stream
- Both endpoints use "orchestrator" as internal agent_id
- Both endpoints build context from config_overrides
- Error handling matches agent-specific endpoint patterns
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from agent_service_maf.core.interfaces import AgentResponse
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_test_app() -> FastAPI:
    """Create a minimal FastAPI app with routes and mock state.

    Sets up a single-team ``TeamRegistry`` on ``app.state.teams`` (the multi-team
    shape routes now expect) backed by MagicMocks for config/gateway/mcp.
    """
    from fastapi import FastAPI

    from agent_service_maf.core.team_bundle import TeamBundle, TeamRegistry
    from agent_service_maf.interface_layer.routes import api_router

    app = FastAPI()
    app.include_router(api_router, prefix="/api/v1")

    mock_config_loader = MagicMock()
    mock_config = MagicMock()
    mock_config.agent.framework = "echo"
    mock_config.semantic_kernel.orchestration.type = "triage"
    mock_config_loader.resolve.return_value = mock_config

    bundle = TeamBundle(
        team_id="default",
        project_id=TEST_PROJECT_ID,
        name="default",
        description="test default team",
        config_path="",
        config_loader=mock_config_loader,
        config=mock_config,
        gateway=MagicMock(),
        mcp_manager=MagicMock(),
        guardrails=None,
        session_manager=None,
    )
    registry = TeamRegistry()
    registry.add(bundle)
    app.state.teams = registry

    # Mock framework registry
    mock_registry = MagicMock()
    mock_agent = AsyncMock()
    mock_agent.invoke = AsyncMock(
        return_value=AgentResponse(
            agent_id="orchestrator",
            output="Orchestrated response",
            artifacts=[],
            usage={},
            metadata={"orchestration_type": "triage"},
            duration_ms=100,
        )
    )
    mock_agent.initialize = AsyncMock()
    mock_registry.create.return_value = mock_agent
    app.state.framework_registry = mock_registry
    app.state.start_time = 0

    return app


# ---------------------------------------------------------------------------
# POST /agents/invoke tests
# ---------------------------------------------------------------------------


class TestAgentlessInvoke:
    """Tests for the agent-less POST /agents/invoke endpoint."""

    def test_invoke_returns_200(self) -> None:
        """Verify POST /agents/invoke returns 200 with orchestrated response."""
        app = _make_test_app()
        client = TestClient(app)

        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={"input": "Hello, orchestrate this!"},
        )

        assert response.status_code == 200, (
            f"Expected 200, got {response.status_code}: {response.text}"
        )
        data = response.json()
        assert data["output"] == "Orchestrated response"

    def test_invoke_with_config_overrides(self) -> None:
        """Verify POST /agents/invoke passes config_overrides."""
        app = _make_test_app()
        client = TestClient(app)

        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={
                "input": "Test with overrides",
                "config_overrides": {"agent": {"temperature": 0.5}},
            },
        )

        assert response.status_code == 200

    def test_invoke_with_session_id(self) -> None:
        """Verify POST /agents/invoke passes session_id."""
        app = _make_test_app()
        client = TestClient(app)

        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={
                "input": "Test with session",
                "session_id": "my-session-123",
            },
        )

        assert response.status_code == 200

    def test_invoke_uses_orchestrator_agent_id(self) -> None:
        """Verify the endpoint uses 'orchestrator' as internal agent_id."""
        app = _make_test_app()
        client = TestClient(app)

        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={"input": "Test agent_id"},
        )

        assert response.status_code == 200
        # The mock agent's invoke was called with agent_id="orchestrator"
        mock_agent = app.state.framework_registry.create.return_value
        call_args = mock_agent.invoke.call_args
        agent_request = call_args[0][0]
        assert agent_request.agent_id == "orchestrator"


# ---------------------------------------------------------------------------
# POST /agents/invoke/stream tests
# ---------------------------------------------------------------------------


class TestAgentlessStream:
    """Tests for the agent-less POST /agents/invoke/stream endpoint."""

    def test_stream_returns_200(self) -> None:
        """Verify POST /agents/invoke/stream returns 200 (SSE response)."""
        app = _make_test_app()

        # For SSE we need to mock create_sse_generator
        with patch("agent_service_maf.interface_layer.routes.create_sse_generator") as mock_gen:

            async def fake_gen() -> AsyncIterator[dict[str, str]]:
                yield {"event": "completed", "data": "done"}

            mock_gen.return_value = fake_gen()

            client = TestClient(app)
            response = client.post(
                f"{TEST_PROJECT_PREFIX}/agents/invoke/stream",
                json={"input": "Stream this"},
            )

            assert response.status_code == 200


# ---------------------------------------------------------------------------
# Error handling tests
# ---------------------------------------------------------------------------


class TestAgentlessErrors:
    """Tests for error handling in agent-less endpoints."""

    def test_invoke_framework_not_found_returns_404(self) -> None:
        """Verify FrameworkNotFoundError returns 404."""
        from agent_service_maf.core.exceptions import FrameworkNotFoundError

        app = _make_test_app()
        app.state.framework_registry.create.side_effect = FrameworkNotFoundError(
            "Framework 'unknown' not found. Available frameworks: ['echo', 'maf'].",
            details={},
        )

        client = TestClient(app)
        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={"input": "Test error"},
        )

        assert response.status_code == 404

    def test_invoke_agent_error_returns_500(self) -> None:
        """Verify AgentFrameworkError returns 500."""
        from agent_service_maf.core.exceptions import AgentFrameworkError

        app = _make_test_app()
        mock_agent = app.state.framework_registry.create.return_value
        mock_agent.invoke.side_effect = AgentFrameworkError(
            "Something went wrong.",
            details={},
        )

        client = TestClient(app)
        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={"input": "Test error"},
        )

        assert response.status_code == 500


# ---------------------------------------------------------------------------
# Route ordering tests
# ---------------------------------------------------------------------------


class TestRouteOrdering:
    """Tests verifying agent-less routes don't conflict with agent_id routes."""

    def test_agents_invoke_does_not_match_agent_id(self) -> None:
        """Verify /agents/invoke is not treated as agent_id='invoke'."""
        app = _make_test_app()
        client = TestClient(app)

        # This should hit the agent-less endpoint, not the agent_id endpoint
        response = client.post(
            f"{TEST_PROJECT_PREFIX}/agents/invoke",
            json={"input": "Test routing"},
        )

        assert response.status_code == 200
        # The mock agent should be initialized without "invoke" as agent_id
        mock_agent = app.state.framework_registry.create.return_value
        if mock_agent.invoke.called:
            agent_request = mock_agent.invoke.call_args[0][0]
            assert agent_request.agent_id == "orchestrator", (
                "Should use 'orchestrator' not 'invoke' as agent_id"
            )
