"""
OpenTelemetry metrics: **RED** (rate, errors, duration), **long-lived** (Prometheus `/metrics`),
and **short-lived** (OTLP push).

- **Long-lived**: instruments from :func:`get_long_lived_meter` and RED metrics are registered on a
  meter provider that uses a Prometheus reader when ``prometheus_metrics_port`` is set; metrics
  are scraped at ``http://<host>:<port>/metrics``.
- **Short-lived**: instruments from :func:`get_short_lived_meter` use a separate provider with OTLP
  export when ``metrics_otlp_endpoint`` is set (push, typically higher churn / ephemeral labels).

If only OTLP is configured, both getters resolve to that provider for backward compatibility.
If only Prometheus is configured, :func:`get_short_lived_meter` raises until OTLP is configured.
"""
from __future__ import annotations

import logging
from typing import Any

from observability_client_runtime.otlp_endpoint_utils import normalize_otlp_http_metrics_endpoint
from observability_client_runtime.otlp_export_tolerance import apply_otlp_unreachable_export_silencing

_logger = logging.getLogger(__name__)

_LOOPBACK_PROM_BIND: frozenset[str] = frozenset(
    {"localhost", "127.0.0.1", "::1"}
)


def _effective_prometheus_bind_addr(host: str) -> str:
    """Use 0.0.0.0 instead of loopback so remote scrapes (e.g. Docker) can reach /metrics."""
    stripped = (host or "").strip()
    if not stripped:
        return "0.0.0.0"
    if stripped.lower() in _LOOPBACK_PROM_BIND:
        _logger.warning(
            "prometheus_metrics_host=%r is loopback; using 0.0.0.0 for remote scrape access",
            stripped,
        )
        return "0.0.0.0"
    return stripped


# Stable semantic attributes for HTTP (OpenTelemetry; string keys avoid extra semconv deps).
ATTR_HTTP_REQUEST_METHOD = "http.request.method"
ATTR_URL_PATH = "url.path"
ATTR_HTTP_ROUTE = "http.route"
ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code"

_METER_NAME_RED = "agent_studio.observability.red"
_METER_VERSION = "1.0.0"

_long_lived_provider: Any | None = None
_short_lived_provider: Any | None = None
_prometheus_server_port: int | None = None  # tracks the port that start_http_server already bound


def get_long_lived_meter(name: str = "domain", version: str = _METER_VERSION) -> Any:
    """
    Meter for **long-lived** metrics (RED, stable business counters) exposed via Prometheus when
    ``prometheus_metrics_port`` is set.

    Falls back to the OTLP-only provider when Prometheus is not configured.
    """
    if _long_lived_provider is not None:
        return _long_lived_provider.get_meter(name, version)
    if _short_lived_provider is not None:
        return _short_lived_provider.get_meter(name, version)
    from opentelemetry import metrics as otel_metrics

    return otel_metrics.get_meter(name, version)


def get_short_lived_meter(name: str = "domain.short", version: str = _METER_VERSION) -> Any:
    """
    Meter for **short-lived** / high-churn metrics exported via **OTLP push** only.

    Requires ``metrics_otlp_endpoint`` (or env) to be configured. Use for ephemeral labels or
    bursty series that should not be scraped from ``/metrics``.
    """
    if _short_lived_provider is not None:
        return _short_lived_provider.get_meter(name, version)
    if _long_lived_provider is not None:
        raise RuntimeError(
            "Short-lived OTLP metrics are not configured. Set metrics_otlp_endpoint (or "
            "OTEL_EXPORTER_OTLP_*) while using prometheus_metrics_port for long-lived scrape, "
            "or use only OTLP (get_long_lived_meter / get_business_meter will use the OTLP provider)."
        )
    from opentelemetry import metrics as otel_metrics

    return otel_metrics.get_meter(name, version)


def get_business_meter(name: str = "domain", version: str = _METER_VERSION) -> Any:
    """Same as :func:`get_long_lived_meter` (stable domain instruments)."""
    return get_long_lived_meter(name, version)


def flush_meter_providers() -> None:
    """Force-flush OTLP / Prometheus metric readers so pending exports run (tests, shutdown hooks)."""
    for prov in (_long_lived_provider, _short_lived_provider):
        if prov is not None and hasattr(prov, "force_flush"):
            prov.force_flush()


def configure_meter_providers(
    *,
    metrics_otlp_endpoint: str | None,
    metrics_export_interval_ms: int,
    metrics_service_name: str | None,
    prometheus_metrics_port: int | None,
    prometheus_metrics_host: str,
) -> None:
    """
    Build long-lived (Prometheus) and/or short-lived (OTLP) meter providers and set the global
    provider to the long-lived one when present, else the OTLP one.

    Safe to call when optional dependencies are missing: skips unavailable exporters.
    """
    global _long_lived_provider, _short_lived_provider, _prometheus_server_port
    apply_otlp_unreachable_export_silencing()
    _long_lived_provider = None
    _short_lived_provider = None

    try:
        from opentelemetry import metrics as otel_metrics
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.resources import Resource
    except ImportError:
        return

    resource = (
        Resource.create({"service.name": metrics_service_name})
        if metrics_service_name
        else Resource.create({})
    )

    readers_long: list[Any] = []
    readers_short: list[Any] = []

    if prometheus_metrics_port is not None:
        bind_addr = _effective_prometheus_bind_addr(prometheus_metrics_host)
        try:
            from opentelemetry.exporter.prometheus import PrometheusMetricReader
            from prometheus_client import start_http_server
        except ImportError:
            pass
        else:
            if _prometheus_server_port == prometheus_metrics_port:
                # Server already bound on this port (e.g. auto-configured by get_logger() at import
                # time then re-configured explicitly in app lifespan). Reuse existing server.
                _logger.debug(
                    "Prometheus /metrics server already running on port %s; reusing.",
                    prometheus_metrics_port,
                )
                readers_long.append(PrometheusMetricReader())
            else:
                try:
                    start_http_server(port=prometheus_metrics_port, addr=bind_addr)
                except OSError as e:
                    _logger.warning(
                        "Prometheus /metrics server not started: cannot bind %s:%s (%s). "
                        "Choose a free port or stop the process using that port.",
                        bind_addr,
                        prometheus_metrics_port,
                        e,
                    )
                else:
                    _prometheus_server_port = prometheus_metrics_port
                    readers_long.append(PrometheusMetricReader())

    if metrics_otlp_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
            from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        except ImportError:
            pass
        else:
            exporter = OTLPMetricExporter(
                endpoint=normalize_otlp_http_metrics_endpoint(metrics_otlp_endpoint)
            )
            readers_short.append(
                PeriodicExportingMetricReader(
                    exporter,
                    export_interval_millis=metrics_export_interval_ms,
                )
            )

    if readers_long:
        _long_lived_provider = MeterProvider(metric_readers=readers_long, resource=resource)
    if readers_short:
        _short_lived_provider = MeterProvider(metric_readers=readers_short, resource=resource)

    if _long_lived_provider is not None:
        try:
            otel_metrics.set_meter_provider(_long_lived_provider)
        except Exception:
            return
    elif _short_lived_provider is not None:
        try:
            otel_metrics.set_meter_provider(_short_lived_provider)
        except Exception:
            return


class _RedMetricsSpanProcessor:
    """Emit RED counters + duration histogram for completed SERVER spans."""

    _ATTACHED_ATTR = "_agent_studio_red_metrics_processor_attached"

    def __init__(self) -> None:
        meter = get_long_lived_meter(_METER_NAME_RED, _METER_VERSION)
        self._request_counter = meter.create_counter(
            name="http.server.request.count",
            unit="",
            description="Total HTTP server requests (RED: rate)",
        )
        self._error_counter = meter.create_counter(
            name="http.server.request.error.count",
            unit="",
            description="HTTP server requests that ended with ERROR status (RED: errors)",
        )
        self._duration_ms = meter.create_histogram(
            name="http.server.request.duration_ms",
            unit="",
            description="HTTP server request duration in milliseconds (RED: duration)",
        )

    def on_start(self, span: Any, parent_context: Any | None = None) -> None:
        del span, parent_context

    def _on_ending(self, span: Any) -> None:
        del span

    def on_end(self, span: Any) -> None:
        try:
            from opentelemetry.trace import SpanKind, StatusCode
        except ImportError:
            return
        if getattr(span, "kind", None) != SpanKind.SERVER:
            return
        attrs = _metric_attributes_from_span(span)
        self._request_counter.add(1, attrs)
        status = getattr(span, "status", None)
        if status is not None and getattr(status, "status_code", None) == StatusCode.ERROR:
            self._error_counter.add(1, attrs)
        st = getattr(span, "start_time", None)
        et = getattr(span, "end_time", None)
        if st is not None and et is not None:
            duration_ms = (et - st) / 1_000_000
            self._duration_ms.record(duration_ms, attrs)

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        del timeout_millis
        return True

    @classmethod
    def attach_once(cls, provider: Any) -> None:
        if getattr(provider, cls._ATTACHED_ATTR, False):
            return
        # Add via the owned hub so detach never needs to reach into SDK private fields.
        from observability_client_runtime.logger_handler import _AgentStudioSpanProcessorHub
        hub = _AgentStudioSpanProcessorHub.get_or_attach(provider)
        hub.add(cls())
        setattr(provider, cls._ATTACHED_ATTR, True)

    @classmethod
    def detach_if_present(cls, provider: Any) -> None:
        # Remove from our owned hub — no OTel SDK private field access needed.
        from observability_client_runtime.logger_handler import _AgentStudioSpanProcessorHub
        hub = _AgentStudioSpanProcessorHub._instance
        if hub is not None:
            hub.remove_type(cls)
        setattr(provider, cls._ATTACHED_ATTR, False)


def _metric_attributes_from_span(span: Any) -> dict[str, str]:
    raw = dict(getattr(span, "attributes", {}) or {})
    method = str(raw.get(ATTR_HTTP_REQUEST_METHOD, "") or "")
    path = str(raw.get(ATTR_URL_PATH, "") or raw.get(ATTR_HTTP_ROUTE, "") or "")
    project_id = str(raw.get("project_id", "") or "")
    status_code = str(raw.get(ATTR_HTTP_RESPONSE_STATUS_CODE, "") or "")
    if not method or not path:
        name = str(getattr(span, "name", "") or "")
        parts = name.split(" ", 1)
        if len(parts) >= 2:
            method = method or parts[0]
            path = path or parts[1]
        elif len(parts) == 1 and not path:
            path = parts[0]
    attrs: dict[str, str] = {
        ATTR_HTTP_REQUEST_METHOD: method or "GET",
        ATTR_URL_PATH: path or "/",
    }
    if status_code:
        attrs[ATTR_HTTP_RESPONSE_STATUS_CODE] = status_code
    if project_id:
        attrs["project_id"] = project_id
    return attrs


__all__ = (
    "ATTR_HTTP_REQUEST_METHOD",
    "ATTR_HTTP_ROUTE",
    "ATTR_URL_PATH",
    "configure_meter_providers",
    "flush_meter_providers",
    "get_business_meter",
    "get_long_lived_meter",
    "get_short_lived_meter",
)
