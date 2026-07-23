"""Unit tests for ``translate_memory_blob`` — the bridge between
config-service's camelCase memory schema and MAF's snake_case
``MemorySection``.

Without this translation every "memory variant" team in the UI silently
runs with MAF defaults regardless of what the operator configured. The
tests below pin the mapping that exists today so a future schema rename
on either side fails loudly instead of silently.
"""

from __future__ import annotations

import pytest

from agent_service_maf.config.remote_adapter import (
    team_blob_to_maf_payload,
    translate_memory_blob,
)


class TestTranslateMemoryBlob:
    def test_memory_type_none_disables(self) -> None:
        out = translate_memory_blob("none", {})
        assert out == {"enabled": False}

    def test_sliding_window_with_window_size(self) -> None:
        out = translate_memory_blob(
            "sliding_window",
            {"windowSize": 8},
        )
        assert out["enabled"] is True
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 8

    def test_conversation_with_summary_strategy_becomes_summary_buffer(self) -> None:
        out = translate_memory_blob(
            "conversation",
            {
                "windowSize": 4,
                "contextStrategy": "summary_buffer",
                "summaryModel": "azure/gpt-4.1-mini",
                "verbatimTurns": 4,
            },
        )
        assert out["buffer_type"] == "summary"
        assert out["max_history_length"] == 4
        assert out["summary_model"] == "azure/gpt-4.1-mini"

    def test_conversation_without_summary_strategy_is_sliding_window(self) -> None:
        out = translate_memory_blob("conversation", {"windowSize": 10})
        assert out["buffer_type"] == "sliding_window"
        assert out["max_history_length"] == 10

    @pytest.mark.parametrize("strategy", ["summarize", "summary_buffer", "hybrid"])
    def test_summary_strategies_map_to_summary(self, strategy: str) -> None:
        out = translate_memory_blob(
            "conversation",
            {"contextStrategy": strategy},
        )
        assert out["buffer_type"] == "summary"

    @pytest.mark.parametrize("strategy", ["trim", "sliding_window_strict", "none", ""])
    def test_non_summary_strategies_keep_sliding_window(self, strategy: str) -> None:
        out = translate_memory_blob(
            "conversation",
            {"contextStrategy": strategy},
        )
        assert out["buffer_type"] == "sliding_window"

    def test_verbatim_turns_fills_when_window_size_missing(self) -> None:
        out = translate_memory_blob(
            "conversation",
            {"contextStrategy": "summary_buffer", "verbatimTurns": 6},
        )
        assert out["max_history_length"] == 6

    def test_window_size_wins_over_verbatim_turns(self) -> None:
        out = translate_memory_blob(
            "conversation",
            {
                "contextStrategy": "summary_buffer",
                "windowSize": 3,
                "verbatimTurns": 8,
            },
        )
        assert out["max_history_length"] == 3

    def test_snake_case_passthrough_wins(self) -> None:
        """An already-translated payload (or hand-written JSON) keeps
        explicit snake_case keys."""
        out = translate_memory_blob(
            "sliding_window",
            {
                "windowSize": 10,
                "max_history_length": 25,
                "max_chars_per_session": 5000,
            },
        )
        assert out["max_history_length"] == 25
        assert out["max_chars_per_session"] == 5000

    def test_empty_returns_empty(self) -> None:
        assert translate_memory_blob(None, None) == {}
        assert translate_memory_blob("", {}) == {}

    def test_unknown_memory_type_passes_config_through(self) -> None:
        """An unknown memoryType shouldn't crash — just pass nested
        snake_case fields and let MemorySection validate."""
        out = translate_memory_blob(
            "future_value",
            {"max_history_length": 12},
        )
        assert out["max_history_length"] == 12


class TestTeamBlobIntegration:
    """Verify ``team_blob_to_maf_payload`` actually wires the translator
    so the camelCase keys never reach MemorySection."""

    def _stub_team_blob(self, **memory_fields) -> dict:
        return {
            "id": "agr-test",
            "project_id": "proj-test",
            "name": "test-team",
            "members": [],
            **memory_fields,
        }

    def test_team_payload_emits_snake_case_memory(self) -> None:
        blob = self._stub_team_blob(
            memoryType="conversation",
            memoryConfig={
                "windowSize": 4,
                "contextStrategy": "summary_buffer",
                "summaryModel": "azure/gpt-4.1-mini",
            },
        )
        payload = team_blob_to_maf_payload(blob, [])
        assert payload["memory"]["buffer_type"] == "summary"
        assert payload["memory"]["max_history_length"] == 4
        assert payload["memory"]["summary_model"] == "azure/gpt-4.1-mini"
        # camelCase must NOT leak through.
        assert "windowSize" not in payload["memory"]
        assert "contextStrategy" not in payload["memory"]

    def test_team_payload_disabled_memory(self) -> None:
        blob = self._stub_team_blob(memoryType="none", memoryConfig={})
        payload = team_blob_to_maf_payload(blob, [])
        assert payload["memory"] == {"enabled": False}

    def test_team_payload_no_memory_keys_emits_default_window(self) -> None:
        """Locked memory-context design: when the blob carries NO memory
        fields, ``resolve_memory`` tier 3 emits the absolute default
        (20-message sliding window) so every agent invocation has a
        concrete cap. Replaces the pre-refactor behavior where the
        section was omitted and the framework's MemorySection defaults
        took over."""
        blob = self._stub_team_blob()
        payload = team_blob_to_maf_payload(blob, [])
        assert payload["memory"] == {
            "enabled": True,
            "buffer_type": "sliding_window",
            "max_history_length": 20,
        }
