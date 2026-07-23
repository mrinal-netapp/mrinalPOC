//! Static defaults + `AGENT_STUDIO_OBSERVABILITY_*` env-override parser.
//! Parity with the Go / Python / TypeScript clients.

use std::collections::HashMap;
use std::env;

use serde_json::{json, Value};

use crate::config::{is_null_token, ConfigError, ObservabilityLoggingConfig};

/// Prefix for the observability env contract.
pub const OBSERVABILITY_ENV_PREFIX: &str = "AGENT_STUDIO_OBSERVABILITY_";

pub(crate) const DEFAULT_LOG_DIR: &str = "App_Logs";
pub(crate) const DEFAULT_LOG_FILENAME: &str = "app.jsonl";
pub(crate) const DEFAULT_TRACE_DIR: &str = "Trace_Logs";
pub(crate) const DEFAULT_TRACE_FILENAME: &str = "trace.jsonl";
pub(crate) const DEFAULT_METRICS_EXPORT_MS: u64 = 60_000;

/// Built-in defaults without consulting the environment. Parity with Go.
pub fn observability_static_defaults() -> ObservabilityLoggingConfig {
    ObservabilityLoggingConfig {
        format: "json".to_string(),
        ensure_tracer_provider: true,
        enable_auto_instrumentation: true,
        enable_auto_span_logging: false,
        auto_span_log_level: "info".to_string(),
        enable_red_metrics: true,
        enable_openllmetry: false,
        traceloop_disable_batch: false,
        otlp_traces_endpoint: None,
        metrics_otlp_endpoint: None,
        metrics_export_interval_ms: DEFAULT_METRICS_EXPORT_MS,
        metrics_service_name: None,
        prometheus_metrics_port: None,
        prometheus_metrics_host: "0.0.0.0".to_string(),
        min_log_level: None,
        log_file_path: DEFAULT_LOG_DIR.to_string(),
        log_file_encoding: "utf-8".to_string(),
        create_log_parent_dirs: true,
        write_spans_to_jsonl_file: true,
        trace_jsonl_filter: "openllmetry".to_string(),
        trace_file_path: None,
        trace_file_encoding: "utf-8".to_string(),
    }
}

/// Field names accepted by JSON config and the env parser.
fn field_names() -> &'static [&'static str] {
    &[
        "format",
        "ensure_tracer_provider",
        "enable_auto_instrumentation",
        "enable_auto_span_logging",
        "auto_span_log_level",
        "enable_red_metrics",
        "enable_openllmetry",
        "traceloop_disable_batch",
        "otlp_traces_endpoint",
        "metrics_otlp_endpoint",
        "metrics_export_interval_ms",
        "metrics_service_name",
        "prometheus_metrics_port",
        "prometheus_metrics_host",
        "min_log_level",
        "log_file_path",
        "log_file_encoding",
        "create_log_parent_dirs",
        "write_spans_to_jsonl_file",
        "trace_jsonl_filter",
        "trace_file_path",
        "trace_file_encoding",
    ]
}

/// Returns `true` for the canonical bool-truthy tokens.
pub fn is_truthy(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn parse_env_bool(raw: &str, field: &str) -> Result<bool, ConfigError> {
    let s = raw.trim().to_ascii_lowercase();
    match s.as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::Env {
            field: field.to_ascii_uppercase(),
            msg: format!("expected boolean (true/false/1/0/yes/no/on/off), got {raw:?}"),
        }),
    }
}

/// Parse `AGENT_STUDIO_OBSERVABILITY_*` env vars present in the environment
/// into a JSON dict suitable for [`crate::config::merge_config_map`].
pub fn observability_env_overrides() -> Result<HashMap<String, Value>, ConfigError> {
    let mut out: HashMap<String, Value> = HashMap::new();
    let static_defaults = observability_static_defaults();

    for &name in field_names() {
        let env_key = format!("{OBSERVABILITY_ENV_PREFIX}{}", name.to_ascii_uppercase());
        let Ok(raw) = env::var(&env_key) else {
            continue;
        };
        let stripped = raw.trim();
        if stripped.is_empty() {
            // Empty string → keep static default; emit it so any prior JSON
            // value is *not* overridden — matches Go's behavior.
            out.insert(name.to_string(), static_field_json(&static_defaults, name));
            continue;
        }

        let value = match name {
            // Bool fields
            "ensure_tracer_provider"
            | "enable_auto_instrumentation"
            | "enable_auto_span_logging"
            | "enable_red_metrics"
            | "enable_openllmetry"
            | "traceloop_disable_batch"
            | "create_log_parent_dirs"
            | "write_spans_to_jsonl_file" => Value::Bool(parse_env_bool(stripped, name)?),

            "metrics_export_interval_ms" => {
                let n: i64 = stripped.parse().map_err(|_| ConfigError::Env {
                    field: name.to_ascii_uppercase(),
                    msg: format!("must be > 0, got {raw:?}"),
                })?;
                if n <= 0 {
                    return Err(ConfigError::Env {
                        field: name.to_ascii_uppercase(),
                        msg: format!("must be > 0, got {raw:?}"),
                    });
                }
                Value::from(n as u64)
            }

            "prometheus_metrics_port" => {
                if is_null_token(stripped) {
                    Value::Null
                } else {
                    let n: i64 = stripped.parse().map_err(|_| ConfigError::Env {
                        field: name.to_ascii_uppercase(),
                        msg: format!("must be > 0 when set, got {raw:?}"),
                    })?;
                    if !(1..=65535).contains(&n) {
                        return Err(ConfigError::Env {
                            field: name.to_ascii_uppercase(),
                            msg: format!("must be in 1..65535 when set, got {raw:?}"),
                        });
                    }
                    Value::from(n as u64)
                }
            }

            "min_log_level" | "auto_span_log_level" => {
                if is_null_token(stripped) {
                    Value::Null
                } else {
                    Value::String(stripped.to_string())
                }
            }

            "otlp_traces_endpoint"
            | "metrics_otlp_endpoint"
            | "metrics_service_name"
            | "log_file_path"
            | "trace_file_path" => {
                if is_null_token(stripped) {
                    Value::Null
                } else {
                    Value::String(stripped.to_string())
                }
            }

            _ => Value::String(stripped.to_string()),
        };

        out.insert(name.to_string(), value);
    }
    Ok(out)
}

fn static_field_json(cfg: &ObservabilityLoggingConfig, name: &str) -> Value {
    match name {
        "format" => json!(cfg.format),
        "ensure_tracer_provider" => json!(cfg.ensure_tracer_provider),
        "enable_auto_instrumentation" => json!(cfg.enable_auto_instrumentation),
        "enable_auto_span_logging" => json!(cfg.enable_auto_span_logging),
        "auto_span_log_level" => json!(cfg.auto_span_log_level),
        "enable_red_metrics" => json!(cfg.enable_red_metrics),
        "enable_openllmetry" => json!(cfg.enable_openllmetry),
        "traceloop_disable_batch" => json!(cfg.traceloop_disable_batch),
        "otlp_traces_endpoint" => json!(cfg.otlp_traces_endpoint),
        "metrics_otlp_endpoint" => json!(cfg.metrics_otlp_endpoint),
        "metrics_export_interval_ms" => json!(cfg.metrics_export_interval_ms),
        "metrics_service_name" => json!(cfg.metrics_service_name),
        "prometheus_metrics_port" => json!(cfg.prometheus_metrics_port),
        "prometheus_metrics_host" => json!(cfg.prometheus_metrics_host),
        "min_log_level" => json!(cfg.min_log_level),
        "log_file_path" => json!(cfg.log_file_path),
        "log_file_encoding" => json!(cfg.log_file_encoding),
        "create_log_parent_dirs" => json!(cfg.create_log_parent_dirs),
        "write_spans_to_jsonl_file" => json!(cfg.write_spans_to_jsonl_file),
        "trace_jsonl_filter" => json!(cfg.trace_jsonl_filter),
        "trace_file_path" => json!(cfg.trace_file_path),
        "trace_file_encoding" => json!(cfg.trace_file_encoding),
        _ => Value::Null,
    }
}

/// Apply `AGENT_STUDIO_OBSERVABILITY_*` env vars onto `cfg`.
pub fn apply_env_defaults(cfg: &mut ObservabilityLoggingConfig) -> Result<(), ConfigError> {
    let overrides = observability_env_overrides()?;
    crate::config::merge_config_map(cfg, overrides)
}
