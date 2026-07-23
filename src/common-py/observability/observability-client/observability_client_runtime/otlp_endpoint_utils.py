"""
OTLP/HTTP exporter URLs: OpenTelemetry POSTs to full paths ``/v1/traces`` and ``/v1/metrics``.
If callers pass only the OTLP base (e.g. ``http://collector:4318``), append the path like the
official exporters do when reading ``OTEL_EXPORTER_OTLP_ENDPOINT``.
"""


def _append_signal_path(endpoint: str, export_path: str) -> str:
    if endpoint.endswith("/"):
        return endpoint + export_path
    return endpoint + "/" + export_path


def normalize_otlp_http_traces_endpoint(url: str) -> str:
    u = url.strip()
    if not u:
        return u
    base = u.rstrip("/")
    if base.lower().endswith("v1/traces"):
        return base
    return _append_signal_path(u.rstrip("/"), "v1/traces")


def normalize_otlp_http_metrics_endpoint(url: str) -> str:
    u = url.strip()
    if not u:
        return u
    base = u.rstrip("/")
    if base.lower().endswith("v1/metrics"):
        return base
    return _append_signal_path(u.rstrip("/"), "v1/metrics")
