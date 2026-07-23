"""
Structlog-based observability: **callers never pass trace_id or timestamp** — those are injected by
this library's processor chain. Users only supply log level, message, and optional structured
fields; the wrapper enriches each event with **timestamp** and, when OpenTelemetry has an active
span, **trace_id** and **span_id** from the SDK (``get_current_span()``). Do not add ``trace_id``,
``span_id``, or ``timestamp`` to your log calls.

To have trace/span IDs on logs, something in the process must establish OTel context (e.g.
``ASGITraceMiddleware`` / ``register_flask_request_tracing`` for HTTP, or ``with_otel_span(...)``
for scripts). That is wiring for **span lifecycle**, not for "ingesting" trace_id into log lines.

Flow:
  1. User: level + message + optional key=value fields only.
  2. Library processors: merge context → OTel trace fields → level → timestamp → … → JSON/console.

Optional **OpenLLMetry** (Traceloop): set ``enable_openllmetry`` on :class:`ObservabilityLoggingConfig`
to load LLM/agent instrumentations; ``traceloop-sdk`` is a dependency of this package (``pip install
agentstudio-observability-client-runtime``). OTLP trace export is handled by Traceloop when enabled, not duplicated
by this module.
"""
from __future__ import annotations

import atexit
import logging
import os
import sys
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, TextIO

import structlog
from opentelemetry import trace as otel_trace
from structlog import DropEvent
from structlog.typing import EventDict, Processor, WrappedLogger

from observability_client_runtime.enums.log_levels import (
    LEVEL_RANK,
    LOG_EVENT_LOGGER_METHODS,
    LogLevel,
    VALID_MIN_LOG_LEVEL_KEYS,
    normalize_level_name,
)
from observability_client_runtime.otlp_export_tolerance import apply_otlp_unreachable_export_silencing
from observability_client_runtime.otlp_endpoint_utils import normalize_otlp_http_traces_endpoint
from observability_client_runtime.otel_red_and_business_metrics import (
    _RedMetricsSpanProcessor,
    configure_meter_providers,
    flush_meter_providers,
    get_business_meter,
    get_long_lived_meter,
    get_short_lived_meter,
)


_TRACER_NAME = "logging.logger_handler"
_VALID_FORMATS: frozenset[str] = frozenset({"json", "console"})
DEFAULT_LOG_DIR = "App_Logs"
DEFAULT_LOG_FILENAME = "app.jsonl"
# Default span JSONL directory when ``trace_file_path`` is omitted (created under process cwd).
DEFAULT_TRACE_DIR = "Trace_Logs"
DEFAULT_TRACE_FILENAME = "trace.jsonl"
APP_LOG_RECORD_TYPE = "app_log"
TRACE_SPAN_RECORD_TYPE = "trace_span"
_PREFERRED_LOG_KEY_ORDER: tuple[str, ...] = (
    "timestamp",
    "level",
    "record_type",
    "event",
    "trace_id",
    "span_id",
    "parent_span_id",
    "span_name",
    "span_kind",
    "span_status",
    "duration_ms",
)
_DEFAULT_METRICS_EXPORT_INTERVAL_MS = 60000
_VALID_TRACE_JSONL_FILTERS: frozenset[str] = frozenset({"all", "openllmetry"})

# Override any default when set (12-factor). Empty value keeps the static default for that field.
OBSERVABILITY_ENV_PREFIX = "AGENT_STUDIO_OBSERVABILITY_"
_ENV_BOOL_TRUE: frozenset[str] = frozenset({"1", "true", "yes", "on"})
_ENV_BOOL_FALSE: frozenset[str] = frozenset({"0", "false", "no", "off"})


def _parse_env_bool(raw: str, *, field_name: str) -> bool:
    s = raw.strip().lower()
    if s in _ENV_BOOL_TRUE:
        return True
    if s in _ENV_BOOL_FALSE:
        return False
    raise ValueError(
        f"{OBSERVABILITY_ENV_PREFIX}{field_name.upper()}: expected a boolean "
        f"(true/false/1/0/yes/no/on/off), got {raw!r}"
    )


def _observability_static_defaults_dict() -> dict[str, Any]:
    """Field names and built-in defaults (no environment)."""
    return {
        "format": "json",
        "ensure_tracer_provider": True,
        "enable_auto_instrumentation": True,
        "enable_auto_span_logging": False,
        "auto_span_log_level": LogLevel.INFO,
        "enable_red_metrics": True,
        "enable_openllmetry": False,
        "traceloop_disable_batch": False,
        "otlp_traces_endpoint": None,
        "metrics_otlp_endpoint": None,
        "metrics_export_interval_ms": _DEFAULT_METRICS_EXPORT_INTERVAL_MS,
        "metrics_service_name": None,
        "prometheus_metrics_port": None,
        "prometheus_metrics_host": "0.0.0.0",
        "min_log_level": None,
        "log_file_path": DEFAULT_LOG_DIR,
        "log_file_encoding": "utf-8",
        "create_log_parent_dirs": True,
        "write_spans_to_jsonl_file": True,
        "trace_jsonl_filter": "openllmetry",
        "trace_file_path": None,
        "trace_file_encoding": "utf-8",
        "install_stdlib_bridge": False,
        "otlp_logs_endpoint": None,
    }


_OBSERVABILITY_FIELD_NAMES: frozenset[str] = frozenset(_observability_static_defaults_dict().keys())


def _parse_observability_env_value(name: str, raw: str, static: Any) -> Any:
    """Coerce ``raw`` from ``AGENT_STUDIO_OBSERVABILITY_<NAME>`` to the field type; ``raw`` may be empty."""
    stripped = raw.strip()
    if stripped == "":
        return static

    if name in (
        "ensure_tracer_provider",
        "enable_auto_instrumentation",
        "enable_auto_span_logging",
        "enable_red_metrics",
        "enable_openllmetry",
        "traceloop_disable_batch",
        "create_log_parent_dirs",
        "write_spans_to_jsonl_file",
        "install_stdlib_bridge",
    ):
        return _parse_env_bool(raw, field_name=name)

    if name == "metrics_export_interval_ms":
        v = int(stripped)
        if v <= 0:
            raise ValueError(
                f"{OBSERVABILITY_ENV_PREFIX}METRICS_EXPORT_INTERVAL_MS must be > 0, got {v!r}"
            )
        return v

    if name == "prometheus_metrics_port":
        if stripped.lower() in ("none", "null", ""):
            return None
        p = int(stripped)
        if p <= 0:
            raise ValueError(
                f"{OBSERVABILITY_ENV_PREFIX}PROMETHEUS_METRICS_PORT must be > 0 when set, got {p!r}"
            )
        return p

    if name in ("auto_span_log_level", "min_log_level"):
        if stripped.lower() in ("none", "null"):
            return None
        return stripped

    if name in ("otlp_traces_endpoint", "metrics_otlp_endpoint", "metrics_service_name", "otlp_logs_endpoint"):
        if stripped.lower() in ("none", "null"):
            return None
        return stripped

    if name in ("log_file_path", "trace_file_path"):
        if stripped.lower() in ("none", "null"):
            return None
        return stripped

    if name in ("format", "trace_jsonl_filter", "log_file_encoding", "trace_file_encoding", "prometheus_metrics_host"):
        return stripped

    return stripped


def _observability_env_value_for_field(field_name: str) -> Any:
    static = _observability_static_defaults_dict()[field_name]
    env_key = f"{OBSERVABILITY_ENV_PREFIX}{field_name.upper()}"
    if env_key not in os.environ:
        return static
    return _parse_observability_env_value(field_name, os.environ[env_key], static)


def _default_factory(field_name: str):
    def _inner() -> Any:
        return _observability_env_value_for_field(field_name)

    return _inner


def observability_static_defaults() -> dict[str, Any]:
    """
    Built-in defaults for :class:`ObservabilityLoggingConfig` **without** reading the environment.

    At runtime, :class:`ObservabilityLoggingConfig` applies ``AGENT_STUDIO_OBSERVABILITY_*`` variables
    on top of these values (and JSON file values, when used, are merged per loader — see
    :func:`logging_config.configure_logging_from_json_file`).
    """
    return dict(_observability_static_defaults_dict())


def observability_env_overrides() -> dict[str, Any]:
    """
    Parsed overrides from ``AGENT_STUDIO_OBSERVABILITY_*`` for keys that appear in ``os.environ``.

    Used when merging JSON config so environment wins over file values.
    """
    out: dict[str, Any] = {}
    for field_name in _OBSERVABILITY_FIELD_NAMES:
        env_key = f"{OBSERVABILITY_ENV_PREFIX}{field_name.upper()}"
        if env_key not in os.environ:
            continue
        static = _observability_static_defaults_dict()[field_name]
        out[field_name] = _parse_observability_env_value(field_name, os.environ[env_key], static)
    return out
# OpenTelemetry ``instrumentation_scope.name`` substrings for LLM/agent/vector integrations (OpenLLMetry stack).
_OPENLLMETRY_SCOPE_MARKERS: tuple[str, ...] = (
    "traceloop.tracer",
    "instrumentation.openai",
    "instrumentation.langchain",
    "instrumentation.mcp",
    "instrumentation.crewai",
    "instrumentation.llamaindex",
    "instrumentation.chromadb",
    "instrumentation.anthropic",
    "instrumentation.bedrock",
    "instrumentation.agno",
    "instrumentation.haystack",
    "instrumentation.transformers",
    "instrumentation.openai_agents",
    "instrumentation.groq",
    "instrumentation.cohere",
    "instrumentation.mistralai",
    "instrumentation.ollama",
    "instrumentation.pinecone",
    "instrumentation.qdrant",
    "instrumentation.weaviate",
    "instrumentation.milvus",
    "instrumentation.marqo",
    "instrumentation.replicate",
    "instrumentation.sagemaker",
    "instrumentation.together",
    "instrumentation.lancedb",
    "instrumentation.vertexai",
    "instrumentation.voyageai",
    "instrumentation.watsonx",
    "instrumentation.writer",
    "instrumentation.google_generativeai",
    "instrumentation.alephalpha",
)
_auto_instrumentation_done = False
_otel_atexit_registered = False


def _unwrap_tracer_provider() -> Any:
    """Return innermost tracer provider (unwraps ProxyTracerProvider across OTel versions)."""
    p: Any = otel_trace.get_tracer_provider()
    for _ in range(8):
        nxt = getattr(p, "_delegate", None)
        if nxt is None:
            nxt = getattr(p, "_tracer_provider", None)
        if nxt is None or nxt is p:
            break
        p = nxt
    return p


def ensure_sdk_tracer_provider(resource: Any | None = None) -> None:
    """
    Install OpenTelemetry SDK TracerProvider if the process still uses the default no-op provider.
    Call once at app startup (before creating spans) if you are not configuring OTel elsewhere.
    Safe to call if a real SDK TracerProvider is already set.

    Pass ``resource`` (e.g. ``Resource.create({"service.name": "my-service"})``) so trace OTLP export
    uses the same ``service.name`` as metrics when ``metrics_service_name`` is configured.
    """
    from opentelemetry.sdk.trace import TracerProvider

    inner = _unwrap_tracer_provider()
    if isinstance(inner, TracerProvider):
        return
    try:
        from opentelemetry.trace import NoOpTracerProvider
    except ImportError:
        NoOpTracerProvider = None  # type: ignore[misc, assignment]

    def _new_provider() -> TracerProvider:
        return TracerProvider(resource=resource) if resource is not None else TracerProvider()

    if NoOpTracerProvider is not None and isinstance(inner, NoOpTracerProvider):
        otel_trace.set_tracer_provider(_new_provider())
        return
    # ProxyTracerProvider before a real SDK is registered (delegate None or NoOp)
    if type(inner).__name__ == "ProxyTracerProvider":
        delg = getattr(inner, "_delegate", None)
        if delg is None or (
            NoOpTracerProvider is not None and isinstance(delg, NoOpTracerProvider)
        ):
            otel_trace.set_tracer_provider(_new_provider())
        return
    # Unknown provider (e.g. custom): do not replace


@contextmanager
def with_otel_span(
    name: str = "request",
    *,
    kind: otel_trace.SpanKind | None = None,
) -> Iterator[None]:
    """
    Start a root span for the current context so logs include trace_id / span_id.
    Use when you do not have HTTP auto-instrumentation (e.g. scripts, workers, tests).
    For web apps, prefer opentelemetry-instrumentation-* so each request gets a span automatically.

    Pass ``kind=otel_trace.SpanKind.SERVER`` (and a span name like ``\"GET /api/users\"``) when you
    want HTTP RED metrics (rate / errors / duration) in scripts or workers; the default kind is
    INTERNAL, which the RED span processor ignores.
    """
    tracer = otel_trace.get_tracer(_TRACER_NAME)
    span_kw: dict[str, Any] = {}
    if kind is not None:
        span_kw["kind"] = kind
    with tracer.start_as_current_span(name, **span_kw):
        yield


# --- Trace / span IDs from OpenTelemetry SDK span context only (no synthetic IDs) ---
def add_otel_trace_fields(
    _: WrappedLogger, __: str, event_dict: EventDict
) -> EventDict:
    """Enrich event with W3C hex trace_id / span_id from OTel when a span is active (callers do not set these)."""
    span = otel_trace.get_current_span()
    ctx = span.get_span_context()
    if ctx.is_valid:
        event_dict.setdefault("trace_id", format(ctx.trace_id, "032x"))
        event_dict.setdefault("span_id", format(ctx.span_id, "016x"))
    return event_dict


def add_default_record_type(
    _: WrappedLogger, __: str, event_dict: EventDict
) -> EventDict:
    """Tag ingested app logs; span bridge can override with its own record_type."""
    event_dict.setdefault("record_type", APP_LOG_RECORD_TYPE)
    return event_dict


def normalize_log_key_order(
    _: WrappedLogger, __: str, event_dict: EventDict
) -> EventDict:
    """Keep a stable key sequence across app and trace records."""
    ordered: dict[str, Any] = {}
    for key in _PREFERRED_LOG_KEY_ORDER:
        if key in event_dict:
            ordered[key] = event_dict[key]
    for key, value in event_dict.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def make_min_log_level_filter(min_log_level: str) -> Processor:
    """
    Drop events whose level is below ``min_log_level`` (e.g. min_log_level=\"info\" drops ``debug``).
    Runs immediately after ``add_log_level`` so ``event_dict[\"level\"]`` is set.
    """
    key = normalize_level_name(min_log_level)
    floor = LEVEL_RANK.get(key)
    if floor is None:
        raise ValueError(
            f"min_log_level must be one of {sorted(VALID_MIN_LOG_LEVEL_KEYS)}, got {min_log_level!r}"
        )

    def processor(
        _: WrappedLogger, __: str, event_dict: EventDict
    ) -> EventDict:
        lvl = normalize_level_name(event_dict.get("level") or LogLevel.INFO.value)
        rank = LEVEL_RANK.get(lvl, LEVEL_RANK[LogLevel.INFO.value])
        if rank < floor:
            raise DropEvent
        return event_dict

    return processor


# --- Shared processors: what we add to every ingested log ---
# Order: merge structlog contextvars → OTel trace/span → add level → [min level filter] → timestamp → …
def get_shared_processors(*, min_log_level: str | None = None) -> list[Processor]:
    procs: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        add_otel_trace_fields,
        add_default_record_type,
        structlog.processors.add_log_level,
    ]
    if min_log_level is not None:
        procs.append(make_min_log_level_filter(min_log_level))
    procs.extend(
        [
            structlog.processors.TimeStamper(fmt="iso"),  # add timestamp
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
        ]
    )
    return procs


def get_renderer(format: str = "json") -> Processor:
    if format == "json":
        return structlog.processors.JSONRenderer()
    return structlog.dev.ConsoleRenderer(colors=True)


@dataclass
class ObservabilityLoggingConfig:
    """
    Validated configuration object for ``configure_observability_logging`` — the **only** way to
    configure the runtime (no flat keyword arguments).

    Instances are **mutable**: you may assign ``obj.format = ...`` or similar after
    construction, then call ``configure_observability_logging(config=obj)`` again to apply.

    Customers discover supported fields directly from this constructor in IDE autocomplete.

    Common fields:
      - ``min_log_level``: ``LogLevel`` enum (for example ``LogLevel.INFO``)
      - ``log_file_path``: file or folder path; when omitted defaults to
        ``App_Logs/app.jsonl``. Relative paths are resolved from the process **current working directory**
        (in code) or from the JSON config file directory (see :func:`logging_config.configure_logging_from_json_file`).
      - ``otlp_traces_endpoint``: OTLP HTTP base or full traces URL for export to the collector
        (e.g. ``http://otel-collector:4318`` or ``.../v1/traces``; env ``OTEL_EXPORTER_OTLP_*`` if
        unset). Does not write traces to the app log file.
      - ``trace_file_path``: optional path for span JSONL (one SDK span object per line) **in
        addition to** OTLP push. **Same rules as** ``log_file_path``: a **directory** (e.g.
        ``../../Trace_Logs``) becomes ``<that_dir>/trace.jsonl``; a path ending in ``.jsonl`` is
        used as the file. Relative paths: from **cwd** in code, or from the **JSON config file
        directory** when loading via :func:`logging_config.configure_logging_from_json_file`. When
        omitted and ``write_spans_to_jsonl_file`` is True, defaults to ``Trace_Logs/trace.jsonl``
        under cwd. Set ``write_spans_to_jsonl_file`` to False to disable local span JSONL entirely.
      - ``write_spans_to_jsonl_file``: when True (default), write completed spans to a JSONL file
        using ``trace_file_path`` or the auto path above; set False to use OTLP/OpenLLMetry only.
      - ``trace_jsonl_filter``: ``\"openllmetry\"`` (default) writes only OpenLLMetry/Traceloop and
        LLM/agent OTel spans to the trace file (excludes ``with_otel_span`` / HTTP bridge spans).
        Use ``\"all\"`` to record every span, including this library's script/HTTP spans.
      - ``trace_file_encoding``: text encoding for the trace file (default UTF-8).
      - ``metrics_otlp_endpoint``: OTLP HTTP base or full metrics URL for **short-lived** push
        metrics (same pattern as traces; env if unset).
      - ``metrics_service_name``: sets ``service.name`` on **both** metrics and trace resources (and
        ``OTEL_SERVICE_NAME`` if unset) so Grafana/Tempo align with Prometheus scrape labels.
      - ``enable_auto_span_logging``: **ignored** (deprecated). Spans are **never** written as
        extra lines to the log file; they are exported via OTLP only. The file receives **app**
        logs only (with ``trace_id`` / ``span_id`` on each line when a span is active).
      - ``prometheus_metrics_port`` / ``prometheus_metrics_host``: optional ``/metrics`` scrape
        endpoint; loopback hosts are normalized to ``0.0.0.0`` for remote scrapes.
      - ``enable_openllmetry``: if True, initialize Traceloop (OpenLLMetry) for LLM/agent spans;
        ``traceloop-sdk`` ships with this package. OTLP export is owned by Traceloop (do not combine with a second
        trace exporter for the same provider). When ``enable_auto_instrumentation`` is True,
        Traceloop OpenAI instrumentation is used and the standalone OpenAI instrumentor is skipped.
      - ``traceloop_disable_batch``: passed to ``Traceloop.init(disable_batch=...)`` for faster
        local export.

    Example:
        ObservabilityLoggingConfig(
            min_log_level=LogLevel.INFO,
            log_file_path="../../App_Logs/tool-service.log",
            trace_file_path="../../Trace_Logs/trace.jsonl",
        )

    Unless a field is passed explicitly, defaults come from :func:`observability_static_defaults`
    merged with ``AGENT_STUDIO_OBSERVABILITY_<FIELD_NAME>`` (uppercase snake) when that variable is set in
    the process environment.
    """

    format: str = field(default_factory=_default_factory("format"))
    ensure_tracer_provider: bool = field(default_factory=_default_factory("ensure_tracer_provider"))
    enable_auto_instrumentation: bool = field(default_factory=_default_factory("enable_auto_instrumentation"))
    enable_auto_span_logging: bool = field(default_factory=_default_factory("enable_auto_span_logging"))
    auto_span_log_level: LogLevel = field(default_factory=_default_factory("auto_span_log_level"))
    enable_red_metrics: bool = field(default_factory=_default_factory("enable_red_metrics"))
    enable_openllmetry: bool = field(default_factory=_default_factory("enable_openllmetry"))
    traceloop_disable_batch: bool = field(default_factory=_default_factory("traceloop_disable_batch"))
    otlp_traces_endpoint: str | None = field(default_factory=_default_factory("otlp_traces_endpoint"))
    metrics_otlp_endpoint: str | None = field(default_factory=_default_factory("metrics_otlp_endpoint"))
    metrics_export_interval_ms: int = field(default_factory=_default_factory("metrics_export_interval_ms"))
    metrics_service_name: str | None = field(default_factory=_default_factory("metrics_service_name"))
    prometheus_metrics_port: int | None = field(default_factory=_default_factory("prometheus_metrics_port"))
    prometheus_metrics_host: str = field(default_factory=_default_factory("prometheus_metrics_host"))
    min_log_level: LogLevel | None = field(default_factory=_default_factory("min_log_level"))
    log_file_path: str | Path | None = field(default_factory=_default_factory("log_file_path"))
    log_file_encoding: str = field(default_factory=_default_factory("log_file_encoding"))
    create_log_parent_dirs: bool = field(default_factory=_default_factory("create_log_parent_dirs"))
    write_spans_to_jsonl_file: bool = field(default_factory=_default_factory("write_spans_to_jsonl_file"))
    trace_jsonl_filter: str = field(default_factory=_default_factory("trace_jsonl_filter"))
    trace_file_path: str | Path | None = field(default_factory=_default_factory("trace_file_path"))
    trace_file_encoding: str = field(default_factory=_default_factory("trace_file_encoding"))
    # When True, install a handler that forwards stdlib logging calls through structlog.
    # Opt-in (default False) so existing uvicorn / pytest handlers are not silently removed.
    install_stdlib_bridge: bool = field(default_factory=_default_factory("install_stdlib_bridge"))
    # OTLP HTTP base URL for log export (e.g. http://otel-collector:4318).
    # When set, structured log records are pushed to the collector via BatchLogRecordProcessor.
    # Env: AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT
    otlp_logs_endpoint: str | None = field(default_factory=_default_factory("otlp_logs_endpoint"))

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        """Re-run the same checks as construction; call after mutating fields."""
        if self.format not in _VALID_FORMATS:
            raise ValueError(f"format must be one of {sorted(_VALID_FORMATS)}, got {self.format!r}")
        if self.min_log_level is not None:
            if isinstance(self.min_log_level, str):
                self.min_log_level = LogLevel(normalize_level_name(self.min_log_level))
            elif not isinstance(self.min_log_level, LogLevel):
                raise ValueError("min_log_level must be a LogLevel enum value or string level name")
        if isinstance(self.auto_span_log_level, str):
            self.auto_span_log_level = LogLevel(normalize_level_name(self.auto_span_log_level))
        elif not isinstance(self.auto_span_log_level, LogLevel):
            raise ValueError("auto_span_log_level must be a LogLevel enum value or string level name")
        if self.metrics_export_interval_ms <= 0:
            raise ValueError("metrics_export_interval_ms must be > 0")
        if self.prometheus_metrics_port is not None and self.prometheus_metrics_port <= 0:
            raise ValueError("prometheus_metrics_port must be > 0 when set")
        if self.trace_jsonl_filter not in _VALID_TRACE_JSONL_FILTERS:
            raise ValueError(
                f"trace_jsonl_filter must be one of {sorted(_VALID_TRACE_JSONL_FILTERS)}, "
                f"got {self.trace_jsonl_filter!r}"
            )


def _resolve_log_output_path(log_file_path: str | Path | None) -> Path:
    """
    Resolve target output file path.

    - None -> App_Logs/app.jsonl
    - directory path -> <dir>/app.jsonl
    - explicit file path -> as provided
    """
    if log_file_path is None:
        return Path(DEFAULT_LOG_DIR) / DEFAULT_LOG_FILENAME
    path = Path(log_file_path)
    if path.exists():
        if path.is_dir():
            return path / DEFAULT_LOG_FILENAME
        # Treat any existing non-directory path (regular file, symlink, char device like
        # /dev/stdout, /dev/stderr) as a valid write target — return it as-is.
        return path
    if path.suffix:
        return path
    return path / DEFAULT_LOG_FILENAME


def _resolve_trace_output_path(trace_file_path: str | Path | None) -> Path | None:
    """
    Resolve optional trace JSONL path.

    - None or blank -> disabled (None)
    - existing file -> append to that file
    - existing directory -> <dir>/trace.jsonl (even if the dir name has a ``.suffix``)
    - non-existent path with a file suffix -> treat as file path
    - non-existent path without suffix -> <path>/trace.jsonl
    """
    if trace_file_path is None:
        return None
    raw = str(trace_file_path).strip()
    if not raw:
        return None
    path = Path(raw)
    if path.exists():
        if path.is_file():
            return path
        if path.is_dir():
            return path / DEFAULT_TRACE_FILENAME
    if path.suffix:
        return path
    return path / DEFAULT_TRACE_FILENAME


def _trace_push_active(config: ObservabilityLoggingConfig) -> bool:
    """True when OTLP trace export or OpenLLMetry is configured to push spans."""
    return bool(_resolve_trace_endpoint(config.otlp_traces_endpoint)) or config.enable_openllmetry


def _effective_trace_jsonl_path(config: ObservabilityLoggingConfig) -> Path | None:
    """
    Target JSONL path: explicit ``trace_file_path``, else ``Trace_Logs/trace.jsonl`` under cwd when
    ``trace_file_path`` is omitted, else (legacy) beside app logs when OTLP/OpenLLMetry pushes only.
    """
    if not config.write_spans_to_jsonl_file:
        return None
    if config.trace_file_path is None:
        return Path(DEFAULT_TRACE_DIR) / DEFAULT_TRACE_FILENAME
    explicit = _resolve_trace_output_path(config.trace_file_path)
    if explicit is not None:
        return explicit
    if _trace_push_active(config):
        return _resolve_log_output_path(config.log_file_path).parent / DEFAULT_TRACE_FILENAME
    return None


def _instrumentation_scope_name(span: Any) -> str:
    scope = getattr(span, "instrumentation_scope", None)
    if scope is None:
        scope = getattr(span, "instrumentation_info", None)
    if scope is None:
        return ""
    return str(getattr(scope, "name", "") or "")


def _span_matches_openllmetry_jsonl_filter(span: Any) -> bool:
    """
    Spans from Traceloop and LLM/agent OpenTelemetry instrumentations (OpenLLMetry stack).

    Excludes this library's HTTP/script spans (``logging.logger_handler``) and generic
    HTTP/client instrumentations (e.g. ``requests``) unless ``gen_ai.*`` / ``traceloop.*`` attributes
    are present on the span.
    """
    try:
        for key in dict(getattr(span, "attributes", None) or {}):
            ks = str(key)
            if ks.startswith("traceloop.") or ks.startswith("gen_ai."):
                return True
    except Exception:
        pass
    scope_name = _instrumentation_scope_name(span)
    if not scope_name or scope_name == _TRACER_NAME:
        return False
    if scope_name == "traceloop.tracer":
        return True
    return any(marker in scope_name for marker in _OPENLLMETRY_SCOPE_MARKERS)


class _FileJsonlSpanProcessor:
    """Append each ended span as one JSON line (``ReadableSpan.to_json(indent=None)``)."""

    def __init__(self, path: Path, *, encoding: str, trace_jsonl_filter: str) -> None:
        self._path = path
        self._encoding = encoding
        self._trace_jsonl_filter = trace_jsonl_filter
        self._lock = threading.Lock()
        self._file: TextIO | None = open(path, "a", encoding=encoding)

    def on_start(self, span: Any, parent_context: Any | None = None) -> None:
        del span, parent_context

    def _on_ending(self, span: Any) -> None:
        del span

    def on_end(self, span: Any) -> None:
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return
        if self._trace_jsonl_filter == "openllmetry" and not _span_matches_openllmetry_jsonl_filter(
            span
        ):
            return
        try:
            line = span.to_json(indent=None) + "\n"
        except Exception:
            return
        with self._lock:
            if self._file is not None:
                self._file.write(line)
                self._file.flush()

    def shutdown(self) -> None:
        with self._lock:
            if self._file is not None:
                try:
                    self._file.flush()
                    self._file.close()
                except OSError:
                    pass
                self._file = None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        del timeout_millis
        with self._lock:
            if self._file is not None:
                try:
                    self._file.flush()
                except OSError:
                    pass
        return True


class _AgentStudioSpanProcessorHub:
    """Owned composite span processor — all processors this library adds go through here.

    Registered once with the SDK provider via the public ``add_span_processor`` API.
    Add/remove operations work on our internal list, so we never touch OTel SDK private
    fields (_active_span_processor, _lock, _span_processors) that may change across
    1.x minor releases.
    """

    _ATTACHED_ATTR = "_agentstudio_hub_attached"
    _instance: "_AgentStudioSpanProcessorHub | None" = None

    def __init__(self) -> None:
        self._processors: list[Any] = []
        self._lock = threading.Lock()

    @classmethod
    def get_or_attach(cls, provider: Any) -> "_AgentStudioSpanProcessorHub":
        if cls._instance is None:
            cls._instance = cls()
        if not getattr(provider, cls._ATTACHED_ATTR, False):
            try:
                provider.add_span_processor(cls._instance)
                setattr(provider, cls._ATTACHED_ATTR, True)
            except AttributeError:
                pass
        return cls._instance

    def add(self, proc: Any) -> None:
        with self._lock:
            self._processors.append(proc)

    def remove_type(self, proc_type: type) -> list[Any]:
        with self._lock:
            removed = [p for p in self._processors if isinstance(p, proc_type)]
            self._processors = [p for p in self._processors if not isinstance(p, proc_type)]
        return removed

    def on_start(self, span: Any, parent_context: Any = None) -> None:
        with self._lock:
            procs = list(self._processors)
        for p in procs:
            try:
                p.on_start(span, parent_context)
            except Exception:
                pass

    def _on_ending(self, span: Any) -> None:
        # Called by newer OTel SDK versions just before a span ends (before on_end).
        # Delegate to child processors so the SDK can find this hook on the hub.
        with self._lock:
            procs = list(self._processors)
        for p in procs:
            try:
                if hasattr(p, "_on_ending"):
                    p._on_ending(span)
            except Exception:
                pass

    def on_end(self, span: Any) -> None:
        with self._lock:
            procs = list(self._processors)
        for p in procs:
            try:
                p.on_end(span)
            except Exception:
                pass

    def shutdown(self) -> None:
        with self._lock:
            procs = list(self._processors)
        for p in procs:
            try:
                p.shutdown()
            except Exception:
                pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        with self._lock:
            procs = list(self._processors)
        ok = True
        for p in procs:
            try:
                ok = ok and bool(p.force_flush(timeout_millis))
            except Exception:
                pass
        return ok


_file_jsonl_span_processor: _FileJsonlSpanProcessor | None = None


def _detach_file_jsonl_span_processor_if_present() -> None:
    """Remove trace-file span processor and close the file (call before re-configuring)."""
    global _file_jsonl_span_processor
    hub = _AgentStudioSpanProcessorHub._instance
    if hub is not None:
        for sp in hub.remove_type(_FileJsonlSpanProcessor):
            try:
                sp.shutdown()
            except Exception:
                pass
    elif _file_jsonl_span_processor is not None:
        try:
            _file_jsonl_span_processor.shutdown()
        except Exception:
            pass
    _file_jsonl_span_processor = None


def _configure_trace_file_export(config: ObservabilityLoggingConfig) -> None:
    """Attach a span processor that writes completed spans to a JSONL file (alongside OTLP push)."""
    global _file_jsonl_span_processor
    path = _effective_trace_jsonl_path(config)
    if path is None:
        return
    try:
        from opentelemetry.sdk.trace import TracerProvider
    except ImportError:
        return
    provider = _unwrap_tracer_provider()
    if not isinstance(provider, TracerProvider):
        return
    if config.create_log_parent_dirs:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            import warnings
            warnings.warn(
                f"[observability] Could not create trace log directory {path.parent}: {exc}. "
                "Trace JSONL file export disabled. Set a writable trace_file_path or mount a "
                "writable volume (e.g. /tmp) when using readOnlyRootFilesystem=true.",
                RuntimeWarning,
                stacklevel=4,
            )
            return
    proc = _FileJsonlSpanProcessor(
        path,
        encoding=config.trace_file_encoding,
        trace_jsonl_filter=config.trace_jsonl_filter,
    )
    hub = _AgentStudioSpanProcessorHub.get_or_attach(provider)
    hub.add(proc)
    _file_jsonl_span_processor = proc


def _resolve_metrics_endpoint(metrics_otlp_endpoint: str | None) -> str | None:
    if metrics_otlp_endpoint:
        return metrics_otlp_endpoint
    return os.environ.get("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT"
    )


def _resolve_trace_endpoint(otlp_traces_endpoint: str | None) -> str | None:
    if otlp_traces_endpoint:
        return otlp_traces_endpoint
    return os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT"
    )


_OTLP_TRACE_EXPORTER_ATTACHED = "_agent_studio_otlp_trace_exporter_attached"


def _register_otel_process_shutdown() -> None:
    """
    Flush and shut down trace/metric exporters on process exit so short-lived scripts still
    deliver spans to the collector before exit (BatchSpanProcessor queues exports otherwise).
    Safe to call multiple times (registers once).
    """
    global _otel_atexit_registered
    if _otel_atexit_registered:
        return
    # Tests call ``force_flush`` / ``shutdown`` explicitly; atexit would double-close exporters.
    if "pytest" in sys.modules:
        return

    def _flush_otel() -> None:
        try:
            provider = _unwrap_tracer_provider()
            if hasattr(provider, "shutdown"):
                provider.shutdown()
        except Exception:
            pass
        try:
            flush_meter_providers()
        except Exception:
            pass

    atexit.register(_flush_otel)
    _otel_atexit_registered = True


def _configure_otlp_log_export(otlp_logs_endpoint: str | None) -> None:
    """Attach OTLP HTTP log export so structured log records are pushed to the collector.

    Uses BatchLogRecordProcessor — all network I/O happens on a background thread with no
    added latency to the caller. Records are batched and flushed every ``schedule_delay_millis``
    ms or when ``max_export_batch_size`` records accumulate, whichever comes first.
    """
    endpoint = otlp_logs_endpoint or os.environ.get("AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT")
    if not endpoint:
        return
    try:
        from opentelemetry.logs import set_logger_provider
        from opentelemetry.exporter.otlp.proto.http.log_exporter import OTLPLogExporter
        from opentelemetry.sdk.logs import LoggerProvider
        from opentelemetry.sdk.logs.export import BatchLogRecordProcessor
    except ImportError:
        return

    base = endpoint.rstrip("/")
    logs_url = base if base.endswith("/v1/logs") else base + "/v1/logs"
    exporter = OTLPLogExporter(endpoint=logs_url)
    log_provider = LoggerProvider()
    log_provider.add_log_record_processor(
        BatchLogRecordProcessor(
            exporter,
            schedule_delay_millis=1000,
            max_export_batch_size=256,
        )
    )
    set_logger_provider(log_provider)
    # Bridge: forward stdlib logging calls to OTel LoggerProvider so they reach the collector.
    try:
        from opentelemetry.instrumentation.logging import LoggingInstrumentor
        LoggingInstrumentor().instrument(set_logging_format=False)
    except ImportError:
        pass


def _configure_otlp_trace_export(otlp_traces_endpoint: str | None) -> None:
    """
    Attach OTLP HTTP span export to the SDK TracerProvider so traces go to the collector.

    Application logs stay on the structlog file sink; this only affects trace/span export.
    """
    endpoint = _resolve_trace_endpoint(otlp_traces_endpoint)
    if not endpoint:
        return
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        return

    provider = _unwrap_tracer_provider()
    if getattr(provider, _OTLP_TRACE_EXPORTER_ATTACHED, False):
        return
    try:
        from opentelemetry.sdk.trace import TracerProvider
    except ImportError:
        return
    if not isinstance(provider, TracerProvider):
        return
    exporter = OTLPSpanExporter(endpoint=normalize_otlp_http_traces_endpoint(endpoint))
    # Short schedule_delay so spans reach the collector quickly (default 5s is easy to miss on exit).
    provider.add_span_processor(
        BatchSpanProcessor(
            exporter,
            schedule_delay_millis=500,
            max_export_batch_size=128,
        )
    )
    setattr(provider, _OTLP_TRACE_EXPORTER_ATTACHED, True)
    _register_otel_process_shutdown()


def _configure_openllmetry(config: ObservabilityLoggingConfig) -> None:
    """
    Initialize Traceloop (OpenLLMetry). ``traceloop-sdk`` is a declared dependency of
    ``agentstudio-observability-client-runtime`` (``pip install agentstudio-observability-client-runtime``).

    Reuses an SDK :class:`~opentelemetry.sdk.trace.TracerProvider` if already installed. Span export
    uses Traceloop's OTLP HTTP exporter (``api_endpoint`` from ``otlp_traces_endpoint`` /
    ``OTEL_EXPORTER_OTLP_*``); :func:`_configure_otlp_trace_export` is skipped to avoid duplicate
    exports.

    If this runtime also configures Prometheus or OTLP metrics, sets
    ``TRACELOOP_METRICS_ENABLED=false`` so Traceloop does not replace the global ``MeterProvider``.
    """
    try:
        from traceloop.sdk import Traceloop
        from traceloop.sdk.instruments import Instruments
    except ImportError as e:
        raise ImportError(
            "enable_openllmetry requires traceloop-sdk. Reinstall the runtime: "
            "pip install agentstudio-observability-client-runtime"
        ) from e

    endpoint = _resolve_trace_endpoint(config.otlp_traces_endpoint)
    app_name = (
        config.metrics_service_name
        or os.environ.get("OTEL_SERVICE_NAME")
        or "agent-studio-log-runtime"
    )

    if config.prometheus_metrics_port is not None or _resolve_metrics_endpoint(
        config.metrics_otlp_endpoint
    ):
        os.environ.setdefault("TRACELOOP_METRICS_ENABLED", "false")

    init_kwargs: dict[str, Any] = {
        "app_name": app_name,
        "disable_batch": config.traceloop_disable_batch,
    }
    if endpoint:
        init_kwargs["api_endpoint"] = endpoint.rstrip("/")
    if config.enable_auto_instrumentation:
        init_kwargs["block_instruments"] = {
            Instruments.REQUESTS,
            Instruments.URLLIB3,
            Instruments.REDIS,
        }

    Traceloop.init(**init_kwargs)


def _auto_instrument_known_libraries(*, skip_openai: bool = False) -> None:
    """Best-effort auto-instrumentation for common integrations."""
    global _auto_instrumentation_done
    if _auto_instrumentation_done:
        return

    instrumentors: tuple[tuple[str, str], ...] = (
        ("opentelemetry.instrumentation.requests", "RequestsInstrumentor"),
        ("opentelemetry.instrumentation.httpx", "HTTPXClientInstrumentor"),
        ("opentelemetry.instrumentation.urllib", "URLLibInstrumentor"),
        ("opentelemetry.instrumentation.urllib3", "URLLib3Instrumentor"),
        ("opentelemetry.instrumentation.sqlalchemy", "SQLAlchemyInstrumentor"),
        ("opentelemetry.instrumentation.psycopg2", "Psycopg2Instrumentor"),
        ("opentelemetry.instrumentation.pymongo", "PymongoInstrumentor"),
        ("opentelemetry.instrumentation.redis", "RedisInstrumentor"),
        ("opentelemetry.instrumentation.openai", "OpenAIInstrumentor"),
    )
    if skip_openai:
        instrumentors = tuple(x for x in instrumentors if x[1] != "OpenAIInstrumentor")
    for module_name, class_name in instrumentors:
        try:
            module = __import__(module_name, fromlist=[class_name])
            instrumentor_cls = getattr(module, class_name)
            instrumentor_cls().instrument()
        except Exception:
            # Integration missing or already instrumented; keep startup non-fatal.
            continue
    _auto_instrumentation_done = True


class _SpanToLogProcessor:
    """Write completed spans as structured log events into the same sink."""

    _ATTACHED_ATTR = "_agent_studio_span_to_log_processor_attached"

    def __init__(self, *, level: LogLevel) -> None:
        self._level = level

    def on_start(self, span: Any, parent_context: Any | None = None) -> None:
        del span, parent_context

    def _on_ending(self, span: Any) -> None:
        # Required by newer OTel SDK versions; keep lightweight/no-op.
        del span

    def on_end(self, span: Any) -> None:
        ctx = span.get_span_context()
        if not ctx.is_valid:
            return
        duration_ms: float | None = None
        if getattr(span, "start_time", None) is not None and getattr(span, "end_time", None) is not None:
            duration_ms = (span.end_time - span.start_time) / 1_000_000
        attrs: dict[str, Any] = {}
        for key, value in dict(getattr(span, "attributes", {}) or {}).items():
            attrs[str(key)] = value
        status = getattr(getattr(span, "status", None), "status_code", None)
        log_event(
            self._level,
            "otel_span_completed",
            record_type=TRACE_SPAN_RECORD_TYPE,
            trace_id=format(ctx.trace_id, "032x"),
            span_id=format(ctx.span_id, "016x"),
            span_name=getattr(span, "name", "unknown"),
            parent_span_id=(
                format(span.parent.span_id, "016x")
                if getattr(span, "parent", None) is not None and getattr(span.parent, "span_id", 0)
                else None
            ),
            duration_ms=duration_ms,
            span_kind=str(getattr(span, "kind", "INTERNAL")),
            span_status=str(status) if status is not None else None,
            span_attributes=attrs,
        )

    def shutdown(self) -> None:
        return

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        del timeout_millis
        return True

    @classmethod
    def attach_once(cls, *, level: LogLevel) -> None:
        provider = _unwrap_tracer_provider()
        if getattr(provider, cls._ATTACHED_ATTR, False):
            return
        try:
            provider.add_span_processor(_SpanToLogProcessor(level=level))
            setattr(provider, cls._ATTACHED_ATTR, True)
        except AttributeError:
            # No mutable SDK provider available; skip silently.
            return


def _detach_red_metrics_processor_if_present() -> None:
    """Remove RED metrics span processor when ``enable_red_metrics`` is turned off."""
    provider = _unwrap_tracer_provider()
    _RedMetricsSpanProcessor.detach_if_present(provider)


def _attach_red_metrics_processor_if_enabled(*, enable_red_metrics: bool) -> None:
    provider = _unwrap_tracer_provider()
    if enable_red_metrics:
        _RedMetricsSpanProcessor.attach_once(provider)
    else:
        _detach_red_metrics_processor_if_present()


def _detach_span_to_log_processor_if_present() -> None:
    """Remove legacy span-to-log processor if present (spans are OTLP-only; not written to the log file)."""
    hub = _AgentStudioSpanProcessorHub._instance
    if hub is not None:
        hub.remove_type(_SpanToLogProcessor)
    provider = _unwrap_tracer_provider()
    setattr(provider, _SpanToLogProcessor._ATTACHED_ATTR, False)


# --- Configure once, then get_logger() ---
_configured = False
_log_file_handle: TextIO | None = None
_stdlib_bridge_installed = False


class _StdlibToStructlogBridge(logging.Handler):
    """Forward stdlib logging records through the structlog pipeline.

    This bridges every ``logging.getLogger(...).info(...)`` call through
    structlog so logs appear in the JSONL file with trace_id / span_id
    injection, instead of going to a plain-text stderr handler.
    """

    _LEVEL_MAP: dict[str, str] = {
        "DEBUG": "debug",
        "INFO": "info",
        "WARNING": "warning",
        "WARN": "warning",
        "ERROR": "error",
        "CRITICAL": "critical",
        "FATAL": "critical",
    }

    def emit(self, record: logging.LogRecord) -> None:
        try:
            bound = structlog.get_logger(record.name)
            level = self._LEVEL_MAP.get(record.levelname, "info")
            msg = record.getMessage()
            exc_info = record.exc_info if record.exc_info and record.exc_info[0] is not None else None
            method = getattr(bound, level, bound.info)
            method(msg, exc_info=exc_info)
        except Exception:
            self.handleError(record)


def _install_stdlib_logging_bridge(min_log_level: str | None) -> None:
    """Install the structlog bridge on the root logger, preserving unknown handlers.

    After this call every ``logging.getLogger(__name__).info(...)`` call
    in any module is routed through structlog → same JSONL file, same
    trace_id / span_id enrichment as ``log_event()`` calls.

    Only previously installed ``_StdlibToStructlogBridge`` instances are removed;
    uvicorn's access logger, pytest's caplog, and any other handlers the application
    installed before this call are left in place.

    Safe to call multiple times; reinstalls the bridge on reconfigure.
    """
    global _stdlib_bridge_installed
    import logging as _stdlib_logging

    root = _stdlib_logging.getLogger()
    # Remove only our own bridge instances from previous configure calls;
    # do NOT wipe handlers added by uvicorn, pytest caplog, or the application.
    for h in [h for h in list(root.handlers) if isinstance(h, _StdlibToStructlogBridge)]:
        try:
            h.close()
        except Exception:
            pass
        root.removeHandler(h)

    bridge = _StdlibToStructlogBridge()
    bridge.setLevel(_stdlib_logging.DEBUG)
    root.addHandler(bridge)

    level_str = (min_log_level or "INFO").upper()
    numeric = getattr(_stdlib_logging, level_str, _stdlib_logging.INFO)
    root.setLevel(numeric)
    _stdlib_bridge_installed = True


def _close_log_file_if_any() -> None:
    global _log_file_handle
    if _log_file_handle is not None:
        try:
            _log_file_handle.flush()
            _log_file_handle.close()
        except OSError:
            pass
        _log_file_handle = None


def configure_observability_logging(*, config: ObservabilityLoggingConfig) -> None:
    """
    Configure structlog once at startup. Call before ``get_logger()``.

    Pass a single :class:`ObservabilityLoggingConfig` (construct in code or from JSON via
    ``logging_config.configure_logging_from_json_file`` / ``ObservabilityLoggingConfig(**kwargs)``).

    Enrichment (callers do not pass these): processors add **timestamp** and **trace_id** /
    **span_id** when OTel has an active span. If ``ensure_tracer_provider`` is True (default), an
    SDK ``TracerProvider`` is installed when none is set. Use HTTP middleware, other OTel
    instrumentation, or ``with_otel_span(...)`` for span context.

    Call :meth:`ObservabilityLoggingConfig.validate` after mutating an instance, then call this
    function again to apply changes.
    """
    global _configured, _log_file_handle

    config.validate()
    apply_otlp_unreachable_export_silencing()
    _detach_file_jsonl_span_processor_if_present()
    _close_log_file_if_any()

    trace_resource: Any | None = None
    if config.metrics_service_name:
        try:
            from opentelemetry.sdk.resources import Resource

            trace_resource = Resource.create({"service.name": config.metrics_service_name})
        except ImportError:
            trace_resource = None
        os.environ.setdefault("OTEL_SERVICE_NAME", config.metrics_service_name)

    if (
        config.ensure_tracer_provider
        or _resolve_trace_endpoint(config.otlp_traces_endpoint)
        or config.enable_openllmetry
        or _effective_trace_jsonl_path(config) is not None
    ):
        ensure_sdk_tracer_provider(resource=trace_resource)
    if config.enable_openllmetry:
        _configure_openllmetry(config)
    else:
        _configure_otlp_trace_export(config.otlp_traces_endpoint)
    _configure_trace_file_export(config)
    _configure_otlp_log_export(config.otlp_logs_endpoint)
    # Spans go to the collector via OTLP; optional ``trace_file_path`` writes spans to a separate file.
    _detach_span_to_log_processor_if_present()
    if config.enable_auto_instrumentation:
        _auto_instrument_known_libraries(skip_openai=config.enable_openllmetry)
    configure_meter_providers(
        metrics_otlp_endpoint=_resolve_metrics_endpoint(config.metrics_otlp_endpoint),
        metrics_export_interval_ms=config.metrics_export_interval_ms,
        metrics_service_name=config.metrics_service_name,
        prometheus_metrics_port=config.prometheus_metrics_port,
        prometheus_metrics_host=config.prometheus_metrics_host,
    )
    _attach_red_metrics_processor_if_enabled(enable_red_metrics=config.enable_red_metrics)

    if (
        _resolve_trace_endpoint(config.otlp_traces_endpoint)
        or _resolve_metrics_endpoint(config.metrics_otlp_endpoint)
        or config.enable_openllmetry
        or _effective_trace_jsonl_path(config) is not None
    ):
        _register_otel_process_shutdown()

    ml: str | None = None
    if config.min_log_level is not None:
        ml = normalize_level_name(
            config.min_log_level.value
            if isinstance(config.min_log_level, LogLevel)
            else config.min_log_level
        )
        if ml not in VALID_MIN_LOG_LEVEL_KEYS:
            raise ValueError(
                f"min_log_level must be one of {sorted(VALID_MIN_LOG_LEVEL_KEYS)}, got {config.min_log_level!r}"
            )

    shared = get_shared_processors(min_log_level=ml)

    shared.append(normalize_log_key_order)
    shared.append(get_renderer(config.format))

    path = _resolve_log_output_path(config.log_file_path)
    if config.create_log_parent_dirs:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            import warnings
            warnings.warn(
                f"[observability] Could not create log directory {path.parent}: {exc}. "
                "Falling back to stderr. Set a writable log_file_path or mount a writable "
                "volume (e.g. /tmp) when using readOnlyRootFilesystem=true.",
                RuntimeWarning,
                stacklevel=4,
            )
            structlog.configure(
                processors=shared,
                context_class=dict,
                logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
                cache_logger_on_first_use=False,
            )
            return
    _log_file_handle = open(path, "a", encoding=config.log_file_encoding)
    logger_factory = structlog.PrintLoggerFactory(file=_log_file_handle)

    structlog.configure(
        processors=shared,
        context_class=dict,
        logger_factory=logger_factory,
        cache_logger_on_first_use=False,
    )
    _configured = True
    if config.install_stdlib_bridge:
        _install_stdlib_logging_bridge(ml)


def configure_observability_minimal(
    *,
    log_file_path: str | Path,
    log_level: str | LogLevel = LogLevel.INFO,
    otlp_traces_endpoint: str | None = None,
    otlp_logs_endpoint: str | None = None,
    trace_file_path: str | Path | None = None,
    enable_auto_instrumentation: bool = True,
    metrics_otlp_endpoint: str | None = None,
    metrics_export_interval_ms: int = _DEFAULT_METRICS_EXPORT_INTERVAL_MS,
    metrics_service_name: str | None = None,
    prometheus_metrics_port: int | None = None,
    prometheus_metrics_host: str | None = None,
) -> None:
    """
    One-call setup: JSON app logs, optional OTLP collector, optional trace JSONL path.

    Omitted ``trace_file_path`` uses the default ``Trace_Logs/trace.jsonl`` (see
    :class:`ObservabilityLoggingConfig`). Omitted metrics fields use the same defaults as the full
    config (safe when no collector is available).

    ``prometheus_metrics_port`` / ``prometheus_metrics_host`` are omitted from the override dict
    unless you pass them explicitly, so ``AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_*`` env vars can
    still enable ``/metrics`` (e.g. port 8000 for Prometheus scrape).

    Example::

        configure_observability_minimal(
            log_file_path='../../App_Logs/tool-service.log',
            trace_file_path='../../Trace_Logs/trace.jsonl',
            log_level='info',
            otlp_traces_endpoint='http://localhost:4318',
            prometheus_metrics_port=8000,
        )
        get_logger().info('started')
    """
    merged: dict[str, Any] = {**observability_static_defaults(), **observability_env_overrides()}
    updates: dict[str, Any] = {
        "format": "json",
        "ensure_tracer_provider": True,
        "min_log_level": log_level,
        "log_file_path": log_file_path,
        "write_spans_to_jsonl_file": True,
        "trace_jsonl_filter": "openllmetry",
        "otlp_traces_endpoint": otlp_traces_endpoint,
        "otlp_logs_endpoint": otlp_logs_endpoint,
        "enable_auto_instrumentation": enable_auto_instrumentation,
        "metrics_otlp_endpoint": metrics_otlp_endpoint,
        "metrics_export_interval_ms": metrics_export_interval_ms,
        "metrics_service_name": metrics_service_name,
    }
    # Only override trace_file_path when explicitly provided; when None, preserve any
    # AGENT_STUDIO_OBSERVABILITY_TRACE_FILE_PATH env var set via observability_env_overrides().
    if trace_file_path is not None:
        updates["trace_file_path"] = trace_file_path
    if prometheus_metrics_port is not None:
        updates["prometheus_metrics_port"] = prometheus_metrics_port
    if prometheus_metrics_host is not None:
        updates["prometheus_metrics_host"] = prometheus_metrics_host
    merged.update(updates)
    configure_observability_logging(config=ObservabilityLoggingConfig(**merged))


def _auto_configure_structlog_only() -> None:
    """Minimal structlog-only setup used by get_logger() before the application calls configure_*.

    Does NOT install an OTel TracerProvider, does NOT register atexit hooks, does NOT
    auto-instrument libraries, and does NOT create files — avoiding the import-order trap where
    module-level ``logger = get_logger()`` calls would install global OTel state with wrong
    (default) settings before the service's real ``configure_observability_*`` runs.

    Writes to stderr so logs are always visible even before a real log file is configured.
    The real ``configure_observability_logging`` / ``configure_observability_minimal`` call
    replaces this configuration when the application starts up.
    """
    global _configured
    shared = get_shared_processors()
    shared.append(normalize_log_key_order)
    shared.append(get_renderer("json"))
    structlog.configure(
        processors=shared,
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
        cache_logger_on_first_use=False,
    )
    _configured = True


def get_logger() -> structlog.BoundLogger:
    """
    Logger for **business fields only** (level, message, optional kwargs). Timestamp and trace/span
    IDs are added automatically by structlog processors; do not pass trace_id, span_id, or timestamp.

    Safe to call at module level before ``configure_observability_*``. A minimal structlog-only
    configuration (stderr output, no OTel providers) is installed on first call; it is replaced
    when the application calls ``configure_observability_minimal`` / ``configure_observability_logging``.
    """
    if not _configured:
        _auto_configure_structlog_only()
    return structlog.get_logger()


# --- Ingest log with explicit level (e.g. when level is provided by caller) ---
def log_event(level: LogLevel | str, message: str, **kwargs: Any) -> None:
    """
    Ingest one event: level + message + optional kwargs. Timestamp and trace/span IDs are injected
    by the library; do not pass trace_id, span_id, or timestamp.

    level: ``LogLevel`` or a valid level string (alias ``warn`` supported).
    message: log message (event description)
    **kwargs: optional fields (e.g. path="/api", duration_ms=100)
    """
    log = get_logger()
    level_raw = level.value if isinstance(level, LogLevel) else level
    level_norm = normalize_level_name(level_raw)
    if level_norm not in LOG_EVENT_LOGGER_METHODS:
        raise ValueError(f"Invalid log level {level!r}; expected one of {sorted(LOG_EVENT_LOGGER_METHODS)}")
    getattr(log, level_norm)(message, **kwargs)


# HTTP: one span per request → all logs in that request get the same trace_id
from observability_client_runtime.http_middleware import (  # noqa: E402
    ASGITraceMiddleware,
    asgi_trace_middleware,
    register_flask_request_tracing,
)

__all__ = (
    "ASGITraceMiddleware",
    "OBSERVABILITY_ENV_PREFIX",
    "LogLevel",
    "ObservabilityLoggingConfig",
    "asgi_trace_middleware",
    "configure_observability_logging",
    "configure_observability_minimal",
    "ensure_sdk_tracer_provider",
    "get_business_meter",
    "get_long_lived_meter",
    "get_short_lived_meter",
    "get_logger",
    "log_event",
    "observability_env_overrides",
    "observability_static_defaults",
    "register_flask_request_tracing",
    "with_otel_span",
)

