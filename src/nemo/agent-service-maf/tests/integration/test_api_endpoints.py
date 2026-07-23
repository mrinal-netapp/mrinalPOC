"""Integration tests for FastAPI API endpoints.

Tests cover:
- GET /health returns 200 with correct structure
- GET /agents lists registered adapters
- POST /agents/{id}/invoke succeeds with mock adapter
- POST /agents/{id}/invoke returns 404 for unknown framework
- POST /agents/{id}/invoke/stream returns SSE response
- GET /agents/{id}/capabilities returns agent capabilities
- GET /agents/{id}/capabilities returns 404 for unknown agent
- Auth middleware passes through /health without auth
- Auth middleware returns 401 for /agents when auth enabled with wrong key
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterator
from typing import Any, Never
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.config.validators import AgentConfig

# §B3: tests pin the migrated EchoAgent (framework.echo_adapter) which
# owns the §B1 STARTED/COMPLETED bookends and uses ResponseBuilder.
# The legacy examples/echo_agent.py predates the §5.4.4 contract.
from agent_service_maf.framework.echo_adapter import EchoAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.interface_layer.api import create_app
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _write_default_team(teams_dir, framework: str) -> None:
    """Write a minimal single-team JSON the multi-team loader will accept."""
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": framework},
            }
        )
    )


@pytest.fixture
def sync_client(tmp_path):
    """Create a synchronous TestClient with MockAgent registered as the default framework.

    Sets AGENT_AGENT__FRAMEWORK=mock via env and seeds AGENT_TEAMS_DIR with a
    single-team JSON so the multi-team loader builds exactly one bundle. The
    JSON-config ConfigLoader inside the per-team build is also stubbed to skip
    file reads, so the env var (framework=mock) wins.

    Locked-field constraint (Phase 2): framework cannot be overridden per-request,
    so it must be set at server-startup time.

    Both the env patch and the ConfigLoader patch must remain active through
    the entire TestClient lifecycle (including lifespan startup/shutdown), so
    they wrap the TestClient context manager here.
    """
    # conftest's clean_registry ensures 'mock' is registered before each test.
    # Import here to avoid circular issues inside nested context managers.
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    teams_dir = tmp_path / "teams"
    _write_default_team(teams_dir, framework="mock")

    env = {"AGENT_AGENT__FRAMEWORK": "mock", "AGENT_TEAMS_DIR": str(teams_dir)}
    with patch.dict("os.environ", env):
        with patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader:
            # Return a real ConfigLoader that skips the JSON file so the env
            # var AGENT_AGENT__FRAMEWORK=mock is not overridden by the JSON config.
            MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                yield client


@pytest.fixture
def echo_sync_client(tmp_path):
    """Create a synchronous TestClient with EchoAgent registered as 'echo'.

    Same multi-team setup as `sync_client`, but with framework=echo.
    """
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    teams_dir = tmp_path / "teams"
    _write_default_team(teams_dir, framework="echo")

    FrameworkRegistry.clear()
    FrameworkRegistry.register("echo")(EchoAgent)
    env = {"AGENT_AGENT__FRAMEWORK": "echo", "AGENT_TEAMS_DIR": str(teams_dir)}
    with patch.dict("os.environ", env):
        with patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader:
            MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                yield client
    FrameworkRegistry.clear()


# ---------------------------------------------------------------------------
# Health endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestHealthEndpoint:
    """Tests for GET /health."""

    def test_health_returns_200(self, sync_client: TestClient) -> None:
        """GET /health returns HTTP 200."""
        response = sync_client.get("/health")
        assert response.status_code == 200, f"Expected status 200, got {response.status_code}"

    def test_health_returns_correct_structure(self, sync_client: TestClient) -> None:
        """GET /health returns JSON with status, version, and uptimeSeconds (camelCase per §A1)."""
        response = sync_client.get("/health")
        data = response.json()
        for key in ("status", "version", "uptimeSeconds"):
            assert key in data, (
                f"Expected '{key}' in health response, got keys: {list(data.keys())}"
            )

    def test_health_status_is_ok(self, sync_client: TestClient) -> None:
        """GET /health returns status='ok' per §5.8.2 wire format."""
        response = sync_client.get("/health")
        data = response.json()
        assert data["status"] == "ok", f"Expected status='ok', got {data['status']!r}"

    def test_health_uptime_is_non_negative(self, sync_client: TestClient) -> None:
        """GET /health uptimeSeconds is >= 0."""
        response = sync_client.get("/health")
        data = response.json()
        assert data["uptimeSeconds"] >= 0, (
            f"Expected non-negative uptime, got {data['uptimeSeconds']}"
        )

    def test_health_accessible_without_auth(self, sync_client: TestClient) -> None:
        """GET /health is accessible without authentication (always exempt)."""
        response = sync_client.get("/health")
        assert response.status_code == 200, (
            f"Expected /health to always be accessible, got {response.status_code}"
        )

    def test_health_version_is_string(self, sync_client: TestClient) -> None:
        """GET /health returns a version string."""
        response = sync_client.get("/health")
        data = response.json()
        assert isinstance(data["version"], str), (
            f"Expected version to be a string, got {type(data['version'])}"
        )


# ---------------------------------------------------------------------------
# List agents endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestListAgentsEndpoint:
    """Tests for GET /agents."""

    def test_list_agents_returns_200(self, sync_client: TestClient) -> None:
        """GET /agents returns HTTP 200."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        assert response.status_code == 200, f"Expected status 200, got {response.status_code}"

    def test_list_agents_returns_correct_structure(self, sync_client: TestClient) -> None:
        """GET /agents returns JSON with agents list and total count."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        assert "agents" in data, f"Expected 'agents' in response, got keys: {list(data.keys())}"
        assert "total" in data, f"Expected 'total' in response, got keys: {list(data.keys())}"

    def test_list_agents_total_matches_agents_count(self, sync_client: TestClient) -> None:
        """GET /agents total count matches the length of agents list."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        assert data["total"] == len(data["agents"]), (
            f"Expected total={len(data['agents'])}, got total={data['total']}"
        )

    def test_list_agents_includes_registered_mock(self, sync_client: TestClient) -> None:
        """GET /agents includes the 'mock' adapter registered by conftest."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        # §A1: wire is camelCase.
        agent_ids = [a["agentId"] for a in data["agents"]]
        assert "mock" in agent_ids, f"Expected 'mock' in agentIds, got: {agent_ids}"

    def test_list_agents_with_echo(self, echo_sync_client: TestClient) -> None:
        """GET /agents lists echo agent when it's registered."""
        response = echo_sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        agent_ids = [a["agentId"] for a in data["agents"]]
        assert "echo" in agent_ids, f"Expected 'echo' in agentIds, got: {agent_ids}"

    def test_list_agents_each_has_agent_id(self, sync_client: TestClient) -> None:
        """GET /agents every agent entry has an agentId field (camelCase)."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        for agent in data["agents"]:
            assert "agentId" in agent, (
                f"Expected 'agentId' in each agent, got keys: {list(agent.keys())}"
            )

    def test_list_agents_each_has_framework(self, sync_client: TestClient) -> None:
        """GET /agents every agent entry has a framework field."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents")
        data = response.json()
        for agent in data["agents"]:
            assert "framework" in agent, (
                f"Expected 'framework' in each agent, got keys: {list(agent.keys())}"
            )


@pytest.mark.integration
class TestTeamsEndpoint:
    """Tests for the /agent-teams discovery endpoints (single-file fallback mode)."""

    def test_list_teams_returns_200(self, sync_client: TestClient) -> None:
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams")
        assert response.status_code == 200, response.text

    def test_list_teams_structure(self, sync_client: TestClient) -> None:
        """GET /agent-teams has teams[], total, default_team_id keys."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams")
        data = response.json()
        for key in ("teams", "total", "default_team_id"):
            assert key in data, f"missing '{key}', got keys: {list(data.keys())}"
        assert data["total"] == len(data["teams"])

    def test_single_file_mode_loads_default_team(self, sync_client: TestClient) -> None:
        """Single-file fallback still produces one team accessible via /agent-teams."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams")
        data = response.json()
        assert data["total"] >= 1
        assert data["default_team_id"], "default_team_id should be set"

    def test_team_detail_uses_default_team_id(self, sync_client: TestClient) -> None:
        """GET /agent-teams/{id} resolves the default team."""
        listing = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams").json()
        default_id = listing["default_team_id"]
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams/{default_id}")
        assert response.status_code == 200, response.text
        assert response.json()["team_id"] == default_id

    def test_unknown_team_returns_404(self, sync_client: TestClient) -> None:
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agent-teams/does_not_exist/invoke",
            json={
                "input": "hi",
                "context": {},
                "config_overrides": {},
                "session_id": "s",
                "metadata": {},
            },
        )
        assert response.status_code == 404
        detail = response.json()["detail"]
        assert "does_not_exist" in detail["error"]
        assert "available_teams" in detail

    def test_team_invoke_routes_to_default_team(self, sync_client: TestClient) -> None:
        """POST /agent-teams/{default_team_id}/invoke behaves like /agents/invoke."""
        default_id = sync_client.get(f"{TEST_PROJECT_PREFIX}/agent-teams").json()["default_team_id"]
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{default_id}/invoke",
            json={
                "input": "team-ping",
                "context": {},
                "config_overrides": {},
                "session_id": "s",
                "metadata": {},
            },
        )
        assert response.status_code == 200, response.text
        assert "team-ping" in response.json()["output"]


# ---------------------------------------------------------------------------
# Invoke endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestInvokeEndpoint:
    """Tests for POST /agents/{agent_id}/invoke."""

    def test_invoke_returns_200_with_mock_adapter(self, sync_client: TestClient) -> None:
        """POST /agents/test/invoke returns 200 with mock adapter (framework set via env)."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke",
            json={"input": "Hello, world!"},
        )
        assert response.status_code == 200, (
            f"Expected status 200, got {response.status_code}. Body: {response.text}"
        )

    def test_invoke_response_structure(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke returns correct response structure (camelCase per §A1)."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke",
            json={"input": "test input"},
        )
        data = response.json()
        for key in ("agentId", "output", "artifacts", "durationMs"):
            assert key in data, (
                f"Expected '{key}' in invoke response, got keys: {list(data.keys())}"
            )

    def test_invoke_agent_id_matches_path(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke returns the correct agentId."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/my-specific-agent/invoke",
            json={"input": "hello"},
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert data["agentId"] == "my-specific-agent", (
            f"Expected agentId='my-specific-agent', got {data['agentId']!r}"
        )

    def test_invoke_output_contains_input(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke output reflects the input (for mock adapter)."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "unique-test-string-xyz"},
        )
        data = response.json()
        assert "unique-test-string-xyz" in data["output"], (
            f"Expected input in output, got: {data['output']!r}"
        )

    def test_invoke_with_unknown_framework_returns_error(self, tmp_path) -> None:
        """POST /agents/{id}/invoke returns 404 or 500 for unknown framework.

        Sets AGENT_AGENT__FRAMEWORK to a non-existent adapter name via env var
        (the only valid way to change the framework since it's a locked field).
        The JSON config file is suppressed so the env var is not overridden.
        """
        FrameworkRegistry.clear()
        FrameworkRegistry.register("mock")(
            type(
                "MockAgent",
                (),
                {
                    "invoke": None,
                    "stream": None,
                    "get_capabilities": None,
                    "initialize": None,
                },
            )
        )
        from agent_service_maf.config.config_loader import ConfigLoader as RealCL

        teams_dir = tmp_path / "teams"
        _write_default_team(teams_dir, framework="mock")
        with (
            patch.dict(
                "os.environ",
                {
                    "AGENT_AGENT__FRAMEWORK": "definitely-nonexistent-xyz",
                    "AGENT_TEAMS_DIR": str(teams_dir),
                },
            ),
            patch("agent_service_maf.core.team_loader.ConfigLoader") as MockLoader,
        ):
            MockLoader.return_value = RealCL(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                    json={"input": "hello"},
                )
        assert response.status_code in (404, 422, 500), (
            f"Expected error status for unknown framework, got {response.status_code}"
        )

    def test_invoke_missing_input_returns_422(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke returns 422 when input is missing."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={},  # Missing required 'input' field
        )
        assert response.status_code == 422, (
            f"Expected 422 for missing input, got {response.status_code}"
        )

    def test_invoke_duration_ms_non_negative(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke returns non-negative durationMs."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "timing test"},
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert data["durationMs"] >= 0, (
            f"Expected non-negative durationMs, got {data['durationMs']}"
        )

    def test_invoke_with_echo_agent(self, echo_sync_client: TestClient) -> None:
        """POST /agents/echo/invoke returns 'Echo: {input}' with echo adapter."""
        response = echo_sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke",
            json={"input": "Hello from test!"},
        )
        assert response.status_code == 200, (
            f"Expected 200 with echo agent, got {response.status_code}. Body: {response.text}"
        )
        data = response.json()
        assert data["output"] == "Echo: Hello from test!", (
            f"Expected 'Echo: Hello from test!', got {data['output']!r}"
        )

    def test_invoke_with_session_id(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke accepts and passes through session_id."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={
                "input": "hello",
                "session_id": "test-session-123",
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 with session_id, got {response.status_code}"
        )

    def test_invoke_with_context_metadata(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke accepts request with context and metadata."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={
                "input": "hello",
                "context": {"backstory": "Be helpful."},
                "metadata": {"trace_id": "abc-123"},
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 with context and metadata, got {response.status_code}"
        )

    def test_invoke_non_locked_config_overrides_accepted(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke accepts config_overrides for non-locked fields."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={
                "input": "hello",
                "config_overrides": {"agent": {"temperature": 0.5}},
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 with non-locked config override, got {response.status_code}. "
            f"Body: {response.text}"
        )

    def test_invoke_locked_framework_override_silently_ignored(
        self, sync_client: TestClient
    ) -> None:
        """POST /agents/{id}/invoke silently drops locked-field shaped overrides.

        Per §A3 / §5.1.1 the typed ``ConfigOverrides`` allowlist is
        ``{model, temperature, max_tokens, agent_overrides}``. Anything
        else (including the legacy nested ``agent.framework`` form)
        falls off via ``extra="ignore"`` and only produces a DEBUG log
        line — the request itself returns 200.
        """
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={
                "input": "hello",
                "config_overrides": {"agent": {"framework": "mock"}},
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 (locked-field override silently dropped per §A3), "
            f"got {response.status_code}. Body: {response.text}"
        )


# ---------------------------------------------------------------------------
# Stream endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestStreamEndpoint:
    """Tests for POST /agents/{agent_id}/stream."""

    def test_stream_returns_200(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke/stream returns HTTP 200."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke/stream",
            json={"input": "Hello, streaming!"},
        )
        assert response.status_code == 200, (
            f"Expected status 200 for SSE stream, got {response.status_code}"
        )

    def test_stream_returns_event_stream_content_type(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke/stream returns text/event-stream content type."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke/stream",
            json={"input": "test"},
        )
        content_type = response.headers.get("content-type", "")
        assert "text/event-stream" in content_type, (
            f"Expected 'text/event-stream' content type, got {content_type!r}"
        )

    def test_stream_response_contains_events(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke/stream response body contains SSE events."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke/stream",
            json={"input": "test streaming"},
        )
        body = response.text
        # SSE format contains "event:" or "data:" lines
        has_sse_content = "event:" in body or "data:" in body
        assert has_sse_content, f"Expected SSE content in response body, got: {body[:200]!r}"

    def test_stream_missing_input_returns_422(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke/stream returns 422 when input is missing."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke/stream",
            json={},  # Missing required 'input' field
        )
        assert response.status_code == 422, (
            f"Expected 422 for missing input, got {response.status_code}"
        )

    def test_stream_with_echo_agent(self, echo_sync_client: TestClient) -> None:
        """POST /agents/echo/invoke/stream returns SSE events from EchoAgent."""
        response = echo_sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke/stream",
            json={"input": "Hi"},
        )
        assert response.status_code == 200, (
            f"Expected 200 with echo agent stream, got {response.status_code}"
        )
        body = response.text
        # Should contain started and completed events
        assert "started" in body, f"Expected 'started' event in stream, got: {body[:200]!r}"

    def test_stream_with_context_metadata(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke/stream accepts context and metadata fields."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke/stream",
            json={
                "input": "stream with metadata",
                "context": {"system_prompt": "Be concise."},
                "metadata": {"request_id": "req-stream-001"},
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 with stream + metadata, got {response.status_code}"
        )


# ---------------------------------------------------------------------------
# Capabilities endpoint tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestCapabilitiesEndpoint:
    """Tests for GET /agents/{agent_id}/capabilities."""

    def test_capabilities_returns_200_for_registered_agent(self, sync_client: TestClient) -> None:
        """GET /agents/{id}/capabilities returns 200 for registered agent."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents/mock/capabilities")
        assert response.status_code == 200, (
            f"Expected 200 for registered agent 'mock', got {response.status_code}"
        )

    def test_capabilities_returns_correct_structure(self, sync_client: TestClient) -> None:
        """GET /agents/{id}/capabilities returns correct structure."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents/mock/capabilities")
        data = response.json()
        for key in ("agentId", "framework", "supportsStreaming"):
            assert key in data, (
                f"Expected '{key}' in capabilities response, got keys: {list(data.keys())}"
            )

    def test_capabilities_agent_id_matches_path(self, sync_client: TestClient) -> None:
        """GET /agents/{id}/capabilities returns correct agentId."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents/mock/capabilities")
        data = response.json()
        assert data["agentId"] == "mock", f"Expected agentId='mock', got {data['agentId']!r}"

    def test_capabilities_returns_404_for_unknown_agent(self, sync_client: TestClient) -> None:
        """GET /agents/{id}/capabilities returns 404 for unregistered agent."""
        response = sync_client.get(
            f"{TEST_PROJECT_PREFIX}/agents/definitely-not-registered-xyz/capabilities"
        )
        assert response.status_code == 404, (
            f"Expected 404 for unregistered agent, got {response.status_code}"
        )

    def test_capabilities_echo_agent(self, echo_sync_client: TestClient) -> None:
        """GET /agents/echo/capabilities returns EchoAgent capabilities."""
        response = echo_sync_client.get(f"{TEST_PROJECT_PREFIX}/agents/echo/capabilities")
        assert response.status_code == 200, (
            f"Expected 200 for echo agent, got {response.status_code}"
        )
        data = response.json()
        assert data["agentId"] == "echo", f"Expected agentId='echo', got {data['agentId']!r}"
        # The migrated EchoAgent (framework.echo_adapter) reports its
        # framework as "echo" -- the pre-migration examples/echo_agent.py
        # reported it as "example".
        assert data["framework"] == "echo", (
            f"Expected framework='echo' (§B3 migrated EchoAgent), got {data['framework']!r}"
        )

    def test_capabilities_includes_supported_protocols(self, sync_client: TestClient) -> None:
        """GET /agents/{id}/capabilities includes supportedProtocols list."""
        response = sync_client.get(f"{TEST_PROJECT_PREFIX}/agents/mock/capabilities")
        data = response.json()
        assert "supportedProtocols" in data, (
            f"Expected 'supportedProtocols' in capabilities, got: {list(data.keys())}"
        )
        assert isinstance(data["supportedProtocols"], list), (
            "Expected supportedProtocols to be a list"
        )


# ---------------------------------------------------------------------------
# Auth middleware integration tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestAuthMiddlewareIntegration:
    """Tests for authentication middleware behavior on API endpoints."""

    def test_health_bypasses_auth(self, sync_client: TestClient) -> None:
        """GET /health works without authentication (always exempt)."""
        response = sync_client.get("/health")
        assert response.status_code == 200, (
            f"Expected /health to be exempt from auth, got {response.status_code}"
        )

    def test_docs_bypasses_auth(self, sync_client: TestClient) -> None:
        """GET /docs is accessible without authentication."""
        response = sync_client.get("/docs")
        # Should not return 401 (may return 200 or redirect)
        assert response.status_code != 401, (
            f"Expected /docs to be exempt from auth, got {response.status_code}"
        )

    def test_api_key_auth_with_valid_key(self, tmp_path) -> None:
        """POST /agents/{id}/invoke succeeds with valid API key when auth enabled.

        The auth middleware reads API keys directly from the AGENT_INTERFACE__AUTH__API_KEYS
        env var via comma-split in create_app(). The ConfigLoader is patched to avoid the
        JSON config file overriding the framework, while the comma-separated api_keys format
        is used for compatibility with create_app()'s direct env var parsing.
        """
        from agent_service_maf.config.validators import AgentSection

        teams_dir = tmp_path / "teams"
        _write_default_team(teams_dir, framework="mock")
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "test-valid-key-12345",
                "AGENT_AGENT__FRAMEWORK": "mock",
                "AGENT_TEAMS_DIR": str(teams_dir),
            },
        ):
            with patch("agent_service_maf.core.team_loader.ConfigLoader") as MockLoader:
                mock_instance = MockLoader.return_value
                # Build a fully-validated AppConfig — model_construct would skip
                # nested-model coercion and leave .gateway as a dict, which
                # breaks LLMGateway(config.gateway).
                base = AgentConfig()
                resolved_config = base.model_copy(update={"agent": AgentSection(framework="mock")})
                mock_instance.resolve.return_value = resolved_config
                app = create_app()
                with TestClient(app) as client:
                    response = client.post(
                        f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                        headers={"X-API-Key": "test-valid-key-12345"},
                        json={"input": "hello"},
                    )
                    assert response.status_code == 200, (
                        f"Expected 200 with valid API key, got {response.status_code}. Body: {response.text}"
                    )

    def test_api_key_auth_with_invalid_key(self) -> None:
        """POST /agents/{id}/invoke returns 401 with invalid API key when auth enabled."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "correct-key-abc123",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                    headers={"X-API-Key": "wrong-key-xyz"},
                    json={"input": "hello"},
                )
                assert response.status_code == 401, (
                    f"Expected 401 with invalid API key, got {response.status_code}"
                )

    def test_api_key_auth_missing_key(self) -> None:
        """POST /agents/{id}/invoke returns 401 with missing API key when auth enabled."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "required-key-456",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                    # No X-API-Key header
                    json={"input": "hello"},
                )
                assert response.status_code == 401, (
                    f"Expected 401 with missing API key, got {response.status_code}"
                )

    def test_admin_config_status_requires_auth(self) -> None:
        """``GET /admin/config/status`` is on the un-prefixed
        ``system_router`` but still operational — it exposes cache
        hit-rate counters, sizes, and TTL. ``AgentAuthMiddleware``
        must gate it (the ``/admin`` prefix is in the protected
        paths tuple). Regression test for the original report that
        the route was reachable without auth."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "expected-key",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.get("/admin/config/status")
                assert response.status_code == 401, (
                    f"/admin/config/status must require auth when "
                    f"AUTH__ENABLED=true; got {response.status_code}. "
                    f"Body: {response.text}"
                )

    def test_admin_config_invalidate_requires_auth(self) -> None:
        """``POST /api/v1/admin/config/invalidate`` wipes the
        config-service cache. The auth middleware must gate it
        (the ``/api/v1/admin`` prefix is in the protected paths
        tuple); historically only ``/api/v1/projects`` was gated,
        leaving cache eviction reachable to unauthenticated callers."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "expected-key",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    "/api/v1/admin/config/invalidate?project_id=p1",
                )
                assert response.status_code == 401, (
                    f"/api/v1/admin/config/invalidate must require auth; "
                    f"got {response.status_code}. Body: {response.text}"
                )

    def test_health_accessible_when_auth_enabled(self) -> None:
        """GET /health remains accessible even when auth is enabled."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "auth-required-key",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.get("/health")
                assert response.status_code == 200, (
                    f"Expected /health to be accessible with auth enabled, got {response.status_code}"
                )

    def test_auth_error_response_structure(self) -> None:
        """Auth failure response has correct JSON structure."""
        with patch.dict(
            "os.environ",
            {
                "AGENT_INTERFACE__AUTH__ENABLED": "true",
                "AGENT_INTERFACE__AUTH__API_KEYS": "valid-key-xyz",
            },
        ):
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                    headers={"X-API-Key": "invalid-key"},
                    json={"input": "hello"},
                )
                assert response.status_code == 401, f"Expected 401, got {response.status_code}"
                data = response.json()
                assert "error" in data, (
                    f"Expected 'error' in 401 response, got keys: {list(data.keys())}"
                )


# ---------------------------------------------------------------------------
# Error handling integration tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestErrorHandling:
    """Tests for error handling in API endpoints."""

    def test_framework_error_returns_error_status(self, tmp_path) -> None:
        """Invoking with an unregistered framework name returns an error response.

        Sets AGENT_AGENT__FRAMEWORK to a non-existent adapter via env var
        (the only valid way to change the framework, since agent.framework is locked
        and cannot be overridden per-request). The JSON config is suppressed so
        the env var is not overridden by the config file.
        """
        FrameworkRegistry.clear()
        FrameworkRegistry.register("mock")(
            type(
                "MockAgent",
                (),
                {
                    "invoke": None,
                    "stream": None,
                    "get_capabilities": None,
                    "initialize": None,
                },
            )
        )
        from agent_service_maf.config.config_loader import ConfigLoader as RealCL

        teams_dir = tmp_path / "teams"
        _write_default_team(teams_dir, framework="mock")
        with (
            patch.dict(
                "os.environ",
                {
                    "AGENT_AGENT__FRAMEWORK": "nonexistent-xyz",
                    "AGENT_TEAMS_DIR": str(teams_dir),
                },
            ),
            patch("agent_service_maf.core.team_loader.ConfigLoader") as MockLoader,
        ):
            MockLoader.return_value = RealCL(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                response = client.post(
                    f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                    json={"input": "test"},
                )
        assert response.status_code in (404, 422, 500), (
            f"Expected error status for unknown framework, got {response.status_code}"
        )

    def test_invoke_response_has_agent_id(self, sync_client: TestClient) -> None:
        """Successful invoke response includes agentId field (camelCase per §A1)."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/specific-id-test/invoke",
            json={"input": "test"},
        )
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        data = response.json()
        assert "agentId" in data, f"Expected 'agentId' in response, got: {list(data.keys())}"

    def test_invoke_json_parse_error_returns_422(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke with malformed JSON returns 422."""
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            content="not valid json",
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 422, (
            f"Expected 422 for malformed JSON, got {response.status_code}"
        )

    def test_agent_timeout_error_returns_504(self, sync_client: TestClient) -> None:
        """``AgentTimeoutError`` raised by an adapter must surface as
        HTTP 504 Gateway Timeout, not 500. Previously it fell through
        the generic ``AgentFrameworkError`` handler and was
        misclassified as an internal error, breaking client retry /
        monitoring logic that distinguishes timeouts from server faults.
        """
        from unittest.mock import patch as _patch

        from agent_service_maf.core.exceptions import AgentTimeoutError
        from tests.conftest import MockAgent

        async def _raise_timeout(self, request, context) -> Never:
            raise AgentTimeoutError(
                "synthetic timeout for handler test",
                details={"timeout_seconds": 1.0, "orchestration_type": "single"},
            )

        with _patch.object(MockAgent, "invoke", _raise_timeout):
            response = sync_client.post(
                f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
                json={"input": "trigger timeout"},
            )
        assert response.status_code == 504, (
            f"AgentTimeoutError must map to 504 Gateway Timeout, "
            f"got {response.status_code}. Body: {response.text}"
        )
        body = response.json()
        # The error_type is propagated through the SafeErrorFormatter
        # alias table; the client-facing payload still includes the
        # type name for diagnostic / retry logic.
        detail = body.get("detail") or body
        assert detail.get("error_type") in (
            "AgentTimeoutError",
            "InternalError",
        ), f"unexpected error_type: {detail.get('error_type')!r}"

    def test_locked_field_override_silently_dropped(self, sync_client: TestClient) -> None:
        """POST /agents/{id}/invoke with locked agent.framework override returns 200.

        Per §A3 / §5.1.1 the typed ``ConfigOverrides`` allowlist
        ignores any field outside ``{model, temperature, max_tokens,
        agent_overrides}``. The legacy nested ``agent.framework`` shape
        is dropped (``extra="ignore"`` + DEBUG ``config_override_ignored``
        log line). Defense-in-depth: even if a caller did slip an
        ``agent.framework`` through ``configOverrides``, the
        :class:`ConfigLoader._check_locked_fields` defense would still
        fire — but for the typed wire model that path is unreachable.
        """
        response = sync_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={
                "input": "test",
                "config_overrides": {"agent": {"framework": "mock"}},
            },
        )
        assert response.status_code == 200, (
            f"Expected 200 (locked-field shape silently dropped), got "
            f"{response.status_code}. Body: {response.text}"
        )


# ---------------------------------------------------------------------------
# Empty-registry semantics: 503 vs 404 on discovery routes
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestEmptyRegistryReturns503:
    """When app.state.teams exists but is empty (no team configs loaded —
    e.g., AGENT_TEAMS_DIR unset or every file failed to parse), discovery
    routes must return 503, not 404. Returning 404 misleads operators into
    thinking they typed the project_id wrong when the real problem is an
    operational/startup misconfiguration.

    Populated-registry + truly-unknown project remains 404 — that's the
    correct shape for a routing mistake and is already exercised by
    ``test_teams.py::test_unknown_project_returns_404``.
    """

    @staticmethod
    def _empty_app() -> TestClient:
        """Build a TestClient with NO teams loaded.

        We don't seed AGENT_TEAMS_DIR and disable single-file fallback, so the
        lifespan completes with an empty TeamRegistry on ``app.state.teams``.
        """
        env = {"AGENT_TEAMS_DIR": "", "AGENT_CONFIG_PATH": "/dev/null/no-such-config"}
        with patch.dict("os.environ", env):
            app = create_app()
            return TestClient(app)

    def test_list_teams_returns_503_when_no_teams_loaded(self) -> None:
        with self._empty_app() as client:
            response = client.get(f"{TEST_PROJECT_PREFIX}/agent-teams")
        assert response.status_code == 503, (
            f"Expected 503 when registry is empty, got {response.status_code}. "
            f"Body: {response.text}"
        )
        assert "No teams loaded" in response.json()["detail"]["error"]

    def test_list_agents_returns_503_when_no_teams_loaded(self) -> None:
        with self._empty_app() as client:
            response = client.get(f"{TEST_PROJECT_PREFIX}/agents")
        assert response.status_code == 503, (
            f"Expected 503 when registry is empty, got {response.status_code}. "
            f"Body: {response.text}"
        )
        assert "No teams loaded" in response.json()["detail"]["error"]

    def test_get_capabilities_returns_503_when_no_teams_loaded(self) -> None:
        with self._empty_app() as client:
            response = client.get(f"{TEST_PROJECT_PREFIX}/agents/echo/capabilities")
        assert response.status_code == 503, (
            f"Expected 503 when registry is empty, got {response.status_code}. "
            f"Body: {response.text}"
        )
        assert "No teams loaded" in response.json()["detail"]["error"]

    def test_invoke_returns_503_when_no_teams_loaded(self) -> None:
        # Sanity check — _resolve_team already had this 503 path, but now
        # all four discovery + invoke surfaces share one helper, so verifying
        # the path here keeps the contract honest.
        with self._empty_app() as client:
            response = client.post(
                f"{TEST_PROJECT_PREFIX}/agents/echo/invoke",
                json={"input": "hi"},
            )
        assert response.status_code == 503, (
            f"Expected 503 when registry is empty, got {response.status_code}. "
            f"Body: {response.text}"
        )

    def test_unknown_project_with_populated_registry_returns_404(
        self, sync_client: TestClient
    ) -> None:
        """Populated registry + an obviously-bogus project_id → 404 (not 503).

        Uses the existing sync_client fixture which seeds a single "default"
        team under TEST_PROJECT_ID. Any other project must look unknown.
        """
        bogus = "11111111-1111-1111-1111-111111111111"
        for path in (
            f"/api/v1/projects/{bogus}/agent-teams",
            f"/api/v1/projects/{bogus}/agents",
            f"/api/v1/projects/{bogus}/agents/echo/capabilities",
        ):
            response = sync_client.get(path)
            assert response.status_code == 404, (
                f"Expected 404 for unknown project on {path}, "
                f"got {response.status_code}: {response.text}"
            )
            detail = response.json()["detail"]
            assert "Unknown project_id" in detail["error"]
            # Operator-friendly: surface the known projects.
            assert "available_projects" in detail
            assert TEST_PROJECT_ID in detail["available_projects"]


# ---------------------------------------------------------------------------
# WebSocket authentication
# ---------------------------------------------------------------------------
#
# AgentAuthMiddleware is BaseHTTPMiddleware and does NOT fire for WS
# connections. WS handshakes are authenticated separately by
# routes._authenticate_websocket, which runs the same provider stashed on
# app.state.auth_provider. These tests pin that the WS path:
#
#   - passes through when auth is disabled,
#   - accepts a valid X-API-Key,
#   - rejects an invalid X-API-Key with WS close code 4401,
#   - rejects a missing X-API-Key with WS close code 4401.


@pytest.mark.integration
class TestWebSocketAuth:
    """Auth coverage for WebSocket routes under /api/v1/projects/...

    Uses the existing sync_client / _write_default_team fixture pattern but
    boots a dedicated app per test so the auth env vars take effect during
    the lifespan (the global sync_client fixture leaves auth disabled).
    """

    @staticmethod
    @contextlib.contextmanager
    def _boot_app_with_auth(
        tmp_path: Any,
        *,
        auth_enabled: bool,
        valid_key: str = "valid-key-xyz",
    ) -> Iterator[TestClient]:
        """Boot a fresh ``TestClient`` with one mock team loaded and the auth
        env vars set as requested.

        Yielded as a context manager so the env patches and the
        ``TestClient`` lifespan unwind together — without this, the
        AGENT_INTERFACE__AUTH__* env vars leak into later tests in the
        suite (see the note below).

        Implementation note: a previous version of this helper tried to
        monkey-patch ``client.__exit__`` to also tear down its patches.
        That doesn't work because Python's ``with`` statement looks up
        ``__exit__`` on the **type**, not the instance — the override was
        silently ignored and env vars leaked across tests. The nested
        ``with`` form below avoids the issue.
        """
        from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

        teams_dir = tmp_path / "teams"
        _write_default_team(teams_dir, framework="mock")
        env = {
            "AGENT_AGENT__FRAMEWORK": "mock",
            "AGENT_TEAMS_DIR": str(teams_dir),
            "AGENT_INTERFACE__AUTH__ENABLED": "true" if auth_enabled else "false",
            "AGENT_INTERFACE__AUTH__API_KEYS": valid_key if auth_enabled else "",
        }
        with (
            patch.dict("os.environ", env),
            patch(
                "agent_service_maf.core.team_loader.ConfigLoader",
                return_value=RealConfigLoader(json_config_path=None),
            ),
        ):
            app = create_app()
            with TestClient(app) as client:
                yield client

    def test_ws_passes_through_when_auth_disabled(self, tmp_path: Any) -> None:
        """No auth configured → WS connects without any header. Confirms
        the disabled-auth path goes through ``NoopAuthMiddleware``.
        """
        with self._boot_app_with_auth(tmp_path, auth_enabled=False) as client:
            with client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws:
                # Just verify the connection completes the handshake. Send a
                # malformed payload to force an immediate server response so
                # we don't leave the test hanging; we expect a JSON error
                # event back, not a close.
                ws.send_text("not json at all")
                msg = ws.receive_json()
                assert msg.get("event") == "error", msg

    def test_ws_accepts_valid_api_key(self, tmp_path: Any) -> None:
        """Auth enabled + correct X-API-Key → handshake succeeds."""
        with (
            self._boot_app_with_auth(
                tmp_path, auth_enabled=True, valid_key="ws-key-correct"
            ) as client,
            client.websocket_connect(
                f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws",
                headers={"X-API-Key": "ws-key-correct"},
            ) as ws,
        ):
            ws.send_text("malformed")
            msg = ws.receive_json()
            assert msg.get("event") == "error", msg

    def test_ws_rejects_invalid_api_key_with_4401(self, tmp_path: Any) -> None:
        """Auth enabled + wrong X-API-Key → handshake fails with code 4401."""
        from starlette.websockets import WebSocketDisconnect

        with self._boot_app_with_auth(
            tmp_path, auth_enabled=True, valid_key="ws-key-correct"
        ) as client:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                with client.websocket_connect(
                    f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws",
                    headers={"X-API-Key": "ws-key-wrong"},
                ):
                    pass  # connection should fail at handshake
            assert exc_info.value.code == 4401, (
                f"Expected WS close code 4401 for invalid key, got {exc_info.value.code}. "
                f"Reason: {exc_info.value.reason!r}"
            )

    def test_ws_rejects_missing_api_key_with_4401(self, tmp_path: Any) -> None:
        """Auth enabled + no X-API-Key header → handshake fails with 4401."""
        from starlette.websockets import WebSocketDisconnect

        with self._boot_app_with_auth(
            tmp_path, auth_enabled=True, valid_key="ws-key-correct"
        ) as client:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                with client.websocket_connect(
                    f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws",
                    # No X-API-Key header at all
                ):
                    pass
            assert exc_info.value.code == 4401, (
                f"Expected WS close code 4401 for missing key, got {exc_info.value.code}. "
                f"Reason: {exc_info.value.reason!r}"
            )

    def test_ws_rejection_also_covers_agents_route(self, tmp_path: Any) -> None:
        """The /agents/{id}/ws route uses the same _authenticate_websocket
        helper as /agent-teams/{id}/ws — verify both paths reject unauthorized
        traffic identically.
        """
        from starlette.websockets import WebSocketDisconnect

        with self._boot_app_with_auth(
            tmp_path, auth_enabled=True, valid_key="ws-key-correct"
        ) as client:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                with client.websocket_connect(
                    f"{TEST_PROJECT_PREFIX}/agents/echo/ws",
                    # Missing key.
                ):
                    pass
            assert exc_info.value.code == 4401
