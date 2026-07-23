"""Shared test fixtures and configuration."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock

# Shared test project_id used across the suite. Tests that boot the FastAPI
# app should mount their team configs under this project (or a second project
# if they want multi-project coverage), then build URLs as
# f"{TEST_PROJECT_PREFIX}/agent-teams/{team_id}/...".
TEST_PROJECT_ID: str = "00000000-0000-0000-0000-000000000001"
TEST_PROJECT_PREFIX: str = f"/api/v1/projects/{TEST_PROJECT_ID}"

import pytest
from httpx import ASGITransport, AsyncClient

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.gateway.llm_gateway import LLMGateway
from agent_service_maf.interface_layer.api import create_app
from agent_service_maf.mcp.mcp_registry import MCPRegistry

# --- Config Helpers ---


def make_config(**overrides: object) -> AgentConfig:
    """Create AgentConfig with overrides. Use nested dicts to set section fields.

    Args:
        **overrides: Nested dict overrides, e.g. ``agent={"framework": "mock"}``.

    Returns:
        A new :class:`AgentConfig` with the merged overrides applied.

    Example:
        >>> cfg = make_config(agent={"framework": "echo"})
        >>> cfg.agent.framework
        'echo'
    """
    from agent_service_maf.config.config_loader import deep_merge
    from agent_service_maf.config.defaults import DEFAULTS

    merged = deep_merge(DEFAULTS, overrides)
    return AgentConfig(**merged)


# --- Config Fixtures ---


@pytest.fixture
def default_config() -> AgentConfig:
    """Return a default AgentConfig for testing."""
    return AgentConfig()


@pytest.fixture
def config_loader(tmp_path: Any) -> ConfigLoader:
    """Return a ConfigLoader with a temp JSON config."""
    return ConfigLoader(json_config_path=tmp_path / "test_config.json")


# --- Mock Agent ---


class MockAgent(BaseAgent):
    """A mock agent for testing that returns predictable responses."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        return AgentResponse(
            agent_id=request.agent_id,
            output=f"Mock response to: {request.input}",
            usage=TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30),
            metadata={"framework": "mock"},
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.THINKING, data="Thinking...")
        yield AgentEvent(event_type=EventType.TOKEN, data=f"Mock response to: {request.input}")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(
            agent_id="mock",
            framework="mock",
            supports_streaming=True,
            description="Mock agent for testing",
        )


@pytest.fixture(autouse=True)
def clean_registry():
    """Ensure registry is clean before each test."""
    FrameworkRegistry.clear()
    FrameworkRegistry.register("mock")(MockAgent)
    yield
    FrameworkRegistry.clear()


# --- Context Fixtures ---


@pytest.fixture
def mock_gateway() -> MagicMock:
    """Return a mock LLM gateway."""
    gateway = MagicMock(spec=LLMGateway)
    gateway.complete = AsyncMock(
        return_value={
            "content": "Mock LLM response",
            "tool_calls": None,
            "usage": TokenUsage(),
            "model": "mock-model",
        }
    )
    return gateway


@pytest.fixture
def mock_mcp_registry() -> MagicMock:
    """Return a mock MCP registry."""
    registry = MagicMock(spec=MCPRegistry)
    registry.get_all_tools.return_value = []
    registry.shutdown = AsyncMock()
    return registry


@pytest.fixture
def execution_context(
    default_config: AgentConfig,
    mock_gateway: MagicMock,
    mock_mcp_registry: MagicMock,
) -> AgentExecutionContext:
    """Return an AgentExecutionContext for testing with a valid UUID4 correlation_id."""
    return AgentExecutionContext(
        config=default_config,
        gateway=mock_gateway,
        mcp_registry=mock_mcp_registry,
        correlation_id=str(uuid.uuid4()),
    )


# --- API Client Fixtures ---


@pytest.fixture
def app():
    """Create a test FastAPI app."""
    application = create_app()
    return application


@pytest.fixture
async def client(app) -> AsyncIterator[AsyncClient]:
    """Create an async test client."""
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as ac:
        yield ac


# --- Request Fixtures ---


@pytest.fixture
def sample_request() -> AgentRequest:
    """Return a sample agent request."""
    return AgentRequest(
        agent_id="test-agent",
        input="Hello, test!",
        context={"test": True},
    )
