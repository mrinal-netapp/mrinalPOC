"""Unit tests for GuardrailPipeline.

Tests cover:
- Empty pipeline passes content through unchanged
- ALLOW guardrail passes content through
- BLOCK guardrail raises the correct exception
- MODIFY guardrail chains modified_content to subsequent guardrails
- WARN guardrail logs and allows content through
- Short-circuit on BLOCK (remaining guardrails skipped)
- fail_open=True swallows internal errors and continues
- fail_open=False re-raises internal errors as GuardrailError
- check_input / check_output / check_tool method signatures
- ToolUnauthorizedError raised by check_tool on BLOCK
- OutputBlockedError raised by check_output on BLOCK
- context dict correlation_id extraction
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_service_maf.core.exceptions import (
    GuardrailError,
    InputBlockedError,
    OutputBlockedError,
    ToolUnauthorizedError,
)
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    OutputGuardrail,
    ToolGuardrail,
)
from agent_service_maf.guardrails.pipeline import GuardrailPipeline

# ---------------------------------------------------------------------------
# Helpers — mock guardrail factories
# ---------------------------------------------------------------------------


def _make_input_guard(
    action: GuardrailAction, name: str = "mock_input", modified: str = ""
) -> InputGuardrail:
    """Create a mock InputGuardrail that always returns the given action."""
    guard = MagicMock(spec=InputGuardrail)
    guard.name = name
    result = GuardrailResult(
        action=action,
        guardrail_name=name,
        message="test message",
        modified_content=modified if action == GuardrailAction.MODIFY else None,
    )
    guard.check = AsyncMock(return_value=result)
    return guard  # type: ignore[return-value]


def _make_output_guard(
    action: GuardrailAction, name: str = "mock_output", modified: str = ""
) -> OutputGuardrail:
    """Create a mock OutputGuardrail that always returns the given action."""
    guard = MagicMock(spec=OutputGuardrail)
    guard.name = name
    result = GuardrailResult(
        action=action,
        guardrail_name=name,
        message="test message",
        modified_content=modified if action == GuardrailAction.MODIFY else None,
    )
    guard.check = AsyncMock(return_value=result)
    return guard  # type: ignore[return-value]


def _make_tool_guard(action: GuardrailAction, name: str = "mock_tool") -> ToolGuardrail:
    """Create a mock ToolGuardrail that always returns the given action."""
    guard = MagicMock(spec=ToolGuardrail)
    guard.name = name
    result = GuardrailResult(action=action, guardrail_name=name, message="test")
    guard.check = AsyncMock(return_value=result)
    return guard  # type: ignore[return-value]


def _make_raising_input_guard(exc: Exception, name: str = "bad_guard") -> InputGuardrail:
    """Create a mock InputGuardrail whose check() raises an internal exception."""
    guard = MagicMock(spec=InputGuardrail)
    guard.name = name
    guard.check = AsyncMock(side_effect=exc)
    return guard  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Empty pipeline
# ---------------------------------------------------------------------------


class TestEmptyPipeline:
    """Tests for a pipeline with no guardrails registered."""

    async def test_check_input_returns_content_unchanged(self) -> None:
        """Empty pipeline must return the input unchanged."""
        pipeline = GuardrailPipeline()
        result = await pipeline.check_input("Hello!", "agent-1")
        assert result == "Hello!", "Empty pipeline must return input unchanged"

    async def test_check_output_returns_content_unchanged(self) -> None:
        """Empty pipeline must return output text unchanged."""
        pipeline = GuardrailPipeline()
        result = await pipeline.check_output("Response text", "agent-1")
        assert result == "Response text", "Empty pipeline must return output unchanged"

    async def test_check_tool_returns_none(self) -> None:
        """Empty tool pipeline must return None (no exception)."""
        pipeline = GuardrailPipeline()
        result = await pipeline.check_tool("search", {}, "agent-1")
        assert result is None, "check_tool must return None when all guardrails allow"


# ---------------------------------------------------------------------------
# ALLOW semantics
# ---------------------------------------------------------------------------


class TestAllowSemantics:
    """Tests for guardrails that return ALLOW."""

    async def test_single_allow_guardrail_passes_content(self) -> None:
        """Single ALLOW guardrail must let content through."""
        guard = _make_input_guard(GuardrailAction.ALLOW, "allow_guard")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        result = await pipeline.check_input("original text", "agent-1")
        assert result == "original text", "ALLOW guardrail must not modify content"

    async def test_multiple_allow_guardrails_all_called(self) -> None:
        """Multiple ALLOW guardrails must all be called in order."""
        g1 = _make_input_guard(GuardrailAction.ALLOW, "first")
        g2 = _make_input_guard(GuardrailAction.ALLOW, "second")
        pipeline = GuardrailPipeline(input_guardrails=[g1, g2])
        result = await pipeline.check_input("hello", "agent-1")
        assert result == "hello", "All-ALLOW pipeline must return original content"
        g1.check.assert_called_once()
        g2.check.assert_called_once()


# ---------------------------------------------------------------------------
# BLOCK semantics
# ---------------------------------------------------------------------------


class TestBlockSemantics:
    """Tests for guardrails that return BLOCK."""

    async def test_block_input_raises_input_blocked_error(self) -> None:
        """Input guardrail BLOCK must raise InputBlockedError."""
        guard = _make_input_guard(GuardrailAction.BLOCK, "blocker")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        with pytest.raises(InputBlockedError):
            await pipeline.check_input("bad input", "agent-1")

    async def test_block_output_raises_output_blocked_error(self) -> None:
        """Output guardrail BLOCK must raise OutputBlockedError."""
        guard = _make_output_guard(GuardrailAction.BLOCK, "out_blocker")
        pipeline = GuardrailPipeline(output_guardrails=[guard])
        with pytest.raises(OutputBlockedError):
            await pipeline.check_output("bad output", "agent-1")

    async def test_block_tool_raises_tool_unauthorized_error(self) -> None:
        """Tool guardrail BLOCK must raise ToolUnauthorizedError."""
        guard = _make_tool_guard(GuardrailAction.BLOCK, "tool_blocker")
        pipeline = GuardrailPipeline(tool_guardrails=[guard])
        with pytest.raises(ToolUnauthorizedError):
            await pipeline.check_tool("bad_tool", {}, "agent-1")

    async def test_block_short_circuits_remaining_guardrails(self) -> None:
        """Guardrails after a BLOCK must not be called."""
        g1 = _make_input_guard(GuardrailAction.BLOCK, "blocker")
        g2 = _make_input_guard(GuardrailAction.ALLOW, "never_reached")
        pipeline = GuardrailPipeline(input_guardrails=[g1, g2])
        with pytest.raises(InputBlockedError):
            await pipeline.check_input("text", "agent-1")
        g2.check.assert_not_called()

    async def test_block_error_message_contains_guardrail_name(self) -> None:
        """InputBlockedError message must include the blocking guardrail's name."""
        guard = _make_input_guard(GuardrailAction.BLOCK, "my_blocker")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        with pytest.raises(InputBlockedError, match="my_blocker"):
            await pipeline.check_input("text", "agent-1")


# ---------------------------------------------------------------------------
# MODIFY semantics
# ---------------------------------------------------------------------------


class TestModifySemantics:
    """Tests for guardrails that return MODIFY."""

    async def test_modify_replaces_content(self) -> None:
        """MODIFY guardrail must replace ctx.content with modified_content."""
        guard = _make_input_guard(GuardrailAction.MODIFY, "modifier", modified="sanitised text")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        result = await pipeline.check_input("original", "agent-1")
        assert result == "sanitised text", (
            "MODIFY action must replace content with modified_content"
        )

    async def test_modify_chains_to_next_guardrail(self) -> None:
        """The modified content from MODIFY must be passed to subsequent guardrails."""
        g1 = _make_input_guard(GuardrailAction.MODIFY, "first_modifier", modified="step1")
        g2 = _make_input_guard(GuardrailAction.ALLOW, "second")
        pipeline = GuardrailPipeline(input_guardrails=[g1, g2])
        result = await pipeline.check_input("original", "agent-1")
        assert result == "step1", (
            "Modified content from first guardrail must propagate to pipeline output"
        )
        # Verify second guardrail received modified content
        call_args = g2.check.call_args
        assert call_args is not None, "Second guardrail must be called"
        ctx_arg: GuardrailContext = call_args[0][0]
        assert ctx_arg.content == "step1", (
            "Second guardrail must receive the modified content from first guardrail"
        )

    async def test_two_modify_guardrails_chain(self) -> None:
        """Two MODIFY guardrails must each see the prior guardrail's output."""
        g1 = _make_input_guard(GuardrailAction.MODIFY, "m1", modified="first")
        g2_result = GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name="m2",
            modified_content="second",
        )
        g2 = MagicMock(spec=InputGuardrail)
        g2.name = "m2"
        g2.check = AsyncMock(return_value=g2_result)
        pipeline = GuardrailPipeline(input_guardrails=[g1, g2])  # type: ignore[arg-type]
        result = await pipeline.check_input("original", "agent-1")
        assert result == "second", "Second MODIFY guardrail must further transform the content"


# ---------------------------------------------------------------------------
# WARN semantics
# ---------------------------------------------------------------------------


class TestWarnSemantics:
    """Tests for guardrails that return WARN."""

    async def test_warn_allows_content_through(self) -> None:
        """WARN action must not alter content and must not raise."""
        guard = _make_input_guard(GuardrailAction.WARN, "warner")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        result = await pipeline.check_input("suspicious but allowed", "agent-1")
        assert result == "suspicious but allowed", "WARN must not modify content"

    async def test_warn_does_not_stop_pipeline(self) -> None:
        """WARN must not stop subsequent guardrails from running."""
        g1 = _make_input_guard(GuardrailAction.WARN, "warner")
        g2 = _make_input_guard(GuardrailAction.ALLOW, "final")
        pipeline = GuardrailPipeline(input_guardrails=[g1, g2])
        await pipeline.check_input("text", "agent-1")
        g2.check.assert_called_once()


# ---------------------------------------------------------------------------
# fail_open behaviour
# ---------------------------------------------------------------------------


class TestFailOpen:
    """Tests for fail_open error handling in the pipeline."""

    async def test_fail_open_true_swallows_internal_error(self) -> None:
        """fail_open=True must swallow internal guardrail exceptions."""
        broken = _make_raising_input_guard(RuntimeError("boom"), "broken")
        pipeline = GuardrailPipeline(input_guardrails=[broken], fail_open=True)
        result = await pipeline.check_input("some input", "agent-1")
        assert result == "some input", (
            "fail_open=True must allow content through when guardrail raises internally"
        )

    async def test_fail_open_false_raises_guardrail_error(self) -> None:
        """fail_open=False must re-raise internal errors as GuardrailError."""
        broken = _make_raising_input_guard(RuntimeError("internal failure"), "broken")
        pipeline = GuardrailPipeline(input_guardrails=[broken], fail_open=False)
        with pytest.raises(GuardrailError, match="internal error"):
            await pipeline.check_input("some input", "agent-1")

    async def test_fail_open_does_not_catch_input_blocked_error(self) -> None:
        """fail_open must not swallow InputBlockedError — those are intentional blocks."""
        guard = _make_input_guard(GuardrailAction.BLOCK, "intentional_block")
        pipeline = GuardrailPipeline(input_guardrails=[guard], fail_open=True)
        with pytest.raises(InputBlockedError):
            await pipeline.check_input("blocked input", "agent-1")

    async def test_fail_open_does_not_catch_tool_unauthorized_error(self) -> None:
        """fail_open must not swallow ToolUnauthorizedError."""
        guard = _make_tool_guard(GuardrailAction.BLOCK, "blocked_tool")
        pipeline = GuardrailPipeline(tool_guardrails=[guard], fail_open=True)
        with pytest.raises(ToolUnauthorizedError):
            await pipeline.check_tool("bad_tool", {}, "agent-1")

    async def test_fail_open_true_continues_after_broken_guard(self) -> None:
        """After swallowing broken guard's error, pipeline must continue to next guard."""
        broken = _make_raising_input_guard(ValueError("crash"), "broken")
        good = _make_input_guard(GuardrailAction.ALLOW, "good")
        pipeline = GuardrailPipeline(input_guardrails=[broken, good], fail_open=True)
        await pipeline.check_input("text", "agent-1")
        good.check.assert_called_once()


# ---------------------------------------------------------------------------
# Context and correlation_id extraction
# ---------------------------------------------------------------------------


class TestContextHandling:
    """Tests for context dict handling in pipeline methods."""

    async def test_check_input_with_correlation_id(self) -> None:
        """check_input must accept context dict with correlation_id."""
        guard = _make_input_guard(GuardrailAction.ALLOW, "guard")
        pipeline = GuardrailPipeline(input_guardrails=[guard])
        result = await pipeline.check_input(
            "text", "agent-1", context={"correlation_id": "abc-123"}
        )
        assert result == "text", "Content must pass through with correlation_id"

    async def test_check_output_with_original_input(self) -> None:
        """check_output must accept original_input parameter."""
        guard = _make_output_guard(GuardrailAction.ALLOW, "guard")
        pipeline = GuardrailPipeline(output_guardrails=[guard])
        result = await pipeline.check_output(
            "response", "agent-1", original_input="original question"
        )
        assert result == "response", "Content must pass through with original_input"

    async def test_check_tool_accepts_context(self) -> None:
        """check_tool must accept context dict."""
        guard = _make_tool_guard(GuardrailAction.ALLOW, "guard")
        pipeline = GuardrailPipeline(tool_guardrails=[guard])
        await pipeline.check_tool(
            "search", {"q": "hello"}, "agent-1", context={"correlation_id": "xyz-789"}
        )
        guard.check.assert_called_once()

    async def test_check_input_none_context_is_safe(self) -> None:
        """check_input with context=None must not raise."""
        pipeline = GuardrailPipeline()
        result = await pipeline.check_input("text", "agent-1", context=None)
        assert result == "text", "None context must be treated as empty dict"


# ---------------------------------------------------------------------------
# Multiple guardrail types in one pipeline
# ---------------------------------------------------------------------------


class TestMixedGuardrails:
    """Tests for pipelines with all three guardrail types."""

    async def test_independent_input_output_tool_guards(self) -> None:
        """Input, output, and tool guardrails must be fully independent."""
        in_guard = _make_input_guard(GuardrailAction.ALLOW, "in")
        out_guard = _make_output_guard(GuardrailAction.ALLOW, "out")
        tool_guard = _make_tool_guard(GuardrailAction.ALLOW, "tool")
        pipeline = GuardrailPipeline(
            input_guardrails=[in_guard],
            output_guardrails=[out_guard],
            tool_guardrails=[tool_guard],
        )
        in_result = await pipeline.check_input("input", "agent-1")
        out_result = await pipeline.check_output("output", "agent-1")
        await pipeline.check_tool("my_tool", {}, "agent-1")

        assert in_result == "input", "Input guard must not interfere with output"
        assert out_result == "output", "Output guard must not interfere with input"
        # Verify each guard was called exactly once for its respective phase
        in_guard.check.assert_called_once()
        out_guard.check.assert_called_once()
        tool_guard.check.assert_called_once()

    async def test_blocked_input_does_not_affect_output_guards(self) -> None:
        """Blocking input must not prevent subsequent output checks on different calls."""
        in_guard = _make_input_guard(GuardrailAction.BLOCK, "blocker")
        out_guard = _make_output_guard(GuardrailAction.ALLOW, "out")
        pipeline = GuardrailPipeline(
            input_guardrails=[in_guard],
            output_guardrails=[out_guard],
        )
        with pytest.raises(InputBlockedError):
            await pipeline.check_input("bad", "agent-1")
        # Output check must still work independently
        out_result = await pipeline.check_output("clean output", "agent-1")
        assert out_result == "clean output", (
            "Output guardrails must be independent from input blocks"
        )

    async def test_pipeline_init_with_none_guardrails(self) -> None:
        """Passing None for any guardrail list must produce an empty list."""
        pipeline = GuardrailPipeline(
            input_guardrails=None,
            output_guardrails=None,
            tool_guardrails=None,
        )
        result = await pipeline.check_input("text", "agent")
        assert result == "text", "None guardrail lists must behave as empty lists"
