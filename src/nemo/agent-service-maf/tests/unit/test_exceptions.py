"""Unit tests for the exception hierarchy.

Tests cover:
- Base class AgentFrameworkError construction and details
- All subclass inheritance relationships
- Specialized exceptions (MCPToolError with extra attributes)
- Exception chaining via __cause__
- details dict defaults to empty dict
- str() representation (the exception message)
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.exceptions import (
    A2ATaskError,
    A2ATaskNotFoundError,
    AgentFrameworkError,
    AgentInvocationError,
    AuthenticationError,
    ConfigurationError,
    FrameworkNotFoundError,
    GatewayError,
    MCPConnectionError,
    MCPServerError,
    MCPToolError,
    ProtocolError,
    RateLimitError,
    SessionNotFoundError,
    StreamingError,
    ValidationError,
)

# ---------------------------------------------------------------------------
# AgentFrameworkError base tests
# ---------------------------------------------------------------------------


class TestAgentFrameworkError:
    """Tests for the base AgentFrameworkError exception class."""

    def test_basic_construction_with_message(self) -> None:
        """AgentFrameworkError stores the message correctly."""
        exc = AgentFrameworkError("Something went wrong.")
        assert str(exc) == "Something went wrong.", (
            f"Expected message 'Something went wrong.', got {str(exc)!r}"
        )

    def test_details_defaults_to_empty_dict(self) -> None:
        """AgentFrameworkError defaults details to empty dict when not provided."""
        exc = AgentFrameworkError("Error occurred")
        assert exc.details == {}, f"Expected details={{}}, got {exc.details}"

    def test_explicit_details_stored_correctly(self) -> None:
        """AgentFrameworkError stores explicit details dict."""
        details = {"field": "model", "value": "bad-value", "count": 42}
        exc = AgentFrameworkError("Error with details", details=details)
        assert exc.details == details, f"Expected details={details}, got {exc.details}"

    def test_is_exception_subclass(self) -> None:
        """AgentFrameworkError is a subclass of Exception."""
        assert issubclass(AgentFrameworkError, Exception), (
            "Expected AgentFrameworkError to be a subclass of Exception"
        )

    def test_can_be_raised_and_caught(self) -> None:
        """AgentFrameworkError can be raised and caught."""
        with pytest.raises(AgentFrameworkError) as exc_info:
            raise AgentFrameworkError("test error", details={"key": "value"})
        assert "test error" in str(exc_info.value), "Expected 'test error' in exception message"
        assert exc_info.value.details["key"] == "value", "Expected details to be accessible"

    def test_details_none_becomes_empty_dict(self) -> None:
        """AgentFrameworkError converts None details to empty dict."""
        exc = AgentFrameworkError("msg", details=None)
        assert exc.details == {}, f"Expected details={{}} when None passed, got {exc.details}"


# ---------------------------------------------------------------------------
# Inheritance hierarchy tests
# ---------------------------------------------------------------------------


class TestExceptionInheritance:
    """Tests verifying the exception inheritance hierarchy."""

    def test_configuration_error_inherits_from_base(self) -> None:
        """ConfigurationError inherits from AgentFrameworkError."""
        assert issubclass(ConfigurationError, AgentFrameworkError), (
            "Expected ConfigurationError to inherit from AgentFrameworkError"
        )

    def test_framework_not_found_error_inherits_from_base(self) -> None:
        """FrameworkNotFoundError inherits from AgentFrameworkError."""
        assert issubclass(FrameworkNotFoundError, AgentFrameworkError), (
            "Expected FrameworkNotFoundError to inherit from AgentFrameworkError"
        )

    def test_agent_invocation_error_inherits_from_base(self) -> None:
        """AgentInvocationError inherits from AgentFrameworkError."""
        assert issubclass(AgentInvocationError, AgentFrameworkError), (
            "Expected AgentInvocationError to inherit from AgentFrameworkError"
        )

    def test_authentication_error_inherits_from_base(self) -> None:
        """AuthenticationError inherits from AgentFrameworkError."""
        assert issubclass(AuthenticationError, AgentFrameworkError), (
            "Expected AuthenticationError to inherit from AgentFrameworkError"
        )

    def test_validation_error_inherits_from_base(self) -> None:
        """ValidationError inherits from AgentFrameworkError."""
        assert issubclass(ValidationError, AgentFrameworkError), (
            "Expected ValidationError to inherit from AgentFrameworkError"
        )

    def test_streaming_error_inherits_from_base(self) -> None:
        """StreamingError inherits from AgentFrameworkError."""
        assert issubclass(StreamingError, AgentFrameworkError), (
            "Expected StreamingError to inherit from AgentFrameworkError"
        )

    def test_mcp_connection_error_inherits_from_base(self) -> None:
        """MCPConnectionError inherits from AgentFrameworkError."""
        assert issubclass(MCPConnectionError, AgentFrameworkError), (
            "Expected MCPConnectionError to inherit from AgentFrameworkError"
        )

    def test_mcp_tool_error_inherits_from_base(self) -> None:
        """MCPToolError inherits from AgentFrameworkError."""
        assert issubclass(MCPToolError, AgentFrameworkError), (
            "Expected MCPToolError to inherit from AgentFrameworkError"
        )

    def test_gateway_error_inherits_from_base(self) -> None:
        """GatewayError inherits from AgentFrameworkError."""
        assert issubclass(GatewayError, AgentFrameworkError), (
            "Expected GatewayError to inherit from AgentFrameworkError"
        )

    def test_rate_limit_error_inherits_from_gateway_error(self) -> None:
        """RateLimitError inherits from GatewayError (and transitively from base)."""
        assert issubclass(RateLimitError, GatewayError), (
            "Expected RateLimitError to inherit from GatewayError"
        )
        assert issubclass(RateLimitError, AgentFrameworkError), (
            "Expected RateLimitError to transitively inherit from AgentFrameworkError"
        )

    def test_session_not_found_error_inherits_from_base(self) -> None:
        """SessionNotFoundError inherits from AgentFrameworkError."""
        assert issubclass(SessionNotFoundError, AgentFrameworkError), (
            "Expected SessionNotFoundError to inherit from AgentFrameworkError"
        )

    def test_a2a_task_error_inherits_from_base(self) -> None:
        """A2ATaskError inherits from AgentFrameworkError."""
        assert issubclass(A2ATaskError, AgentFrameworkError), (
            "Expected A2ATaskError to inherit from AgentFrameworkError"
        )

    def test_a2a_task_not_found_inherits_from_a2a_task_error(self) -> None:
        """A2ATaskNotFoundError inherits from A2ATaskError."""
        assert issubclass(A2ATaskNotFoundError, A2ATaskError), (
            "Expected A2ATaskNotFoundError to inherit from A2ATaskError"
        )

    def test_mcp_server_error_inherits_from_base(self) -> None:
        """MCPServerError inherits from AgentFrameworkError."""
        assert issubclass(MCPServerError, AgentFrameworkError), (
            "Expected MCPServerError to inherit from AgentFrameworkError"
        )

    def test_protocol_error_inherits_from_base(self) -> None:
        """ProtocolError inherits from AgentFrameworkError."""
        assert issubclass(ProtocolError, AgentFrameworkError), (
            "Expected ProtocolError to inherit from AgentFrameworkError"
        )

    def test_catch_base_class_catches_all_subclasses(self) -> None:
        """Catching AgentFrameworkError catches all derived exception types."""
        subclasses = [
            ConfigurationError("config error"),
            FrameworkNotFoundError("not found"),
            AgentInvocationError("invocation error"),
            AuthenticationError("auth error"),
            ValidationError("validation error"),
            StreamingError("streaming error"),
            MCPConnectionError("mcp connection"),
            MCPToolError("mcp tool"),
            GatewayError("gateway error"),
            RateLimitError("rate limit"),
            SessionNotFoundError("session not found"),
            A2ATaskError("a2a error"),
            A2ATaskNotFoundError("a2a not found"),
            MCPServerError("server error"),
            ProtocolError("protocol error"),
        ]
        for exc in subclasses:
            with pytest.raises(AgentFrameworkError):
                raise exc


# ---------------------------------------------------------------------------
# MCPToolError special attributes
# ---------------------------------------------------------------------------


class TestMCPToolError:
    """Tests for MCPToolError's extra server_name and tool_name attributes."""

    def test_construction_with_all_attributes(self) -> None:
        """MCPToolError stores server_name and tool_name."""
        exc = MCPToolError(
            "Tool failed",
            server_name="vector-db",
            tool_name="semantic_search",
            details={"error_code": "INDEX_NOT_FOUND"},
        )
        assert exc.server_name == "vector-db", (
            f"Expected server_name='vector-db', got {exc.server_name!r}"
        )
        assert exc.tool_name == "semantic_search", (
            f"Expected tool_name='semantic_search', got {exc.tool_name!r}"
        )
        assert exc.details["error_code"] == "INDEX_NOT_FOUND", "Expected error_code in details"

    def test_construction_with_defaults(self) -> None:
        """MCPToolError defaults server_name and tool_name to empty strings."""
        exc = MCPToolError("Tool failed")
        assert exc.server_name == "", f"Expected default server_name='', got {exc.server_name!r}"
        assert exc.tool_name == "", f"Expected default tool_name='', got {exc.tool_name!r}"

    def test_message_accessible_via_str(self) -> None:
        """MCPToolError message is accessible via str()."""
        exc = MCPToolError("Custom tool error message", server_name="s", tool_name="t")
        assert "Custom tool error message" in str(exc), (
            f"Expected message in str(exc), got {str(exc)!r}"
        )


# ---------------------------------------------------------------------------
# Exception chaining tests
# ---------------------------------------------------------------------------


class TestExceptionChaining:
    """Tests for exception chaining via __cause__."""

    def test_chained_exception_preserves_cause(self) -> None:
        """Exceptions chained with 'from' preserve __cause__."""
        original = ValueError("original error")
        try:
            raise AgentInvocationError("wrapped error") from original
        except AgentInvocationError as exc:
            assert exc.__cause__ is original, (
                f"Expected __cause__ to be the original ValueError, got {exc.__cause__}"
            )

    def test_framework_error_details_contain_context(self) -> None:
        """AgentFrameworkError details dict can carry debugging context."""
        exc = AgentInvocationError(
            "Invocation failed",
            details={
                "agent_id": "echo",
                "framework": "echo",
                "correlation_id": "abc-123",
                "duration_ms": 500,
            },
        )
        assert exc.details["agent_id"] == "echo", "Expected agent_id in details"
        assert exc.details["duration_ms"] == 500, "Expected duration_ms in details"


# ---------------------------------------------------------------------------
# Specific exception construction tests
# ---------------------------------------------------------------------------


class TestSpecificExceptions:
    """Tests for individual exception types."""

    def test_configuration_error_construction(self) -> None:
        """ConfigurationError can be constructed with message and details."""
        exc = ConfigurationError(
            "Config validation failed for 'model'",
            details={"field": "model"},
        )
        assert "model" in str(exc), "Expected 'model' in exception message"
        assert exc.details["field"] == "model", "Expected field in details"

    def test_framework_not_found_error_construction(self) -> None:
        """FrameworkNotFoundError can be constructed with requested and available names."""
        exc = FrameworkNotFoundError(
            "Framework 'unknown' is not registered. Available: ['echo'].",
            details={"requested": "unknown", "available": ["echo"]},
        )
        assert "unknown" in str(exc), "Expected 'unknown' in exception message"
        assert exc.details["requested"] == "unknown", "Expected requested in details"

    def test_rate_limit_error_is_catchable_as_gateway_error(self) -> None:
        """RateLimitError can be caught as GatewayError."""
        with pytest.raises(GatewayError):
            raise RateLimitError("Rate limit exceeded", details={"retry_after_seconds": 30})

    def test_a2a_task_not_found_catchable_as_a2a_task_error(self) -> None:
        """A2ATaskNotFoundError can be caught as A2ATaskError."""
        with pytest.raises(A2ATaskError):
            raise A2ATaskNotFoundError("Task not found")
