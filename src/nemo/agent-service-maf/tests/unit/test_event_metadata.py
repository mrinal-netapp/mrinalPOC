"""Wire-contract tests for streaming event metadata TypedDicts.

The TypedDicts in :mod:`agent_service_maf.core.event_metadata` describe
the shape of every ``AgentEvent.metadata`` payload on the wire. Python
does NOT enforce TypedDict shapes at runtime, and ``__required_keys__``
/ ``__optional_keys__`` introspection does not honor ``NotRequired``
markers when the module uses ``from __future__ import annotations``
(annotations are stored as strings, not types). So these tests pin the
contract via ``__annotations__`` introspection on the raw string form
— if a refactor renames a field (e.g. ``toolCallId`` → ``tool_call_id``)
or drops a ``NotRequired`` wrapper, the test breaks even though Python
would otherwise accept the change silently. mypy --strict in CI catches
the same issues at the call sites; these tests pin the module itself.

The keys are intentionally camelCase to match the §5.2 CamelCaseModel
wire convention. Do not "fix" them to snake_case without updating the
adapters and the SSE handler that emit them.
"""

from __future__ import annotations

from agent_service_maf.core.event_metadata import (
    ArtifactMetadata,
    CompletedMetadata,
    ErrorMetadata,
    StartedMetadata,
    StreamStats,
    ThinkingMetadata,
    TokenMetadata,
    ToolCallMetadata,
    ToolResultMetadata,
)


def _not_required_keys(td: type) -> set[str]:
    """Return the subset of keys whose raw annotation is wrapped in
    ``NotRequired[...]``. We inspect the annotation source strings
    directly because ``from __future__ import annotations`` is on in
    the module, so ``__annotations__`` holds unresolved ``ForwardRef``
    objects and Python's ``__optional_keys__`` does not see the
    ``NotRequired`` markers."""
    return {
        k
        for k, v in td.__annotations__.items()
        if "NotRequired" in getattr(v, "__forward_arg__", str(v))
    }


# ---------------------------------------------------------------------------
# Started / Thinking / Token — total=False, all keys optional
# ---------------------------------------------------------------------------


class TestStartedMetadata:
    def test_keys_locked(self) -> None:
        assert set(StartedMetadata.__annotations__) == {"agentId", "framework"}

    def test_total_is_false(self) -> None:
        # total=False means every key is optional — the bare ``started``
        # sentinel must be valid with an empty metadata dict.
        assert StartedMetadata.__total__ is False


class TestThinkingMetadata:
    def test_keys_locked(self) -> None:
        assert set(ThinkingMetadata.__annotations__) == {"agentId"}

    def test_total_is_false(self) -> None:
        assert ThinkingMetadata.__total__ is False


class TestTokenMetadata:
    def test_keys_locked(self) -> None:
        assert set(TokenMetadata.__annotations__) == {"agentId"}

    def test_total_is_false(self) -> None:
        assert TokenMetadata.__total__ is False


# ---------------------------------------------------------------------------
# ToolCall / ToolResult — required keys lock the wire contract
# ---------------------------------------------------------------------------


class TestToolCallMetadata:
    def test_keys_locked(self) -> None:
        # Adapters MUST emit toolCallId / toolName / arguments; the
        # agent identifiers are optional (only required in multi-agent
        # orchestrations).
        assert set(ToolCallMetadata.__annotations__) == {
            "toolCallId",
            "toolName",
            "arguments",
            "agentId",
            "agentName",
        }

    def test_optional_keys_are_not_required(self) -> None:
        assert _not_required_keys(ToolCallMetadata) == {"agentId", "agentName"}

    def test_total_is_true(self) -> None:
        # total=True (the default) means the non-NotRequired keys are
        # mandatory. total=False would silently turn the contract advisory.
        assert ToolCallMetadata.__total__ is True


class TestToolResultMetadata:
    def test_keys_locked(self) -> None:
        # toolCallId pairs with the originating tool_call event; result
        # is the JSON-serializable payload. Both are load-bearing for
        # citation attribution.
        assert set(ToolResultMetadata.__annotations__) == {
            "toolCallId",
            "result",
            "durationMs",
            "agentId",
            "agentName",
            "kbCitations",
        }

    def test_optional_keys_are_not_required(self) -> None:
        # Everything except toolCallId and result is NotRequired.
        assert _not_required_keys(ToolResultMetadata) == {
            "durationMs",
            "agentId",
            "agentName",
            "kbCitations",
        }

    def test_total_is_true(self) -> None:
        assert ToolResultMetadata.__total__ is True


# ---------------------------------------------------------------------------
# Artifact — required type+name, optional payload variants
# ---------------------------------------------------------------------------


class TestArtifactMetadata:
    def test_keys_locked(self) -> None:
        assert set(ArtifactMetadata.__annotations__) == {
            "artifactType",
            "name",
            "mimeType",
            "downloadUrl",
            "inlineContent",
        }

    def test_optional_keys_are_not_required(self) -> None:
        # downloadUrl XOR inlineContent is the expected usage but the
        # TypedDict does not enforce the XOR — emitters that have both
        # may carry both. See the module docstring.
        assert _not_required_keys(ArtifactMetadata) == {
            "mimeType",
            "downloadUrl",
            "inlineContent",
        }


# ---------------------------------------------------------------------------
# Error — total=False, every field optional
# ---------------------------------------------------------------------------


class TestErrorMetadata:
    def test_keys_locked(self) -> None:
        # reason is the enum the SSE handler emits on stream-limit
        # triggers; the others apply to adapter-raised exceptions.
        assert set(ErrorMetadata.__annotations__) == {
            "errorType",
            "correlationId",
            "reason",
            "elapsedSeconds",
            "idleSeconds",
            "eventCount",
        }

    def test_total_is_false(self) -> None:
        assert ErrorMetadata.__total__ is False


# ---------------------------------------------------------------------------
# StreamStats / Completed — final-event contract
# ---------------------------------------------------------------------------


class TestStreamStats:
    def test_keys_locked(self) -> None:
        assert set(StreamStats.__annotations__) == {
            "eventsEmitted",
            "streamDurationMs",
        }

    def test_no_optional_fields(self) -> None:
        # Both counters are always emitted on a ``completed`` event when
        # streamStats is present at all.
        assert _not_required_keys(StreamStats) == set()


class TestCompletedMetadata:
    def test_keys_locked(self) -> None:
        # invokeResponse is the §5.4.2 InvokeResponse payload — REST
        # sync, SSE completed.metadata.invokeResponse, and async
        # TaskStatusResponse.result must all reach the consumer as the
        # same shape, so this key is non-negotiable.
        assert set(CompletedMetadata.__annotations__) == {
            "invokeResponse",
            "streamStats",
        }

    def test_only_stream_stats_is_optional(self) -> None:
        assert _not_required_keys(CompletedMetadata) == {"streamStats"}


# ---------------------------------------------------------------------------
# Cross-cutting wire-format invariants
# ---------------------------------------------------------------------------


METADATA_TYPES = [
    StartedMetadata,
    ThinkingMetadata,
    TokenMetadata,
    ToolCallMetadata,
    ToolResultMetadata,
    ArtifactMetadata,
    ErrorMetadata,
    StreamStats,
    CompletedMetadata,
]


class TestWireKeyConvention:
    """Every key on every metadata TypedDict must be camelCase, never
    snake_case. The wire format is locked at §5.2; a snake_case field
    leaking through would break the CamelCaseModel contract the UI
    relies on for parsing."""

    def test_all_keys_are_camel_case(self) -> None:
        offenders: list[tuple[str, str]] = []
        for td in METADATA_TYPES:
            for key in td.__annotations__:
                if "_" in key:
                    offenders.append((td.__name__, key))
        assert offenders == [], (
            f"Wire keys must be camelCase per §5.2 — found snake_case keys: {offenders}"
        )


class TestModuleAllExportsEverything:
    """The module's ``__all__`` must include every public TypedDict so
    that ``from event_metadata import *`` works for consumers."""

    def test_all_typed_dicts_are_in_dunder_all(self) -> None:
        from agent_service_maf.core import event_metadata

        expected = {td.__name__ for td in METADATA_TYPES}
        assert set(event_metadata.__all__) == expected
