"""Unit tests for the agent-definition config models.

These models live in :mod:`agent_service_maf.config.validators` and are
framework-agnostic (consumed by the Microsoft Agent Framework adapter). The
section key ``semantic_kernel`` / class name ``SemanticKernelSection`` is
retained for backward compatibility with stored team configs.

Tests cover:
- SKAgentDefinition validation (name, model, temperature, etc.)
- SemanticKernelSection defaults
- OrchestrationConfig defaults and validation
"""

from __future__ import annotations

from agent_service_maf.config.validators import (
    OrchestrationConfig,
    SemanticKernelSection,
    SKAgentDefinition,
)

# ---------------------------------------------------------------------------
# SKAgentDefinition validation tests
# ---------------------------------------------------------------------------


class TestSKAgentDefinition:
    """Tests for the SKAgentDefinition Pydantic model."""

    def test_minimal_creation(self) -> None:
        """Verify minimal agent definition with just a name."""
        agent = SKAgentDefinition(name="test")
        assert agent.name == "test", f"Expected name 'test', got '{agent.name}'"
        assert agent.instructions == "", (
            f"Default instructions should be empty, got '{agent.instructions}'"
        )
        assert agent.model is None, f"Default model should be None, got {agent.model}"

    def test_full_creation(self) -> None:
        """Verify agent definition with all fields set."""
        agent = SKAgentDefinition(
            name="full-agent",
            instructions="Be helpful",
            description="A helpful agent",
            model="openai/gpt-4o",
            temperature=0.5,
            max_tokens=2048,
            top_p=0.9,
            presence_penalty=0.1,
            frequency_penalty=-0.1,
            response_format="json_object",
            tools=["search", "fetch"],
            mcp_servers=["web"],
            function_choice_behavior="required",
        )
        assert agent.name == "full-agent", f"Name mismatch: {agent.name}"
        assert agent.temperature == 0.5, f"Temperature mismatch: {agent.temperature}"
        assert agent.tools == ["search", "fetch"], f"Tools mismatch: {agent.tools}"
        assert agent.function_choice_behavior == "required", (
            f"Function choice mismatch: {agent.function_choice_behavior}"
        )

    def test_default_function_choice_is_auto(self) -> None:
        """Verify default function_choice_behavior is 'auto'."""
        agent = SKAgentDefinition(name="test")
        assert agent.function_choice_behavior == "auto", (
            f"Default function_choice should be 'auto', got '{agent.function_choice_behavior}'"
        )

    def test_default_tools_empty(self) -> None:
        """Verify default tools list is empty."""
        agent = SKAgentDefinition(name="test")
        assert agent.tools == [], f"Default tools should be empty, got {agent.tools}"

    def test_default_mcp_servers_empty(self) -> None:
        """Verify default mcp_servers list is empty."""
        agent = SKAgentDefinition(name="test")
        assert agent.mcp_servers == [], (
            f"Default mcp_servers should be empty, got {agent.mcp_servers}"
        )


# ---------------------------------------------------------------------------
# SemanticKernelSection tests
# ---------------------------------------------------------------------------


class TestSemanticKernelSection:
    """Tests for the SemanticKernelSection configuration model."""

    def test_default_agents_contains_one(self) -> None:
        """Verify default config has one agent named 'default'."""
        section = SemanticKernelSection()
        assert len(section.agents) == 1, f"Expected 1 default agent, got {len(section.agents)}"
        assert section.agents[0].name == "default", (
            f"Default agent name should be 'default', got '{section.agents[0].name}'"
        )

    def test_default_orchestration_is_single(self) -> None:
        """Verify default orchestration type is 'single'."""
        section = SemanticKernelSection()
        assert section.orchestration.type == "single", (
            f"Default orchestration type should be 'single', got '{section.orchestration.type}'"
        )

    def test_default_session_ttl(self) -> None:
        """Verify default session TTL is 3600."""
        section = SemanticKernelSection()
        assert section.session_ttl_seconds == 3600, (
            f"Default session_ttl_seconds should be 3600, got {section.session_ttl_seconds}"
        )

    def test_default_telemetry_disabled(self) -> None:
        """Verify telemetry is disabled by default."""
        section = SemanticKernelSection()
        assert section.enable_telemetry is False, "Telemetry should be disabled by default"

    def test_custom_agents_list(self) -> None:
        """Verify custom agents list is accepted."""
        section = SemanticKernelSection(
            agents=[
                SKAgentDefinition(name="writer"),
                SKAgentDefinition(name="reviewer"),
            ]
        )
        assert len(section.agents) == 2, f"Expected 2 agents, got {len(section.agents)}"


# ---------------------------------------------------------------------------
# OrchestrationConfig tests
# ---------------------------------------------------------------------------


class TestOrchestrationConfig:
    """Tests for the OrchestrationConfig model."""

    def test_default_type_is_single(self) -> None:
        """Verify default type is 'single'."""
        config = OrchestrationConfig()
        assert config.type == "single", f"Default type should be 'single', got '{config.type}'"

    def test_default_max_rounds(self) -> None:
        """Verify default max_rounds is 20."""
        config = OrchestrationConfig()
        assert config.max_rounds == 20, f"Default max_rounds should be 20, got {config.max_rounds}"

    def test_handoffs_default_empty(self) -> None:
        """Verify handoffs default to empty list."""
        config = OrchestrationConfig()
        assert config.handoffs == [], f"Default handoffs should be empty, got {config.handoffs}"
