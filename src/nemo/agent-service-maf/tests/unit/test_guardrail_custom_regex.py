"""Unit tests for the custom regex guardrail (Task 004 #3).

Covers operator ``patterns[]`` matching, each ``action_on_trigger``, the
empty-patterns no-op (always ALLOW), invalid-regex build failure, configurable
placeholder, case sensitivity, and placeholder-skip behaviour.
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.custom_regex import CustomRegexGuard


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


class TestCustomRegexGuard:
    def test_name(self) -> None:
        assert CustomRegexGuard().name == "custom_regex"

    def test_default_action_is_modify(self) -> None:
        g = CustomRegexGuard(config={"patterns": ["x"]})
        assert g._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_pattern_match_redacted(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"PROJ-\d{5}"]})
        result = await g.check(_ctx("Ticket PROJ-12345 is open."))
        assert result.action == GuardrailAction.MODIFY
        content = result.modified_content or ""
        assert "PROJ-12345" not in content
        assert "[CUSTOM_REDACTED]" in content

    async def test_custom_placeholder(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"\bAcme Corp\b"], "placeholder": "[REMOVED]"})
        result = await g.check(_ctx("Contact Acme Corp today."))
        assert result.action == GuardrailAction.MODIFY
        assert "[REMOVED]" in (result.modified_content or "")

    async def test_multiple_patterns(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"PROJ-\d+", r"\bsecret\b"]})
        result = await g.check(_ctx("PROJ-99 holds a secret value."))
        assert result.action == GuardrailAction.MODIFY
        assert (result.details or {})["match_count"] == 2

    async def test_case_insensitive_default(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"classified"]})
        result = await g.check(_ctx("This is CLASSIFIED material."))
        assert result.action == GuardrailAction.MODIFY

    async def test_case_sensitive_when_disabled(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"classified"], "case_insensitive": False})
        result = await g.check(_ctx("This is CLASSIFIED material."))
        assert result.action == GuardrailAction.ALLOW

    async def test_no_match_allows(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"PROJ-\d{5}"]})
        result = await g.check(_ctx("Nothing sensitive here."))
        assert result.action == GuardrailAction.ALLOW

    async def test_empty_patterns_always_allow(self) -> None:
        g = CustomRegexGuard(config={"patterns": []})
        result = await g.check(_ctx("anything at all PROJ-12345"))
        assert result.action == GuardrailAction.ALLOW

    async def test_missing_patterns_always_allow(self) -> None:
        g = CustomRegexGuard()
        result = await g.check(_ctx("anything at all"))
        assert result.action == GuardrailAction.ALLOW

    def test_invalid_regex_raises_configuration_error(self) -> None:
        with pytest.raises(ConfigurationError):
            CustomRegexGuard(config={"patterns": ["("]})

    async def test_block_action(self) -> None:
        g = CustomRegexGuard(
            config={"patterns": [r"(?i)\bclassified\b"], "action_on_trigger": "block"}
        )
        result = await g.check(_ctx("This is classified."))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_warn_action(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"\bsecret\b"], "action_on_trigger": "warn"})
        result = await g.check(_ctx("a secret here"))
        assert result.action == GuardrailAction.WARN
        assert result.modified_content is None

    async def test_custom_message(self) -> None:
        g = CustomRegexGuard(
            config={
                "patterns": [r"\bsecret\b"],
                "action_on_trigger": "block",
                "message": "blocked by policy",
            }
        )
        result = await g.check(_ctx("a secret here"))
        assert result.message == "blocked by policy"

    async def test_existing_placeholder_not_double_wrapped(self) -> None:
        # A pattern that would match inside an existing redaction placeholder.
        g = CustomRegexGuard(config={"patterns": [r"REDACTED"]})
        result = await g.check(_ctx("value [PAN_REDACTED] here"))
        assert result.action == GuardrailAction.ALLOW

    async def test_details_never_contain_matched_text(self) -> None:
        g = CustomRegexGuard(config={"patterns": [r"PROJ-\d{5}"]})
        result = await g.check(_ctx("Ticket PROJ-12345 open."))
        assert result.details is not None
        assert "PROJ-12345" not in str(result.details)
        assert result.details["pattern_count"] == 1
