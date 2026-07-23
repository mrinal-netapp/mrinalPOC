"""
Tone down OpenTelemetry OTLP HTTP/gRPC exporter logging when the collector is unreachable.

Exporters log WARNING/ERROR on connection refused and retries; that is normal in local dev when
no collector is listening. Application code and tests should not look like failures.

Opt out of silencing (e.g. debug export issues)::

    export AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS=1
"""
from __future__ import annotations

import logging
import os

_OTLP_LOGGER_PREFIXES: tuple[str, ...] = (
    "opentelemetry.exporter.otlp",
    "opentelemetry.exporter.otlp.proto.http",
    "opentelemetry.exporter.otlp.proto.grpc",
)


def apply_otlp_unreachable_export_silencing() -> None:
    """
    Set OTLP exporter loggers to CRITICAL so missing collectors do not flood stderr.

    Honors ``AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS`` (truthy) to skip adjustment.
    """
    raw = (os.environ.get("AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return
    for name in _OTLP_LOGGER_PREFIXES:
        logging.getLogger(name).setLevel(logging.CRITICAL)
