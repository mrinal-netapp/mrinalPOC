//! File-backed JSONL span processor: writes one JSON line per ended span if it
//! matches the filter (`openllmetry` keeps only spans tagged with `gen_ai.*` /
//! `traceloop.*` attributes or known instrumentation-scope markers; `all` keeps
//! every valid span).
//!
//! Mirrors `fileJSONLSpanProcessor` from the Go client.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use opentelemetry::trace::Status;
use opentelemetry::Value as OtelValue;
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::trace::{SpanData, SpanProcessor};
use opentelemetry_sdk::Resource;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::config::ObservabilityLoggingConfig;
use crate::logger_handler::TRACER_NAME_HANDLER;
use crate::observability_env::{DEFAULT_TRACE_DIR, DEFAULT_TRACE_FILENAME};

const OPENLLMETRY_SCOPE_MARKERS: &[&str] = &[
    "traceloop.tracer",
    "instrumentation.openai",
    "instrumentation.langchain",
    "instrumentation.mcp",
    "instrumentation.crewai",
    "instrumentation.llamaindex",
    "instrumentation.chromadb",
];

/// What spans to keep in the JSONL trace dump.
#[derive(Debug, Clone, Copy)]
pub enum TraceJsonlFilter {
    All,
    Openllmetry,
}

impl TraceJsonlFilter {
    fn from_str(s: &str) -> Self {
        if s.eq_ignore_ascii_case("all") {
            Self::All
        } else {
            Self::Openllmetry
        }
    }
}

#[derive(Debug)]
pub(crate) struct FileJsonlSpanProcessor {
    filter: TraceJsonlFilter,
    file: Mutex<Option<File>>,
}

impl FileJsonlSpanProcessor {
    pub(crate) fn new(path: &Path, filter: &str) -> std::io::Result<Self> {
        let file = OpenOptions::new().append(true).create(true).open(path)?;
        Ok(Self {
            filter: TraceJsonlFilter::from_str(filter),
            file: Mutex::new(Some(file)),
        })
    }
}

impl SpanProcessor for FileJsonlSpanProcessor {
    fn on_start(&self, _span: &mut opentelemetry_sdk::trace::Span, _cx: &opentelemetry::Context) {}

    fn on_end(&self, span: SpanData) {
        if !span.span_context.is_valid() {
            return;
        }
        if matches!(self.filter, TraceJsonlFilter::Openllmetry)
            && !span_matches_openllmetry_filter(&span)
        {
            return;
        }
        let Ok(line) = span_to_jsonline(&span) else {
            return;
        };
        let mut guard = self.file.lock();
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }

    fn force_flush(&self) -> OTelSdkResult {
        let mut guard = self.file.lock();
        if let Some(f) = guard.as_mut() {
            let _ = f.sync_all();
        }
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        let mut guard = self.file.lock();
        *guard = None;
        Ok(())
    }

    fn set_resource(&mut self, _resource: &Resource) {}
}

fn span_matches_openllmetry_filter(span: &SpanData) -> bool {
    for kv in span.attributes.iter() {
        let key = kv.key.as_str();
        if key.starts_with("traceloop.") || key.starts_with("gen_ai.") {
            return true;
        }
    }
    let scope = span.instrumentation_scope.name();
    if scope.is_empty() || scope == TRACER_NAME_HANDLER {
        return false;
    }
    if scope == "traceloop.tracer" {
        return true;
    }
    OPENLLMETRY_SCOPE_MARKERS.iter().any(|m| scope.contains(m))
}

fn otel_value_to_json(v: &OtelValue) -> Value {
    match v {
        OtelValue::Bool(b) => Value::Bool(*b),
        OtelValue::I64(i) => Value::from(*i),
        OtelValue::F64(f) => serde_json::Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        OtelValue::String(s) => Value::String(s.to_string()),
        OtelValue::Array(arr) => {
            // The Array enum has distinct variants for each scalar type.
            // serde_json::to_value works because OtelValue::Array's Debug is
            // a stable representation, but for cross-version safety we serialize
            // each scalar variant ourselves via to_string when in doubt.
            Value::String(format!("{arr:?}"))
        }
        other => Value::String(format!("{other:?}")),
    }
}

fn span_to_jsonline(span: &SpanData) -> serde_json::Result<String> {
    let mut rec = Map::new();
    rec.insert(
        "trace_id".to_string(),
        Value::String(format!("{}", span.span_context.trace_id())),
    );
    rec.insert(
        "span_id".to_string(),
        Value::String(format!("{}", span.span_context.span_id())),
    );
    rec.insert("name".to_string(), Value::String(span.name.to_string()));
    rec.insert(
        "kind".to_string(),
        Value::String(format!("{:?}", span.span_kind)),
    );
    let status = match &span.status {
        Status::Unset => "Unset",
        Status::Ok => "Ok",
        Status::Error { .. } => "Error",
    };
    rec.insert("status".to_string(), Value::String(status.to_string()));
    if let (Ok(start), Ok(end)) = (
        span.start_time.duration_since(std::time::UNIX_EPOCH),
        span.end_time.duration_since(std::time::UNIX_EPOCH),
    ) {
        let duration_ms = end.as_millis().saturating_sub(start.as_millis());
        rec.insert("duration_ms".to_string(), Value::from(duration_ms as u64));
    }
    if !span.attributes.is_empty() {
        let mut attrs = Map::new();
        for kv in span.attributes.iter() {
            attrs.insert(kv.key.as_str().to_string(), otel_value_to_json(&kv.value));
        }
        rec.insert("attributes".to_string(), Value::Object(attrs));
    }
    serde_json::to_string(&Value::Object(rec))
}

/// Resolve the effective `Trace_Logs/trace.jsonl` path from the configured value.
pub(crate) fn effective_trace_jsonl_path(cfg: &ObservabilityLoggingConfig) -> Option<PathBuf> {
    if !cfg.write_spans_to_jsonl_file {
        return None;
    }
    if let Some(p) = cfg
        .trace_file_path
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        return Some(resolve_trace_output_path(p));
    }
    Some(PathBuf::from(DEFAULT_TRACE_DIR).join(DEFAULT_TRACE_FILENAME))
}

fn resolve_trace_output_path(trace_file_path: &str) -> PathBuf {
    let raw = trace_file_path.trim();
    if raw.is_empty() {
        return PathBuf::new();
    }
    let path = PathBuf::from(raw);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.is_dir() {
            return path.join(DEFAULT_TRACE_FILENAME);
        }
        return path;
    }
    if path.extension().is_some() {
        return path;
    }
    path.join(DEFAULT_TRACE_FILENAME)
}

pub(crate) fn resolve_log_output_path(log_file_path: &str) -> PathBuf {
    use crate::observability_env::{DEFAULT_LOG_DIR, DEFAULT_LOG_FILENAME};
    if log_file_path.trim().is_empty() {
        return PathBuf::from(DEFAULT_LOG_DIR).join(DEFAULT_LOG_FILENAME);
    }
    let path = PathBuf::from(log_file_path);
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.is_dir() {
            return path.join(DEFAULT_LOG_FILENAME);
        }
        return path;
    }
    if path.extension().is_some() {
        return path;
    }
    path.join(DEFAULT_LOG_FILENAME)
}
