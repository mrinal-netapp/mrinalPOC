"""Phoenix (Arize) tracing via OpenTelemetry OTLP HTTP + OpenInference Agno."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import os
from collections.abc import Generator
from typing import Optional

from observability_client_runtime import get_logger
from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from openinference.semconv.resource import ResourceAttributes

from .config import settings

logger = get_logger()

_tracer_provider: TracerProvider | None = None

# Set per AgentStudio HTTP invoke (project id from URL). Used by _PhoenixProjectSpanProcessor
# so OTLP spans land in Phoenix project == AgentStudio project id (concurrent-safe via contextvars).
agentstudio_phoenix_project_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "agentstudio_phoenix_project_id",
    default=None,
)


@contextlib.contextmanager
def phoenix_project_scope(project_id: str) -> Generator[None, None, None]:
    """Scope OpenTelemetry spans to a Phoenix project named ``project_id`` (AgentStudio project id)."""
    token = agentstudio_phoenix_project_id.set(project_id)
    try:
        yield
    finally:
        agentstudio_phoenix_project_id.reset(token)


@contextlib.contextmanager
def agno_team_nest_under_current_span() -> Generator[None, None, None]:
    """Make OpenInference Agno Team runs children of the current OTEL span.

    Agno's instrumentor starts top-level :class:`agno.team.team.Team` runs with an
    invalid parent context so each run becomes its own trace. When we wrap
    ``team.arun`` in ``invoke_team_*`` with ``start_as_current_span``, that would
    otherwise leave all Agno/model spans in a separate trace from our HTTP span.
    Setting a synthetic Agno parent node id skips that behavior so spans nest under
    the active span (see ``_get_team_span_context`` in OpenInference's run wrapper).
    """
    try:
        from openinference.instrumentation.agno.utils import (
            _AGNO_PARENT_NODE_CONTEXT_KEY,
        )
    except ImportError:
        yield
        return

    from opentelemetry import context as otel_context

    new_ctx = otel_context.set_value(
        _AGNO_PARENT_NODE_CONTEXT_KEY,
        "agentstudio.invoke",
    )
    tok = otel_context.attach(new_ctx)
    try:
        yield
    finally:
        otel_context.detach(tok)


class _PhoenixProjectSpanProcessor(SpanProcessor):
    """Assign OpenInference PROJECT_NAME from ``agentstudio_phoenix_project_id`` on export (per-span)."""

    def on_start(self, span: Span, parent_context: Optional[Context] = None) -> None:
        return

    def on_end(self, span: ReadableSpan) -> None:
        pid = agentstudio_phoenix_project_id.get()
        if not pid:
            return
        try:
            old_res = span.resource
        except Exception:
            old_res = getattr(span, "_resource", None)
        if old_res is None:
            return
        try:
            merged = {**dict(old_res.attributes), ResourceAttributes.PROJECT_NAME: pid}
            schema_url = getattr(old_res, "schema_url", None) or None
            new_res = Resource(merged, schema_url)
            setattr(span, "_resource", new_res)
        except Exception as exc:
            logger.debug("Could not set Phoenix project on span: %s", exc)

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def init_tracing() -> None:
    global _tracer_provider
    endpoint = os.getenv("PHOENIX_COLLECTOR_ENDPOINT", "").strip()
    if not endpoint:
        logger.info("PHOENIX_COLLECTOR_ENDPOINT not set; Phoenix tracing disabled")
        return

    # HTTP client timeout for each OTLP export (seconds). Default OTLP is often 10s; Phoenix/SQLite can be slow under load.
    export_timeout = int(float(os.getenv("PHOENIX_OTLP_TIMEOUT_SECONDS", "30")))
    # BatchSpanProcessor max time to wait for an export batch to finish (ms). Should be >= exporter timeout.
    bsp_export_timeout_ms = int(os.getenv("PHOENIX_OTLP_BSP_EXPORT_TIMEOUT_MS", "60000"))

    # Default project for spans created outside phoenix_project_scope (should be rare).
    resource = Resource.create(
        {
            ResourceAttributes.PROJECT_NAME: settings.PHOENIX_PROJECT_NAME,
            "service.name": "agent-service",
        }
    )
    _tracer_provider = TracerProvider(resource=resource)
    # Must run before BatchSpanProcessor so exported spans carry the per-request project name.
    _tracer_provider.add_span_processor(_PhoenixProjectSpanProcessor())
    exporter = OTLPSpanExporter(endpoint=endpoint, timeout=export_timeout)
    _tracer_provider.add_span_processor(
        BatchSpanProcessor(
            exporter,
            export_timeout_millis=bsp_export_timeout_ms,
        )
    )
    trace.set_tracer_provider(_tracer_provider)

    from openinference.instrumentation.agno import AgnoInstrumentor

    AgnoInstrumentor().instrument(tracer_provider=_tracer_provider)

    # NOTE: We intentionally do NOT register LiteLLMInstrumentor here.
    # AgnoInstrumentor already creates LLM spans (e.g. "LiteLLM.ainvoke_stream",
    # named after Agno's upstream ``agno.models.litellm.LiteLLM`` class) that
    # capture model, messages, and token usage. Adding LiteLLMInstrumentor
    # would monkey-patch the ``litellm`` Python SDK Agno uses internally and
    # produce a redundant child span ("acompletion") with identical duration
    # and attributes, doubling LLM span volume in Phoenix without adding info.

    logger.info(
        "Phoenix tracing enabled: endpoint=%s otlp_timeout=%ss bsp_export_timeout_ms=%s",
        endpoint,
        export_timeout,
        bsp_export_timeout_ms,
    )


async def shutdown_tracing() -> None:
    global _tracer_provider
    if _tracer_provider is None:
        return
    await asyncio.to_thread(_tracer_provider.shutdown)
    _tracer_provider = None
    logger.info("Phoenix tracer provider shut down")


def tracing_enabled() -> bool:
    """True when Phoenix OTLP tracing was initialized (TracerProvider registered)."""
    return _tracer_provider is not None


def get_phoenix_api_url() -> str:
    """Base URL for Phoenix REST API (spans/traces queries), e.g. http://phoenix:6006.

    Uses PHOENIX_API_URL when set; otherwise strips ``/v1/traces`` from PHOENIX_COLLECTOR_ENDPOINT.
    """
    explicit = (settings.PHOENIX_API_URL or "").strip()
    if explicit:
        return explicit.rstrip("/")
    endpoint = os.getenv("PHOENIX_COLLECTOR_ENDPOINT", "").strip()
    if not endpoint:
        return ""
    if endpoint.endswith("/v1/traces"):
        return endpoint[: -len("/v1/traces")].rstrip("/")
    # Fallback: drop last path segment (e.g. .../v1/traces -> .../v1)
    return endpoint.rsplit("/", 1)[0].rstrip("/")
