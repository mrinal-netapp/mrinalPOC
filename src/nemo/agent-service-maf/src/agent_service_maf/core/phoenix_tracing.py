"""Per-project discriminator for Phoenix observability (O1).

The Phoenix Observability MCP bridge (``src/images/mcp-server-phoenix``) enforces
hard per-project isolation, but that is only meaningful if the telemetry it
queries is *tagged* by AgentStudio project. MAF exports all spans under a single
``service.name=agent-service-maf`` (per-service, not per-project), so without
this module every project's spans would be indistinguishable in Phoenix.

This installs a span processor that stamps spans from the request-scoped
identity ContextVar
(:func:`agent_service_maf.core.identity.get_current_identity`) that every invoke
route binds via ``set_current_identity``. Two things are read off the active
identity at span-start time, with different wiring requirements:

* the caller's AgentStudio **project id** — always present on a bound identity
  (``validate_project_access`` sets it), so this needs no route cooperation
  beyond the identity binding that already exists.
* the OpenInference **session.id** — only stamped when a route populates
  ``IdentityContext.session_id`` *before* binding. The invoke/stream routes do
  this explicitly (``identity.model_copy(update={"session_id": ...})`` with the
  raw, un-scoped id) so spans carry ``session.id`` for session -> trace
  lookups. This wiring is required: a route that binds an identity without a
  session_id simply produces spans with no ``session.id`` (no error, but those
  spans can't be looked up by session). Preserve it when adding invoke routes.

Two discriminators are written so either Phoenix MCP mode works:

* ``agentstudio.project_id`` **span attribute** (attribute mode) — set on span
  *start*, so it is present for the whole span lifetime and applies to every
  child span (httpx, model calls, ...) created while an identity is bound. This
  is the primary, ordering-independent mechanism and matches the bridge's
  ``PHOENIX_PROJECT_ATTR``.
* OpenInference ``openinference.project.name`` **resource attribute**
  (project_name mode) — best-effort on span *end*, mirroring the legacy
  ``agent-service`` behavior so operators who prefer a per-project Phoenix
  project can opt into it. Its reliability depends on this processor running
  before the export processor; attribute mode does not.

Fail-safe: when no identity is bound (startup, no-auth dev paths) nothing is
stamped, so the bridge's project filter simply matches no rows — never another
project's data.
"""

from __future__ import annotations

import contextlib
import os
from typing import TYPE_CHECKING

import structlog
from opentelemetry import trace

from agent_service_maf.core.identity import get_current_identity

if TYPE_CHECKING:
    # Types only — this module must import without the OpenTelemetry SDK present
    # (annotations are strings via ``from __future__ import annotations``).
    from opentelemetry.context import Context
    from opentelemetry.sdk.trace import ReadableSpan, Span

logger = structlog.get_logger(__name__)

# Span attribute the Phoenix MCP bridge filters on in "attribute" mode. Kept in
# sync with PHOENIX_PROJECT_ATTR in src/images/mcp-server-phoenix/server.py.
PROJECT_ATTRIBUTE = os.environ.get("PHOENIX_PROJECT_ATTR", "agentstudio.project_id")

# OpenInference resource attribute Phoenix reads to route spans to a project.
_OPENINFERENCE_PROJECT_NAME = "openinference.project.name"

# OpenInference span attribute Phoenix uses to group spans into sessions and to
# support session -> trace lookups. Stamping it lets callers filter spans by
# ``session.id == '<id>'`` and enumerate a session's traces.
SESSION_ATTRIBUTE = "session.id"

_installed = False


def _current_project_id() -> str:
    identity = get_current_identity()
    if identity is None:
        return ""
    return (identity.project_id or "").strip()


def _current_session_id() -> str:
    identity = get_current_identity()
    if identity is None:
        return ""
    return (getattr(identity, "session_id", "") or "").strip()


class PhoenixProjectSpanProcessor:
    """Stamp the active AgentStudio project id onto spans.

    Duck-typed to the OpenTelemetry ``SpanProcessor`` protocol (``on_start`` /
    ``_on_ending`` / ``on_end`` / ``shutdown`` / ``force_flush``) rather than
    subclassing, so this module imports without the OpenTelemetry SDK present
    (only the API is needed to register it on the active provider). Note that
    ``_on_ending`` is not optional: the SDK calls it on every registered
    processor at span end, so it must exist even though it is "private".
    """

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        pid = _current_project_id()
        if pid:
            # Defensive; never break tracing.
            with contextlib.suppress(Exception):  # pragma: no cover
                span.set_attribute(PROJECT_ATTRIBUTE, pid)
        # Stamp the session id (OpenInference session.id) so spans group into
        # sessions and can be filtered/looked-up by session. Set at start so it
        # applies to the whole span lifetime and all child spans.
        sid = _current_session_id()
        if sid:
            # Defensive; never break tracing.
            with contextlib.suppress(Exception):  # pragma: no cover
                span.set_attribute(SESSION_ATTRIBUTE, sid)

    def _on_ending(self, span: Span) -> None:
        # Called by the OpenTelemetry SDK while the span is still WRITABLE, just
        # before it is sealed and handed to on_end / exporters. This is the
        # correct place to rewrite the span's resource so it routes to a
        # per-project Phoenix project. It is also a REQUIRED hook: opentelemetry
        # -sdk (>=1.x) invokes SpanProcessor._on_ending on every registered
        # processor when a span ends, so a duck-typed processor missing it raises
        # ``AttributeError: ... has no attribute '_on_ending'`` on every span end.
        pid = _current_project_id()
        if not pid:
            return
        # Best-effort: route the span to a per-project Phoenix project by
        # rewriting the OpenInference project-name resource attribute.
        try:
            from opentelemetry.sdk.resources import Resource  # lazy: SDK optional
        except Exception:  # pragma: no cover
            return
        try:
            old_res = getattr(span, "resource", None) or getattr(span, "_resource", None)
            if old_res is None:
                return
            merged = {**dict(old_res.attributes), _OPENINFERENCE_PROJECT_NAME: pid}
            schema_url = getattr(old_res, "schema_url", None) or None
            span._resource = Resource(merged, schema_url)  # noqa: SLF001
        except Exception as exc:  # pragma: no cover
            logger.debug("could not stamp phoenix project on span", error=str(exc))

    def on_end(self, span: ReadableSpan) -> None:
        # Span is read-only here; per-project routing happens in _on_ending
        # (above) while the span is still writable. Kept as a no-op so the
        # duck-typed SpanProcessor protocol (on_start/_on_ending/on_end/
        # shutdown/force_flush) stays complete — the SDK calls on_end too.
        return

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def install_phoenix_project_stamping() -> bool:
    """Register the project-stamping processor on the active TracerProvider.

    Idempotent. Returns ``True`` when a processor was installed, ``False`` when
    tracing is not active (no SDK TracerProvider) or it was already installed.
    Safe to call unconditionally at startup after observability is configured.
    """
    global _installed
    if _installed:
        return False
    provider = trace.get_tracer_provider()
    add_span_processor = getattr(provider, "add_span_processor", None)
    if not callable(add_span_processor):
        # No-op API provider (tracing disabled / not configured yet).
        logger.info("phoenix project stamping skipped: no SDK TracerProvider active")
        return False
    add_span_processor(PhoenixProjectSpanProcessor())
    _installed = True
    logger.info("phoenix project stamping installed", attribute=PROJECT_ATTRIBUTE)
    return True


__all__ = [
    "PROJECT_ATTRIBUTE",
    "PhoenixProjectSpanProcessor",
    "install_phoenix_project_stamping",
]
