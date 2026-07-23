"""Reconstruct Agno Message lists from SessionStore records.

Background:
    SessionStore persists conversation messages as flat records with role,
    content, and optional metadata. Tool calls are stored as
    ``metadata["toolCalls"]`` on the assistant record — NOT as separate
    tool/tool_result messages. This is a storage/UX choice that loses
    fidelity when replaying history to the model.

This module rebuilds provider-appropriate Agno Message lists from those
records.  Phase 1 supports two modes:

* ``preserve_tool_cycles=True``  (default for tool-capable models):
  expand metadata.toolCalls into a sequence of
  ``assistant(with tool_calls)`` + ``tool(role=tool, tool_call_id=...)``
  messages so the model sees the full tool round-trip.

* ``preserve_tool_cycles=False`` (for models that don't support tools,
  or as a defensive fallback): drop tool blocks, optionally prepend
  "[Assistant used tools: ...]" hint.

Tool-call ID handling:
    Tool calls in SessionStore metadata have a ``toolCallId`` field
    (provider-assigned at original generation time).  We reuse that ID
    when present, ensuring the ``assistant.tool_calls[i].id`` matches
    the corresponding ``Message(role="tool", tool_call_id=...)``.
    For records lacking an ID we synthesize a deterministic one
    (``reconstructed-{msg_idx}-{tool_idx}``) so collisions across
    sessions are impossible.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from observability_client_runtime import get_logger

logger = get_logger()


@dataclass
class ReconstructedMessage:
    """Provider-agnostic intermediate.

    Why not use ``agno.models.message.Message`` directly?
    Importing Agno's Message into a hot module risks circular imports
    during agent_factory init. The ContextManager converts these to
    Agno Messages just before passing to ``arun(input=...)``.
    """

    role: str  # "system" | "user" | "assistant" | "tool"
    content: str
    tool_calls: list[dict[str, Any]] | None = None  # for assistant turns
    tool_call_id: str | None = None  # for role=tool messages
    metadata: dict[str, Any] = field(default_factory=dict)

    def text_length(self) -> int:
        """Approximate length for token estimation."""
        n = len(self.content or "")
        if self.tool_calls:
            try:
                n += len(json.dumps(self.tool_calls))
            except Exception:
                n += sum(len(str(tc)) for tc in self.tool_calls)
        return n


def _tool_call_id(raw: dict[str, Any], msg_idx: int, tool_idx: int) -> str:
    tid = raw.get("toolCallId") or raw.get("tool_call_id") or raw.get("id")
    if tid:
        return str(tid)
    return f"reconstructed-{msg_idx}-{tool_idx}"


def _expand_assistant_with_tools(
    record: dict[str, Any], msg_idx: int
) -> list[ReconstructedMessage]:
    """Expand a SessionStore assistant record with toolCalls metadata
    into [assistant(tool_calls), tool, assistant(tool_calls), tool, ...,
    assistant(final_content)] message sequence."""

    tool_calls_raw = record.get("toolCalls") or []
    if not tool_calls_raw:
        return [ReconstructedMessage(role="assistant", content=record.get("content", "") or "")]

    out: list[ReconstructedMessage] = []
    # Single assistant message carrying all tool_uses (matches how most
    # providers actually invoke parallel tool calls)
    pending_tool_blocks: list[dict[str, Any]] = []
    tool_results: list[ReconstructedMessage] = []
    for t_idx, tc in enumerate(tool_calls_raw):
        tc_id = _tool_call_id(tc, msg_idx, t_idx)
        tool_block = {
            "id": tc_id,
            "type": "function",
            "function": {
                "name": tc.get("toolName") or tc.get("name") or "unknown_tool",
                "arguments": _stringify_args(tc.get("args") or tc.get("arguments") or {}),
            },
        }
        pending_tool_blocks.append(tool_block)
        tool_results.append(
            ReconstructedMessage(
                role="tool",
                content=_stringify_result(tc.get("result")),
                tool_call_id=tc_id,
            )
        )

    out.append(
        ReconstructedMessage(
            role="assistant",
            content="",  # tool-use turn has no user-facing text
            tool_calls=pending_tool_blocks,
        )
    )
    out.extend(tool_results)
    # Final assistant text answer (if any)
    final_text = record.get("content", "") or ""
    if final_text:
        out.append(ReconstructedMessage(role="assistant", content=final_text))
    return out


def _stringify_args(args: Any) -> str:
    if isinstance(args, str):
        return args
    try:
        return json.dumps(args, default=str)
    except Exception:
        return str(args)


def _stringify_result(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    try:
        return json.dumps(result, default=str)
    except Exception:
        return str(result)


def _summary_of_tools_used(record: dict[str, Any]) -> str:
    tc = record.get("toolCalls") or []
    if not tc:
        return ""
    names = [t.get("toolName") or t.get("name") or "?" for t in tc]
    return f"[Assistant used tools: {', '.join(names)}]\n\n"


class HistoryReconstructor:
    """Convert SessionStore records into provider-correct message sequences."""

    def from_session_records(
        self,
        records: list[dict[str, Any]],
        provider: str | None,
        model_supports_tools: bool,
        preserve_tool_cycles: bool = True,
    ) -> list[ReconstructedMessage]:
        """Build a Message list from raw SessionStore records.

        Args:
            records: list of session_store entries ({role, content, timestamp, ...metadata})
            provider: provider key (anthropic, openai, ...) — may inform per-provider tweaks later
            model_supports_tools: if False, never expand tool cycles
            preserve_tool_cycles: caller override. False = always drop tool blocks even if model supports them.

        Returns:
            Ordered list of ReconstructedMessage suitable for trim/summarize
            and ultimately conversion to Agno Message before agent.arun().
        """
        if not records:
            return []

        expand_tools = preserve_tool_cycles and model_supports_tools
        out: list[ReconstructedMessage] = []

        for idx, rec in enumerate(records):
            role = rec.get("role", "")
            if role == "user":
                out.append(ReconstructedMessage(role="user", content=rec.get("content", "") or ""))
                continue

            if role == "assistant":
                has_tools = bool(rec.get("toolCalls"))
                if has_tools and expand_tools:
                    out.extend(_expand_assistant_with_tools(rec, idx))
                elif has_tools:
                    # Drop tool blocks; prepend hint
                    hint = _summary_of_tools_used(rec)
                    text = (rec.get("content", "") or "")
                    out.append(
                        ReconstructedMessage(
                            role="assistant",
                            content=f"{hint}{text}" if hint else text,
                        )
                    )
                else:
                    out.append(
                        ReconstructedMessage(role="assistant", content=rec.get("content", "") or "")
                    )
                continue

            # Unknown role — skip silently with debug log. Persisted history
            # is user/assistant only today; future-proof against drift.
            logger.debug("Skipping unknown role %r in session record %d", role, idx)

        return out


# Module-level reusable instance (stateless)
default_reconstructor = HistoryReconstructor()
