"""Unit tests for temporal_worker entrypoint helpers."""

from __future__ import annotations

from datetime import timedelta

import pytest

pytest.importorskip("temporalio")

import temporal_worker as tw  # noqa: E402


class TestGracefulShutdownTimeout:
    def test_parses_seconds_from_env(self, monkeypatch):
        monkeypatch.setenv("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", "120s")
        assert tw._graceful_shutdown_timeout() == timedelta(seconds=120)

    def test_defaults_on_invalid_value(self, monkeypatch):
        monkeypatch.setenv("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", "not-a-number")
        assert tw._graceful_shutdown_timeout() == timedelta(seconds=90)

    def test_defaults_when_unset(self, monkeypatch):
        monkeypatch.delenv("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", raising=False)
        assert tw._graceful_shutdown_timeout() == timedelta(seconds=90)

    def test_strips_suffix(self, monkeypatch):
        monkeypatch.setenv("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", "45S")
        assert tw._graceful_shutdown_timeout() == timedelta(seconds=45)
