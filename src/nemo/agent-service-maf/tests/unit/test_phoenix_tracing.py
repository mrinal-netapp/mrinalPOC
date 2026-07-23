"""Unit tests for the Phoenix per-project span stamping (O1).

The processor reads the request-scoped identity ContextVar and stamps the
``agentstudio.project_id`` attribute on spans so the Phoenix Observability MCP
can enforce per-project isolation. These tests use a fake span + the real
identity ContextVar; no OpenTelemetry SDK is required.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.core.phoenix_tracing import (
    PROJECT_ATTRIBUTE,
    SESSION_ATTRIBUTE,
    PhoenixProjectSpanProcessor,
    install_phoenix_project_stamping,
)


def _identity(project_id: str) -> IdentityContext:
    return IdentityContext(user_id="alice", project_id=project_id)


def test_on_start_stamps_project_id_from_identity():
    span = MagicMock()
    tok = set_current_identity(_identity("proj-a"))
    try:
        PhoenixProjectSpanProcessor().on_start(span)
    finally:
        reset_current_identity(tok)
    span.set_attribute.assert_called_once_with(PROJECT_ATTRIBUTE, "proj-a")


def test_on_start_stamps_session_id_when_present():
    span = MagicMock()
    identity = IdentityContext(user_id="alice", project_id="proj-a", session_id="sess-1")
    tok = set_current_identity(identity)
    try:
        PhoenixProjectSpanProcessor().on_start(span)
    finally:
        reset_current_identity(tok)
    span.set_attribute.assert_any_call(PROJECT_ATTRIBUTE, "proj-a")
    span.set_attribute.assert_any_call(SESSION_ATTRIBUTE, "sess-1")


def test_on_start_no_identity_does_not_stamp():
    span = MagicMock()
    # No identity bound in this context.
    PhoenixProjectSpanProcessor().on_start(span)
    span.set_attribute.assert_not_called()


def test_on_start_empty_project_id_does_not_stamp():
    span = MagicMock()
    tok = set_current_identity(_identity(""))
    try:
        PhoenixProjectSpanProcessor().on_start(span)
    finally:
        reset_current_identity(tok)
    span.set_attribute.assert_not_called()


def test_on_start_never_raises_on_bad_span():
    span = MagicMock()
    span.set_attribute.side_effect = RuntimeError("boom")
    tok = set_current_identity(_identity("proj-a"))
    try:
        # Must swallow the error — tracing must never break the request.
        PhoenixProjectSpanProcessor().on_start(span)
    finally:
        reset_current_identity(tok)


def test_processor_has_full_spanprocessor_protocol():
    # Regression: opentelemetry-sdk (>=1.x) calls SpanProcessor._on_ending on
    # every registered processor when a span ends. A missing _on_ending raised
    # "'PhoenixProjectSpanProcessor' object has no attribute '_on_ending'" on
    # every span end. Guard the whole duck-typed protocol so it can't regress.
    proc = PhoenixProjectSpanProcessor()
    for method in ("on_start", "_on_ending", "on_end", "shutdown", "force_flush"):
        assert callable(getattr(proc, method, None)), f"missing SpanProcessor method: {method}"


def test_on_ending_and_on_end_never_raise():
    # Both hooks run synchronously on the span-ending thread and must never
    # throw — a raise here would break every traced request.
    span = MagicMock()
    tok = set_current_identity(_identity("proj-a"))
    try:
        PhoenixProjectSpanProcessor()._on_ending(span)
        PhoenixProjectSpanProcessor().on_end(span)
    finally:
        reset_current_identity(tok)


def test_default_attribute_matches_bridge_default():
    # Kept in sync with PHOENIX_PROJECT_ATTR in mcp-server-phoenix/server.py.
    assert PROJECT_ATTRIBUTE == "agentstudio.project_id"


def test_install_is_noop_without_sdk_tracer_provider(monkeypatch):
    # The default (no-op API) provider has no add_span_processor; install must
    # return False and not raise.
    import agent_service_maf.core.phoenix_tracing as pt

    monkeypatch.setattr(pt, "_installed", False)

    class _NoopProvider:
        pass

    monkeypatch.setattr(pt.trace, "get_tracer_provider", lambda: _NoopProvider())
    assert install_phoenix_project_stamping() is False


def test_install_registers_on_sdk_provider(monkeypatch):
    import agent_service_maf.core.phoenix_tracing as pt

    monkeypatch.setattr(pt, "_installed", False)
    added: list[object] = []

    class _SdkProvider:
        def add_span_processor(self, proc):
            added.append(proc)

    monkeypatch.setattr(pt.trace, "get_tracer_provider", lambda: _SdkProvider())

    assert install_phoenix_project_stamping() is True
    assert len(added) == 1
    assert isinstance(added[0], PhoenixProjectSpanProcessor)
    # Idempotent: a second call is a no-op.
    assert install_phoenix_project_stamping() is False
    assert len(added) == 1
