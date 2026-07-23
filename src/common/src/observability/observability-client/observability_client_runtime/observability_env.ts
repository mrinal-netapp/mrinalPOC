/**
 * Built-in defaults and AGENT_STUDIO_OBSERVABILITY_* parsing
 * (aligned with Python ``logger_handler``).
 */
import type { ObservabilityDefaults } from './types';

export const OBSERVABILITY_ENV_PREFIX = 'AGENT_STUDIO_OBSERVABILITY_';

const _ENV_BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);
const _ENV_BOOL_FALSE = new Set(['0', 'false', 'no', 'off']);

export const DEFAULT_LOG_DIR = 'App_Logs';
export const DEFAULT_TRACE_DIR = 'Trace_Logs';

function _observabilityStaticDefaultsDict(): ObservabilityDefaults {
  return {
    format: 'json',
    ensure_tracer_provider: true,
    enable_auto_instrumentation: true,
    enable_auto_span_logging: false,
    auto_span_log_level: 'info',
    enable_red_metrics: true,
    enable_openllmetry: false,
    traceloop_disable_batch: false,
    otlp_traces_endpoint: null,
    otlp_logs_endpoint: null,
    metrics_otlp_endpoint: null,
    metrics_export_interval_ms: 60000,
    metrics_service_name: null,
    prometheus_metrics_port: null,
    prometheus_metrics_host: '0.0.0.0',
    min_log_level: null,
    log_file_path: DEFAULT_LOG_DIR,
    log_file_name: 'app.jsonl',
    log_file_encoding: 'utf-8',
    create_log_parent_dirs: true,
    write_spans_to_jsonl_file: true,
    trace_jsonl_filter: 'openllmetry',
    trace_file_path: null,
    trace_file_encoding: 'utf-8',
  };
}

const _OBSERVABILITY_FIELD_NAMES = new Set<string>(
  Object.keys(_observabilityStaticDefaultsDict()),
);

function _parseEnvBool(raw: string, fieldName: string): boolean {
  const s = String(raw).trim().toLowerCase();
  if (_ENV_BOOL_TRUE.has(s)) return true;
  if (_ENV_BOOL_FALSE.has(s)) return false;
  throw new Error(
    `${OBSERVABILITY_ENV_PREFIX}${String(fieldName).toUpperCase()}: expected a boolean ` +
      `(true/false/1/0/yes/no/on/off), got ${JSON.stringify(raw)}`,
  );
}

function _parseObservabilityEnvValue(
  name: string,
  raw: string,
  staticVal: unknown,
): unknown {
  const stripped = String(raw).trim();
  if (stripped === '') return staticVal;

  if (
    [
      'ensure_tracer_provider',
      'enable_auto_instrumentation',
      'enable_auto_span_logging',
      'enable_red_metrics',
      'enable_openllmetry',
      'traceloop_disable_batch',
      'create_log_parent_dirs',
      'write_spans_to_jsonl_file',
    ].includes(name)
  ) {
    return _parseEnvBool(raw, name);
  }

  if (name === 'metrics_export_interval_ms') {
    const v = parseInt(stripped, 10);
    if (Number.isNaN(v) || v <= 0) {
      throw new Error(
        `${OBSERVABILITY_ENV_PREFIX}METRICS_EXPORT_INTERVAL_MS must be > 0, got ${JSON.stringify(raw)}`,
      );
    }
    return v;
  }

  if (name === 'prometheus_metrics_port') {
    if (['none', 'null'].includes(stripped.toLowerCase()) || stripped === '') return null;
    const p = parseInt(stripped, 10);
    if (Number.isNaN(p) || p <= 0) {
      throw new Error(
        `${OBSERVABILITY_ENV_PREFIX}PROMETHEUS_METRICS_PORT must be > 0 when set, got ${JSON.stringify(raw)}`,
      );
    }
    return p;
  }

  if (name === 'auto_span_log_level' || name === 'min_log_level') {
    if (['none', 'null'].includes(stripped.toLowerCase())) return null;
    return stripped;
  }

  if (
    name === 'otlp_traces_endpoint' ||
    name === 'otlp_logs_endpoint' ||
    name === 'metrics_otlp_endpoint' ||
    name === 'metrics_service_name'
  ) {
    if (['none', 'null'].includes(stripped.toLowerCase())) return null;
    return stripped;
  }

  if (name === 'log_file_path' || name === 'trace_file_path') {
    if (['none', 'null'].includes(stripped.toLowerCase())) return null;
    return stripped;
  }

  if (
    name === 'format' ||
    name === 'trace_jsonl_filter' ||
    name === 'log_file_encoding' ||
    name === 'trace_file_encoding' ||
    name === 'prometheus_metrics_host'
  ) {
    return stripped;
  }

  return stripped;
}

function _observabilityEnvValueForField(fieldName: string): unknown {
  const staticRow = _observabilityStaticDefaultsDict();
  const staticVal = (staticRow as Record<string, unknown>)[fieldName];
  const envKey = `${OBSERVABILITY_ENV_PREFIX}${fieldName.toUpperCase()}`;
  if (!(envKey in process.env)) return staticVal;
  return _parseObservabilityEnvValue(fieldName, process.env[envKey] as string, staticVal);
}

export function observability_static_defaults(): ObservabilityDefaults {
  return { ..._observabilityStaticDefaultsDict() };
}

export function observability_env_overrides(): Partial<ObservabilityDefaults> {
  const out: Record<string, unknown> = {};
  const staticRow = _observabilityStaticDefaultsDict();
  for (const fieldName of _OBSERVABILITY_FIELD_NAMES) {
    const envKey = `${OBSERVABILITY_ENV_PREFIX}${fieldName.toUpperCase()}`;
    if (!(envKey in process.env)) continue;
    out[fieldName] = _parseObservabilityEnvValue(
      fieldName,
      process.env[envKey] as string,
      (staticRow as Record<string, unknown>)[fieldName],
    );
  }
  return out as Partial<ObservabilityDefaults>;
}

/**
 * Merge order for ``new ObservabilityLoggingConfig()`` without JSON:
 * static → env per field.
 */
export function buildObservabilityDefaultsFromEnv(): ObservabilityDefaults {
  const row = _observabilityStaticDefaultsDict();
  const merged: Record<string, unknown> = { ...row };
  for (const k of _OBSERVABILITY_FIELD_NAMES) {
    merged[k] = _observabilityEnvValueForField(k);
  }
  return merged as ObservabilityDefaults;
}
