"""Tests for HistoryReconstructor."""

from src.history_reconstructor import (
    HistoryReconstructor,
    ReconstructedMessage,
)


def _records_simple_user_assistant() -> list[dict]:
    return [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there"},
        {"role": "user", "content": "how are you"},
        {"role": "assistant", "content": "great"},
    ]


def _records_with_tool_calls() -> list[dict]:
    return [
        {"role": "user", "content": "search for X"},
        {
            "role": "assistant",
            "content": "Found 3 results.",
            "toolCalls": [
                {
                    "toolCallId": "call_abc",
                    "toolName": "search",
                    "args": {"q": "X"},
                    "result": {"hits": 3},
                }
            ],
        },
    ]


class TestSimpleRoundtrip:
    def test_empty_returns_empty(self):
        r = HistoryReconstructor()
        assert r.from_session_records([], provider="anthropic", model_supports_tools=True) == []

    def test_user_and_assistant(self):
        r = HistoryReconstructor()
        out = r.from_session_records(
            _records_simple_user_assistant(),
            provider="anthropic",
            model_supports_tools=True,
        )
        assert len(out) == 4
        assert [m.role for m in out] == ["user", "assistant", "user", "assistant"]
        assert out[0].content == "hello"
        assert out[3].content == "great"


class TestToolCycles:
    def test_tool_cycles_expanded_when_supported(self):
        r = HistoryReconstructor()
        out = r.from_session_records(
            _records_with_tool_calls(),
            provider="anthropic",
            model_supports_tools=True,
        )
        # Expected: user, assistant(tool_calls), tool, assistant(final_text)
        assert len(out) == 4
        assert out[0].role == "user"
        assert out[1].role == "assistant"
        assert out[1].tool_calls is not None
        assert out[1].tool_calls[0]["id"] == "call_abc"
        assert out[2].role == "tool"
        assert out[2].tool_call_id == "call_abc"
        assert out[3].role == "assistant"
        assert out[3].content == "Found 3 results."

    def test_tool_cycles_dropped_with_hint_when_not_supported(self):
        r = HistoryReconstructor()
        out = r.from_session_records(
            _records_with_tool_calls(),
            provider="openai",
            model_supports_tools=False,
        )
        # Expected: user, assistant(hint+content) — no expansion
        assert len(out) == 2
        assert out[0].role == "user"
        assert out[1].role == "assistant"
        assert out[1].tool_calls is None
        assert "Assistant used tools" in out[1].content
        assert "Found 3 results." in out[1].content

    def test_tool_call_id_synthesized_when_missing(self):
        r = HistoryReconstructor()
        records = [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": "done",
                "toolCalls": [
                    {"toolName": "x", "args": {}, "result": "ok"},  # no toolCallId
                ],
            },
        ]
        out = r.from_session_records(records, provider="anthropic", model_supports_tools=True)
        # find the tool message
        tool_msgs = [m for m in out if m.role == "tool"]
        assistant_with_calls = [m for m in out if m.role == "assistant" and m.tool_calls]
        assert len(tool_msgs) == 1
        assert len(assistant_with_calls) == 1
        # IDs must match between tool_calls[i].id and the tool message
        synth_id = assistant_with_calls[0].tool_calls[0]["id"]
        assert tool_msgs[0].tool_call_id == synth_id
        assert synth_id.startswith("reconstructed-")


class TestTextLength:
    def test_text_length_includes_tool_calls(self):
        m = ReconstructedMessage(
            role="assistant",
            content="",
            tool_calls=[{"id": "x", "type": "function", "function": {"name": "foo", "arguments": "{}"}}],
        )
        assert m.text_length() > 0
