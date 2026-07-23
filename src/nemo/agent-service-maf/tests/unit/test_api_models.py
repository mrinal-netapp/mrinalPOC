"""Unit tests for API layer Pydantic models.

Tests cover:
- InvokeRequest construction, defaults, and validation
- InvokeResponse construction and from_agent_response() factory
- ErrorResponse construction and defaults
- AgentListResponse construction
- HealthResponse construction
- ChatMessageModel construction
- ChatRequest construction
- ChatResponse construction and from_agent_response() factory
- ChatHistoryResponse construction
- JSON roundtrip for all models
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.interfaces import AgentCapabilities, AgentResponse, TokenUsage
from agent_service_maf.interface_layer.models import (
    AgentListResponse,
    ChatHistoryResponse,
    ChatMessageModel,
    ChatResponse,
    ErrorResponse,
    HealthResponse,
    InvokeRequest,
    InvokeResponse,
)

# ---------------------------------------------------------------------------
# InvokeRequest tests
# ---------------------------------------------------------------------------


class TestInvokeRequest:
    """Tests for the InvokeRequest API model."""

    def test_input_is_required(self) -> None:
        """InvokeRequest requires the input field."""
        with pytest.raises(Exception):
            InvokeRequest()  # type: ignore[call-arg]

    def test_minimal_construction(self) -> None:
        """InvokeRequest can be constructed with just input."""
        req = InvokeRequest(input="Hello")
        assert req.input == "Hello", f"Expected input='Hello', got {req.input!r}"

    def test_defaults_for_optional_fields(self) -> None:
        """InvokeRequest defaults all optional fields correctly."""
        req = InvokeRequest(input="test")
        assert req.context == {}, f"Expected context={{}}, got {req.context}"
        # §A3: typed ConfigOverrides default is None (not an empty dict).
        assert req.config_overrides is None, (
            f"Expected config_overrides=None, got {req.config_overrides}"
        )
        assert req.session_id is None, f"Expected session_id=None, got {req.session_id}"
        assert req.metadata == {}, f"Expected metadata={{}}, got {req.metadata}"

    def test_all_fields_can_be_set(self) -> None:
        """InvokeRequest stores all provided fields."""
        from agent_service_maf.interface_layer.models import ConfigOverrides

        req = InvokeRequest(
            input="Summarize this.",
            context={"backstory": "Be concise."},
            config_overrides=ConfigOverrides(model="claude-sonnet", temperature=0.5),
            session_id="sess-001",
            metadata={"trace_id": "trace-abc"},
        )
        assert req.input == "Summarize this.", "Expected input to be stored"
        assert req.context["backstory"] == "Be concise.", "Expected backstory in context"
        assert req.config_overrides is not None, "Expected config_overrides set"
        assert req.config_overrides.model == "claude-sonnet", "Expected model override"
        assert req.config_overrides.temperature == 0.5, "Expected temperature override"
        assert req.session_id == "sess-001", "Expected session_id='sess-001'"
        assert req.metadata["trace_id"] == "trace-abc", "Expected trace_id in metadata"

    def test_json_roundtrip(self) -> None:
        """InvokeRequest serializes and deserializes correctly."""
        original = InvokeRequest(
            input="Hello, world!",
            context={"key": "value"},
            session_id="sess-abc",
        )
        json_str = original.model_dump_json()
        restored = InvokeRequest.model_validate_json(json_str)
        assert restored.input == original.input, "Expected input to match after roundtrip"
        assert restored.context == original.context, "Expected context to match after roundtrip"
        assert restored.session_id == original.session_id, "Expected session_id to match"


# ---------------------------------------------------------------------------
# InvokeResponse tests
# ---------------------------------------------------------------------------


class TestInvokeResponse:
    """Tests for the InvokeResponse API model."""

    def test_required_fields(self) -> None:
        """InvokeResponse requires agent_id and output."""
        resp = InvokeResponse(agent_id="echo", output="Hello!")
        assert resp.agent_id == "echo", "Expected agent_id='echo'"
        assert resp.output == "Hello!", "Expected output='Hello!'"

    def test_default_fields(self) -> None:
        """InvokeResponse defaults all optional fields correctly."""
        resp = InvokeResponse(agent_id="echo", output="hi")
        assert resp.artifacts == [], f"Expected artifacts=[], got {resp.artifacts}"
        assert resp.usage is None, f"Expected usage=None, got {resp.usage}"
        assert resp.metadata == {}, f"Expected metadata={{}}, got {resp.metadata}"
        assert resp.duration_ms == 0, f"Expected duration_ms=0, got {resp.duration_ms}"

    def test_from_agent_response_without_usage(self) -> None:
        """from_agent_response() creates InvokeResponse from AgentResponse (no usage)."""
        agent_resp = AgentResponse(
            agent_id="echo",
            output="Echo: hello",
            duration_ms=42,
        )
        invoke_resp = InvokeResponse.from_agent_response(agent_resp)
        assert invoke_resp.agent_id == "echo", "Expected agent_id='echo'"
        assert invoke_resp.output == "Echo: hello", "Expected output to match"
        assert invoke_resp.duration_ms == 42, "Expected duration_ms=42"
        assert invoke_resp.usage is None, "Expected usage=None when AgentResponse has no usage"

    def test_from_agent_response_with_usage(self) -> None:
        """from_agent_response() converts TokenUsage to dict."""
        token_usage = TokenUsage(
            prompt_tokens=10, completion_tokens=20, total_tokens=30, estimated_cost_usd=0.001
        )
        agent_resp = AgentResponse(
            agent_id="echo",
            output="Hello",
            usage=token_usage,
            duration_ms=100,
        )
        invoke_resp = InvokeResponse.from_agent_response(agent_resp)
        assert invoke_resp.usage is not None, "Expected usage to be set"
        assert isinstance(invoke_resp.usage, dict), (
            f"Expected usage as dict in API response, got {type(invoke_resp.usage)}"
        )
        # §A1/§5.2.2: usage dict is camelCase on the wire (by_alias=True).
        assert invoke_resp.usage["promptTokens"] == 10, "Expected promptTokens=10"
        assert invoke_resp.usage["totalTokens"] == 30, "Expected totalTokens=30"

    def test_from_agent_response_preserves_artifacts(self) -> None:
        """from_agent_response() preserves artifacts list."""
        agent_resp = AgentResponse(
            agent_id="echo",
            output="hi",
            artifacts=[{"type": "text", "content": "raw output"}],
        )
        invoke_resp = InvokeResponse.from_agent_response(agent_resp)
        assert len(invoke_resp.artifacts) == 1, "Expected one artifact"
        assert invoke_resp.artifacts[0]["type"] == "text", "Expected artifact type='text'"

    def test_from_agent_response_preserves_metadata(self) -> None:
        """from_agent_response() preserves metadata dict."""
        agent_resp = AgentResponse(
            agent_id="echo",
            output="hi",
            metadata={"request_id": "abc-123", "framework": "echo"},
        )
        invoke_resp = InvokeResponse.from_agent_response(agent_resp)
        assert invoke_resp.metadata["request_id"] == "abc-123", "Expected request_id in metadata"

    def test_from_agent_response_session_id_override(self) -> None:
        """``session_id`` kwarg overrides ``response.session_id``.

        The route handler uses this to echo back the raw (pre-scope)
        caller-facing form rather than the storage key. Without the
        override, the client would see ``team:proj:tid:uid:abc`` and
        couldn't safely replay it on the next turn.
        """
        agent_resp = AgentResponse(
            agent_id="echo",
            output="hi",
            session_id="team:proj:tid:uid:sess-abc",
        )
        invoke_resp = InvokeResponse.from_agent_response(
            agent_resp,
            session_id="sess-abc",
        )
        assert invoke_resp.session_id == "sess-abc"

    def test_from_agent_response_session_id_default(self) -> None:
        """Without the kwarg, falls through to ``response.session_id``."""
        agent_resp = AgentResponse(
            agent_id="echo",
            output="hi",
            session_id="sess-abc",
        )
        invoke_resp = InvokeResponse.from_agent_response(agent_resp)
        assert invoke_resp.session_id == "sess-abc"

    def test_json_roundtrip(self) -> None:
        """InvokeResponse serializes and deserializes correctly."""
        original = InvokeResponse(
            agent_id="echo",
            output="Hello",
            duration_ms=50,
        )
        json_str = original.model_dump_json()
        restored = InvokeResponse.model_validate_json(json_str)
        assert restored.agent_id == original.agent_id, "Expected agent_id to match"
        assert restored.duration_ms == 50, "Expected duration_ms=50 after roundtrip"

    def test_negative_duration_ms_raises(self) -> None:
        """InvokeResponse rejects negative duration_ms."""
        with pytest.raises(Exception):
            InvokeResponse(agent_id="echo", output="hi", duration_ms=-1)


# ---------------------------------------------------------------------------
# ErrorResponse tests
# ---------------------------------------------------------------------------


class TestErrorResponse:
    """Tests for the ErrorResponse API model."""

    def test_required_fields(self) -> None:
        """ErrorResponse requires error and error_type."""
        resp = ErrorResponse(
            error="Something went wrong.",
            error_type="InternalError",
        )
        assert resp.error == "Something went wrong.", "Expected error message stored"
        assert resp.error_type == "InternalError", "Expected error_type='InternalError'"

    def test_defaults(self) -> None:
        """ErrorResponse defaults details to empty dict and correlation_id to empty string."""
        resp = ErrorResponse(error="Error", error_type="InternalError")
        assert resp.details == {}, f"Expected details={{}}, got {resp.details}"
        assert resp.correlation_id == "", f"Expected correlation_id='', got {resp.correlation_id!r}"

    def test_all_fields(self) -> None:
        """ErrorResponse stores all provided fields."""
        resp = ErrorResponse(
            error="Framework 'x' not found.",
            error_type="FrameworkNotFoundError",
            details={"requested": "x"},
            correlation_id="abc-123",
        )
        assert resp.details["requested"] == "x", "Expected details to be stored"
        assert resp.correlation_id == "abc-123", "Expected correlation_id='abc-123'"

    def test_json_roundtrip(self) -> None:
        """ErrorResponse serializes and deserializes correctly."""
        original = ErrorResponse(
            error="Test error",
            error_type="TestError",
            correlation_id="corr-123",
        )
        json_str = original.model_dump_json()
        restored = ErrorResponse.model_validate_json(json_str)
        assert restored.error == original.error, "Expected error to match"
        assert restored.correlation_id == original.correlation_id, (
            "Expected correlation_id to match"
        )


# ---------------------------------------------------------------------------
# AgentListResponse tests
# ---------------------------------------------------------------------------


class TestAgentListResponse:
    """Tests for the AgentListResponse API model."""

    def test_default_empty_list(self) -> None:
        """AgentListResponse defaults to empty list with total=0."""
        resp = AgentListResponse()
        assert resp.agents == [], f"Expected agents=[], got {resp.agents}"
        assert resp.total == 0, f"Expected total=0, got {resp.total}"

    def test_with_agents(self) -> None:
        """AgentListResponse stores agents and total."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        resp = AgentListResponse(agents=[caps], total=1)
        assert len(resp.agents) == 1, "Expected one agent"
        assert resp.total == 1, "Expected total=1"

    def test_negative_total_raises(self) -> None:
        """AgentListResponse rejects negative total."""
        with pytest.raises(Exception):
            AgentListResponse(total=-1)


# ---------------------------------------------------------------------------
# HealthResponse tests
# ---------------------------------------------------------------------------


class TestHealthResponse:
    """Tests for the HealthResponse API model."""

    def test_default_status_healthy(self) -> None:
        """HealthResponse defaults status to 'ok' per §5.8.2 wire example."""
        resp = HealthResponse()
        assert resp.status == "ok", f"Expected status='ok', got {resp.status!r}"

    def test_default_uptime_zero(self) -> None:
        """HealthResponse defaults uptime_seconds to 0.0."""
        resp = HealthResponse()
        assert resp.uptime_seconds == 0.0, f"Expected uptime_seconds=0.0, got {resp.uptime_seconds}"

    def test_custom_values_stored(self) -> None:
        """HealthResponse stores custom status, version, and uptime."""
        resp = HealthResponse(status="degraded", version="1.2.3", uptime_seconds=3600.0)
        assert resp.status == "degraded", "Expected status='degraded'"
        assert resp.version == "1.2.3", "Expected version='1.2.3'"
        assert resp.uptime_seconds == 3600.0, "Expected uptime_seconds=3600.0"

    def test_negative_uptime_raises(self) -> None:
        """HealthResponse rejects negative uptime_seconds."""
        with pytest.raises(Exception):
            HealthResponse(uptime_seconds=-1.0)


# ---------------------------------------------------------------------------
# ChatMessageModel tests
# ---------------------------------------------------------------------------


class TestChatMessageModel:
    """Tests for the ChatMessageModel."""

    def test_required_fields(self) -> None:
        """ChatMessageModel requires role and content."""
        msg = ChatMessageModel(role="user", content="Hello!")
        assert msg.role == "user", "Expected role='user'"
        assert msg.content == "Hello!", "Expected content='Hello!'"

    def test_defaults(self) -> None:
        """ChatMessageModel defaults timestamp to None and metadata to empty dict."""
        msg = ChatMessageModel(role="assistant", content="Hi")
        assert msg.timestamp is None, f"Expected timestamp=None, got {msg.timestamp}"
        assert msg.metadata == {}, f"Expected metadata={{}}, got {msg.metadata}"


# ---------------------------------------------------------------------------
# ChatResponse tests
# ---------------------------------------------------------------------------


class TestChatResponse:
    """Tests for the ChatResponse API model."""

    def test_from_agent_response(self) -> None:
        """from_agent_response() creates ChatResponse from AgentResponse."""
        agent_resp = AgentResponse(
            agent_id="echo",
            output="Hello there!",
            duration_ms=30,
        )
        chat_resp = ChatResponse.from_agent_response(agent_resp, session_id="sess-123")
        assert chat_resp.agent_id == "echo", "Expected agent_id='echo'"
        assert chat_resp.session_id == "sess-123", "Expected session_id='sess-123'"
        assert chat_resp.message.role == "assistant", "Expected message role='assistant'"
        assert chat_resp.message.content == "Hello there!", "Expected message content"
        assert chat_resp.duration_ms == 30, "Expected duration_ms=30"

    def test_from_agent_response_with_usage(self) -> None:
        """from_agent_response() converts TokenUsage to dict in ChatResponse."""
        token_usage = TokenUsage(prompt_tokens=5, completion_tokens=10, total_tokens=15)
        agent_resp = AgentResponse(agent_id="echo", output="Hi", usage=token_usage)
        chat_resp = ChatResponse.from_agent_response(agent_resp, session_id="s")
        assert isinstance(chat_resp.usage, dict), "Expected usage as dict"
        # §A1/§5.2.2: usage dict is camelCase on the wire (by_alias=True).
        assert chat_resp.usage["promptTokens"] == 5, "Expected promptTokens=5"


# ---------------------------------------------------------------------------
# ChatHistoryResponse tests
# ---------------------------------------------------------------------------


class TestChatHistoryResponse:
    """Tests for the ChatHistoryResponse model."""

    def test_defaults(self) -> None:
        """ChatHistoryResponse defaults messages to empty list and total=0."""
        resp = ChatHistoryResponse(session_id="sess-1")
        assert resp.messages == [], "Expected messages=[]"
        assert resp.total == 0, "Expected total=0"

    def test_with_messages(self) -> None:
        """ChatHistoryResponse stores messages and total."""
        msgs = [
            ChatMessageModel(role="user", content="Hi"),
            ChatMessageModel(role="assistant", content="Hello!"),
        ]
        resp = ChatHistoryResponse(session_id="sess-1", messages=msgs, total=2)
        assert len(resp.messages) == 2, "Expected 2 messages"
        assert resp.total == 2, "Expected total=2"
