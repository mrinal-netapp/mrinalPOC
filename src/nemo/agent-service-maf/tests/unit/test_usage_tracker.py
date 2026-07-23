"""Unit tests for UsageTracker.

Tests cover record accumulation, per-model breakdown, summary format,
reset semantics, history bounding, and concurrent safety.
"""

from __future__ import annotations

import asyncio

import pytest

from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.gateway.cost_tracker import _MAX_HISTORY, UsageTracker

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_usage(
    prompt: int = 10,
    completion: int = 20,
    total: int | None = None,
    cost: float = 0.001,
) -> TokenUsage:
    """Create a TokenUsage with sensible defaults."""
    return TokenUsage(
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total if total is not None else prompt + completion,
        estimated_cost_usd=cost,
    )


MODEL_A = "anthropic/claude-sonnet-4-20250514"
MODEL_B = "openai/gpt-4o"


# ---------------------------------------------------------------------------
# record() — basic accumulation
# ---------------------------------------------------------------------------


class TestUsageTrackerRecord:
    """Tests for record() updating totals."""

    @pytest.mark.asyncio
    async def test_record_updates_prompt_tokens(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=100, completion=50, total=150), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_prompt_tokens"] == 100, (
            "total_prompt_tokens should equal the recorded prompt_tokens"
        )

    @pytest.mark.asyncio
    async def test_record_updates_completion_tokens(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=100, completion=50, total=150), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_completion_tokens"] == 50, (
            "total_completion_tokens should equal the recorded completion_tokens"
        )

    @pytest.mark.asyncio
    async def test_record_updates_total_tokens(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=100, completion=50, total=150), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_tokens"] == 150, "total_tokens should equal the recorded total_tokens"

    @pytest.mark.asyncio
    async def test_record_updates_cost(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(cost=0.005), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_estimated_cost_usd"] == pytest.approx(0.005, rel=1e-6), (
            "total_estimated_cost_usd should equal the recorded cost"
        )

    @pytest.mark.asyncio
    async def test_record_increments_request_count(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(), MODEL_A)
        summary = tracker.get_summary()
        assert summary["request_count"] == 1, "request_count should be 1 after one record() call"

    @pytest.mark.asyncio
    async def test_record_zero_usage(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=0, completion=0, total=0, cost=0.0), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_tokens"] == 0, (
            "Recording zero usage should result in zero total_tokens"
        )
        assert summary["request_count"] == 1, (
            "request_count should still increment even for zero-usage records"
        )


class TestUsageTrackerMultipleRecords:
    """Tests for accumulation over multiple record() calls."""

    @pytest.mark.asyncio
    async def test_multiple_records_accumulate_tokens(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=10, completion=20, total=30), MODEL_A)
        await tracker.record(make_usage(prompt=15, completion=25, total=40), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_prompt_tokens"] == 25, (
            "prompt_tokens should accumulate across multiple records"
        )
        assert summary["total_completion_tokens"] == 45, (
            "completion_tokens should accumulate across multiple records"
        )
        assert summary["total_tokens"] == 70, (
            "total_tokens should accumulate across multiple records"
        )

    @pytest.mark.asyncio
    async def test_multiple_records_accumulate_cost(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(cost=0.001), MODEL_A)
        await tracker.record(make_usage(cost=0.002), MODEL_A)
        await tracker.record(make_usage(cost=0.003), MODEL_A)
        summary = tracker.get_summary()
        assert summary["total_estimated_cost_usd"] == pytest.approx(0.006, rel=1e-6), (
            "cost should accumulate across multiple records"
        )

    @pytest.mark.asyncio
    async def test_multiple_records_increment_request_count(self) -> None:
        tracker = UsageTracker()
        for _ in range(5):
            await tracker.record(make_usage(), MODEL_A)
        summary = tracker.get_summary()
        assert summary["request_count"] == 5, (
            "request_count should equal the number of record() calls"
        )


# ---------------------------------------------------------------------------
# Per-model tracking
# ---------------------------------------------------------------------------


class TestUsageTrackerByModel:
    """Tests for per-model breakdown."""

    @pytest.mark.asyncio
    async def test_record_creates_model_entry(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=5, completion=10, total=15), MODEL_A)
        by_model = tracker.get_summary_by_model()
        assert MODEL_A in by_model, (
            f"Model '{MODEL_A}' should appear in get_summary_by_model() after recording"
        )

    @pytest.mark.asyncio
    async def test_record_different_models_tracked_separately(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=10, completion=20, total=30, cost=0.01), MODEL_A)
        await tracker.record(make_usage(prompt=5, completion=15, total=20, cost=0.005), MODEL_B)
        by_model = tracker.get_summary_by_model()

        assert MODEL_A in by_model, f"'{MODEL_A}' should be in model breakdown"
        assert MODEL_B in by_model, f"'{MODEL_B}' should be in model breakdown"

        assert by_model[MODEL_A]["prompt_tokens"] == 10, (
            f"Model A prompt_tokens should be 10, got {by_model[MODEL_A]['prompt_tokens']}"
        )
        assert by_model[MODEL_B]["prompt_tokens"] == 5, (
            f"Model B prompt_tokens should be 5, got {by_model[MODEL_B]['prompt_tokens']}"
        )

    @pytest.mark.asyncio
    async def test_record_same_model_accumulates(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=10, completion=20, total=30), MODEL_A)
        await tracker.record(make_usage(prompt=10, completion=20, total=30), MODEL_A)
        by_model = tracker.get_summary_by_model()
        assert by_model[MODEL_A]["prompt_tokens"] == 20, (
            "Same model records should accumulate prompt_tokens"
        )
        assert by_model[MODEL_A]["request_count"] == 2, (
            "Same model request_count should be 2 after two records"
        )

    @pytest.mark.asyncio
    async def test_model_cost_from_bifrost_not_recalculated(self) -> None:
        """Cost is passed through from Bifrost, not recalculated."""
        tracker = UsageTracker()
        await tracker.record(make_usage(cost=0.123456789), MODEL_A)
        by_model = tracker.get_summary_by_model()
        # Cost is rounded to 8 decimal places in the output
        assert by_model[MODEL_A]["estimated_cost_usd"] == pytest.approx(0.123456789, rel=1e-6), (
            "Per-model cost should reflect Bifrost-reported cost (not recalculated)"
        )

    @pytest.mark.asyncio
    async def test_get_summary_by_model_contains_all_fields(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=10, completion=20, total=30, cost=0.01), MODEL_A)
        by_model = tracker.get_summary_by_model()
        model_data = by_model[MODEL_A]

        required_keys = {
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "estimated_cost_usd",
            "request_count",
        }
        assert required_keys.issubset(model_data.keys()), (
            f"Per-model data should contain keys {required_keys}, got {set(model_data.keys())}"
        )


# ---------------------------------------------------------------------------
# get_summary() format
# ---------------------------------------------------------------------------


class TestUsageTrackerGetSummary:
    """Tests for get_summary() return format and content."""

    @pytest.mark.asyncio
    async def test_get_summary_empty_tracker(self) -> None:
        tracker = UsageTracker()
        summary = tracker.get_summary()
        assert summary["total_prompt_tokens"] == 0, "Empty tracker total_prompt_tokens should be 0"
        assert summary["total_completion_tokens"] == 0, (
            "Empty tracker total_completion_tokens should be 0"
        )
        assert summary["total_tokens"] == 0, "Empty tracker total_tokens should be 0"
        assert summary["total_estimated_cost_usd"] == 0.0, (
            "Empty tracker total_estimated_cost_usd should be 0.0"
        )
        assert summary["request_count"] == 0, "Empty tracker request_count should be 0"

    @pytest.mark.asyncio
    async def test_get_summary_contains_required_keys(self) -> None:
        tracker = UsageTracker()
        summary = tracker.get_summary()
        required_keys = {
            "total_prompt_tokens",
            "total_completion_tokens",
            "total_tokens",
            "total_estimated_cost_usd",
            "request_count",
            "by_model",
            "note",
        }
        assert required_keys.issubset(summary.keys()), (
            f"Summary missing required keys. Expected {required_keys}, got {set(summary.keys())}"
        )

    @pytest.mark.asyncio
    async def test_get_summary_note_field_present(self) -> None:
        tracker = UsageTracker()
        summary = tracker.get_summary()
        assert isinstance(summary["note"], str), "Summary 'note' field should be a string"
        assert len(summary["note"]) > 0, "Summary 'note' field should be non-empty"

    @pytest.mark.asyncio
    async def test_get_summary_by_model_embedded_in_summary(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(), MODEL_A)
        summary = tracker.get_summary()
        assert MODEL_A in summary["by_model"], (
            "get_summary() 'by_model' key should include recorded models"
        )

    @pytest.mark.asyncio
    async def test_get_summary_cost_rounded_to_8_decimal_places(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(cost=0.000000001), MODEL_A)
        summary = tracker.get_summary()
        # Should be rounded to 8 decimal places
        assert isinstance(summary["total_estimated_cost_usd"], float), (
            "total_estimated_cost_usd should be a float"
        )


# ---------------------------------------------------------------------------
# reset()
# ---------------------------------------------------------------------------


class TestUsageTrackerReset:
    """Tests for reset() clearing all state."""

    @pytest.mark.asyncio
    async def test_reset_clears_totals(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=100, completion=200, total=300, cost=0.5), MODEL_A)
        await tracker.reset()
        summary = tracker.get_summary()
        assert summary["total_prompt_tokens"] == 0, "After reset(), total_prompt_tokens should be 0"
        assert summary["total_completion_tokens"] == 0, (
            "After reset(), total_completion_tokens should be 0"
        )
        assert summary["total_tokens"] == 0, "After reset(), total_tokens should be 0"
        assert summary["total_estimated_cost_usd"] == 0.0, (
            "After reset(), total_estimated_cost_usd should be 0.0"
        )
        assert summary["request_count"] == 0, "After reset(), request_count should be 0"

    @pytest.mark.asyncio
    async def test_reset_clears_model_breakdown(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(), MODEL_A)
        await tracker.record(make_usage(), MODEL_B)
        await tracker.reset()
        by_model = tracker.get_summary_by_model()
        assert len(by_model) == 0, (
            "After reset(), get_summary_by_model() should return an empty dict"
        )

    @pytest.mark.asyncio
    async def test_reset_allows_fresh_recording(self) -> None:
        tracker = UsageTracker()
        await tracker.record(make_usage(prompt=100), MODEL_A)
        await tracker.reset()
        await tracker.record(make_usage(prompt=50), MODEL_B)
        summary = tracker.get_summary()
        assert summary["total_prompt_tokens"] == 50, (
            "After reset(), fresh records should start accumulating from zero"
        )
        assert summary["request_count"] == 1, (
            "After reset(), request_count should start from 1 on fresh record"
        )


# ---------------------------------------------------------------------------
# History bounded at _MAX_HISTORY
# ---------------------------------------------------------------------------


class TestUsageTrackerHistoryBound:
    """Tests for the 1000-entry history cap."""

    @pytest.mark.asyncio
    async def test_history_bounded_at_max(self) -> None:
        tracker = UsageTracker()
        # Record more than _MAX_HISTORY entries
        overflow = _MAX_HISTORY + 10
        for _ in range(overflow):
            await tracker.record(make_usage(prompt=1, completion=1, total=2), MODEL_A)

        # The history deque should be capped at _MAX_HISTORY
        assert len(tracker._history) == _MAX_HISTORY, (
            f"History should be bounded at {_MAX_HISTORY} entries, got {len(tracker._history)}"
        )

    @pytest.mark.asyncio
    async def test_totals_not_bounded_by_history(self) -> None:
        """Totals should accumulate beyond _MAX_HISTORY even though history is capped."""
        tracker = UsageTracker()
        count = _MAX_HISTORY + 10
        for _ in range(count):
            await tracker.record(make_usage(prompt=1, completion=1, total=2), MODEL_A)

        summary = tracker.get_summary()
        assert summary["request_count"] == count, (
            f"request_count should be {count} (not capped by history), "
            f"got {summary['request_count']}"
        )
        assert summary["total_tokens"] == count * 2, (
            f"total_tokens should be {count * 2} (not capped by history), "
            f"got {summary['total_tokens']}"
        )


# ---------------------------------------------------------------------------
# Concurrent record() safety
# ---------------------------------------------------------------------------


class TestUsageTrackerConcurrency:
    """Tests for asyncio-safe concurrent record() calls."""

    @pytest.mark.asyncio
    async def test_concurrent_records_safe(self) -> None:
        """Multiple concurrent record() calls should not produce data races."""
        tracker = UsageTracker()
        n = 50

        async def record_one() -> None:
            await tracker.record(make_usage(prompt=1, completion=1, total=2, cost=0.001), MODEL_A)

        await asyncio.gather(*(record_one() for _ in range(n)))

        summary = tracker.get_summary()
        assert summary["request_count"] == n, (
            f"Concurrent records: expected request_count={n}, got {summary['request_count']}"
        )
        assert summary["total_prompt_tokens"] == n, (
            f"Concurrent records: expected total_prompt_tokens={n}, "
            f"got {summary['total_prompt_tokens']}"
        )
        assert summary["total_estimated_cost_usd"] == pytest.approx(n * 0.001, rel=1e-4), (
            "Concurrent records: cost should accumulate correctly under concurrency"
        )

    @pytest.mark.asyncio
    async def test_concurrent_records_multiple_models(self) -> None:
        tracker = UsageTracker()
        n_per_model = 20

        async def record_model_a() -> None:
            await tracker.record(make_usage(prompt=2), MODEL_A)

        async def record_model_b() -> None:
            await tracker.record(make_usage(prompt=3), MODEL_B)

        tasks = [record_model_a() for _ in range(n_per_model)]
        tasks += [record_model_b() for _ in range(n_per_model)]
        await asyncio.gather(*tasks)

        by_model = tracker.get_summary_by_model()
        assert by_model[MODEL_A]["request_count"] == n_per_model, (
            f"Concurrent model-A records: expected {n_per_model}, "
            f"got {by_model[MODEL_A]['request_count']}"
        )
        assert by_model[MODEL_B]["request_count"] == n_per_model, (
            f"Concurrent model-B records: expected {n_per_model}, "
            f"got {by_model[MODEL_B]['request_count']}"
        )

    @pytest.mark.asyncio
    async def test_concurrent_reset_and_record(self) -> None:
        """reset() and record() running concurrently should not raise."""
        tracker = UsageTracker()

        async def do_records() -> None:
            for _ in range(10):
                await tracker.record(make_usage(), MODEL_A)

        async def do_resets() -> None:
            for _ in range(5):
                await tracker.reset()
                await asyncio.sleep(0)

        # Should complete without raising
        await asyncio.gather(do_records(), do_resets())
