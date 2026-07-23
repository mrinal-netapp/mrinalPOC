"""Tests for acquisition pipeline resilience helpers (EOF Redis failure cap).

Complements test_redis_stream.py (JobStream/DirQueue primitives).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from streaming.redis_stream import (  # noqa: E402
    EOF_SEEN_REDIS_FAILURE_THRESHOLD,
    track_eof_seen_redis_failures as _track_eof_seen_redis_failures,
)


class TestTrackEofSeenRedisFailures:
    def test_counter_resets_on_definite_false(self) -> None:
        c = [0]
        _track_eof_seen_redis_failures(None, c)
        assert c[0] == 1
        _track_eof_seen_redis_failures(False, c)
        assert c[0] == 0

    def test_counter_resets_on_definite_true(self) -> None:
        c = [0]
        for _ in range(3):
            _track_eof_seen_redis_failures(None, c)
        assert c[0] == 3
        _track_eof_seen_redis_failures(True, c)
        assert c[0] == 0

    def test_raises_after_threshold_consecutive_none(self) -> None:
        c = [0]
        for _ in range(EOF_SEEN_REDIS_FAILURE_THRESHOLD):
            _track_eof_seen_redis_failures(None, c)
        assert c[0] == EOF_SEEN_REDIS_FAILURE_THRESHOLD
        with pytest.raises(RuntimeError, match="get_eof_seen"):
            _track_eof_seen_redis_failures(None, c)

    def test_exactly_threshold_none_values_does_not_raise(self) -> None:
        """Counter may reach THRESHOLD; raise only on the (THRESHOLD+1)th None."""
        c = [0]
        for _ in range(EOF_SEEN_REDIS_FAILURE_THRESHOLD):
            _track_eof_seen_redis_failures(None, c)
        assert c[0] == EOF_SEEN_REDIS_FAILURE_THRESHOLD
