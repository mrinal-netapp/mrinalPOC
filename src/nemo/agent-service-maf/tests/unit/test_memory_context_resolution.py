"""Unit tests for the memory-context resolution chain in
:mod:`agent_service_maf.config.remote_adapter`.

Covers the three public entry points:

* :func:`_legacy_agent_memory_context_to_new` — converts the original
  AgentMemoryContext dict (``message_retention_policy`` + ``message_history_limit``)
  to the new unified shape.
* :func:`translate_memory_context` — translates the new ``memoryContext``
  schema into the snake-case dict consumed by ``MemorySection``,
  applying defaults locked by the design.
* :func:`resolve_memory` — the 3-tier dual-read fallback chain that
  prefers the new shape over the legacy ``memoryType`` / ``memoryConfig``
  pair, and falls back to a 20-message window when neither is present.

These tests complement the existing ``test_remote_adapter_memory.py``
suite (which exercises the legacy translator) by covering the new
schema and the fallback chain that ships the locked design.
"""

from __future__ import annotations

import pytest

from agent_service_maf.config.remote_adapter import (
    _DEFAULT_MESSAGE_WINDOW_LIMIT,
    _DEFAULT_SUMMARY_REFRESH_EVERY_TURNS,
    _DEFAULT_SUMMARY_TOKEN_LIMIT,
    _legacy_agent_memory_context_to_new,
    resolve_memory,
    translate_memory_context,
)

# ---------------------------------------------------------------------------
# _legacy_agent_memory_context_to_new
# ---------------------------------------------------------------------------


class TestLegacyAgentMemoryContextToNew:
    def test_enabled_false_returns_none_type(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {"enabled": False, "message_retention_policy": "sliding_window"},
        )
        assert out == {"enabled": False, "type": "none"}

    def test_policy_none_returns_none_type(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {"enabled": True, "message_retention_policy": "none"},
        )
        assert out == {"enabled": False, "type": "none"}

    def test_message_history_limit_zero_disables(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": 0,
            },
        )
        assert out == {"enabled": False, "type": "none"}

    def test_sliding_window_with_positive_limit(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": 7,
            },
        )
        assert out == {"enabled": True, "type": "window", "message_window_limit": 7}

    def test_summarize_maps_to_summary_buffer(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {
                "enabled": True,
                "message_retention_policy": "summarize",
                "message_history_limit": 12,
            },
        )
        assert out == {
            "enabled": True,
            "type": "summary_buffer",
            "message_window_limit": 12,
        }

    def test_summarize_without_limit(self) -> None:
        """A summarize policy with no limit emits the type but no
        message_window_limit (translator will apply the default)."""
        out = _legacy_agent_memory_context_to_new(
            {"enabled": True, "message_retention_policy": "summarize"},
        )
        assert out == {"enabled": True, "type": "summary_buffer"}

    def test_unknown_policy_defaults_to_window(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {
                "enabled": True,
                "message_retention_policy": "made-up-policy",
                "message_history_limit": 5,
            },
        )
        assert out == {"enabled": True, "type": "window", "message_window_limit": 5}

    def test_non_string_policy_is_treated_as_default(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {"enabled": True, "message_retention_policy": 42, "message_history_limit": 3},
        )
        assert out == {"enabled": True, "type": "window", "message_window_limit": 3}

    def test_non_int_limit_is_ignored(self) -> None:
        out = _legacy_agent_memory_context_to_new(
            {
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": "10",  # str, not int
            },
        )
        assert out == {"enabled": True, "type": "window"}


# ---------------------------------------------------------------------------
# translate_memory_context
# ---------------------------------------------------------------------------


class TestTranslateMemoryContext:
    def test_none_input_returns_empty(self) -> None:
        assert translate_memory_context(None) == {}

    def test_empty_dict_returns_empty(self) -> None:
        assert translate_memory_context({}) == {}

    def test_non_dict_returns_empty(self) -> None:
        # The _coerce_dict helper turns scalars into {}.
        assert translate_memory_context(42) == {}
        assert translate_memory_context("a-string") == {}
        assert translate_memory_context([1, 2, 3]) == {}

    def test_enabled_false_short_circuits(self) -> None:
        out = translate_memory_context({"enabled": False, "type": "window"})
        assert out == {"enabled": False}

    def test_type_none_short_circuits(self) -> None:
        out = translate_memory_context({"type": "none"})
        assert out == {"enabled": False}

    def test_type_none_case_insensitive(self) -> None:
        out = translate_memory_context({"type": "  NONE  "})
        assert out == {"enabled": False}

    def test_window_type_emits_default_when_limit_absent(self) -> None:
        out = translate_memory_context({"type": "window"})
        assert out == {
            "enabled": True,
            "buffer_type": "sliding_window",
            "max_history_length": _DEFAULT_MESSAGE_WINDOW_LIMIT,
        }

    def test_window_type_emits_explicit_limit(self) -> None:
        out = translate_memory_context({"type": "window", "message_window_limit": 4})
        assert out["enabled"] is True
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 4

    def test_window_type_with_token_limit_emits_both(self) -> None:
        """Token limit is the locked tiebreaker — both fields are emitted
        so the runtime can apply the rule (token wins when set)."""
        out = translate_memory_context(
            {
                "type": "window",
                "message_window_limit": 50,
                "message_token_limit": 4096,
            },
        )
        assert out["max_history_length"] == 50
        assert out["max_tokens_per_session"] == 4096

    def test_summary_type_emits_defaults(self) -> None:
        out = translate_memory_context({"type": "summary"})
        assert out["enabled"] is True
        assert out["buffer_type"] == "summary"
        assert out["summary_max_tokens"] == _DEFAULT_SUMMARY_TOKEN_LIMIT
        assert out["summary_refresh_every_turns"] == _DEFAULT_SUMMARY_REFRESH_EVERY_TURNS
        # Summary type does NOT get a default message window (no verbatim tail).
        assert "max_history_length" not in out

    def test_summary_buffer_type_emits_window_default(self) -> None:
        """summary_buffer keeps a verbatim tail, so the default window
        limit applies just like the bare ``window`` type."""
        out = translate_memory_context({"type": "summary_buffer"})
        assert out["buffer_type"] == "summary"
        assert out["max_history_length"] == _DEFAULT_MESSAGE_WINDOW_LIMIT
        assert out["summary_max_tokens"] == _DEFAULT_SUMMARY_TOKEN_LIMIT

    def test_summary_explicit_token_limit_overrides_default(self) -> None:
        out = translate_memory_context(
            {"type": "summary", "summary_token_limit": 512},
        )
        assert out["summary_max_tokens"] == 512

    def test_summary_token_limit_zero_or_negative_falls_back_to_default(self) -> None:
        # Zero and negative are NOT treated as explicit user choices.
        out_zero = translate_memory_context({"type": "summary", "summary_token_limit": 0})
        assert out_zero["summary_max_tokens"] == _DEFAULT_SUMMARY_TOKEN_LIMIT

    def test_summary_refresh_every_turns_passthrough(self) -> None:
        out = translate_memory_context(
            {"type": "summary_buffer", "summary_refresh_every_turns": 6},
        )
        assert out["summary_refresh_every_turns"] == 6

    def test_summary_model_passthrough(self) -> None:
        out = translate_memory_context(
            {"type": "summary", "summary_model": "azure/gpt-4o-mini"},
        )
        assert out["summary_model"] == "azure/gpt-4o-mini"

    def test_summary_model_empty_string_is_not_emitted(self) -> None:
        out = translate_memory_context({"type": "summary", "summary_model": ""})
        assert "summary_model" not in out

    def test_summary_model_non_string_is_not_emitted(self) -> None:
        out = translate_memory_context({"type": "summary", "summary_model": 42})
        assert "summary_model" not in out

    def test_adaptive_summarize_nested_passthrough(self) -> None:
        out = translate_memory_context(
            {
                "type": "summary_buffer",
                "adaptive_summarize": {"overflow_threshold": 0.4},
            },
        )
        assert out["adaptive_summarize"] == {"overflow_threshold": 0.4}

    def test_adaptive_summarize_empty_dict_dropped(self) -> None:
        out = translate_memory_context(
            {"type": "summary_buffer", "adaptive_summarize": {}},
        )
        assert "adaptive_summarize" not in out

    def test_budget_nested_passthrough(self) -> None:
        out = translate_memory_context(
            {
                "type": "window",
                "budget": {
                    "tool_round_reservation": 1024,
                    "output_reservation": 2048,
                    "safety_buffer_pct": 0.1,
                },
            },
        )
        assert out["budget"] == {
            "tool_round_reservation": 1024,
            "output_reservation": 2048,
            "safety_buffer_pct": 0.1,
        }

    def test_unknown_type_yields_no_buffer_type(self) -> None:
        """An unrecognised type doesn't crash — buffer_type is omitted
        and the runtime falls back to its own default."""
        out = translate_memory_context({"type": "future_value"})
        # enabled stays True, but no buffer_type → MemorySection picks one.
        assert out["enabled"] is True
        assert "buffer_type" not in out

    def test_window_limit_zero_passes_through_defensively(self) -> None:
        """The config-service validator now rejects ``message_window_limit=0``
        at the API edge (range tightened to 1..200 to match the UI input
        and remove the round-trip ambiguity). The MAF translator stays
        tolerant of 0 in case it ever appears via a legacy row or a
        non-validating client — pin that the value passes through to
        ``max_history_length`` verbatim instead of being silently
        replaced by the default."""
        out = translate_memory_context({"type": "window", "message_window_limit": 0})
        assert out["max_history_length"] == 0

    def test_legacy_shape_is_normalized_before_translation(self) -> None:
        """A record carrying the legacy AgentMemoryContext shape (no
        ``type`` field, has ``message_retention_policy``) is normalized
        via _legacy_agent_memory_context_to_new before translation."""
        out = translate_memory_context(
            {
                "enabled": True,
                "message_retention_policy": "sliding_window",
                "message_history_limit": 9,
            },
        )
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 9


# ---------------------------------------------------------------------------
# resolve_memory (tier 1 → 2 → 3 chain)
# ---------------------------------------------------------------------------


class TestResolveMemory:
    def test_tier1_new_memory_context_wins(self) -> None:
        out = resolve_memory(
            {
                "memoryContext": {"type": "window", "message_window_limit": 4},
                "memoryType": "sliding_window",  # MUST be ignored
                "memoryConfig": {"windowSize": 999},
            },
        )
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 4

    def test_tier1_snake_case_alias_memory_context(self) -> None:
        out = resolve_memory(
            {"memory_context": {"type": "window", "message_window_limit": 3}},
        )
        assert out["max_history_length"] == 3

    def test_tier1_disabled_short_circuits(self) -> None:
        out = resolve_memory(
            {
                "memoryContext": {"enabled": False},
                "memoryType": "sliding_window",
                "memoryConfig": {"windowSize": 8},
            },
        )
        assert out == {"enabled": False}

    def test_tier2_legacy_fields_when_no_memory_context(self) -> None:
        out = resolve_memory(
            {
                "memoryType": "sliding_window",
                "memoryConfig": {"windowSize": 6},
            },
        )
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 6

    def test_tier2_legacy_memory_type_none(self) -> None:
        out = resolve_memory(
            {"memoryType": "none", "memoryConfig": {}},
        )
        assert out == {"enabled": False}

    def test_tier3_absolute_default_when_nothing_present(self) -> None:
        out = resolve_memory({"id": "some-team", "name": "no-memory"})
        assert out == {
            "enabled": True,
            "buffer_type": "sliding_window",
            "max_history_length": 20,
        }

    def test_tier3_default_is_a_fresh_copy_per_call(self) -> None:
        """Mutating the returned dict must not poison subsequent calls."""
        first = resolve_memory({})
        first["max_history_length"] = 999
        second = resolve_memory({})
        assert second["max_history_length"] == 20

    def test_empty_memory_context_falls_through_to_tier2(self) -> None:
        """An empty (``{}``) memoryContext should not count as a tier-1
        match — fall through to legacy."""
        out = resolve_memory(
            {
                "memoryContext": {},
                "memoryType": "sliding_window",
                "memoryConfig": {"windowSize": 5},
            },
        )
        assert out["max_history_length"] == 5

    def test_summary_model_passes_through_resolution(self) -> None:
        out = resolve_memory(
            {
                "memoryContext": {
                    "type": "summary",
                    "summary_model": "openai/gpt-4o-mini",
                },
            },
        )
        assert out["summary_model"] == "openai/gpt-4o-mini"

    @pytest.mark.parametrize("memory_context_value", [None, 0, [], False])
    def test_falsy_memory_context_falls_through(self, memory_context_value) -> None:
        """``None``, ``0``, ``[]``, ``False`` for memoryContext should
        not match tier 1 — fall through to tier 2 / tier 3."""
        out = resolve_memory({"memoryContext": memory_context_value})
        # No legacy fields → tier 3 default fires.
        assert out["max_history_length"] == 20
