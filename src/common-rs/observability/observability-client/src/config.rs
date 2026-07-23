//! [`ObservabilityLoggingConfig`] — the only supported configuration shape for
//! [`crate::configure_observability_logging`]. Mirrors the Go struct field-for-field.

use std::collections::HashMap;

use serde_json::Value;
use thiserror::Error;

use crate::enums;

/// `app_log` record type marker on every log line.
pub const APP_LOG_RECORD_TYPE: &str = "app_log";
/// `trace_span` record type marker on JSONL trace lines.
pub const TRACE_SPAN_RECORD_TYPE: &str = "trace_span";

/// Errors raised during config parsing / validation.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("format must be json or console, got {0:?}")]
    InvalidFormat(String),
    #[error("{0}")]
    InvalidMinLogLevel(String),
    #[error("metrics_export_interval_ms must be > 0")]
    InvalidExportInterval,
    #[error("prometheus_metrics_port must be > 0 when set")]
    InvalidPromPort,
    #[error("trace_jsonl_filter must be all or openllmetry, got {0:?}")]
    InvalidTraceFilter(String),
    #[error("enable_openllmetry is not supported in the Rust runtime; use the Python or Node OpenLLMetry integration, or emit OTel spans with `gen_ai.*` / `traceloop.*` attributes manually")]
    OpenllmetryUnsupported,
    #[error("AGENT_STUDIO_OBSERVABILITY_{field}: {msg}")]
    Env { field: String, msg: String },
    #[error("unknown config key: {0}")]
    UnknownKey(String),
    #[error("unsupported logging config version {got}; expected {expected}")]
    UnsupportedVersion { got: i64, expected: i64 },
    #[error("invalid JSON config: {0}")]
    InvalidJson(String),
    #[error("I/O error reading config: {0}")]
    Io(#[from] std::io::Error),
}

/// Full observability configuration. All knobs documented in
/// `.specs/observability/01-config-and-env.spec.md`.
#[derive(Debug, Clone)]
pub struct ObservabilityLoggingConfig {
    pub format: String,
    pub ensure_tracer_provider: bool,
    pub enable_auto_instrumentation: bool,
    pub enable_auto_span_logging: bool,
    pub auto_span_log_level: String,
    pub enable_red_metrics: bool,
    pub enable_openllmetry: bool,
    pub traceloop_disable_batch: bool,
    pub otlp_traces_endpoint: Option<String>,
    pub metrics_otlp_endpoint: Option<String>,
    pub metrics_export_interval_ms: u64,
    pub metrics_service_name: Option<String>,
    pub prometheus_metrics_port: Option<u16>,
    pub prometheus_metrics_host: String,
    pub min_log_level: Option<String>,
    pub log_file_path: String,
    pub log_file_encoding: String,
    pub create_log_parent_dirs: bool,
    pub write_spans_to_jsonl_file: bool,
    pub trace_jsonl_filter: String,
    pub trace_file_path: Option<String>,
    pub trace_file_encoding: String,
}

impl ObservabilityLoggingConfig {
    /// Validate the config. Parity with the Go `Validate` method.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.format != "json" && self.format != "console" {
            return Err(ConfigError::InvalidFormat(self.format.clone()));
        }
        if let Some(level) = &self.min_log_level {
            enums::validate_min_log_level(level).map_err(ConfigError::InvalidMinLogLevel)?;
        }
        if self.metrics_export_interval_ms == 0 {
            return Err(ConfigError::InvalidExportInterval);
        }
        if let Some(p) = self.prometheus_metrics_port {
            if p == 0 {
                return Err(ConfigError::InvalidPromPort);
            }
        }
        match self.trace_jsonl_filter.as_str() {
            "all" | "openllmetry" => {}
            other => return Err(ConfigError::InvalidTraceFilter(other.to_string())),
        }
        if self.enable_openllmetry {
            return Err(ConfigError::OpenllmetryUnsupported);
        }
        Ok(())
    }
}

/// Apply a parsed `HashMap<String, Value>` of overrides onto the config in-place.
/// Unknown keys → [`ConfigError::UnknownKey`].
pub fn merge_config_map(
    cfg: &mut ObservabilityLoggingConfig,
    m: HashMap<String, Value>,
) -> Result<(), ConfigError> {
    for (k, v) in m {
        match k.as_str() {
            "format" => cfg.format = as_string(&v),
            "ensure_tracer_provider" => cfg.ensure_tracer_provider = as_bool(&v),
            "enable_auto_instrumentation" => cfg.enable_auto_instrumentation = as_bool(&v),
            "enable_auto_span_logging" => cfg.enable_auto_span_logging = as_bool(&v),
            "auto_span_log_level" => cfg.auto_span_log_level = as_string(&v),
            "enable_red_metrics" => cfg.enable_red_metrics = as_bool(&v),
            "enable_openllmetry" => cfg.enable_openllmetry = as_bool(&v),
            "traceloop_disable_batch" => cfg.traceloop_disable_batch = as_bool(&v),
            "otlp_traces_endpoint" => cfg.otlp_traces_endpoint = as_optional_string(&v),
            "metrics_otlp_endpoint" => cfg.metrics_otlp_endpoint = as_optional_string(&v),
            "metrics_export_interval_ms" => cfg.metrics_export_interval_ms = as_u64(&v),
            "metrics_service_name" => cfg.metrics_service_name = as_optional_string(&v),
            "prometheus_metrics_port" => cfg.prometheus_metrics_port = as_optional_u16(&v),
            "prometheus_metrics_host" => cfg.prometheus_metrics_host = as_string(&v),
            "min_log_level" => cfg.min_log_level = as_optional_string(&v),
            "log_file_path" => cfg.log_file_path = as_string(&v),
            "log_file_encoding" => cfg.log_file_encoding = as_string(&v),
            "create_log_parent_dirs" => cfg.create_log_parent_dirs = as_bool(&v),
            "write_spans_to_jsonl_file" => cfg.write_spans_to_jsonl_file = as_bool(&v),
            "trace_jsonl_filter" => cfg.trace_jsonl_filter = as_string(&v),
            "trace_file_path" => cfg.trace_file_path = as_optional_string(&v),
            "trace_file_encoding" => cfg.trace_file_encoding = as_string(&v),
            other => return Err(ConfigError::UnknownKey(other.to_string())),
        }
    }
    Ok(())
}

fn as_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    }
}

fn as_optional_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => {
            if is_null_token(s) {
                None
            } else {
                Some(s.clone())
            }
        }
        other => Some(other.to_string()),
    }
}

fn as_bool(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => {
            let lower = s.trim().to_ascii_lowercase();
            matches!(lower.as_str(), "true" | "1" | "yes" | "on")
        }
        Value::Number(n) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        _ => false,
    }
}

fn as_u64(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_i64().and_then(|i| u64::try_from(i).ok()))
            .or_else(|| n.as_f64().map(|f| f as u64))
            .unwrap_or(0),
        Value::String(s) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

fn as_optional_u16(v: &Value) -> Option<u16> {
    match v {
        Value::Null => None,
        Value::String(s) if is_null_token(s) => None,
        Value::String(s) => s.trim().parse::<u16>().ok(),
        Value::Number(n) => n.as_u64().and_then(|x| u16::try_from(x).ok()),
        _ => None,
    }
}

pub(crate) fn is_null_token(s: &str) -> bool {
    matches!(s.trim().to_ascii_lowercase().as_str(), "none" | "null" | "")
}
