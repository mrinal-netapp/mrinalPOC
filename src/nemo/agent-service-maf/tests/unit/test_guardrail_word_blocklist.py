"""Unit tests for the word/phrase blocklist guardrail (Task 004 #4).

Covers whole-word matching (no substring hits), contiguous phrase matching,
case sensitivity, empty-lists no-op (always ALLOW), each ``action_on_trigger``,
and the configurable placeholder on ``modify``.
"""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.word_blocklist import WordBlocklistGuard


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


class TestWordBlocklistGuard:
    def test_name(self) -> None:
        assert WordBlocklistGuard().name == "word_blocklist"

    def test_default_action_is_block(self) -> None:
        g = WordBlocklistGuard(config={"words": ["x"]})
        assert g._trigger_action == GuardrailAction.BLOCK  # type: ignore[attr-defined]

    async def test_word_whole_word_match(self) -> None:
        g = WordBlocklistGuard(config={"words": ["ass"]})
        result = await g.check(_ctx("what an ass that was"))
        assert result.action == GuardrailAction.BLOCK

    async def test_word_does_not_match_substring(self) -> None:
        g = WordBlocklistGuard(config={"words": ["ass"]})
        result = await g.check(_ctx("the class started on time"))
        assert result.action == GuardrailAction.ALLOW

    async def test_phrase_contiguous_match(self) -> None:
        g = WordBlocklistGuard(config={"phrases": ["Acme Corp"]})
        result = await g.check(_ctx("please contact Acme Corp today"))
        assert result.action == GuardrailAction.BLOCK

    async def test_phrase_flexible_whitespace(self) -> None:
        g = WordBlocklistGuard(config={"phrases": ["do not share"]})
        result = await g.check(_ctx("please do   not\tshare this"))
        assert result.action == GuardrailAction.BLOCK

    async def test_phrase_not_matched_when_words_interleaved(self) -> None:
        g = WordBlocklistGuard(config={"phrases": ["Acme Corp"]})
        result = await g.check(_ctx("Acme International Corp"))
        assert result.action == GuardrailAction.ALLOW

    async def test_case_insensitive_default(self) -> None:
        g = WordBlocklistGuard(config={"words": ["confidential"]})
        result = await g.check(_ctx("This is CONFIDENTIAL."))
        assert result.action == GuardrailAction.BLOCK

    async def test_case_sensitive_when_disabled(self) -> None:
        g = WordBlocklistGuard(config={"words": ["confidential"], "case_insensitive": False})
        result = await g.check(_ctx("This is CONFIDENTIAL."))
        assert result.action == GuardrailAction.ALLOW

    async def test_empty_lists_always_allow(self) -> None:
        g = WordBlocklistGuard(config={"words": [], "phrases": []})
        result = await g.check(_ctx("anything at all"))
        assert result.action == GuardrailAction.ALLOW

    async def test_missing_lists_always_allow(self) -> None:
        g = WordBlocklistGuard()
        result = await g.check(_ctx("anything at all"))
        assert result.action == GuardrailAction.ALLOW

    async def test_clean_text_allows(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"]})
        result = await g.check(_ctx("our product is great"))
        assert result.action == GuardrailAction.ALLOW

    async def test_modify_action_redacts(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"], "action_on_trigger": "modify"})
        result = await g.check(_ctx("the competitor is here"))
        assert result.action == GuardrailAction.MODIFY
        content = result.modified_content or ""
        assert "competitor" not in content
        assert "[BLOCKED]" in content

    async def test_modify_custom_placeholder(self) -> None:
        g = WordBlocklistGuard(
            config={
                "words": ["competitor"],
                "action_on_trigger": "modify",
                "placeholder": "[REDACTED]",
            }
        )
        result = await g.check(_ctx("the competitor is here"))
        assert "[REDACTED]" in (result.modified_content or "")

    async def test_warn_action(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"], "action_on_trigger": "warn"})
        result = await g.check(_ctx("the competitor is here"))
        assert result.action == GuardrailAction.WARN
        assert result.modified_content is None

    async def test_block_action_no_modification(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"]})
        result = await g.check(_ctx("the competitor is here"))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_custom_message(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"], "message": "policy violation"})
        result = await g.check(_ctx("the competitor is here"))
        assert result.message == "policy violation"

    async def test_words_and_phrases_combined(self) -> None:
        g = WordBlocklistGuard(
            config={
                "words": ["classified"],
                "phrases": ["do not share"],
                "action_on_trigger": "modify",
            }
        )
        result = await g.check(_ctx("this is classified, do not share it"))
        assert result.action == GuardrailAction.MODIFY
        assert (result.details or {})["match_count"] == 2

    async def test_details_never_contain_matched_text(self) -> None:
        g = WordBlocklistGuard(config={"words": ["competitor"]})
        result = await g.check(_ctx("the competitor is here"))
        assert result.details is not None
        assert "competitor" not in str(result.details)
        assert result.details["word_count"] == 1
