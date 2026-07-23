"""Behavior tests for ``agent_framework._evaluation`` (EVALS experimental).

This module is the eval engine: ``EvalItem`` (query/response container),
the built-in check functions (``keyword_check``, ``tool_called_check``,
``tool_calls_present``, ``tool_call_args_match``), the ``@evaluator``
decorator that wraps plain functions, and ``LocalEvaluator`` which runs
checks without LLM calls.

Our existing tests don't import any of this, so it sits at 21%. The
production agent-eval worker exercises it end-to-end, but those tests
are integration-tier. These unit tests cover the pure-Python paths so
unit coverage stops under-reporting the file.

Coverage uplift target: ``_evaluation.py`` 21% → ~50%.
"""

from __future__ import annotations

import pytest
from agent_framework import Message
from agent_framework._evaluation import (
    CheckResult,
    ConversationSplit,
    EvalItem,
    EvalNotPassedError,
    EvalResults,
    ExpectedToolCall,
    LocalEvaluator,
    evaluator,
    keyword_check,
    tool_call_args_match,
    tool_called_check,
    tool_calls_present,
)
from agent_framework._types import Content


def _conversation(user_text: str, assistant_text: str) -> list[Message]:
    return [
        Message("user", [user_text]),
        Message("assistant", [assistant_text]),
    ]


# ---------------------------------------------------------------------------
# EvalItem
# ---------------------------------------------------------------------------


def test_eval_item_query_response_split_last_turn() -> None:
    item = EvalItem(conversation=_conversation("What's the weather?", "It's sunny."))
    assert item.query == "What's the weather?"
    assert item.response == "It's sunny."


def test_eval_item_full_split_evaluates_full_trajectory() -> None:
    convo = [
        Message("user", ["First question."]),
        Message("assistant", ["First answer."]),
        Message("user", ["Second question."]),
        Message("assistant", ["Second answer."]),
    ]
    item = EvalItem(conversation=convo, split_strategy=ConversationSplit.FULL)
    # FULL splits after the FIRST user msg, so response includes everything after.
    assert "First answer" in item.response
    assert "Second answer" in item.response


def test_eval_item_split_messages_returns_two_lists() -> None:
    item = EvalItem(conversation=_conversation("hi", "hello"))
    q, r = item.split_messages()
    assert len(q) == 1
    assert len(r) == 1


def test_eval_item_no_user_message_yields_empty_query() -> None:
    convo = [Message("assistant", ["Just talking to myself."])]
    item = EvalItem(conversation=convo)
    assert item.query == ""


# ---------------------------------------------------------------------------
# ExpectedToolCall
# ---------------------------------------------------------------------------


def test_expected_tool_call_dataclass() -> None:
    etc = ExpectedToolCall(name="get_weather", arguments={"city": "NYC"})
    assert etc.name == "get_weather"
    assert etc.arguments == {"city": "NYC"}

    # arguments defaults to None.
    etc2 = ExpectedToolCall(name="ping")
    assert etc2.arguments is None


# ---------------------------------------------------------------------------
# keyword_check
# ---------------------------------------------------------------------------


def test_keyword_check_passes_when_all_present() -> None:
    item = EvalItem(conversation=_conversation("temp?", "The weather is sunny, temperature 72F"))
    check = keyword_check("weather", "temperature")
    result = check(item)
    assert result.passed is True
    assert result.check_name == "keyword_check"


def test_keyword_check_fails_with_missing_words() -> None:
    item = EvalItem(conversation=_conversation("hello", "hi there"))
    check = keyword_check("weather", "temperature")
    result = check(item)
    assert result.passed is False
    assert "Missing keywords" in result.reason


def test_keyword_check_case_sensitive() -> None:
    item = EvalItem(conversation=_conversation("q?", "Weather report"))
    # Case-sensitive search for "weather" misses "Weather"
    assert keyword_check("weather", case_sensitive=True)(item).passed is False
    assert keyword_check("Weather", case_sensitive=True)(item).passed is True


# ---------------------------------------------------------------------------
# tool_called_check
# ---------------------------------------------------------------------------


def _conversation_with_tool_calls(*tool_names: str) -> list[Message]:
    contents = [
        Content.from_function_call(call_id=f"c{i}", name=name, arguments={})
        for i, name in enumerate(tool_names)
    ]
    return [
        Message("user", ["Use the tools"]),
        Message("assistant", list(contents)),
    ]


def test_tool_called_check_all_mode_pass() -> None:
    item = EvalItem(conversation=_conversation_with_tool_calls("get_weather", "get_flight"))
    check = tool_called_check("get_weather", "get_flight", mode="all")
    assert check(item).passed is True


def test_tool_called_check_all_mode_fail_missing() -> None:
    item = EvalItem(conversation=_conversation_with_tool_calls("get_weather"))
    check = tool_called_check("get_weather", "get_flight", mode="all")
    result = check(item)
    assert result.passed is False
    assert "get_flight" in result.reason


def test_tool_called_check_any_mode() -> None:
    item = EvalItem(conversation=_conversation_with_tool_calls("get_weather"))
    check = tool_called_check("get_weather", "get_flight", mode="any")
    assert check(item).passed is True

    item_no_tools = EvalItem(conversation=_conversation("hi", "hi"))
    assert tool_called_check("get_weather", mode="any")(item_no_tools).passed is False


# ---------------------------------------------------------------------------
# tool_calls_present
# ---------------------------------------------------------------------------


def test_tool_calls_present_no_expected_passes() -> None:
    item = EvalItem(conversation=_conversation("hi", "hi"))
    assert tool_calls_present(item).passed is True


def test_tool_calls_present_finds_expected() -> None:
    item = EvalItem(
        conversation=_conversation_with_tool_calls("get_weather"),
        expected_tool_calls=[ExpectedToolCall("get_weather")],
    )
    result = tool_calls_present(item)
    assert result.passed is True


def test_tool_calls_present_missing_fails() -> None:
    item = EvalItem(
        conversation=_conversation("hi", "hi"),
        expected_tool_calls=[ExpectedToolCall("get_weather")],
    )
    result = tool_calls_present(item)
    assert result.passed is False
    assert "get_weather" in result.reason


# ---------------------------------------------------------------------------
# tool_call_args_match
# ---------------------------------------------------------------------------


def test_tool_call_args_match_when_args_overlap() -> None:
    # Build a conversation with a tool call that has arguments.
    convo = [
        Message("user", ["weather in NYC"]),
        Message(
            "assistant",
            [
                Content.from_function_call(
                    call_id="c0", name="get_weather", arguments={"city": "NYC"}
                )
            ],
        ),
    ]
    item = EvalItem(
        conversation=convo,
        expected_tool_calls=[ExpectedToolCall(name="get_weather", arguments={"city": "NYC"})],
    )
    assert tool_call_args_match(item).passed is True


def test_tool_call_args_match_no_expected_passes() -> None:
    item = EvalItem(conversation=_conversation("hi", "hi"))
    assert tool_call_args_match(item).passed is True


# ---------------------------------------------------------------------------
# @evaluator decorator
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_evaluator_decorator_wraps_sync_function() -> None:
    @evaluator
    def mentions_weather(response: str) -> bool:
        return "weather" in response.lower()

    item = EvalItem(conversation=_conversation("q?", "the weather is fine"))
    result = await mentions_weather(item)
    assert isinstance(result, CheckResult)
    assert result.passed is True
    assert result.check_name == "mentions_weather"


@pytest.mark.asyncio
async def test_evaluator_decorator_with_name_kwarg() -> None:
    @evaluator(name="length_under_50")
    def is_short(response: str) -> bool:
        return len(response) < 50

    item = EvalItem(conversation=_conversation("q?", "short"))
    result = await is_short(item)
    assert result.check_name == "length_under_50"
    assert result.passed is True


@pytest.mark.asyncio
async def test_evaluator_decorator_supports_async_function() -> None:
    @evaluator
    async def async_check(query: str, response: str) -> float:
        # Return 1.0 → coerced to passed=True
        return 1.0 if query and response else 0.0

    item = EvalItem(conversation=_conversation("ask", "answer"))
    result = await async_check(item)
    assert result.passed is True


def test_evaluator_decorator_rejects_unknown_required_param() -> None:
    with pytest.raises(TypeError, match="unknown required parameter"):

        @evaluator
        def bad_eval(no_such_thing: str) -> bool:
            return True


@pytest.mark.asyncio
async def test_evaluator_can_return_dict_with_score() -> None:
    @evaluator
    def scorer(response: str) -> dict:
        return {"score": 0.8, "passed": True}

    item = EvalItem(conversation=_conversation("q?", "a"))
    result = await scorer(item)
    assert result.passed is True


# ---------------------------------------------------------------------------
# LocalEvaluator
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_local_evaluator_aggregates_pass_and_fail() -> None:
    item_pass = EvalItem(conversation=_conversation("q?", "weather report"))
    item_fail = EvalItem(conversation=_conversation("q?", "no answer here"))
    local = LocalEvaluator(keyword_check("weather"))
    results = await local.evaluate([item_pass, item_fail])
    assert isinstance(results, EvalResults)
    assert results.result_counts["passed"] == 1
    assert results.result_counts["failed"] == 1


@pytest.mark.asyncio
async def test_local_evaluator_failure_reasons_aggregated_in_error() -> None:
    item = EvalItem(conversation=_conversation("q?", "no answer here"))
    local = LocalEvaluator(keyword_check("weather"))
    results = await local.evaluate([item])
    assert results.error is not None
    assert "keyword_check" in results.error


# ---------------------------------------------------------------------------
# EvalNotPassedError
# ---------------------------------------------------------------------------


def test_eval_not_passed_error_is_subclass_of_exception() -> None:
    assert issubclass(EvalNotPassedError, Exception)
    # Instances are constructible.
    err = EvalNotPassedError("3 failed")
    assert "3 failed" in str(err)


# ---------------------------------------------------------------------------
# EvalResults.raise_for_status integration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_eval_results_raise_for_status_raises_on_failures() -> None:
    item = EvalItem(conversation=_conversation("q?", "no answer here"))
    local = LocalEvaluator(keyword_check("weather"))
    results = await local.evaluate([item])
    with pytest.raises(EvalNotPassedError):
        results.raise_for_status()


@pytest.mark.asyncio
async def test_eval_results_raise_for_status_silent_on_all_pass() -> None:
    item = EvalItem(conversation=_conversation("q?", "weather is sunny"))
    local = LocalEvaluator(keyword_check("weather"))
    results = await local.evaluate([item])
    # Should not raise.
    results.raise_for_status()
