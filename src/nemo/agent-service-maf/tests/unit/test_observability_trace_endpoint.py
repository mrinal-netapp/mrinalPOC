"""Tests for OTLP trace endpoint resolution (AKS app-monitoring safe path)."""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def api_module(monkeypatch: pytest.MonkeyPatch):
    """Import api module with observability client stubbed out."""
    monkeypatch.setenv("AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "/dev/stdout")
    for key in (
        "PHOENIX_COLLECTOR_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_BEFORE_AUTO_INSTRUMENTATION",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ):
        monkeypatch.delenv(key, raising=False)
    return importlib.import_module("agent_service_maf.interface_layer.api")


def test_prefers_phoenix_collector_endpoint(api_module, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "PHOENIX_COLLECTOR_ENDPOINT",
        "http://observability-otel-collector.monitoring.svc.cluster.local:4318/v1/traces",
    )
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://10.0.1.187:28331/v1/traces")
    assert (
        api_module._resolve_otlp_traces_endpoint()
        == "http://observability-otel-collector.monitoring.svc.cluster.local:4318/v1/traces"
    )


def test_falls_back_to_pre_auto_instrumentation_endpoint(
    api_module, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_BEFORE_AUTO_INSTRUMENTATION",
        "http://observability-otel-collector.monitoring.svc.cluster.local:4318",
    )
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://10.0.1.187:28331/v1/traces")
    assert (
        api_module._resolve_otlp_traces_endpoint()
        == "http://observability-otel-collector.monitoring.svc.cluster.local:4318"
    )


def test_falls_back_to_otel_traces_endpoint(api_module, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://collector:4318")
    assert api_module._resolve_otlp_traces_endpoint() == "http://collector:4318"


def test_returns_none_when_unset(api_module, monkeypatch: pytest.MonkeyPatch) -> None:
    assert api_module._resolve_otlp_traces_endpoint() is None
