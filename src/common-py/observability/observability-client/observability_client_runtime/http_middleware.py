"""
HTTP request → one OpenTelemetry server span per request.

All structlog logs emitted while handling that request see the same trace_id / span_id
(via get_current_span()), as long as ``configure_observability_logging(config=...)`` has run.

Supports:
  - ASGI (Starlette / FastAPI) via ASGITraceMiddleware
  - Flask via register_flask_request_tracing

Incoming W3C traceparent headers are respected (distributed tracing).
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.propagate import extract

from .context_vars import bind_context, clear_context
from .otel_red_and_business_metrics import (
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_HTTP_RESPONSE_STATUS_CODE,
    ATTR_URL_PATH,
)

_TRACER_NAME = "logging.client_library"


def _headers_to_carrier(scope_headers: list[tuple[bytes, bytes]]) -> dict[str, str]:
    """ASGI headers list → dict with lowercase keys (for W3C propagator)."""
    carrier: dict[str, str] = {}
    for k, v in scope_headers:
        key = k.decode("latin-1").lower()
        val = v.decode("latin-1", "replace")
        carrier[key] = val
    return carrier


def asgi_trace_middleware(app: Callable[..., Any]) -> Callable[..., Any]:
    """
    Wrap an ASGI application so each HTTP request runs in a SERVER span.

    All logs during ``await app(...)`` share one trace_id (child of incoming traceparent if present).

    Prefer :class:`ASGITraceMiddleware` with FastAPI/Starlette ``add_middleware``.
    """

    async def wrapped(scope: dict, receive: Callable, send: Callable) -> None:
        if scope.get("type") != "http":
            await app(scope, receive, send)
            return

        carrier = _headers_to_carrier(scope.get("headers") or [])
        ctx = extract(carrier)
        extract_token = otel_context.attach(ctx)

        method_raw = scope.get("method") or "GET"
        path_raw = scope.get("path") or "/"
        method = method_raw.decode("latin-1", "replace") if isinstance(method_raw, bytes) else str(method_raw)
        path = path_raw.decode("latin-1", "replace") if isinstance(path_raw, bytes) else str(path_raw)
        tracer = trace.get_tracer(_TRACER_NAME)

        project_id = carrier.get("x-project-id", "")

        try:
            with tracer.start_as_current_span(
                f"{method} {path}",
                kind=trace.SpanKind.SERVER,
                attributes={
                    ATTR_HTTP_REQUEST_METHOD: method,
                    ATTR_URL_PATH: path,
                },
            ) as span:
                if project_id:
                    span.set_attribute("project_id", project_id)
                    bind_context(project_id=project_id)

                async def send_with_status(message: dict) -> None:
                    if message.get("type") == "http.response.start":
                        status = int(message.get("status", 200))
                        span.set_attribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status)
                        if status >= 500:
                            span.set_status(trace.Status(trace.StatusCode.ERROR))
                    await send(message)

                try:
                    await app(scope, receive, send_with_status)
                finally:
                    if project_id:
                        clear_context()
        finally:
            otel_context.detach(extract_token)

    return wrapped


class ASGITraceMiddleware:
    """
    Starlette / FastAPI middleware: one SERVER span per HTTP request.

    Example::

        from fastapi import FastAPI
        from http_middleware import ASGITraceMiddleware

        app = FastAPI()
        app.add_middleware(ASGITraceMiddleware)
    """

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = asgi_trace_middleware(app)

    async def __call__(self, scope: dict, receive: Callable, send: Callable) -> None:
        await self.app(scope, receive, send)


def register_flask_request_tracing(app: Any) -> None:
    """
    Register Flask hooks so each request runs inside a SERVER span.

    Example::

        from flask import Flask
        from http_middleware import register_flask_request_tracing

        app = Flask(__name__)
        register_flask_request_tracing(app)
    """
    from flask import g, has_request_context, request

    tracer = trace.get_tracer(_TRACER_NAME)

    @app.before_request
    def _otel_before_request() -> None:
        carrier = {k.lower(): v for k, v in request.headers.items()}
        ctx = extract(carrier)
        g._otel_extract_token = otel_context.attach(ctx)
        span = tracer.start_span(
            f"{request.method} {request.path}",
            kind=trace.SpanKind.SERVER,
            attributes={
                ATTR_HTTP_REQUEST_METHOD: request.method,
                ATTR_URL_PATH: request.path,
            },
        )
        project_id = request.headers.get("X-Project-ID", "")
        if project_id:
            span.set_attribute("project_id", project_id)
            bind_context(project_id=project_id)
        g._otel_span = span
        g._otel_span_token = otel_context.attach(trace.set_span_in_context(span))

    @app.after_request
    def _otel_after_request(response: Any) -> Any:
        span = getattr(g, "_otel_span", None)
        if span is not None:
            span.set_attribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status_code)
            if response.status_code >= 500:
                span.set_status(trace.Status(trace.StatusCode.ERROR))
        return response

    @app.teardown_request
    def _otel_teardown_request(_exc: BaseException | None) -> None:
        if not has_request_context():
            return
        span_token = getattr(g, "_otel_span_token", None)
        span = getattr(g, "_otel_span", None)
        extract_token = getattr(g, "_otel_extract_token", None)
        if span_token is not None:
            otel_context.detach(span_token)
        if span is not None:
            span.end()
        if extract_token is not None:
            otel_context.detach(extract_token)
        clear_context()

