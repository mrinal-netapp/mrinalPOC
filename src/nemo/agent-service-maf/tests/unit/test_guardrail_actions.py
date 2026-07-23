"""Unit tests for configurable ``action_on_trigger`` (Task 002).

Covers:
- ``resolve_action`` helper: default fallback, invalid value, disallowed action.
- ``pii_masker`` honouring ``modify`` / ``block`` / ``warn``.
- ``content_filter`` as a dual-phase guardrail honouring ``block`` / ``warn`` /
  ``modify`` (in-place redaction), including the input phase.
- Registry wiring: rule-level ``action_on_trigger`` is merged into instances, the
  same class yields two instances (input + output) with different actions, and
  rule-level wins over a ``config``-level value.
- Defaults: rules omitting ``action_on_trigger`` behave as before.
"""

from __future__ import annotations

import pytest

from agent_service_maf.config.validators import GuardrailRule, GuardrailSection
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    resolve_action,
)
from agent_service_maf.guardrails.catalog.content_filter import (
    _SECRET_PLACEHOLDER,
    ContentFilter,
)
from agent_service_maf.guardrails.catalog.pii_masker import PIIMasker
from agent_service_maf.guardrails.registry import GuardrailRegistry

_EMAIL_TEXT = "Reach me at maya@gmail.com please."
_SECRET_TEXT = "Token: sk-abcdefghijklmnopqrstuvwxyz123456"


def _input_ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_input(content, "agent-1", "corr-1")


def _output_ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


# ---------------------------------------------------------------------------
# resolve_action
# ---------------------------------------------------------------------------


class TestResolveAction:
    """Tests for the resolve_action helper."""

    _ALLOWED = frozenset({GuardrailAction.BLOCK, GuardrailAction.WARN})

    def test_none_returns_default(self) -> None:
        assert (
            resolve_action(None, default=GuardrailAction.BLOCK, allowed=self._ALLOWED)
            == GuardrailAction.BLOCK
        )

    def test_valid_allowed_value(self) -> None:
        assert (
            resolve_action("warn", default=GuardrailAction.BLOCK, allowed=self._ALLOWED)
            == GuardrailAction.WARN
        )

    def test_case_insensitive(self) -> None:
        assert (
            resolve_action(" WARN ", default=GuardrailAction.BLOCK, allowed=self._ALLOWED)
            == GuardrailAction.WARN
        )

    def test_invalid_value_returns_default(self) -> None:
        assert (
            resolve_action("nonsense", default=GuardrailAction.BLOCK, allowed=self._ALLOWED)
            == GuardrailAction.BLOCK
        )

    def test_disallowed_value_returns_default(self) -> None:
        # MODIFY is a real action but not in the allowed set -> falls back.
        assert (
            resolve_action("modify", default=GuardrailAction.BLOCK, allowed=self._ALLOWED)
            == GuardrailAction.BLOCK
        )


# ---------------------------------------------------------------------------
# pii_masker actions
# ---------------------------------------------------------------------------


class TestPIIMaskerActions:
    """pii_masker honours action_on_trigger."""

    async def test_default_is_modify(self) -> None:
        m = PIIMasker(config={})
        result = await m.check(_input_ctx(_EMAIL_TEXT))
        assert result.action == GuardrailAction.MODIFY
        assert "[EMAIL_REDACTED]" in (result.modified_content or "")

    async def test_modify_action(self) -> None:
        m = PIIMasker(config={"action_on_trigger": "modify"})
        result = await m.check(_input_ctx(_EMAIL_TEXT))
        assert result.action == GuardrailAction.MODIFY
        assert "maya@gmail.com" not in (result.modified_content or "")

    async def test_block_action(self) -> None:
        m = PIIMasker(config={"action_on_trigger": "block"})
        result = await m.check(_input_ctx(_EMAIL_TEXT))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_warn_action(self) -> None:
        m = PIIMasker(config={"action_on_trigger": "warn"})
        result = await m.check(_input_ctx(_EMAIL_TEXT))
        assert result.action == GuardrailAction.WARN

    async def test_clean_input_allows(self) -> None:
        m = PIIMasker(config={"action_on_trigger": "block"})
        result = await m.check(_input_ctx("Just a normal sentence."))
        assert result.action == GuardrailAction.ALLOW

    async def test_custom_message(self) -> None:
        m = PIIMasker(config={"action_on_trigger": "block", "message": "no PII allowed"})
        result = await m.check(_input_ctx(_EMAIL_TEXT))
        assert result.message == "no PII allowed"


# ---------------------------------------------------------------------------
# content_filter actions (input + output)
# ---------------------------------------------------------------------------


class TestContentFilterActions:
    """content_filter is dual-phase and honours action_on_trigger."""

    async def test_default_is_block_output(self) -> None:
        cf = ContentFilter(config={})
        result = await cf.check(_output_ctx(_SECRET_TEXT))
        assert result.action == GuardrailAction.BLOCK

    async def test_input_phase_blocks_secret(self) -> None:
        cf = ContentFilter(config={"action_on_trigger": "block"})
        result = await cf.check(_input_ctx(_SECRET_TEXT))
        assert result.action == GuardrailAction.BLOCK

    async def test_warn_action(self) -> None:
        cf = ContentFilter(config={"action_on_trigger": "warn"})
        result = await cf.check(_input_ctx(_SECRET_TEXT))
        assert result.action == GuardrailAction.WARN

    async def test_modify_redacts_secret(self) -> None:
        cf = ContentFilter(config={"action_on_trigger": "modify"})
        result = await cf.check(_output_ctx(_SECRET_TEXT))
        assert result.action == GuardrailAction.MODIFY
        assert result.modified_content is not None
        assert "sk-abcdefghijklmnopqrstuvwxyz123456" not in result.modified_content
        assert _SECRET_PLACEHOLDER in result.modified_content

    async def test_clean_content_allows(self) -> None:
        cf = ContentFilter(config={"action_on_trigger": "block"})
        result = await cf.check(_output_ctx("Nothing secret here."))
        assert result.action == GuardrailAction.ALLOW

    async def test_block_details_backward_compatible(self) -> None:
        cf = ContentFilter()
        result = await cf.check(_output_ctx(_SECRET_TEXT))
        assert result.details is not None
        assert "matched_pattern" in result.details


# ---------------------------------------------------------------------------
# Registry wiring
# ---------------------------------------------------------------------------


class TestRegistryActionWiring:
    """build_pipeline merges rule-level action_on_trigger into instances."""

    def test_dual_instance_different_actions(self) -> None:
        """Same class (pii_masker) -> two instances with different actions."""
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[
                GuardrailRule(name="pii_masker", action_on_trigger="modify"),
            ],
            output_guardrails=[
                GuardrailRule(name="pii_masker", action_on_trigger="block"),
            ],
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="a")

        input_guards = pipeline._input_guardrails
        output_guards = pipeline._output_guardrails
        assert len(input_guards) == 1
        assert len(output_guards) == 1
        assert input_guards[0]._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]
        assert output_guards[0]._trigger_action == GuardrailAction.BLOCK  # type: ignore[attr-defined]
        # Two distinct instances built from the same class.
        assert input_guards[0] is not output_guards[0]

    def test_rule_level_wins_over_config_level(self) -> None:
        """Rule-level action_on_trigger overrides a config-level value."""
        config = GuardrailSection(
            enabled=True,
            output_guardrails=[
                GuardrailRule(
                    name="pii_masker",
                    action_on_trigger="block",
                    config={"action_on_trigger": "warn"},
                ),
            ],
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="a")
        assert pipeline._output_guardrails[0]._trigger_action == GuardrailAction.BLOCK  # type: ignore[attr-defined]

    def test_default_action_when_omitted(self) -> None:
        """Omitting action_on_trigger uses the per-guardrail default (pii=modify)."""
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="pii_masker")],
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="a")
        # Omitting action_on_trigger uses the per-guardrail default (pii=modify).
        assert pipeline._input_guardrails[0]._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_pipeline_masks_on_input_blocks_on_output(self) -> None:
        """End-to-end through the pipeline: input masks, output blocks on PII."""
        from agent_service_maf.core.exceptions import OutputBlockedError

        config = GuardrailSection(
            enabled=True,
            input_guardrails=[
                GuardrailRule(name="pii_masker", action_on_trigger="modify"),
            ],
            output_guardrails=[
                GuardrailRule(name="pii_masker", action_on_trigger="block"),
            ],
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="a")

        masked = await pipeline.check_input(_EMAIL_TEXT, agent_id="a")
        assert "maya@gmail.com" not in masked
        assert "[EMAIL_REDACTED]" in masked

        with pytest.raises(OutputBlockedError):
            await pipeline.check_output(_EMAIL_TEXT, agent_id="a", original_input="x")
