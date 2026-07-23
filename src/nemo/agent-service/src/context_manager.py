"""Automatic context-window management for agent.arun() calls.

This is the single chokepoint between request ingress and the LLM call.
It owns the decision of "what messages go to the model" for a turn:

1. Reconstructs prior history from SessionStore records.
2. Estimates the token cost of system prompt + tools + history + new
   user message + reserved output budget.
3. If the total fits, returns a passthrough message list.
4. Otherwise applies the configured strategy (trim today; summarize
   in Phase 3) to fit the budget at turn boundaries.

Phase 1 implements ``trim`` and ``aggressive_trim`` only. The
``summarize`` / ``hybrid`` strategies fall back to ``trim`` until the
``CONTEXT_MANAGER_SUMMARIZATION_ENABLED`` flag flips in Phase 3.

See docs/design/agent-service-context-management.md for the full spec.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from observability_client_runtime import get_logger

from .config import settings
from .history_reconstructor import HistoryReconstructor, ReconstructedMessage
from .token_counter import HeuristicTokenCounter, TokenCounter, get_counter

if False:  # TYPE_CHECKING
    from .session_store import SummaryStore  # pragma: no cover
    from .summarizer import Summarizer  # pragma: no cover

logger = get_logger()

StrategyName = Literal["trim", "summarize", "hybrid", "sliding_window_strict", "none"]
StrategyUsed = Literal["passthrough", "trim", "summarize", "sliding_window_strict"]


# Models that don't pair well with tool_use replay (kept conservative
# until a per-model capability flag exists in config-service).
_MODELS_WITHOUT_TOOL_REPLAY: set[str] = {
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-16k",
}


@dataclass
class MemoryConfig:
    """Resolved per-agent memory config with applied defaults."""

    context_strategy: StrategyName = "trim"
    verbatim_turns: int = 3
    tool_round_reservation: int = 6000
    output_reservation_override: int | None = None
    safety_buffer_pct: float = 0.05
    summary_model: str | None = None
    summary_refresh_every_turns: int = 5
    memory_type: str = "conversation"  # 'none' | 'conversation' | 'sliding_window'
    window_size: int | None = None

    @classmethod
    def from_dict(
        cls,
        memory_config: dict[str, Any] | None,
        memory_type: str = "conversation",
        provider: str | None = None,
    ) -> "MemoryConfig":
        mc = memory_config or {}
        # Provider-aware strategy default (see docs §Prompt-cache awareness)
        if provider in ("anthropic", "aws_bedrock"):
            default_strategy: StrategyName = "trim"
        else:
            default_strategy = settings.DEFAULT_CONTEXT_STRATEGY  # type: ignore[assignment]

        strategy = mc.get("contextStrategy") or default_strategy
        if strategy not in ("trim", "summarize", "hybrid", "sliding_window_strict", "none"):
            logger.warning("Unknown contextStrategy %r; falling back to 'trim'", strategy)
            strategy = "trim"

        return cls(
            context_strategy=strategy,  # type: ignore[arg-type]
            verbatim_turns=int(mc.get("verbatimTurns") or settings.DEFAULT_VERBATIM_TURNS),
            tool_round_reservation=int(
                mc.get("toolRoundReservation") or settings.DEFAULT_TOOL_ROUND_RESERVATION
            ),
            output_reservation_override=mc.get("outputReservation"),
            safety_buffer_pct=float(
                mc.get("safetyBufferPct") or settings.DEFAULT_SAFETY_BUFFER_PCT
            ),
            summary_model=mc.get("summaryModel"),
            summary_refresh_every_turns=int(
                mc.get("summaryRefreshEveryTurns") or settings.DEFAULT_SUMMARY_REFRESH_EVERY_TURNS
            ),
            memory_type=memory_type,
            window_size=mc.get("windowSize"),
        )


@dataclass
class PreparedContext:
    """Result of ContextManager.prepare()."""

    messages: list[ReconstructedMessage]
    est_input_tokens: int
    budget: int
    strategy_used: StrategyUsed
    trimmed_turn_count: int = 0
    summary_generated: bool = False
    summary_reused: bool = False
    context_window: int = 0
    context_window_source: Literal[
        "enriched", "provider_fallback", "default", "agent_attr"
    ] = "agent_attr"
    notes: list[str] = field(default_factory=list)


# Provider-level fallback for when config-service enrichment hasn't
# happened yet or returned no contextWindow. Kept conservative.
_PROVIDER_FALLBACK_CONTEXT_WINDOW: dict[str, int] = {
    "anthropic": 200_000,
    "openai": 128_000,
    "azure": 32_000,
    "google": 1_048_576,
    "aws_bedrock": 128_000,
    "openai_compatible": 32_000,
    "ollama": 128_000,
}


def resolve_context_window(
    explicit: int | None,
    provider: str | None,
) -> tuple[int, Literal["enriched", "provider_fallback", "default"]]:
    """Pick the best available context window with a three-level fallback.

    Order: explicit (from model_info enrichment) → provider family floor → universal default.
    """
    if explicit and explicit > 0:
        return int(explicit), "enriched"
    if provider and provider in _PROVIDER_FALLBACK_CONTEXT_WINDOW:
        return _PROVIDER_FALLBACK_CONTEXT_WINDOW[provider], "provider_fallback"
    return settings.DEFAULT_CONTEXT_WINDOW, "default"


def resolve_output_reservation(
    agent_max_tokens: int | None,
    model_max_output_tokens: int | None,
    supports_extended_output: bool,
    has_outcome_schema: bool,
) -> int:
    """Apply the budget formula's output_reservation chain with caps."""
    base = (
        agent_max_tokens
        or model_max_output_tokens
        or 4096
    )
    cap = (
        settings.DEFAULT_OUTPUT_RESERVATION_CAP_EXTENDED
        if supports_extended_output
        else settings.DEFAULT_OUTPUT_RESERVATION_CAP
    )
    reservation = min(int(base), cap)
    if has_outcome_schema:
        reservation = int(reservation * settings.DEFAULT_OUTCOME_SCHEMA_OUTPUT_MULTIPLIER)
        # Don't let multiplier exceed cap
        reservation = min(reservation, cap)
    return reservation


def resolve_safety_buffer(context_window: int, pct: float) -> int:
    raw = int(context_window * max(0.0, pct))
    return min(raw, settings.DEFAULT_SAFETY_BUFFER_CAP)


def _turn_starts(messages: list[ReconstructedMessage]) -> list[int]:
    """Return the indices in ``messages`` where each turn begins.

    A turn starts at every ``role == "user"`` message. The system message
    (if present at index 0) is not part of any turn — it's separate.
    """
    starts: list[int] = []
    for i, m in enumerate(messages):
        if m.role == "user":
            starts.append(i)
    return starts


class ContextManager:
    """Sizing and trimming for a single agent.arun() invocation.

    Stateless: a single instance can serve all concurrent requests.
    Token counters are created per-call (cheap, stateless).

    Phase 3 additions:
        * ``summary_store`` and ``summarizer`` are optional collaborators.
          When both are wired and ``CONTEXT_MANAGER_SUMMARIZATION_ENABLED``
          is true, ``prepare()`` will produce a rolling summary instead
          of (or in addition to) trimming.
    """

    def __init__(
        self,
        history_reconstructor: HistoryReconstructor,
        summary_store: "SummaryStore | None" = None,
        summarizer: "Summarizer | None" = None,
    ):
        self._reconstructor = history_reconstructor
        self._summary_store = summary_store
        self._summarizer = summarizer

    def model_supports_tool_replay(self, model: str | None) -> bool:
        if not model:
            return True  # be optimistic
        return model not in _MODELS_WITHOUT_TOOL_REPLAY

    async def prepare(
        self,
        *,
        owner_kind: Literal["agent", "team"],
        owner_id: str,
        user_id: str,
        session_id: str,
        system_prompt: str,
        tool_schemas_text: str,
        user_msg_content: str,
        history_records: list[dict[str, Any]],
        provider: str | None,
        model: str | None,
        context_window: int,
        context_window_source: Literal[
            "enriched", "provider_fallback", "default", "agent_attr"
        ],
        memory_config: MemoryConfig,
        has_tools: bool,
        output_reservation: int,
    ) -> PreparedContext:
        """Build the final message list for one turn.

        Phase 1 paths:
        * ``passthrough`` if everything fits
        * ``trim``  if it doesn't (turn-boundary safe)
        * ``summarize`` / ``hybrid`` request fall back to ``trim`` when
          CONTEXT_MANAGER_SUMMARIZATION_ENABLED is false.
        """
        counter: TokenCounter = get_counter(provider, model)

        # Reconstruct prior history (if memory enabled)
        if memory_config.memory_type == "none":
            history_msgs: list[ReconstructedMessage] = []
        else:
            history_msgs = self._reconstructor.from_session_records(
                history_records,
                provider=provider,
                model_supports_tools=self.model_supports_tool_replay(model),
            )

        # Build the canonical message list: [system, ...history, user]
        messages: list[ReconstructedMessage] = []
        if system_prompt:
            messages.append(ReconstructedMessage(role="system", content=system_prompt))
        messages.extend(history_msgs)
        messages.append(ReconstructedMessage(role="user", content=user_msg_content))

        # Estimate input tokens
        system_tokens = counter.count(system_prompt) if system_prompt else 0
        tools_tokens = counter.count(tool_schemas_text) if tool_schemas_text else 0
        user_tokens = counter.count(user_msg_content)
        history_tokens = sum(_message_token_estimate(m, counter) for m in history_msgs)

        tool_round_reservation = (
            memory_config.tool_round_reservation if has_tools else 0
        )
        safety_buffer = resolve_safety_buffer(context_window, memory_config.safety_buffer_pct)

        available_for_history = (
            context_window
            - system_tokens
            - tools_tokens
            - user_tokens
            - tool_round_reservation
            - output_reservation
            - safety_buffer
        )

        notes: list[str] = []
        if context_window_source != "enriched":
            notes.append(f"context_window from {context_window_source}")

        # Floor case: even with no history, we cannot fit. This is the
        # single user-visible failure mode.
        if available_for_history < 0:
            est_total = (
                system_tokens + tools_tokens + user_tokens
                + tool_round_reservation + output_reservation + safety_buffer
            )
            logger.error(
                "Single-turn cannot fit context: ctxWin=%d, fixed_cost=%d, "
                "owner=%s/%s session=%s",
                context_window, est_total, owner_kind, owner_id, session_id,
            )
            raise SingleTurnOverflowError(
                context_window=context_window,
                fixed_cost=est_total,
                provider=provider,
                model=model,
            )

        if history_tokens <= available_for_history:
            # Passthrough — fits without modification
            return PreparedContext(
                messages=messages,
                est_input_tokens=system_tokens + tools_tokens + user_tokens + history_tokens,
                budget=context_window,
                strategy_used="passthrough",
                context_window=context_window,
                context_window_source=context_window_source,
                notes=notes,
            )

        # Determine effective strategy
        eff_strategy = memory_config.context_strategy
        summarization_available = (
            settings.CONTEXT_MANAGER_SUMMARIZATION_ENABLED
            and self._summary_store is not None
            and self._summarizer is not None
        )
        if eff_strategy in ("summarize", "hybrid") and not summarization_available:
            notes.append(f"strategy {eff_strategy} requested but summarization disabled; using trim")
            eff_strategy = "trim"
        if eff_strategy == "none":
            # 'none' means caller asked us not to alter the context. But
            # we know it won't fit — fall back to trim to avoid an LLM
            # error.
            notes.append("strategy=none but overflow detected; forcing trim")
            eff_strategy = "trim"

        if eff_strategy == "hybrid":
            overflow_ratio = (history_tokens - available_for_history) / max(available_for_history, 1)
            threshold = settings.DEFAULT_SUMMARY_OVERFLOW_THRESHOLD
            if overflow_ratio < threshold:
                notes.append(
                    f"hybrid: overflow {overflow_ratio:.2f} < {threshold:.2f} → trim",
                )
                eff_strategy = "trim"
            else:
                notes.append(
                    f"hybrid: overflow {overflow_ratio:.2f} ≥ {threshold:.2f} → summarize",
                )
                eff_strategy = "summarize"

        if eff_strategy == "summarize":
            try:
                return await self._apply_summarize(
                    owner_kind=owner_kind, owner_id=owner_id,
                    user_id=user_id, session_id=session_id,
                    system_prompt=system_prompt, history_msgs=history_msgs,
                    user_msg_content=user_msg_content,
                    counter=counter, available_for_history=available_for_history,
                    context_window=context_window,
                    context_window_source=context_window_source,
                    memory_config=memory_config, provider=provider,
                    notes=notes,
                )
            except Exception as exc:
                logger.warning(
                    "Summarize path failed (%s); falling back to trim", exc,
                )
                notes.append(f"summarize failed: {exc.__class__.__name__}; using trim")

        if eff_strategy == "sliding_window_strict":
            return self._apply_sliding_window_strict(
                messages, system_prompt, history_msgs, user_msg_content,
                memory_config, counter, available_for_history,
                context_window, context_window_source, notes,
            )

        # trim (also covers fallback from summarize/hybrid in Phase 1)
        return self._apply_trim(
            messages, system_prompt, history_msgs, user_msg_content,
            counter, available_for_history,
            context_window, context_window_source, notes,
        )

    async def _apply_summarize(
        self,
        *,
        owner_kind: str,
        owner_id: str,
        user_id: str,
        session_id: str,
        system_prompt: str,
        history_msgs: list[ReconstructedMessage],
        user_msg_content: str,
        counter: TokenCounter,
        available_for_history: int,
        context_window: int,
        context_window_source: Literal[
            "enriched", "provider_fallback", "default", "agent_attr"
        ],
        memory_config: MemoryConfig,
        provider: str | None,
        notes: list[str],
    ) -> PreparedContext:
        """Summarize the oldest history block and assemble messages
        with provider-correct placement.

        See docs/design/agent-service-context-management.md §Strategies
        for the placement rules per provider.
        """
        assert self._summary_store is not None and self._summarizer is not None

        turn_starts = _turn_starts(history_msgs)
        n_verbatim = max(1, memory_config.verbatim_turns)
        if len(turn_starts) <= n_verbatim:
            # Not enough history to bother summarizing
            return self._apply_trim(
                [], system_prompt, history_msgs, user_msg_content,
                counter, available_for_history,
                context_window, context_window_source, notes,
            )
        split = turn_starts[-n_verbatim]
        old_block = history_msgs[:split]
        verbatim_tail = history_msgs[split:]

        prior_record = await self._summary_store.get(
            owner_kind, owner_id, user_id, session_id,
        )
        prior_summary_text = prior_record.text if prior_record else None
        summary_reused = bool(prior_record) and len(old_block) == 0

        # Generate / refresh summary
        from .summarizer import SummaryOutput  # local import keeps cold-start light
        if not old_block and prior_record:
            summary_out = SummaryOutput(
                text=prior_record.text,
                placement="system_append",  # placeholder; will be overridden below
                token_count_estimate=counter.count(prior_record.text),
            )
        else:
            summary_out = await self._summarizer.summarize(
                provider=provider,
                summary_model=memory_config.summary_model,
                prior_summary=prior_summary_text,
                messages=old_block,
                max_summary_tokens=settings.DEFAULT_SUMMARY_MAX_TOKENS,
            )

        if not summary_out.text:
            raise RuntimeError("Summarizer returned empty text")

        # Persist (CAS — if a newer summary exists this no-ops)
        try:
            covers_idx = (prior_record.covers_up_to_msg_idx if prior_record else 0) + len(old_block)
            await self._summary_store.set(
                owner_kind, owner_id, user_id, session_id,
                summary_out.text, covers_idx,
            )
        except Exception:
            logger.exception("Failed to persist rolling summary; continuing")

        # Assemble per provider-correct placement
        out: list[ReconstructedMessage] = []
        placement = summary_out.placement
        if placement == "system_append":
            sys_text = system_prompt
            sep = "\n\n" if sys_text else ""
            out.append(
                ReconstructedMessage(
                    role="system",
                    content=f"{sys_text}{sep}[Summary of earlier conversation: {summary_out.text}]",
                )
            )
            out.extend(verbatim_tail)
            out.append(ReconstructedMessage(role="user", content=user_msg_content))
        elif placement == "system_message":
            if system_prompt:
                out.append(ReconstructedMessage(role="system", content=system_prompt))
            out.append(
                ReconstructedMessage(
                    role="system",
                    content=f"[Summary of earlier conversation: {summary_out.text}]",
                )
            )
            out.extend(verbatim_tail)
            out.append(ReconstructedMessage(role="user", content=user_msg_content))
        elif placement == "user_prepend":
            if system_prompt:
                out.append(ReconstructedMessage(role="system", content=system_prompt))
            out.extend(verbatim_tail)
            # Prepend hint to the *current* user message — keeps Gemini's
            # single systemInstruction stable.
            out.append(
                ReconstructedMessage(
                    role="user",
                    content=(
                        f"[Earlier context: {summary_out.text}]\n\n{user_msg_content}"
                    ),
                )
            )
        else:
            # Unknown placement — defensive fallback
            if system_prompt:
                out.append(ReconstructedMessage(role="system", content=system_prompt))
            out.append(
                ReconstructedMessage(
                    role="system",
                    content=f"[Summary of earlier conversation: {summary_out.text}]",
                )
            )
            out.extend(verbatim_tail)
            out.append(ReconstructedMessage(role="user", content=user_msg_content))

        est_total = _sum_tokens(out, counter)
        notes.append(
            f"summarize: collapsed {len(old_block)} old msgs into {summary_out.token_count_estimate or '?'} tokens; "
            f"kept {len(verbatim_tail)} verbatim"
        )

        # If we STILL overflow (e.g. tools too large), fall back to trim
        if est_total > context_window:
            notes.append("summarize result still exceeds context_window; trimming further")
            return self._apply_trim(
                [], system_prompt, out[1:-1] if out else [], user_msg_content,
                counter, available_for_history,
                context_window, context_window_source, notes,
            )

        return PreparedContext(
            messages=out,
            est_input_tokens=est_total,
            budget=context_window,
            strategy_used="summarize",
            trimmed_turn_count=0,
            summary_generated=not summary_reused,
            summary_reused=summary_reused,
            context_window=context_window,
            context_window_source=context_window_source,
            notes=notes,
        )

    def _apply_trim(
        self,
        full_messages: list[ReconstructedMessage],
        system_prompt: str,
        history_msgs: list[ReconstructedMessage],
        user_msg_content: str,
        counter: TokenCounter,
        budget: int,
        context_window: int,
        context_window_source: Literal[
            "enriched", "provider_fallback", "default", "agent_attr"
        ],
        notes: list[str],
    ) -> PreparedContext:
        """Drop oldest complete turns until history fits in budget.

        Turn = a user message and all subsequent assistant/tool messages
        until the next user message. This preserves tool_use/tool_result
        pairing required by Anthropic and OpenAI.
        """
        kept = list(history_msgs)
        turn_starts = _turn_starts(kept)

        trimmed_turns = 0
        # Drop turns from the front (oldest first)
        while turn_starts and _sum_tokens(kept, counter) > budget:
            # Remove from start of kept up to (but not including) the
            # second turn start
            if len(turn_starts) == 1:
                # Only one turn left; can't preserve while staying in
                # budget. Drop everything pre-current-user.
                kept = []
                trimmed_turns += 1
                break
            drop_until = turn_starts[1]  # index where next turn begins
            del kept[:drop_until]
            trimmed_turns += 1
            turn_starts = _turn_starts(kept)

        # Rebuild final message list
        final: list[ReconstructedMessage] = []
        if system_prompt:
            final.append(ReconstructedMessage(role="system", content=system_prompt))
        final.extend(kept)
        final.append(ReconstructedMessage(role="user", content=user_msg_content))

        est_total = _sum_tokens(final, counter)
        notes.append(f"trim dropped {trimmed_turns} turn(s)")
        logger.info(
            "ContextManager.trim: dropped %d turn(s), kept_history=%d msgs, est_input=%d, budget=%d",
            trimmed_turns, len(kept), est_total, context_window,
        )
        return PreparedContext(
            messages=final,
            est_input_tokens=est_total,
            budget=context_window,
            strategy_used="trim",
            trimmed_turn_count=trimmed_turns,
            context_window=context_window,
            context_window_source=context_window_source,
            notes=notes,
        )

    def _apply_sliding_window_strict(
        self,
        full_messages: list[ReconstructedMessage],
        system_prompt: str,
        history_msgs: list[ReconstructedMessage],
        user_msg_content: str,
        memory_config: MemoryConfig,
        counter: TokenCounter,
        budget: int,
        context_window: int,
        context_window_source: Literal[
            "enriched", "provider_fallback", "default", "agent_attr"
        ],
        notes: list[str],
    ) -> PreparedContext:
        """Keep at most the last N turns from history. Falls back to
        trim if even N turns don't fit."""
        n = memory_config.window_size or settings.DEFAULT_VERBATIM_TURNS
        turn_starts = _turn_starts(history_msgs)
        if len(turn_starts) <= n:
            keep_from = 0
        else:
            keep_from = turn_starts[-n]
        kept = history_msgs[keep_from:]

        # If still over budget, fall back to trim (and emit warning)
        if _sum_tokens([ReconstructedMessage(role="system", content=system_prompt)] + kept +
                       [ReconstructedMessage(role="user", content=user_msg_content)], counter) > budget:
            notes.append("strict window exceeded budget; falling back to trim")
            return self._apply_trim(
                full_messages, system_prompt, history_msgs, user_msg_content,
                counter, budget, context_window, context_window_source, notes,
            )

        final: list[ReconstructedMessage] = []
        if system_prompt:
            final.append(ReconstructedMessage(role="system", content=system_prompt))
        final.extend(kept)
        final.append(ReconstructedMessage(role="user", content=user_msg_content))
        est_total = _sum_tokens(final, counter)
        return PreparedContext(
            messages=final,
            est_input_tokens=est_total,
            budget=context_window,
            strategy_used="sliding_window_strict",
            trimmed_turn_count=max(0, len(turn_starts) - n),
            context_window=context_window,
            context_window_source=context_window_source,
            notes=notes,
        )

    async def refresh_summary(
        self,
        *,
        owner_kind: str,
        owner_id: str,
        user_id: str,
        session_id: str,
        history_records: list[dict[str, Any]],
        provider: str | None,
        memory_config: MemoryConfig,
    ) -> bool:
        """Background hook: extend the rolling summary up to the latest
        message. Safe to call after every successful turn.

        Returns True if a refresh was performed, False otherwise.

        Honors:
          * CONTEXT_MANAGER_SUMMARIZATION_ENABLED (no-op if False)
          * memory_config.summary_refresh_every_turns (don't refresh on
            every turn if cadence > 1)
          * CAS on covers_up_to_msg_idx (won't overwrite a newer
            summary)
        """
        if not settings.CONTEXT_MANAGER_SUMMARIZATION_ENABLED:
            return False
        if self._summary_store is None or self._summarizer is None:
            return False
        if not history_records:
            return False

        # Cadence gating
        prior = await self._summary_store.get(owner_kind, owner_id, user_id, session_id)
        prior_idx = prior.covers_up_to_msg_idx if prior else 0
        n_new = max(0, len(history_records) - prior_idx)
        if n_new < memory_config.summary_refresh_every_turns:
            return False

        # Re-build messages we'd want to summarize: everything before the
        # tail-of-verbatim window.
        from .summarizer import SummaryOutput  # local import keeps cold-start light
        reconstructed = self._reconstructor.from_session_records(
            history_records, provider=provider, model_supports_tools=True,
        )
        turn_starts = _turn_starts(reconstructed)
        n_verbatim = max(1, memory_config.verbatim_turns)
        if len(turn_starts) <= n_verbatim:
            return False
        split = turn_starts[-n_verbatim]
        old_block = reconstructed[:split]
        if not old_block:
            return False

        try:
            summary = await self._summarizer.summarize(
                provider=provider,
                summary_model=memory_config.summary_model,
                prior_summary=prior.text if prior else None,
                messages=old_block,
                max_summary_tokens=settings.DEFAULT_SUMMARY_MAX_TOKENS,
            )
        except Exception:
            logger.exception("Background summary refresh failed")
            return False

        if not summary.text:
            return False
        try:
            return await self._summary_store.set(
                owner_kind, owner_id, user_id, session_id,
                summary.text, len(history_records),
            )
        except Exception:
            logger.exception("Background summary persist failed")
            return False

    def aggressive_trim(
        self, messages: list[ReconstructedMessage]
    ) -> list[ReconstructedMessage]:
        """Emergency lane — drop the oldest half of history (turn-aligned),
        keeping system prompt and the final user message intact.

        Used by the reactive retry path in main.py when the LLM rejects
        the request with ContextWindowExceededError despite proactive
        sizing.
        """
        if not messages:
            return messages
        # Identify segments
        system = messages[0] if messages[0].role == "system" else None
        body_start = 1 if system else 0
        # Final user message is the last role=user message
        last_user_idx = None
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].role == "user":
                last_user_idx = i
                break
        if last_user_idx is None:
            return messages  # nothing to do

        history = messages[body_start:last_user_idx]
        final_user = messages[last_user_idx]

        turn_starts = _turn_starts(history)
        if len(turn_starts) <= 1:
            kept: list[ReconstructedMessage] = []
        else:
            half = len(turn_starts) // 2
            keep_from = turn_starts[half]
            kept = history[keep_from:]

        out: list[ReconstructedMessage] = []
        if system:
            out.append(system)
        out.extend(kept)
        out.append(final_user)
        return out


def _message_token_estimate(msg: ReconstructedMessage, counter: TokenCounter) -> int:
    base = counter.count(msg.content)
    if msg.tool_calls:
        # rough — JSON-shaped overhead
        import json as _json
        try:
            base += counter.count(_json.dumps(msg.tool_calls), content_class="json")
        except Exception:
            base += sum(counter.count(str(tc), content_class="json") for tc in msg.tool_calls)
    return base


def _sum_tokens(messages: list[ReconstructedMessage], counter: TokenCounter) -> int:
    return sum(_message_token_estimate(m, counter) for m in messages)


class SingleTurnOverflowError(Exception):
    """Raised when system_prompt + tools + user_msg already exceed the
    context window. The only user-visible failure mode in Phase 1."""

    def __init__(
        self,
        context_window: int,
        fixed_cost: int,
        provider: str | None,
        model: str | None,
    ):
        self.context_window = context_window
        self.fixed_cost = fixed_cost
        self.provider = provider
        self.model = model
        super().__init__(
            f"Single message exceeds model context window "
            f"(estimated {fixed_cost} tokens for system+tools+user; "
            f"window is {context_window}). Reduce tool count, switch to a "
            f"larger-context model, or shorten input."
        )


# Detect context-window overflow signaled by the LLM after the call
def is_context_overflow_error(exc: BaseException) -> bool:
    s = str(exc).lower()
    return "contextwindowexceeded" in s or "context length" in s or "maximum context" in s
