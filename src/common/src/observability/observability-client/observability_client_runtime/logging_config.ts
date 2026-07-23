import fs from 'fs';
import path from 'path';
import { observability_env_overrides, observability_static_defaults } from './observability_env';
import {
  ObservabilityLoggingConfig,
  configure_observability_logging,
} from './logger_handler';
import type { ObservabilityDefaults, ConfigureResult } from './types';

export const CONFIG_VERSION = 1;

const _LOGGING_KEYS = new Set<string>([
  'format',
  'ensure_tracer_provider',
  'enable_auto_instrumentation',
  'enable_auto_span_logging',
  'auto_span_log_level',
  'enable_red_metrics',
  'enable_openllmetry',
  'traceloop_disable_batch',
  'otlp_traces_endpoint',
  'metrics_otlp_endpoint',
  'metrics_export_interval_ms',
  'metrics_service_name',
  'prometheus_metrics_port',
  'prometheus_metrics_host',
  'min_log_level',
  'log_file_path',
  'log_file_name',
  'log_file_encoding',
  'create_log_parent_dirs',
  'write_spans_to_jsonl_file',
  'trace_jsonl_filter',
  'trace_file_path',
  'trace_file_encoding',
  'service_name',
  'service_version',
  'environment',
]);

/**
 * Expand ${VAR} and ${VAR:-default} placeholders in a string.
 * Implemented as a manual parser (no regex) to avoid ReDoS on adversarial input.
 */
function _expandEnvString(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('${', i);
    if (start === -1) { out.push(s.slice(i)); break; }
    out.push(s.slice(i, start));
    const end = s.indexOf('}', start + 2);
    if (end === -1) { out.push(s.slice(start)); break; }
    const inner = s.slice(start + 2, end);
    const sep = inner.indexOf(':-');
    const name = (sep >= 0 ? inner.slice(0, sep) : inner).trim();
    const defVal = sep >= 0 ? inner.slice(sep + 2) : undefined;
    const env = process.env[name];
    if (defVal !== undefined) {
      out.push(env === undefined || env === '' ? defVal : env);
    } else {
      out.push(env !== undefined && env !== null ? env : '');
    }
    i = end + 1;
  }
  return out.join('');
}

function _expandEnvPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    return _expandEnvString(value);
  }
  if (Array.isArray(value)) return value.map((v) => _expandEnvPlaceholders(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = _expandEnvPlaceholders(v);
    }
    return out;
  }
  return value;
}

function _coerceLoggingKwargsTypes(
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...kwargs };

  function bool(v: unknown): boolean {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
      if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    }
    throw new Error(`Expected boolean, got ${JSON.stringify(v)}`);
  }

  function optInt(v: unknown): number | null {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    if (typeof v === 'boolean') throw new Error(`Expected int or null, got ${JSON.stringify(v)}`);
    return typeof v === 'number' ? v : parseInt(String(v), 10);
  }

  function reqInt(v: unknown): number {
    if (typeof v === 'boolean') throw new Error(`Expected int, got ${JSON.stringify(v)}`);
    return typeof v === 'number' ? v : parseInt(String(v), 10);
  }

  const boolKeys = [
    'ensure_tracer_provider',
    'enable_auto_instrumentation',
    'enable_auto_span_logging',
    'enable_red_metrics',
    'enable_openllmetry',
    'traceloop_disable_batch',
    'create_log_parent_dirs',
    'write_spans_to_jsonl_file',
  ];
  for (const k of boolKeys) {
    if (k in out && out[k] != null) out[k] = bool(out[k]);
  }
  if ('metrics_export_interval_ms' in out && out['metrics_export_interval_ms'] != null) {
    out['metrics_export_interval_ms'] = reqInt(out['metrics_export_interval_ms']);
  }
  if ('prometheus_metrics_port' in out) {
    out['prometheus_metrics_port'] = optInt(out['prometheus_metrics_port']);
  }
  return out;
}

function _coerceValue(_key: string, value: unknown): unknown {
  if (value === null) return null;
  return value;
}

function _buildKwargs(loggingCfg: Record<string, unknown>): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {};
  for (const key of _LOGGING_KEYS) {
    if (!(key in loggingCfg)) continue;
    kwargs[key] = _coerceValue(key, loggingCfg[key]);
  }
  return kwargs;
}

function _resolvePathAgainstConfigDir(
  configPath: string,
  maybeRelative: string | null | undefined,
): string | null {
  if (maybeRelative == null) return null;
  if (path.isAbsolute(maybeRelative)) return maybeRelative;
  return path.resolve(path.dirname(configPath), maybeRelative);
}

export function load_logging_config_dict(raw: Record<string, unknown>): Record<string, unknown> {
  const version = (raw['version'] as number | undefined) ?? CONFIG_VERSION;
  if (version !== CONFIG_VERSION) {
    throw new Error(`Unsupported logging config version ${version}`);
  }

  const loggingCfg: Record<string, unknown> =
    raw['logging'] && typeof raw['logging'] === 'object'
      ? (raw['logging'] as Record<string, unknown>)
      : Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'version'));

  const unknown = Object.keys(loggingCfg).filter((key) => !_LOGGING_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown logging config keys: ${unknown.sort().join(', ')}`);
  }

  const expanded = _expandEnvPlaceholders(loggingCfg) as Record<string, unknown>;
  const kwargs = _buildKwargs(expanded);
  return _coerceLoggingKwargsTypes(kwargs);
}

export function configure_logging_from_json_file(
  configFilePath: string,
  encoding: BufferEncoding = 'utf-8',
): ConfigureResult {
  const resolvedPath = path.resolve(configFilePath);
  const raw = JSON.parse(fs.readFileSync(resolvedPath, { encoding })) as Record<string, unknown>;
  const kwargs = load_logging_config_dict(raw);
  const merged: Record<string, unknown> = {
    ...(observability_static_defaults() as Record<string, unknown>),
    ...kwargs,
    ...(observability_env_overrides() as Record<string, unknown>),
  };
  merged['log_file_path'] = _resolvePathAgainstConfigDir(
    resolvedPath,
    merged['log_file_path'] as string | null,
  );
  merged['trace_file_path'] = _resolvePathAgainstConfigDir(
    resolvedPath,
    merged['trace_file_path'] as string | null,
  );
  return configure_observability_logging({
    config: new ObservabilityLoggingConfig(merged as unknown as Partial<ObservabilityDefaults>),
  });
}

export function configure_logging_from_packaged_default(
  encoding: BufferEncoding = 'utf-8',
): ConfigureResult {
  const packagedPath = path.join(__dirname, 'config', 'log_config.json');
  return configure_logging_from_json_file(packagedPath, encoding);
}

export function configure_logging_from_env({
  env_var = 'LOG_CONFIG',
  default_path = null,
  use_packaged_default = false,
}: {
  env_var?: string;
  default_path?: string | null;
  use_packaged_default?: boolean;
} = {}): ConfigureResult | undefined {
  const pathFromEnv = process.env[env_var];
  if (pathFromEnv) return configure_logging_from_json_file(pathFromEnv);
  if (default_path) return configure_logging_from_json_file(default_path);
  if (use_packaged_default) return configure_logging_from_packaged_default();
  return undefined;
}

export type { ConfigureResult };
