//! `log_config.json` loader: schema check, `${VAR:-default}` placeholder
//! expansion, type coercion. Parity with the Go / Python / TypeScript clients.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{Map, Value};

use crate::config::{is_null_token, merge_config_map, ConfigError, ObservabilityLoggingConfig};
use crate::logger_handler::configure_observability_logging;
use crate::observability_env::{apply_env_defaults, observability_static_defaults};

/// Embedded copy of the packaged `config/log_config.json`.
const PACKAGED_CONFIG_JSON: &str = include_str!("config/log_config.json");

/// Supported JSON config schema version.
pub const CONFIG_VERSION: i64 = 1;

static PLACEHOLDER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\$\{([^}:]+)(?::-([^}]*))?\}").expect("regex"));

static LOGGING_CONFIG_KEYS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
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
        "metrics_service_name",
        "metrics_export_interval_ms",
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
    .iter()
    .copied()
    .collect()
});

/// Parse a `{ version, logging: { ... } }` JSON value into a flat map suitable
/// for [`crate::config::merge_config_map`].
pub fn load_logging_config_dict(raw: Value) -> Result<HashMap<String, Value>, ConfigError> {
    let raw = match raw {
        Value::Object(m) => m,
        other => {
            return Err(ConfigError::InvalidJson(format!(
                "expected object at top level, got {other}"
            )))
        }
    };

    let version = raw
        .get("version")
        .and_then(|v| v.as_i64())
        .unwrap_or(CONFIG_VERSION);
    if version != CONFIG_VERSION {
        return Err(ConfigError::UnsupportedVersion {
            got: version,
            expected: CONFIG_VERSION,
        });
    }

    let logging: Map<String, Value> = match raw.get("logging") {
        Some(Value::Object(m)) => m.clone(),
        _ => raw
            .into_iter()
            .filter(|(k, _)| k != "version")
            .collect::<Map<String, Value>>(),
    };

    for k in logging.keys() {
        if !LOGGING_CONFIG_KEYS.contains(k.as_str()) {
            return Err(ConfigError::UnknownKey(k.clone()));
        }
    }

    let mut expanded: HashMap<String, Value> = HashMap::with_capacity(logging.len());
    for (k, v) in logging {
        expanded.insert(k, expand_env_placeholders(v));
    }
    Ok(coerce_logging_kwargs_types(expanded))
}

fn expand_env_placeholders(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(
            PLACEHOLDER_RE
                .replace_all(&s, |caps: &regex::Captures<'_>| {
                    let name = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
                    let default = caps.get(2);
                    match env::var(name) {
                        Ok(val) if !val.is_empty() => val,
                        _ => default.map(|m| m.as_str().to_string()).unwrap_or_default(),
                    }
                })
                .into_owned(),
        ),
        Value::Array(arr) => Value::Array(arr.into_iter().map(expand_env_placeholders).collect()),
        Value::Object(map) => {
            let out: Map<String, Value> = map
                .into_iter()
                .map(|(k, v)| (k, expand_env_placeholders(v)))
                .collect();
            Value::Object(out)
        }
        other => other,
    }
}

/// Coerce string-typed values (the result of `${...}` expansion) into the
/// correct JSON type for `merge_config_map`.
fn coerce_logging_kwargs_types(mut kwargs: HashMap<String, Value>) -> HashMap<String, Value> {
    const BOOL_KEYS: &[&str] = &[
        "ensure_tracer_provider",
        "enable_auto_instrumentation",
        "enable_auto_span_logging",
        "enable_red_metrics",
        "enable_openllmetry",
        "traceloop_disable_batch",
        "create_log_parent_dirs",
        "write_spans_to_jsonl_file",
    ];
    for k in BOOL_KEYS {
        if let Some(v) = kwargs.get_mut(*k) {
            *v = Value::Bool(parse_json_bool(v));
        }
    }
    if let Some(v) = kwargs.get_mut("metrics_export_interval_ms") {
        *v = Value::from(parse_json_u64(v));
    }
    if let Some(v) = kwargs.get_mut("prometheus_metrics_port") {
        *v = parse_json_port(v);
    }
    kwargs
}

fn parse_json_bool(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        ),
        Value::Number(n) => n.as_i64().map(|i| i != 0).unwrap_or(false),
        _ => false,
    }
}

fn parse_json_u64(v: &Value) -> u64 {
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

fn parse_json_port(v: &Value) -> Value {
    match v {
        Value::Null => Value::Null,
        Value::String(s) if is_null_token(s) => Value::Null,
        Value::String(s) => s
            .trim()
            .parse::<u64>()
            .map(Value::from)
            .unwrap_or(Value::Null),
        Value::Number(_) => v.clone(),
        _ => Value::Null,
    }
}

/// Build the config from packaged defaults + JSON file + env, then configure.
pub fn configure_logging_from_json_file<P: AsRef<Path>>(path: P) -> Result<(), ConfigError> {
    let abs = fs::canonicalize(&path).unwrap_or_else(|_| path.as_ref().to_path_buf());
    let data = fs::read_to_string(&abs)?;
    let raw: Value =
        serde_json::from_str(&data).map_err(|e| ConfigError::InvalidJson(e.to_string()))?;
    let kwargs = load_logging_config_dict(raw)?;
    let mut cfg = observability_static_defaults();
    merge_config_map(&mut cfg, kwargs)?;
    apply_env_defaults(&mut cfg)?;
    resolve_paths_against(&mut cfg, abs.parent().unwrap_or(Path::new(".")));
    configure_observability_logging(cfg).map_err(|e| ConfigError::InvalidJson(e.to_string()))
}

fn resolve_paths_against(cfg: &mut ObservabilityLoggingConfig, dir: &Path) {
    if !cfg.log_file_path.is_empty() {
        let p = PathBuf::from(&cfg.log_file_path);
        if !p.is_absolute() {
            cfg.log_file_path = dir.join(p).to_string_lossy().into_owned();
        }
    }
    if let Some(tp) = cfg.trace_file_path.clone() {
        let p = PathBuf::from(&tp);
        if !p.is_absolute() {
            cfg.trace_file_path = Some(dir.join(p).to_string_lossy().into_owned());
        }
    }
}

/// Configure from the bundled `config/log_config.json` (with env overrides).
pub fn configure_logging_from_packaged_default() -> Result<(), ConfigError> {
    let raw: Value = serde_json::from_str(PACKAGED_CONFIG_JSON)
        .map_err(|e| ConfigError::InvalidJson(e.to_string()))?;
    let kwargs = load_logging_config_dict(raw)?;
    let mut cfg = observability_static_defaults();
    merge_config_map(&mut cfg, kwargs)?;
    apply_env_defaults(&mut cfg)?;
    configure_observability_logging(cfg).map_err(|e| ConfigError::InvalidJson(e.to_string()))
}

/// Honor `LOG_CONFIG` env var → `default_path` arg → packaged default.
pub fn configure_logging_from_env(
    env_var: Option<&str>,
    default_path: Option<&Path>,
    use_packaged_default: bool,
) -> Result<(), ConfigError> {
    let env_var = env_var.unwrap_or("LOG_CONFIG");
    if let Ok(p) = env::var(env_var) {
        if !p.is_empty() {
            return configure_logging_from_json_file(p);
        }
    }
    if let Some(p) = default_path {
        return configure_logging_from_json_file(p);
    }
    if use_packaged_default {
        return configure_logging_from_packaged_default();
    }
    Ok(())
}

/// Shorthand: set service name then load packaged defaults.
pub fn configure_logging_for_service(name: &str) -> Result<(), ConfigError> {
    if !name.is_empty() {
        env::set_var("OTEL_SERVICE_NAME", name);
        env::set_var(
            crate::observability_env::OBSERVABILITY_ENV_PREFIX.to_string() + "METRICS_SERVICE_NAME",
            name,
        );
    }
    configure_logging_from_packaged_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_expansion() {
        let v = Value::String("${NONEXISTENT_X:-fallback}".to_string());
        let out = expand_env_placeholders(v);
        assert_eq!(out, Value::String("fallback".to_string()));
    }

    #[test]
    fn unknown_key_rejected() {
        let raw: Value =
            serde_json::from_str(r#"{"version": 1, "logging": {"not_a_real_key": "x"}}"#).unwrap();
        assert!(matches!(
            load_logging_config_dict(raw),
            Err(ConfigError::UnknownKey(_))
        ));
    }

    #[test]
    fn version_mismatch_rejected() {
        let raw: Value = serde_json::from_str(r#"{"version": 99, "logging": {}}"#).unwrap();
        assert!(matches!(
            load_logging_config_dict(raw),
            Err(ConfigError::UnsupportedVersion { .. })
        ));
    }
}
