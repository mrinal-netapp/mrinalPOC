"""Tests for ContextManager: budget formula, trim, aggressive_trim, fallback chain."""

import asyncio

import pytest

from src.context_manager import (
    ContextManager,
    MemoryConfig,
    SingleTurnOverflowError,
    resolve_context_window,
    resolve_output_reservation,
    resolve_safety_buffer,
)
from src.history_reconstructor import HistoryReconstructor


@pytest.fixture
def cm() -> ContextManager:
    return ContextManager(history_reconstructor=HistoryReconstructor())


def _run(coro):
    """Run an async coroutine in tests without pytest-asyncio."""
    return asyncio.run(coro)


def _make_records(n_turns: int, chars_per_turn: int = 4000) -> list[dict]:
    """Build a session of n_turns user/assistant pairs."""
    records: list[dict] = []
    for i in range(n_turns):
        records.append({"role": "user", "content": "u" * chars_per_turn})
        records.append({"role": "assistant", "content": "a" * chars_per_turn})
    return records


def _default_memory_config(strategy: str = "trim") -> MemoryConfig:
    return MemoryConfig(
        context_strategy=strategy,  # type: ignore[arg-type]
        memory_type="conversation",
    )


class TestResolveContextWindow:
    def test_explicit_wins(self):
        ctx, src = resolve_context_window(150_000, "openai")
        assert ctx == 150_000 and src == "enriched"

    def test_provider_fallback(self):
        ctx, src = resolve_context_window(None, "anthropic")
        assert ctx == 200_000 and src == "provider_fallback"

    def test_default_when_unknown_provider(self):
        ctx, src = resolve_context_window(None, "some_unknown_provider")
        assert src == "default"

    def test_zero_explicit_treated_as_missing(self):
        ctx, src = resolve_context_window(0, "openai")
        assert ctx > 0 and src in ("provider_fallback", "default")


class TestResolveOutputReservation:
    def test_uses_agent_max_tokens_when_set(self):
        assert resolve_output_reservation(2048, None, False, False) == 2048

    def test_falls_back_to_model_max(self):
        assert resolve_output_reservation(None, 4096, False, False) == 4096

    def test_capped_at_regular_default(self):
        # 100_000 hard-capped at 8192 (regular)
        assert resolve_output_reservation(100_000, None, False, False) == 8192

    def test_extended_output_higher_cap(self):
        # 100_000 capped at 65536 (extended)
        assert resolve_output_reservation(100_000, None, True, False) == 65536

    def test_outcome_schema_multiplier(self):
        # 4000 * 1.4 = 5600 (under cap of 8192)
        assert resolve_output_reservation(4000, None, False, True) == 5600

    def test_outcome_schema_capped(self):
        # 7000 * 1.4 = 9800 -> cap 8192
        assert resolve_output_reservation(7000, None, False, True) == 8192


class TestResolveSafetyBuffer:
    def test_returns_percentage_when_under_cap(self):
        assert resolve_safety_buffer(50_000, 0.05) == 2500

    def test_capped_at_default(self):
        # 1M * 5% = 50k, capped at 4096
        assert resolve_safety_buffer(1_000_000, 0.05) == 4096


class TestPrepareTrim:
    def test_passthrough_when_fits(self, cm: ContextManager):
        prepared = _run(cm.prepare(
            owner_kind="agent",
            owner_id="a1",
            user_id="u1",
            session_id="s1",
            system_prompt="You are helpful.",
            tool_schemas_text="",
            user_msg_content="hello",
            history_records=_make_records(2, chars_per_turn=200),
            provider="anthropic",
            model="claude-sonnet-4-6",
            context_window=200_000,
            context_window_source="enriched",
            memory_config=_default_memory_config(),
            has_tools=False,
            output_reservation=4096,
        ))
        assert prepared.strategy_used == "passthrough"
        assert prepared.trimmed_turn_count == 0
        # system + 4 history + final user = 6 messages
        assert len(prepared.messages) == 6

    def test_trim_when_overflows(self, cm: ContextManager):
        # Force overflow with a small context window
        prepared = _run(cm.prepare(
            owner_kind="agent",
            owner_id="a1",
            user_id="u1",
            session_id="s1",
            system_prompt="sys",
            tool_schemas_text="",
            user_msg_content="now",
            history_records=_make_records(20, chars_per_turn=4000),  # ~160k chars
            provider="openai",
            model="gpt-4o",
            context_window=8_000,
            context_window_source="enriched",
            memory_config=_default_memory_config(),
            has_tools=False,
            output_reservation=2048,
        ))
        assert prepared.strategy_used == "trim"
        assert prepared.trimmed_turn_count > 0
        # Sanity: trimmed result should be smaller than full
        assert len(prepared.messages) < (20 * 2 + 2)  # history + system + final user

    def test_floor_case_raises(self, cm: ContextManager):
        # System prompt alone exceeds context window
        with pytest.raises(SingleTurnOverflowError):
            _run(cm.prepare(
                owner_kind="agent",
                owner_id="a1",
                user_id="u1",
                session_id="s1",
                system_prompt="x" * 200_000,  # huge system prompt
                tool_schemas_text="",
                user_msg_content="hi",
                history_records=[],
                provider="openai",
                model="gpt-4",
                context_window=8_000,
                context_window_source="enriched",
                memory_config=_default_memory_config(),
                has_tools=False,
                output_reservation=2048,
            ))

    def test_summarize_falls_back_to_trim_when_disabled(self, cm: ContextManager, monkeypatch):
        # CONTEXT_MANAGER_SUMMARIZATION_ENABLED defaults to False
        prepared = _run(cm.prepare(
            owner_kind="agent",
            owner_id="a1",
            user_id="u1",
            session_id="s1",
            system_prompt="sys",
            tool_schemas_text="",
            user_msg_content="now",
            history_records=_make_records(20, chars_per_turn=4000),
            provider="openai",
            model="gpt-4o",
            context_window=8_000,
            context_window_source="enriched",
            memory_config=_default_memory_config(strategy="summarize"),
            has_tools=False,
            output_reservation=2048,
        ))
        assert prepared.strategy_used == "trim"
        assert any("summarization disabled" in n for n in prepared.notes)


class TestAggressiveTrim:
    def test_keeps_system_and_final_user(self, cm: ContextManager):
        from src.history_reconstructor import ReconstructedMessage as RM
        messages = [
            RM(role="system", content="sys"),
            RM(role="user", content="u1"),
            RM(role="assistant", content="a1"),
            RM(role="user", content="u2"),
            RM(role="assistant", content="a2"),
            RM(role="user", content="u3"),
            RM(role="assistant", content="a3"),
            RM(role="user", content="u4_final"),
        ]
        out = cm.aggressive_trim(messages)
        assert out[0].role == "system" and out[0].content == "sys"
        assert out[-1].content == "u4_final"
        # Should have dropped roughly half the history turns
        assert len(out) < len(messages)

    def test_empty_input(self, cm: ContextManager):
        assert cm.aggressive_trim([]) == []


class TestMemoryTypeNone:
    def test_no_history_injected(self, cm: ContextManager):
        prepared = _run(cm.prepare(
            owner_kind="agent",
            owner_id="a1",
            user_id="u1",
            session_id="s1",
            system_prompt="sys",
            tool_schemas_text="",
            user_msg_content="hello",
            history_records=_make_records(5, chars_per_turn=200),
            provider="anthropic",
            model="claude-sonnet-4-6",
            context_window=200_000,
            context_window_source="enriched",
            memory_config=MemoryConfig(memory_type="none"),
            has_tools=False,
            output_reservation=4096,
        ))
        # system + user only
        assert len(prepared.messages) == 2
        assert prepared.messages[0].role == "system"
        assert prepared.messages[1].role == "user"
