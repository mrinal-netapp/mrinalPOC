"""UsageTracker — passive per-session token and cost observer.

This module records token usage returned by the Bifrost proxy after each
successful LLM completion. It is a **passive observer only** — it does not
calculate costs (Bifrost does) and does not enforce rate limits. Its purpose
is local debugging, per-session observability, and surfacing usage summaries
in health/debug endpoints.

Thread safety: All mutations are protected by ``asyncio.Lock`` so multiple
concurrent gateway calls can safely call ``record()`` without data races.

History is bounded at 1000 entries via a ``deque`` with ``maxlen``.

Example::

    from agent_service_maf.gateway.cost_tracker import UsageTracker
    from agent_service_maf.core.interfaces import TokenUsage

    tracker = UsageTracker()
    model = "anthropic/claude-sonnet-4-20250514"
    await tracker.record(TokenUsage(prompt_tokens=10, completion_tokens=20), model)
    summary = tracker.get_summary()
    print(summary["total_tokens"])  # 30
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import structlog

from agent_service_maf.core.interfaces import TokenUsage

logger = structlog.get_logger(__name__)

_MAX_HISTORY = 1000


@dataclass
class _ModelStats:
    """Per-model accumulated statistics."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    request_count: int = 0


class UsageTracker:
    """Passive per-session observer for token usage and cost passthrough.

    Records ``TokenUsage`` objects returned from the Bifrost proxy after each
    successful LLM completion. Cost figures originate from Bifrost and are
    stored as-is — they are NOT calculated locally.

    All public mutation methods are ``async`` and protected by ``asyncio.Lock``
    to support concurrent gateway calls safely.

    Attributes are not exposed as public dataclass fields to prevent accidental
    direct mutation from callers; use ``record()``, ``get_summary()``, and
    ``reset()`` instead.

    Example::

        tracker = UsageTracker()
        await tracker.record(usage, model="anthropic/claude-sonnet-4-20250514")
        print(tracker.get_summary())
    """

    def __init__(self) -> None:
        self._lock: asyncio.Lock = asyncio.Lock()
        self._total_prompt_tokens: int = 0
        self._total_completion_tokens: int = 0
        self._total_tokens: int = 0
        self._total_estimated_cost_usd: float = 0.0
        self._request_count: int = 0
        self._by_model: dict[str, _ModelStats] = {}
        self._history: deque[dict[str, Any]] = deque(maxlen=_MAX_HISTORY)

    async def record(self, usage: TokenUsage, model: str) -> None:
        """Record token usage from a single completion request.

        Updates running totals and per-model breakdown. Cost is taken directly
        from the ``usage.estimated_cost_usd`` field as reported by Bifrost —
        it is never recalculated here.

        Args:
            usage: ``TokenUsage`` populated from the Bifrost response.
            model: Model identifier string (e.g. ``"anthropic/claude-sonnet-4-20250514"``).
        """
        async with self._lock:
            self._total_prompt_tokens += usage.prompt_tokens
            self._total_completion_tokens += usage.completion_tokens
            self._total_tokens += usage.total_tokens
            self._total_estimated_cost_usd += usage.estimated_cost_usd
            self._request_count += 1

            if model not in self._by_model:
                self._by_model[model] = _ModelStats()
            stats = self._by_model[model]
            stats.prompt_tokens += usage.prompt_tokens
            stats.completion_tokens += usage.completion_tokens
            stats.total_tokens += usage.total_tokens
            stats.estimated_cost_usd += usage.estimated_cost_usd
            stats.request_count += 1

            self._history.append(
                {
                    "timestamp": time.time(),
                    "model": model,
                    "prompt_tokens": usage.prompt_tokens,
                    "completion_tokens": usage.completion_tokens,
                    "total_tokens": usage.total_tokens,
                    "estimated_cost_usd": usage.estimated_cost_usd,
                }
            )

        logger.debug(
            "usage_recorded",
            model=model,
            prompt_tokens=usage.prompt_tokens,
            completion_tokens=usage.completion_tokens,
            total_requests=self._request_count,
        )

    def get_summary(self) -> dict[str, Any]:
        """Return accumulated usage totals across all models and requests.

        Cost figures are passed through from Bifrost responses; they are not
        independently calculated by this tracker.

        Returns:
            Dict with keys:
                - ``total_prompt_tokens`` (int)
                - ``total_completion_tokens`` (int)
                - ``total_tokens`` (int)
                - ``total_estimated_cost_usd`` (float)
                - ``request_count`` (int)
                - ``by_model`` (dict of per-model breakdowns)
                - ``note`` (str) — reminder that Bifrost is the authoritative source
        """
        return {
            "total_prompt_tokens": self._total_prompt_tokens,
            "total_completion_tokens": self._total_completion_tokens,
            "total_tokens": self._total_tokens,
            "total_estimated_cost_usd": round(self._total_estimated_cost_usd, 8),
            "request_count": self._request_count,
            "by_model": self.get_summary_by_model(),
            "note": (
                "Cost and rate limits are tracked by Bifrost. "
                "These figures are local estimates for debugging only."
            ),
        }

    def get_summary_by_model(self) -> dict[str, dict[str, Any]]:
        """Return per-model token and cost breakdown for debugging.

        Returns:
            Dict keyed by model string, each containing:
                - ``prompt_tokens`` (int)
                - ``completion_tokens`` (int)
                - ``total_tokens`` (int)
                - ``estimated_cost_usd`` (float)
                - ``request_count`` (int)
        """
        return {
            model: {
                "prompt_tokens": stats.prompt_tokens,
                "completion_tokens": stats.completion_tokens,
                "total_tokens": stats.total_tokens,
                "estimated_cost_usd": round(stats.estimated_cost_usd, 8),
                "request_count": stats.request_count,
            }
            for model, stats in self._by_model.items()
        }

    async def reset(self) -> None:
        """Zero out all counters and clear history.

        Typically called at the start of a new session or during testing.
        """
        async with self._lock:
            self._total_prompt_tokens = 0
            self._total_completion_tokens = 0
            self._total_tokens = 0
            self._total_estimated_cost_usd = 0.0
            self._request_count = 0
            self._by_model.clear()
            self._history.clear()
        logger.debug("usage_tracker_reset")
