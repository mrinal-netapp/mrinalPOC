"""Unit tests for AgentExecutionContext.

Tests cover:
- Construction with valid correlation_id
- Auto-generation of correlation_id when empty
- Validation rejects invalid correlation_id formats
- UUID4 format validation (version 4, correct variant bits)
- Optional fields (gateway, mcp_registry, guardrails) default to None
- request_metadata and session_id defaults
"""

from __future__ import annotations

import uuid

import pytest

from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_context(**kwargs) -> AgentExecutionContext:
    """Construct an AgentExecutionContext with a minimal valid config."""
    kwargs.setdefault("config", AgentConfig())
    return AgentExecutionContext(**kwargs)


# ---------------------------------------------------------------------------
# Auto-generation of correlation_id
# ---------------------------------------------------------------------------


class TestCorrelationIdAutoGeneration:
    """Tests for auto-generation of correlation_id when empty string is provided."""

    def test_empty_correlation_id_generates_uuid4(self) -> None:
        """An empty correlation_id triggers auto-generation of a valid UUID4."""
        ctx = make_context(correlation_id="")
        assert ctx.correlation_id != "", "Expected auto-generated correlation_id to be non-empty"
        # Verify it is a valid UUID4
        parsed = uuid.UUID(ctx.correlation_id)
        assert parsed.version == 4, (
            f"Expected auto-generated correlation_id to be UUID4, got version {parsed.version}"
        )

    def test_omitted_correlation_id_generates_uuid4(self) -> None:
        """Omitting correlation_id triggers auto-generation of a valid UUID4."""
        ctx = make_context()
        parsed = uuid.UUID(ctx.correlation_id)
        assert parsed.version == 4, (
            f"Expected auto-generated correlation_id to be UUID4, got version {parsed.version}"
        )

    def test_auto_generated_ids_are_unique(self) -> None:
        """Multiple contexts with empty correlation_id get different IDs."""
        ctx1 = make_context()
        ctx2 = make_context()
        assert ctx1.correlation_id != ctx2.correlation_id, (
            "Expected different auto-generated correlation_ids for distinct contexts"
        )

    def test_auto_generated_id_is_36_chars(self) -> None:
        """Auto-generated correlation_id is 36 characters (UUID4 canonical form)."""
        ctx = make_context()
        assert len(ctx.correlation_id) == 36, (
            f"Expected 36-char correlation_id, got {len(ctx.correlation_id)}"
        )


# ---------------------------------------------------------------------------
# Valid UUID4 acceptance
# ---------------------------------------------------------------------------


class TestCorrelationIdValidation:
    """Tests for UUID4 format validation of provided correlation_id."""

    def test_valid_uuid4_is_accepted(self) -> None:
        """A valid UUID4 string is accepted as correlation_id."""
        valid_id = "550e8400-e29b-41d4-a716-446655440000"
        ctx = make_context(correlation_id=valid_id)
        assert ctx.correlation_id == valid_id, (
            f"Expected stored correlation_id={valid_id!r}, got {ctx.correlation_id!r}"
        )

    def test_another_valid_uuid4(self) -> None:
        """Another valid UUID4 with different variant bits is accepted."""
        valid_id = str(uuid.uuid4())
        ctx = make_context(correlation_id=valid_id)
        assert ctx.correlation_id == valid_id, (
            f"Expected stored correlation_id={valid_id!r}, got {ctx.correlation_id!r}"
        )

    def test_uppercase_uuid4_is_accepted(self) -> None:
        """UUID4 with uppercase hex digits is accepted (case-insensitive)."""
        valid_id = str(uuid.uuid4()).upper()
        ctx = make_context(correlation_id=valid_id)
        assert ctx.correlation_id == valid_id.upper(), (
            f"Expected uppercase UUID4 to be accepted, got {ctx.correlation_id!r}"
        )

    def test_non_uuid_string_raises_value_error(self) -> None:
        """A non-UUID4 string raises ValueError with an actionable message."""
        with pytest.raises(ValueError) as exc_info:
            make_context(correlation_id="not-a-uuid")
        error_msg = str(exc_info.value)
        assert "correlation_id" in error_msg.lower() or "uuid" in error_msg.lower(), (
            f"Expected error message to mention correlation_id or UUID, got: {error_msg}"
        )

    def test_uuid1_raises_value_error(self) -> None:
        """A UUID1 string raises ValueError (must be UUID4 version)."""
        uuid1_id = str(uuid.uuid1())
        with pytest.raises(ValueError) as exc_info:
            make_context(correlation_id=uuid1_id)
        assert "uuid4" in str(exc_info.value).lower() or "4" in str(exc_info.value), (
            f"Expected error about UUID4 format, got: {exc_info.value}"
        )

    def test_wrong_format_no_dashes_raises(self) -> None:
        """A UUID without dashes raises ValueError."""
        no_dashes = "550e8400e29b41d4a716446655440000"
        with pytest.raises(ValueError):
            make_context(correlation_id=no_dashes)

    def test_arbitrary_string_raises(self) -> None:
        """Arbitrary strings raise ValueError."""
        with pytest.raises(ValueError):
            make_context(correlation_id="test-correlation-id")

    def test_partial_uuid_raises(self) -> None:
        """A partial UUID string raises ValueError."""
        with pytest.raises(ValueError):
            make_context(correlation_id="550e8400-e29b-41d4")

    def test_error_message_includes_invalid_value(self) -> None:
        """ValueError message includes the invalid value."""
        bad_id = "bad-id-value"
        with pytest.raises(ValueError) as exc_info:
            make_context(correlation_id=bad_id)
        assert bad_id in str(exc_info.value), (
            f"Expected invalid value '{bad_id}' in error message: {exc_info.value}"
        )

    def test_error_message_provides_fix_guidance(self) -> None:
        """ValueError message tells user how to generate a valid UUID4."""
        with pytest.raises(ValueError) as exc_info:
            make_context(correlation_id="bad")
        # Should mention uuid or how to generate one
        error_lower = str(exc_info.value).lower()
        has_guidance = "uuid" in error_lower or "generate" in error_lower or "import" in error_lower
        assert has_guidance, (
            f"Expected error message to provide fix guidance, got: {exc_info.value}"
        )


# ---------------------------------------------------------------------------
# Optional fields and defaults
# ---------------------------------------------------------------------------


class TestContextDefaults:
    """Tests for optional field defaults in AgentExecutionContext."""

    def test_gateway_defaults_to_none(self) -> None:
        """gateway defaults to None (implemented in Phase 2)."""
        ctx = make_context()
        assert ctx.gateway is None, f"Expected gateway=None, got {ctx.gateway}"

    def test_mcp_registry_defaults_to_none(self) -> None:
        """mcp_registry defaults to None (implemented in Phase 5)."""
        ctx = make_context()
        assert ctx.mcp_registry is None, f"Expected mcp_registry=None, got {ctx.mcp_registry}"

    def test_guardrails_defaults_to_none(self) -> None:
        """guardrails defaults to None (implemented in Phase 3.5)."""
        ctx = make_context()
        assert ctx.guardrails is None, f"Expected guardrails=None, got {ctx.guardrails}"

    def test_request_metadata_defaults_to_empty_dict(self) -> None:
        """request_metadata defaults to empty dict."""
        ctx = make_context()
        assert ctx.request_metadata == {}, (
            f"Expected request_metadata={{}}, got {ctx.request_metadata}"
        )

    def test_session_id_defaults_to_none(self) -> None:
        """session_id defaults to None."""
        ctx = make_context()
        assert ctx.session_id is None, f"Expected session_id=None, got {ctx.session_id}"

    def test_config_is_stored(self) -> None:
        """AgentConfig passed to constructor is stored on ctx.config."""
        config = AgentConfig()
        ctx = AgentExecutionContext(config=config)
        assert ctx.config is config, "Expected config to be stored as-is"


# ---------------------------------------------------------------------------
# Full construction with all fields
# ---------------------------------------------------------------------------


class TestContextFullConstruction:
    """Tests for construction with all fields explicitly set."""

    def test_full_context_construction(self) -> None:
        """AgentExecutionContext can be constructed with all fields."""
        config = AgentConfig()
        correlation_id = str(uuid.uuid4())
        metadata = {"trace_id": "abc-123"}
        ctx = AgentExecutionContext(
            config=config,
            gateway=None,
            mcp_registry=None,
            guardrails=None,
            request_metadata=metadata,
            session_id="sess-001",
            correlation_id=correlation_id,
        )
        assert ctx.config is config, "Expected config to be stored"
        assert ctx.correlation_id == correlation_id, "Expected correlation_id to be stored"
        assert ctx.request_metadata == metadata, "Expected metadata to be stored"
        assert ctx.session_id == "sess-001", "Expected session_id='sess-001'"
