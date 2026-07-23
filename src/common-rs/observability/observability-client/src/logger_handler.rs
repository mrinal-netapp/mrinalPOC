//! Central runtime: tracing-subscriber + OTel SDK tracer + meter wiring,
//! plus the public `log_event` / `with_otel_span` / `get_logger` /
//! `shutdown_observability` API.
//!
//! Mirrors the Go client's `logger_handler.go` (and therefore the Python /
//! TypeScript clients' public shape).

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use once_cell::sync::OnceCell;
use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry::trace::{SpanKind, TraceContextExt, Tracer};
use opentelemetry::{global, Context, InstrumentationScope};
use opentelemetry_otlp::{Protocol, SpanExporter, WithExportConfig};
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};
use opentelemetry_sdk::trace::{BatchConfigBuilder, BatchSpanProcessor, SdkTracerProvider};
use opentelemetry_sdk::Resource;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use thiserror::Error;
use tracing::Subscriber;
use tracing_subscriber::layer::{Context as TracingContext, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{registry::Registry, Layer};

use crate::config::{ConfigError, ObservabilityLoggingConfig, APP_LOG_RECORD_TYPE};
use crate::enums::{normalize_level_name, LEVEL_RANK, LOG_EVENT_METHODS};
use crate::observability_env::{apply_env_defaults, observability_static_defaults};
use crate::otlp_endpoint_utils::normalize_otlp_http_traces_endpoint;
use crate::otlp_export_tolerance::apply_otlp_unreachable_export_silencing;
use crate::red_metrics::{
    configure_meter_providers, shutdown_meter_providers, MetricsError, RedMetricsSpanProcessor,
};
use crate::trace_jsonl::{
    effective_trace_jsonl_path, resolve_log_output_path, FileJsonlSpanProcessor,
};

/// Tracer name used for spans opened via [`with_otel_span`].
/// Mirrors the Go `tracerNameHandler` constant.
pub const TRACER_NAME_HANDLER: &str = "logging.logger_handler";
/// Tracer name used by HTTP middleware. Mirrors the Go `tracerNameClientLibrary`.
pub const TRACER_NAME_CLIENT_LIBRARY: &str = "logging.client_library";

const MIN_LEVEL_UNSET: u8 = 0;

/// Errors that can be returned by [`configure_observability_logging`].
#[derive(Debug, Error)]
pub enum ObservabilityError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("I/O: {0}")]
    Io(#[from] io::Error),
    #[error("OTLP trace exporter init failed: {0}")]
    OtlpTraceExporter(String),
    #[error("Metrics setup failed: {0}")]
    Metrics(#[from] MetricsError),
}

// Each piece of mutable state lives behind its own concurrency primitive so a
// log write can never block on a long-running configure path.
static SINK: OnceCell<Arc<Mutex<Option<JsonSink>>>> = OnceCell::new();
static TRACER_PROVIDER: OnceCell<Mutex<Option<SdkTracerProvider>>> = OnceCell::new();
static MIN_LEVEL_RANK: AtomicU8 = AtomicU8::new(MIN_LEVEL_UNSET);
static CONFIGURED: AtomicBool = AtomicBool::new(false);
/// Auto-configure guard so the lazy bootstrap can't recurse.
static AUTO_CONFIGURING: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// Recursion guard: while one thread is inside [`log_event_inner`], we
    /// must not let the `tracing` capture layer re-enter and emit more events
    /// (the OTel SDK calls `tracing::info!` internally, including during
    /// log writes when the OTLP exporter is unreachable).
    static IN_LOG_EVENT_TLS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn sink() -> &'static Arc<Mutex<Option<JsonSink>>> {
    SINK.get_or_init(|| Arc::new(Mutex::new(None)))
}

fn tracer_slot() -> &'static Mutex<Option<SdkTracerProvider>> {
    TRACER_PROVIDER.get_or_init(|| Mutex::new(None))
}

/// Order preferred at the head of each log line. Other keys are appended after.
pub(crate) const PREFERRED_LOG_KEY_ORDER: &[&str] = &[
    "timestamp",
    "level",
    "record_type",
    "event",
    "trace_id",
    "span_id",
    "request_id",
];

// ─── Public bootstrapping API ────────────────────────────────────────────────

/// Wire up tracing/spans/metrics from a fully-resolved config.
/// Idempotent — subsequent calls reconfigure exporters but leave the
/// tracing-subscriber instance in place.
pub fn configure_observability_logging(
    cfg: ObservabilityLoggingConfig,
) -> Result<(), ObservabilityError> {
    cfg.validate()?;
    apply_otlp_unreachable_export_silencing();

    // Tear down prior wiring first so spans/exporters from a previous config
    // don't leak into the new one.
    teardown();

    let log_path = resolve_log_output_path(&cfg.log_file_path);
    if cfg.create_log_parent_dirs {
        if let Some(p) = log_path.parent() {
            if !p.as_os_str().is_empty() {
                std::fs::create_dir_all(p)?;
            }
        }
    }
    if let Some(name) = cfg
        .metrics_service_name
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        if std::env::var("OTEL_SERVICE_NAME")
            .ok()
            .filter(|v| !v.is_empty())
            .is_none()
        {
            std::env::set_var("OTEL_SERVICE_NAME", name);
        }
    }

    // Install / swap the JSON sink.
    let mirror_stdout = cfg.format == "console";
    let new_sink = JsonSink::new(&log_path, mirror_stdout)?;
    {
        let mut s = sink().lock();
        *s = Some(new_sink);
    }
    install_subscriber_once();

    let new_rank = cfg
        .min_log_level
        .as_deref()
        .map(normalize_level_name)
        .and_then(|n| LEVEL_RANK.get(n.as_str()).copied())
        .unwrap_or(MIN_LEVEL_UNSET);
    MIN_LEVEL_RANK.store(new_rank, Ordering::Release);

    let resource = build_resource(&cfg);
    let tracer_provider = build_tracer_provider(&cfg, resource.clone())?;
    global::set_tracer_provider(tracer_provider.clone());
    global::set_text_map_propagator(TextMapCompositePropagator::new(vec![
        Box::new(TraceContextPropagator::new()),
        Box::new(BaggagePropagator::new()),
    ]));
    {
        let mut tp_slot = tracer_slot().lock();
        *tp_slot = Some(tracer_provider);
    }

    configure_meter_providers(&cfg, resource)?;

    CONFIGURED.store(true, Ordering::Release);
    Ok(())
}

/// One-call setup variant aligned with the Go `MinimalConfig` struct.
#[derive(Debug, Default, Clone)]
pub struct MinimalConfig {
    pub log_file_path: Option<String>,
    pub log_level: Option<String>,
    pub otlp_traces_endpoint: Option<String>,
    pub trace_file_path: Option<String>,
    pub enable_auto_instrumentation: bool,
    pub metrics_otlp_endpoint: Option<String>,
    pub metrics_export_interval_ms: Option<u64>,
    pub metrics_service_name: Option<String>,
    pub prometheus_metrics_port: Option<u16>,
    pub prometheus_metrics_host: Option<String>,
}

/// Build a config from the merged defaults + env, then apply minimal overrides.
pub fn configure_observability_minimal(opts: MinimalConfig) -> Result<(), ObservabilityError> {
    let mut merged = observability_static_defaults();
    apply_env_defaults(&mut merged)?;
    if let Some(p) = opts.log_file_path.filter(|s| !s.is_empty()) {
        merged.log_file_path = p;
    }
    if let Some(lv) = opts.log_level {
        merged.min_log_level = Some(normalize_level_name(&lv));
    }
    if opts.otlp_traces_endpoint.is_some() {
        merged.otlp_traces_endpoint = opts.otlp_traces_endpoint;
    }
    if opts.trace_file_path.is_some() {
        merged.trace_file_path = opts.trace_file_path;
    }
    merged.enable_auto_instrumentation = opts.enable_auto_instrumentation;
    if opts.metrics_otlp_endpoint.is_some() {
        merged.metrics_otlp_endpoint = opts.metrics_otlp_endpoint;
    }
    if let Some(ms) = opts.metrics_export_interval_ms.filter(|m| *m > 0) {
        merged.metrics_export_interval_ms = ms;
    }
    if opts.metrics_service_name.is_some() {
        merged.metrics_service_name = opts.metrics_service_name;
    }
    if opts.prometheus_metrics_port.is_some() {
        merged.prometheus_metrics_port = opts.prometheus_metrics_port;
    }
    if let Some(host) = opts.prometheus_metrics_host {
        merged.prometheus_metrics_host = host;
    }
    configure_observability_logging(merged)
}

/// Lazy auto-configures with defaults if not yet configured.
pub fn get_logger() -> Logger {
    if !CONFIGURED.load(Ordering::Acquire)
        && AUTO_CONFIGURING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    {
        let mut cfg = observability_static_defaults();
        let _ = apply_env_defaults(&mut cfg);
        let _ = configure_observability_logging(cfg);
        AUTO_CONFIGURING.store(false, Ordering::Release);
    }
    Logger
}

/// Flush and tear down the OTel exporters, meter providers, and JSONL sink.
/// Idempotent. Returns Ok on success.
pub fn shutdown_observability() -> Result<(), ObservabilityError> {
    teardown();
    Ok(())
}

fn teardown() {
    if let Some(slot) = TRACER_PROVIDER.get() {
        let mut s = slot.lock();
        if let Some(tp) = s.take() {
            let _ = tp.shutdown_with_timeout(Duration::from_secs(5));
        }
    }
    shutdown_meter_providers();
    if let Some(arc) = SINK.get() {
        let mut s = arc.lock();
        if let Some(sink) = s.as_mut() {
            let _ = sink.flush();
        }
        *s = None;
    }
    MIN_LEVEL_RANK.store(MIN_LEVEL_UNSET, Ordering::Release);
    CONFIGURED.store(false, Ordering::Release);
}

// ─── Span helpers ───────────────────────────────────────────────────────────

/// Open an OTel span via the global tracer and run `f` inside it.
pub fn with_otel_span<F, R>(name: &str, kind: SpanKind, f: F) -> R
where
    F: FnOnce(&Context) -> R,
{
    let scope = InstrumentationScope::builder(TRACER_NAME_HANDLER.to_string()).build();
    let tracer = global::tracer_with_scope(scope);
    let span_name = if name.is_empty() {
        "request".to_string()
    } else {
        name.to_string()
    };
    let parent = Context::current();
    let mut builder = tracer.span_builder(span_name);
    builder.span_kind = Some(kind);
    let span = tracer.build_with_context(builder, &parent);
    let cx = parent.with_span(span);
    let _guard = cx.clone().attach();
    let out = f(&cx);
    cx.span().end();
    out
}

/// Async variant of [`with_otel_span`].
pub async fn with_otel_span_async<F, Fut, R>(name: &str, kind: SpanKind, f: F) -> R
where
    F: FnOnce(Context) -> Fut,
    Fut: std::future::Future<Output = R>,
{
    let scope = InstrumentationScope::builder(TRACER_NAME_HANDLER.to_string()).build();
    let tracer = global::tracer_with_scope(scope);
    let span_name = if name.is_empty() {
        "request".to_string()
    } else {
        name.to_string()
    };
    let parent = Context::current();
    let mut builder = tracer.span_builder(span_name);
    builder.span_kind = Some(kind);
    let span = tracer.build_with_context(builder, &parent);
    let cx = parent.with_span(span);
    let _guard = cx.clone().attach();
    let out = f(cx.clone()).await;
    cx.span().end();
    out
}

/// `{ trace_id, span_id }` map from the current OTel context, or empty if no
/// valid span is active.
pub fn otel_fields() -> Map<String, Value> {
    let mut out = Map::new();
    let sc = Context::current().span().span_context().clone();
    if sc.is_valid() {
        out.insert(
            "trace_id".to_string(),
            Value::String(format!("{}", sc.trace_id())),
        );
        out.insert(
            "span_id".to_string(),
            Value::String(format!("{}", sc.span_id())),
        );
    }
    out
}

// ─── Public log API ─────────────────────────────────────────────────────────

/// Handle returned by [`get_logger`]. Cheap to clone; all routing goes
/// through the shared global sink.
#[derive(Debug, Clone, Copy)]
pub struct Logger;

impl Logger {
    pub fn debug(&self, message: &str, fields: Map<String, Value>) {
        let _ = log_event_inner("debug", message, fields);
    }
    pub fn info(&self, message: &str, fields: Map<String, Value>) {
        let _ = log_event_inner("info", message, fields);
    }
    pub fn warn(&self, message: &str, fields: Map<String, Value>) {
        let _ = log_event_inner("warning", message, fields);
    }
    pub fn error(&self, message: &str, fields: Map<String, Value>) {
        let _ = log_event_inner("error", message, fields);
    }
    pub fn critical(&self, message: &str, fields: Map<String, Value>) {
        let _ = log_event_inner("critical", message, fields);
    }
}

/// Emit a single log event at the explicit level. Unknown levels return an error.
pub fn log_event(level: &str, message: &str, fields: Map<String, Value>) -> Result<(), String> {
    log_event_inner(level, message, fields)
}

pub fn log_debug(message: &str, fields: Map<String, Value>) {
    let _ = log_event_inner("debug", message, fields);
}
pub fn log_info(message: &str, fields: Map<String, Value>) {
    let _ = log_event_inner("info", message, fields);
}
pub fn log_warn(message: &str, fields: Map<String, Value>) {
    let _ = log_event_inner("warning", message, fields);
}
pub fn log_error(message: &str, fields: Map<String, Value>) {
    let _ = log_event_inner("error", message, fields);
}
pub fn log_critical(message: &str, fields: Map<String, Value>) {
    let _ = log_event_inner("critical", message, fields);
}

fn log_event_inner(level: &str, message: &str, fields: Map<String, Value>) -> Result<(), String> {
    let norm = normalize_level_name(level);
    if !LOG_EVENT_METHODS.contains_key(norm.as_str()) {
        return Err(format!("invalid log level {level:?}"));
    }
    let floor = MIN_LEVEL_RANK.load(Ordering::Acquire);
    if floor != MIN_LEVEL_UNSET {
        if let Some(r) = LEVEL_RANK.get(norm.as_str()) {
            if *r < floor {
                return Ok(());
            }
        }
    }

    // Build the record once.
    let mut record: BTreeMap<String, Value> = BTreeMap::new();
    record.insert(
        "timestamp".to_string(),
        Value::String(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    record.insert("level".to_string(), Value::String(norm));
    record.insert(
        "record_type".to_string(),
        Value::String(APP_LOG_RECORD_TYPE.to_string()),
    );
    record.insert(
        "event".to_string(),
        Value::String(sanitize_log_string(message)),
    );
    for (k, v) in otel_fields() {
        record.insert(k, v);
    }
    for (k, v) in fields {
        let safe = if let Value::String(s) = &v {
            Value::String(sanitize_log_string(s))
        } else {
            v
        };
        record.insert(k, safe);
    }
    write_record(record);
    Ok(())
}

fn write_record(record: BTreeMap<String, Value>) {
    let ordered = order_keys(record);
    let mut line = serde_json::to_string(&Value::Object(ordered)).unwrap_or_default();
    line.push('\n');
    let mut wrote = false;
    if let Some(arc) = SINK.get() {
        let mut sink = arc.lock();
        if let Some(sink) = sink.as_mut() {
            let _ = sink.write_all(line.as_bytes());
            wrote = true;
        }
    }
    if !wrote {
        let _ = io::stderr().write_all(line.as_bytes());
    }
}

fn order_keys(record: BTreeMap<String, Value>) -> Map<String, Value> {
    let mut out = Map::with_capacity(record.len());
    for k in PREFERRED_LOG_KEY_ORDER {
        if let Some(v) = record.get(*k).cloned() {
            out.insert((*k).to_string(), v);
        }
    }
    for (k, v) in record {
        if !out.contains_key(&k) {
            out.insert(k, v);
        }
    }
    out
}

fn sanitize_log_string(s: &str) -> String {
    s.replace(['\n', '\r'], " ")
}

// ─── Tracer / Resource setup ────────────────────────────────────────────────

fn build_resource(cfg: &ObservabilityLoggingConfig) -> Resource {
    let mut b = Resource::builder();
    if let Some(name) = cfg
        .metrics_service_name
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        b = b.with_service_name(name.to_string());
    }
    b.build()
}

fn build_tracer_provider(
    cfg: &ObservabilityLoggingConfig,
    resource: Resource,
) -> Result<SdkTracerProvider, ObservabilityError> {
    let mut builder = SdkTracerProvider::builder().with_resource(resource);

    if let Some(endpoint) = resolve_trace_endpoint(cfg.otlp_traces_endpoint.as_deref()) {
        let normalized = normalize_otlp_http_traces_endpoint(&endpoint);
        let exporter = SpanExporter::builder()
            .with_http()
            .with_endpoint(normalized)
            .with_protocol(Protocol::HttpBinary)
            .build()
            .map_err(|e| ObservabilityError::OtlpTraceExporter(e.to_string()))?;
        let proc = BatchSpanProcessor::builder(exporter)
            .with_batch_config(
                BatchConfigBuilder::default()
                    .with_scheduled_delay(Duration::from_millis(500))
                    .with_max_export_batch_size(128)
                    .build(),
            )
            .build();
        builder = builder.with_span_processor(proc);
    }

    if cfg.enable_red_metrics {
        builder = builder.with_span_processor(RedMetricsSpanProcessor);
    }

    if let Some(trace_path) = effective_trace_jsonl_path(cfg) {
        if cfg.create_log_parent_dirs {
            if let Some(p) = trace_path.parent() {
                if !p.as_os_str().is_empty() {
                    let _ = std::fs::create_dir_all(p);
                }
            }
        }
        match FileJsonlSpanProcessor::new(&trace_path, &cfg.trace_jsonl_filter) {
            Ok(proc) => builder = builder.with_span_processor(proc),
            Err(e) => eprintln!("trace_jsonl_open_failed: {e}"),
        }
    }

    Ok(builder.build())
}

fn resolve_trace_endpoint(cfg_endpoint: Option<&str>) -> Option<String> {
    if let Some(e) = cfg_endpoint {
        let t = e.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(v) = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|v| !v.is_empty())
}

// ─── JSON sink (file + stdout) ──────────────────────────────────────────────

/// Append-only JSON line sink. Writes to a file and optionally mirrors to stdout.
pub(crate) struct JsonSink {
    file: Option<std::fs::File>,
    mirror_stdout: bool,
}

impl JsonSink {
    fn new(path: &Path, mirror_stdout: bool) -> io::Result<Self> {
        let file = OpenOptions::new().append(true).create(true).open(path)?;
        Ok(Self {
            file: Some(file),
            mirror_stdout,
        })
    }
}

impl io::Write for JsonSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Some(f) = self.file.as_mut() {
            let _ = f.write_all(buf);
        }
        if self.mirror_stdout {
            let _ = io::stdout().write_all(buf);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        if self.mirror_stdout {
            let _ = io::stdout().flush();
        }
        Ok(())
    }
}

// ─── tracing-subscriber bridge ──────────────────────────────────────────────

static SUBSCRIBER_INSTALLED: OnceCell<()> = OnceCell::new();

struct EventCaptureLayer;

impl<S> Layer<S> for EventCaptureLayer
where
    S: Subscriber + for<'span> LookupSpan<'span>,
{
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: TracingContext<'_, S>) {
        if IN_LOG_EVENT_TLS.with(|c| c.get()) {
            return;
        }
        IN_LOG_EVENT_TLS.with(|c| c.set(true));
        let mut fields: Map<String, Value> = Map::new();
        let mut visitor = JsonVisitor(&mut fields);
        event.record(&mut visitor);
        let message = fields
            .remove("message")
            .map(|v| match v {
                Value::String(s) => s,
                other => other.to_string(),
            })
            .unwrap_or_else(|| event.metadata().target().to_string());

        let level = match *event.metadata().level() {
            tracing::Level::TRACE | tracing::Level::DEBUG => "debug",
            tracing::Level::INFO => "info",
            tracing::Level::WARN => "warning",
            tracing::Level::ERROR => "error",
        };
        let _ = log_event_inner(level, &message, fields);
        IN_LOG_EVENT_TLS.with(|c| c.set(false));
    }
}

struct JsonVisitor<'a>(&'a mut Map<String, Value>);

impl<'a> tracing::field::Visit for JsonVisitor<'a> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.insert(
            field.name().to_string(),
            Value::String(format!("{value:?}")),
        );
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.0.insert(field.name().to_string(), Value::from(value));
    }
    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.0.insert(
            field.name().to_string(),
            serde_json::Number::from_f64(value)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        );
    }
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.0.insert(field.name().to_string(), Value::Bool(value));
    }
}

fn install_subscriber_once() {
    if SUBSCRIBER_INSTALLED.set(()).is_err() {
        return;
    }
    let registry = Registry::default().with(EventCaptureLayer);
    if let Err(e) = tracing::subscriber::set_global_default(registry) {
        eprintln!(
            "[observability-client] could not install tracing subscriber (likely already set): {e}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_keys_puts_preferred_first() {
        let mut m: BTreeMap<String, Value> = BTreeMap::new();
        m.insert("user_id".to_string(), Value::String("x".to_string()));
        m.insert("timestamp".to_string(), Value::String("t".to_string()));
        m.insert("level".to_string(), Value::String("info".to_string()));
        let out = order_keys(m);
        let keys: Vec<&String> = out.keys().collect();
        assert_eq!(keys[0], "timestamp");
        assert_eq!(keys[1], "level");
        assert!(keys.iter().any(|k| *k == "user_id"));
    }

    #[test]
    fn sanitize_strips_newlines() {
        assert_eq!(sanitize_log_string("a\nb\rc"), "a b c");
    }
}
