import fs from 'fs';
import path from 'path';
import log4js from 'log4js';
import {
  metrics,
  trace,
  SpanKind,
  SpanStatusCode,
  type Meter,
} from '@opentelemetry/api';
import { getProjectId } from './context_store';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  BasicTracerProvider,
  type SpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

import {
  LogLevel,
  LEVEL_RANK,
  VALID_MIN_LOG_LEVEL_KEYS,
  normalizeLevelName,
} from '../enums/log-levels';
import {
  normalizeOtlpHttpMetricsEndpoint,
  normalizeOtlpHttpTracesEndpoint,
  otlpCollectorBaseForTraceloop,
} from './otlp_endpoint_utils';
import { applyOtlpUnreachableExportSilencing } from './otlp_export_tolerance';
import {
  buildObservabilityDefaultsFromEnv,
  observability_env_overrides,
  observability_static_defaults,
} from './observability_env';
import {
  CompositeSpanProcessor,
  FileJsonlSpanProcessor,
  TRACE_SPAN_RECORD_TYPE,
  effectiveTraceJsonlPath,
} from './trace_jsonl';
import type {
  ObservabilityConfigOptions,
  ObservabilityDefaults,
  ObservabilityLogger,
  TraceloopSdkModule,
} from './types';
export type { ConfigureResult } from './types';

export { TRACE_SPAN_RECORD_TYPE };

export const DEFAULT_CONFIG = Object.freeze(observability_static_defaults());

const _TRACER_NAME = 'logging.logger_handler';
export const DEFAULT_LOG_DIR = 'App_Logs';
export const DEFAULT_LOG_FILENAME = 'app.jsonl';
export const APP_LOG_RECORD_TYPE = 'app_log';

const _VALID_TRACE_JSONL_FILTERS = new Set(['all', 'openllmetry']);

/** Stable key order aligned with Python ``normalize_log_key_order`` / ``_PREFERRED_LOG_KEY_ORDER`` */
const _PREFERRED_LOG_KEY_ORDER = [
  'timestamp',
  'level',
  'record_type',
  'event',
  'trace_id',
  'span_id',
  'parent_span_id',
  'span_name',
  'span_kind',
  'span_status',
  'duration_ms',
];

const _LOOPBACK_PROM_BIND = new Set(['localhost', '127.0.0.1', '::1']);

let _configured = false;
let _sdk: NodeSDK | null = null;
let _traceloopActive = false;
let _logger: ObservabilityLogger | null = null;
let _currentConfig: Partial<ObservabilityLoggingConfig> = {};
let _autoInstrumentationDone = false;
let _longLivedMeterProvider: MeterProvider | null = null;
let _shortLivedMeterProvider: MeterProvider | null = null;
let _promExporter: PrometheusExporter | null = null;
let _logFilePath = '';
let _logEncoding = 'utf-8';

const _LOG4JS_CATEGORY = 'agentstudio.observability-client-runtime';

function getLongLivedMeter(name = 'domain', version = '1.0.0'): Meter {
  if (_longLivedMeterProvider) return _longLivedMeterProvider.getMeter(name, version);
  if (_shortLivedMeterProvider) return _shortLivedMeterProvider.getMeter(name, version);
  return metrics.getMeter(name, version);
}

function getShortLivedMeter(name = 'domain.short', version = '1.0.0'): Meter {
  if (_shortLivedMeterProvider) return _shortLivedMeterProvider.getMeter(name, version);
  if (_longLivedMeterProvider) {
    throw new Error(
      'Short-lived OTLP metrics are not configured. Set metrics_otlp_endpoint (or OTEL_EXPORTER_OTLP_*) ' +
        'while using prometheus_metrics_port for scrape, or use OTLP-only mode.',
    );
  }
  return metrics.getMeter(name, version);
}

function _unwrapTracerProvider(): ReturnType<typeof trace.getTracerProvider> {
  let p = trace.getTracerProvider();
  for (let i = 0; i < 8; i++) {
    const pAny = p as unknown as Record<string, unknown>;
    let nxt: typeof p | null = null;
    if (typeof pAny['getDelegate'] === 'function') {
      nxt = (pAny['getDelegate'] as () => typeof p)();
    } else if (pAny['_delegate']) {
      nxt = pAny['_delegate'] as typeof p;
    }
    if (nxt == null || nxt === p) break;
    p = nxt;
  }
  return p;
}

/**
 * Install an SDK TracerProvider when the process still uses the default
 * no-op / proxy provider. Mirrors Python ``ensure_sdk_tracer_provider``.
 */
export function ensure_sdk_tracer_provider(
  resourceAttrs: Record<string, string> | null = null,
): void {
  const inner = _unwrapTracerProvider();
  if (inner instanceof BasicTracerProvider) return;
  const resource =
    resourceAttrs && Object.keys(resourceAttrs).length > 0
      ? resourceFromAttributes(resourceAttrs)
      : undefined;
  const provider = resource
    ? new BasicTracerProvider({ resource })
    : new BasicTracerProvider();
  trace.setGlobalTracerProvider(provider);
}

function _resolveTraceEndpoint(configEndpoint: string | null | undefined): string | null {
  if (configEndpoint) return configEndpoint;
  return (
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    null
  );
}

function _resolveMetricsEndpoint(configEndpoint: string | null | undefined): string | null {
  if (configEndpoint) return configEndpoint;
  return (
    process.env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ??
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    null
  );
}

function _effectivePrometheusBindAddr(host: string | null | undefined): string {
  const stripped = String(host ?? '').trim();
  if (!stripped) return '0.0.0.0';
  if (_LOOPBACK_PROM_BIND.has(stripped.toLowerCase())) {
    process.emitWarning(
      `prometheus_metrics_host=${JSON.stringify(stripped)} is loopback; using 0.0.0.0 for remote scrape access`,
    );
    return '0.0.0.0';
  }
  return stripped;
}

export class ObservabilityLoggingConfig {
  format: string;
  ensure_tracer_provider: boolean;
  metrics_service_name: string | null;
  service_name: string | null;
  service_version: string | null;
  environment: string | null;
  log_file_path: string | null;
  log_file_name: string;
  log_file_encoding: string;
  create_log_parent_dirs: boolean;
  min_log_level: string | null;
  enable_auto_instrumentation: boolean;
  enable_auto_span_logging: boolean;
  auto_span_log_level: string;
  enable_red_metrics: boolean;
  enable_openllmetry: boolean;
  traceloop_disable_batch: boolean;
  prometheus_metrics_port: number | null;
  prometheus_metrics_host: string;
  otlp_traces_endpoint: string | null;
  otlp_logs_endpoint: string | null;
  metrics_otlp_endpoint: string | null;
  metrics_export_interval_ms: number;
  write_spans_to_jsonl_file: boolean;
  trace_jsonl_filter: string;
  trace_file_path: string | null;
  trace_file_encoding: string;

  constructor(config: ObservabilityConfigOptions = {}) {
    const b = buildObservabilityDefaultsFromEnv();
    this.format = config.format ?? b.format;
    this.ensure_tracer_provider = config.ensure_tracer_provider ?? b.ensure_tracer_provider;
    this.metrics_service_name = config.metrics_service_name ?? b.metrics_service_name ?? null;
    this.service_name = config.service_name ?? b.service_name ?? null;
    this.service_version = config.service_version ?? b.service_version ?? null;
    this.environment = config.environment ?? b.environment ?? null;
    this.log_file_path = config.log_file_path ?? b.log_file_path;
    this.log_file_name = config.log_file_name ?? b.log_file_name ?? DEFAULT_LOG_FILENAME;
    this.log_file_encoding = config.log_file_encoding ?? b.log_file_encoding;
    this.create_log_parent_dirs = config.create_log_parent_dirs ?? b.create_log_parent_dirs;
    this.min_log_level = config.min_log_level ?? b.min_log_level;
    this.enable_auto_instrumentation =
      config.enable_auto_instrumentation ?? b.enable_auto_instrumentation;
    this.enable_auto_span_logging = config.enable_auto_span_logging ?? b.enable_auto_span_logging;
    this.auto_span_log_level = config.auto_span_log_level ?? b.auto_span_log_level;
    this.enable_red_metrics = config.enable_red_metrics ?? b.enable_red_metrics;
    this.enable_openllmetry = config.enable_openllmetry ?? b.enable_openllmetry;
    this.traceloop_disable_batch = config.traceloop_disable_batch ?? b.traceloop_disable_batch;
    this.prometheus_metrics_port = config.prometheus_metrics_port ?? b.prometheus_metrics_port ?? null;
    this.prometheus_metrics_host = config.prometheus_metrics_host ?? b.prometheus_metrics_host ?? '0.0.0.0';
    this.otlp_traces_endpoint = config.otlp_traces_endpoint ?? b.otlp_traces_endpoint;
    this.otlp_logs_endpoint = config.otlp_logs_endpoint ?? (b as Record<string, unknown>)['otlp_logs_endpoint'] as string | null ?? null;
    this.metrics_otlp_endpoint = config.metrics_otlp_endpoint ?? b.metrics_otlp_endpoint;
    this.metrics_export_interval_ms =
      config.metrics_export_interval_ms ?? b.metrics_export_interval_ms;
    this.write_spans_to_jsonl_file = config.write_spans_to_jsonl_file ?? b.write_spans_to_jsonl_file;
    this.trace_jsonl_filter = config.trace_jsonl_filter ?? b.trace_jsonl_filter;
    this.trace_file_path = config.trace_file_path ?? b.trace_file_path;
    this.trace_file_encoding = config.trace_file_encoding ?? b.trace_file_encoding;
    this.validate();
  }

  validate(): void {
    if (!['json', 'console'].includes(this.format)) {
      throw new Error(`format must be one of ['console', 'json'], got ${this.format}`);
    }
    if (this.min_log_level != null) {
      const normalized = normalizeLevelName(this.min_log_level);
      if (!VALID_MIN_LOG_LEVEL_KEYS.includes(normalized)) {
        throw new Error(`min_log_level must be one of ${VALID_MIN_LOG_LEVEL_KEYS.join(', ')}`);
      }
      this.min_log_level = normalized;
    }
    if (this.metrics_export_interval_ms <= 0) {
      throw new Error('metrics_export_interval_ms must be > 0');
    }
    if (this.prometheus_metrics_port != null && this.prometheus_metrics_port <= 0) {
      throw new Error('prometheus_metrics_port must be > 0 when set');
    }
    if (!_VALID_TRACE_JSONL_FILTERS.has(this.trace_jsonl_filter)) {
      throw new Error(
        `trace_jsonl_filter must be one of ${[..._VALID_TRACE_JSONL_FILTERS].sort().join(', ')}, got ${this.trace_jsonl_filter}`,
      );
    }
  }
}

function _resolveLogOutputPath(
  logFilePath: string | null | undefined,
  logFileName: string | null | undefined,
): string {
  const fileName = logFileName ?? DEFAULT_LOG_FILENAME;
  if (logFilePath == null || String(logFilePath).trim() === '') {
    return path.resolve(DEFAULT_LOG_DIR, fileName);
  }
  const resolved = path.resolve(String(logFilePath));
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) return resolved;
    // Character devices (/dev/stdout, /dev/stderr), named pipes, and sockets
    // are writable sinks, not directories — return as-is without appending a filename.
    if (stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) return resolved;
  }
  if (path.extname(resolved)) return resolved;
  return path.join(resolved, fileName);
}

/**
 * Serialize a log event to a JSON string with preferred keys appearing first.
 *
 * Builds the JSON string directly from key/value pairs rather than writing
 * to an intermediate object, so no user-controlled key is ever used as a
 * computed property name in an assignment expression.
 */
function _orderedJson(event: Record<string, unknown>): string {
  const preferredSet = new Set(_PREFERRED_LOG_KEY_ORDER);
  const allKeys = Object.keys(event);
  const orderedKeys = [
    ..._PREFERRED_LOG_KEY_ORDER.filter((k) => allKeys.includes(k)),
    ...allKeys.filter((k) => !preferredSet.has(k)),
  ];
  const pairs = orderedKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(event[k])}`);
  return `{${pairs.join(',')}}`;
}

export const ATTR_HTTP_REQUEST_METHOD = 'http.request.method';
export const ATTR_URL_PATH = 'url.path';
export const ATTR_HTTP_ROUTE = 'http.route';
export const ATTR_HTTP_RESPONSE_STATUS_CODE = 'http.response.status_code';
// Legacy semconv (instrumentation-http < 0.213 still emits these)
const ATTR_HTTP_METHOD_LEGACY = 'http.method';
const ATTR_HTTP_TARGET_LEGACY = 'http.target';

function _metricAttributesFromSpan(
  span: ReadableSpan,
): Record<string, string> {
  const attrs = span.attributes ?? {};
  let method = String(
    (attrs[ATTR_HTTP_REQUEST_METHOD] ?? attrs[ATTR_HTTP_METHOD_LEGACY] ?? '') as string,
  );
  let urlPath = String(
    (attrs[ATTR_URL_PATH] ?? attrs[ATTR_HTTP_ROUTE] ?? attrs[ATTR_HTTP_TARGET_LEGACY] ?? '') as string,
  );
  // Prefer the span attribute; fall back to the AsyncLocalStorage context store.
  // The express OTel instrumentation wraps each middleware in an INTERNAL child span,
  // so setAttribute() in the middleware sets it on the child, not the SERVER span.
  // getProjectId() still works because res.end() (and thus span.end()) runs inside
  // the runWithContext() scope established by express_middleware.ts.
  const projectId =
    String((attrs['project_id'] ?? '') as string) || (getProjectId() ?? '');
  const statusCode = String((attrs[ATTR_HTTP_RESPONSE_STATUS_CODE] ?? '') as string);
  if (urlPath && urlPath.includes('?')) {
    urlPath = urlPath.split('?')[0];
  }
  if (!method || !urlPath) {
    const name = String(span.name ?? '');
    const parts = name.split(' ');
    if (parts.length >= 2) {
      method = method || parts[0];
      urlPath = urlPath || parts.slice(1).join(' ');
    } else if (parts.length === 1 && parts[0]) {
      if (!urlPath && !parts[0].match(/^[A-Z]+$/)) {
        urlPath = parts[0];
      }
    }
  }
  const result: Record<string, string> = {
    [ATTR_HTTP_REQUEST_METHOD]: method || 'GET',
    [ATTR_URL_PATH]: urlPath || '/unknown',
  };
  if (statusCode) {
    result[ATTR_HTTP_RESPONSE_STATUS_CODE] = statusCode;
  }
  if (projectId) {
    result['project_id'] = projectId;
  }
  return result;
}

function _hrTimeDurationMs(
  start: [number, number] | null | undefined,
  end: [number, number] | null | undefined,
): number {
  if (!start || !end) return 0;
  return (end[0] - start[0]) * 1000 + (end[1] - start[1]) / 1e6;
}

class RedMetricsSpanProcessor implements SpanProcessor {
  private _requestCounter: ReturnType<Meter['createCounter']> | null = null;
  private _errorCounter: ReturnType<Meter['createCounter']> | null = null;
  private _durationMs: ReturnType<Meter['createHistogram']> | null = null;

  onStart(): void {
    // Nothing to do on start.
  }

  private _ensureInstruments(): void {
    if (this._requestCounter) return;
    const meter = getLongLivedMeter('agent_studio.observability.red', '1.0.0');
    this._requestCounter = meter.createCounter('http.server.request.count', {
      unit: '1',
      description: 'Total HTTP server requests (RED: rate)',
    });
    this._errorCounter = meter.createCounter('http.server.request.error.count', {
      unit: '1',
      description: 'HTTP server requests that ended with ERROR status (RED: errors)',
    });
    this._durationMs = meter.createHistogram('http.server.request.duration_ms', {
      unit: 'ms',
      description: 'HTTP server request duration in milliseconds (RED: duration)',
    });
  }

  onEnd(span: ReadableSpan): void {
    if (span.kind !== SpanKind.SERVER) return;
    this._ensureInstruments();
    const metricAttrs = _metricAttributesFromSpan(span);
    this._requestCounter!.add(1, metricAttrs);
    if (span.status && span.status.code === SpanStatusCode.ERROR) {
      this._errorCounter!.add(1, metricAttrs);
    }
    let durationMs = 0;
    if (span.duration != null && Array.isArray(span.duration)) {
      durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6;
    } else {
      durationMs = _hrTimeDurationMs(
        span.startTime as [number, number],
        span.endTime as [number, number],
      );
    }
    this._durationMs!.record(durationMs, metricAttrs);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

function _autoInstrumentKnownLibraries(): void {
  if (_autoInstrumentationDone) return;
  _autoInstrumentationDone = true;
}

function _configureLog4js(filePath: string, encoding: string): void {
  log4js.configure({
    appenders: {
      logFile: {
        type: 'file',
        filename: filePath,
        flags: 'a',
        encoding,
        layout: { type: 'messagePassThrough' },
      },
      stdout: {
        type: 'stdout',
        layout: { type: 'messagePassThrough' },
      },
    },
    categories: {
      default: { appenders: ['logFile', 'stdout'], level: 'all' },
      [_LOG4JS_CATEGORY]: { appenders: ['logFile', 'stdout'], level: 'all' },
    },
  });
}

function _buildLogger(): ObservabilityLogger {
  const config = _currentConfig;
  const threshold = config.min_log_level ? LEVEL_RANK[config.min_log_level] ?? null : null;

  _configureLog4js(_logFilePath, _logEncoding);
  const internalLog4jsLogger = log4js.getLogger(_LOG4JS_CATEGORY);

  function emit(levelRaw: string, event: string, rawFields?: unknown): void {
    // Normalize fields: accept any value and coerce to a Record for structured output.
    let fields: Record<string, unknown>;
    if (rawFields == null) {
      fields = {};
    } else if (typeof rawFields === 'object' && !Array.isArray(rawFields)) {
      fields = rawFields as Record<string, unknown>;
    } else {
      // Plain string, number, array etc. — store under 'detail' for structured output.
      fields = { detail: rawFields };
    }

    const normalizedLevel = normalizeLevelName(levelRaw);
    if (LEVEL_RANK[normalizedLevel] == null) {
      throw new Error(`Invalid log level: ${levelRaw}`);
    }
    if (threshold != null && (LEVEL_RANK[normalizedLevel] ?? 0) < threshold) return;
    const span = trace.getActiveSpan();
    const spanContext = span ? span.spanContext() : null;
    const projectId = getProjectId();
    const base: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      record_type: fields['record_type'] ?? APP_LOG_RECORD_TYPE,
      event,
      trace_id: spanContext ? spanContext.traceId : undefined,
      span_id: spanContext ? spanContext.spanId : undefined,
      ...(projectId ? { project_id: projectId } : {}),
    };
    if (config.format === 'console') {
      process.stdout.write(`${_orderedJson({ ...base, ...fields })}\n`);
      return;
    }
    internalLog4jsLogger.info(_orderedJson({ ...base, ...fields }));
  }

  return {
    trace(event, fields) { emit('trace', event, fields); },
    debug(event, fields) { emit('debug', event, fields); },
    info(event, fields) { emit('info', event, fields); },
    warning(event, fields) { emit('warning', event, fields); },
    warn(event, fields) { emit('warning', event, fields); },
    error(event, fields) { emit('error', event, fields); },
    critical(event, fields) { emit('critical', event, fields); },
    exception(event, fields) { emit('exception', event, fields); },
  };
}

function _buildTraceResourceAttributes(
  configObj: ObservabilityLoggingConfig,
): Record<string, string> | null {
  const name = configObj.metrics_service_name ?? configObj.service_name;
  if (!name) return null;
  const attrs: Record<string, string> = {
    [SemanticResourceAttributes.SERVICE_NAME]: name,
  };
  if (configObj.service_version) {
    attrs[SemanticResourceAttributes.SERVICE_VERSION] = configObj.service_version;
  }
  if (configObj.environment) {
    attrs[SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT] = configObj.environment;
  }
  return attrs;
}

async function _shutdownOurNodeSdk(): Promise<void> {
  if (_sdk) {
    const sdkToShutdown = _sdk;
    _sdk = null;
    try {
      await sdkToShutdown.shutdown();
    } catch {
      /* ignore */
    }
  }
}

function _maybeShutdownTraceloopProvider(): Promise<void> {
  let traceloop: TraceloopSdkModule | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    traceloop = require('@traceloop/node-server-sdk') as TraceloopSdkModule;
  } catch {
    return Promise.resolve();
  }
  const flush = traceloop.forceFlush;
  const chain = typeof flush === 'function' ? flush() : Promise.resolve();
  return chain.then(() => {
    const tp = trace.getTracerProvider() as unknown as Record<string, unknown>;
    if (tp && typeof tp['shutdown'] === 'function') {
      return (tp['shutdown'] as () => Promise<void>)();
    }
    return undefined;
  });
}

import type { ConfigureResult } from './types';

export function configure_observability_logging(options: {
  config: ObservabilityLoggingConfig;
}): ConfigureResult {
  if (
    !options ||
    typeof options !== 'object' ||
    !Object.prototype.hasOwnProperty.call(options, 'config') ||
    !(options.config instanceof ObservabilityLoggingConfig)
  ) {
    throw new Error(
      'configure_observability_logging requires { config: ObservabilityLoggingConfig }',
    );
  }
  const configObj = options.config;
  configObj.validate();
  applyOtlpUnreachableExportSilencing();

  _currentConfig = { ...configObj };

  if (configObj.metrics_service_name) {
    process.env['OTEL_SERVICE_NAME'] =
      process.env['OTEL_SERVICE_NAME'] ?? configObj.metrics_service_name;
  }

  const resolvedTrace = _resolveTraceEndpoint(configObj.otlp_traces_endpoint);

  _logFilePath = _resolveLogOutputPath(configObj.log_file_path, configObj.log_file_name);
  _logEncoding = configObj.log_file_encoding ?? 'utf-8';
  if (configObj.create_log_parent_dirs) {
    fs.mkdirSync(path.dirname(_logFilePath), { recursive: true });
  }

  _logger = _buildLogger();

  const traceJsonlAbs = effectiveTraceJsonlPath(
    configObj,
    _resolveTraceEndpoint,
    (lp) => _resolveLogOutputPath(lp, configObj.log_file_name),
  );

  const resourceAttrs = _buildTraceResourceAttributes(configObj);
  // Merge with defaultResource() so telemetry_sdk_* attributes (sdk name, language,
  // version) are automatically included alongside service-specific attributes.
  // Service-specific attrs take precedence over defaults (e.g. service.name overrides
  // defaultResource's "unknown_service:node").
  const resource = defaultResource().merge(
    resourceAttrs ? resourceFromAttributes(resourceAttrs) : resourceFromAttributes({}),
  );

  void _shutdownOurNodeSdk();
  if (_traceloopActive) {
    _maybeShutdownTraceloopProvider().catch(() => undefined);
    _traceloopActive = false;
  }

  if (configObj.enable_openllmetry) {
    if (
      configObj.prometheus_metrics_port != null ||
      _resolveMetricsEndpoint(configObj.metrics_otlp_endpoint)
    ) {
      process.env['TRACELOOP_METRICS_ENABLED'] =
        process.env['TRACELOOP_METRICS_ENABLED'] ?? 'false';
    }
    let traceloop: TraceloopSdkModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      traceloop = require('@traceloop/node-server-sdk') as TraceloopSdkModule;
    } catch {
      throw new Error(
        'enable_openllmetry requires @traceloop/node-server-sdk. Install: npm install @traceloop/node-server-sdk',
      );
    }
    const extras: SpanProcessor[] = [];
    if (configObj.enable_red_metrics) extras.push(new RedMetricsSpanProcessor());
    if (traceJsonlAbs) {
      if (configObj.create_log_parent_dirs) {
        fs.mkdirSync(path.dirname(traceJsonlAbs), { recursive: true });
      }
      extras.push(
        new FileJsonlSpanProcessor(
          traceJsonlAbs,
          configObj.trace_file_encoding,
          configObj.trace_jsonl_filter,
        ),
      );
    }
    let extraProcessor: SpanProcessor | null = null;
    if (extras.length === 1) extraProcessor = extras[0];
    else if (extras.length > 1) extraProcessor = new CompositeSpanProcessor(extras);

    const rawBase =
      resolvedTrace ??
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
    const tlBase = rawBase ? otlpCollectorBaseForTraceloop(rawBase) : undefined;
    const appName =
      configObj.metrics_service_name ??
      process.env['OTEL_SERVICE_NAME'] ??
      'agent-studio-log-runtime';

    traceloop.initialize({
      appName,
      baseUrl: tlBase,
      disableBatch: configObj.traceloop_disable_batch,
      processor: extraProcessor ?? undefined,
      silenceInitializationMessage: true,
    });
    _traceloopActive = true;
  } else if (configObj.ensure_tracer_provider) {
    const spanProcessors: SpanProcessor[] = [];
    if (configObj.enable_red_metrics) spanProcessors.push(new RedMetricsSpanProcessor());
    if (resolvedTrace) {
      const url = normalizeOtlpHttpTracesEndpoint(resolvedTrace);
      spanProcessors.push(
        new BatchSpanProcessor(new OTLPTraceExporter({ url }), {
          scheduledDelayMillis: 500,
          maxExportBatchSize: 512,
          maxQueueSize: 8192,
        }),
      );
    }
    if (traceJsonlAbs) {
      if (configObj.create_log_parent_dirs) {
        fs.mkdirSync(path.dirname(traceJsonlAbs), { recursive: true });
      }
      spanProcessors.push(
        new FileJsonlSpanProcessor(
          traceJsonlAbs,
          configObj.trace_file_encoding,
          configObj.trace_jsonl_filter,
        ),
      );
    }

    _sdk = new NodeSDK({
      resource,
      spanProcessors,
      instrumentations: configObj.enable_auto_instrumentation
        ? [getNodeAutoInstrumentations()]
        : [],
    });

    if (configObj.enable_auto_instrumentation) _autoInstrumentKnownLibraries();

    try {
      _sdk.start();
    } catch (error) {
      _logger.error('otel_start_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (configObj.ensure_tracer_provider) {
    // Stop the old PrometheusExporter server synchronously before creating a new one.
    // This releases the port immediately so the new exporter can bind without conflict.
    if (_promExporter) {
      try {
        _promExporter.stopServer().catch(() => {});
      } catch {
        /* ignore */
      }
      _promExporter = null;
    }
    if (_longLivedMeterProvider) {
      _longLivedMeterProvider.shutdown().catch(() => {});
    }
    if (_shortLivedMeterProvider) {
      _shortLivedMeterProvider.shutdown().catch(() => {});
    }
    _longLivedMeterProvider = null;
    _shortLivedMeterProvider = null;

    const otlpMetricsUrl = _resolveMetricsEndpoint(configObj.metrics_otlp_endpoint);

    if (configObj.prometheus_metrics_port != null && configObj.prometheus_metrics_port > 0) {
      try {
        const bindHost = _effectivePrometheusBindAddr(configObj.prometheus_metrics_host);
        const promExporter = new PrometheusExporter({
          port: configObj.prometheus_metrics_port,
          host: bindHost,
        });
        _promExporter = promExporter;
        _longLivedMeterProvider = new MeterProvider({ readers: [promExporter], resource });
        metrics.setGlobalMeterProvider(_longLivedMeterProvider);
      } catch (error) {
        _logger.warning('prometheus_metrics_start_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (otlpMetricsUrl) {
      try {
        const metricsUrl = normalizeOtlpHttpMetricsEndpoint(otlpMetricsUrl);
        const otlpReader = new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: metricsUrl }),
          exportIntervalMillis: configObj.metrics_export_interval_ms,
        });
        _shortLivedMeterProvider = new MeterProvider({ readers: [otlpReader], resource });
        if (!_longLivedMeterProvider) {
          metrics.setGlobalMeterProvider(_shortLivedMeterProvider);
        }
      } catch (error) {
        _logger.warning('otlp_metrics_start_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  _configured = true;

  // OTLP logs export: propagate endpoint to env var so OTel auto-instrumentation picks it up.
  // Full @opentelemetry/sdk-logs + @opentelemetry/exporter-logs-otlp-http bridge is wired once
  // those packages are added to package.json.
  const resolvedLogsEndpoint =
    configObj.otlp_logs_endpoint ||
    process.env['AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT'];
  if (resolvedLogsEndpoint) {
    const base = resolvedLogsEndpoint.replace(/\/$/, '');
    const logsUrl = base.endsWith('/v1/logs') ? base : `${base}/v1/logs`;
    if (!process.env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']) {
      process.env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] = logsUrl;
    }
  }

  return { log_file_path: _logFilePath, trace_file_path: traceJsonlAbs };
}

export function get_logger(): ObservabilityLogger {
  if (!_configured) {
    // Use ensure_tracer_provider:false so this fallback call only sets up file logging.
    // The real TracerProvider is registered by configure_observability_for_service() later.
    // Without this guard, module-level get_logger() calls (before configure_observability_for_service)
    // steal the global TracerProvider slot, causing the real SDK registration to be silently refused.
    configure_observability_logging({
      config: new ObservabilityLoggingConfig({ ensure_tracer_provider: false }),
    });
  }
  return _logger!;
}

const _LOG_EVENT_METHODS = new Set([
  'debug',
  'info',
  'warning',
  'error',
  'critical',
  'exception',
]);

export function log_event(
  level: string | { value: string },
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const log = get_logger();
  let levelRaw: string;
  if (level && typeof level === 'object' && 'value' in level) {
    levelRaw = level.value;
  } else {
    levelRaw = level as string;
  }
  const levelNorm = normalizeLevelName(levelRaw);
  if (!_LOG_EVENT_METHODS.has(levelNorm)) {
    throw new Error(
      `Invalid log level ${JSON.stringify(level)}; expected one of ${[..._LOG_EVENT_METHODS].sort().join(', ')}`,
    );
  }
  (log as unknown as Record<string, (e: string, f: Record<string, unknown>) => void>)[levelNorm](
    event,
    fields,
  );
}

export function configure_observability_minimal({
  log_file_path,
  log_level = 'info',
  otlp_traces_endpoint = null,
  otlp_logs_endpoint = null,
  trace_file_path = null,
  enable_auto_instrumentation = true,
  metrics_otlp_endpoint = null,
  metrics_export_interval_ms = 60000,
  metrics_service_name = null,
  prometheus_metrics_port = null,
  prometheus_metrics_host = null,
}: {
  log_file_path?: string | null;
  log_level?: string;
  otlp_traces_endpoint?: string | null;
  otlp_logs_endpoint?: string | null;
  trace_file_path?: string | null;
  enable_auto_instrumentation?: boolean;
  metrics_otlp_endpoint?: string | null;
  metrics_export_interval_ms?: number;
  metrics_service_name?: string | null;
  prometheus_metrics_port?: number | null;
  prometheus_metrics_host?: string | null;
} = {}): void {
  const merged: Record<string, unknown> = {
    ...observability_static_defaults(),
    ...observability_env_overrides(),
  };
  const updates: Record<string, unknown> = {
    format: 'json',
    ensure_tracer_provider: true,
    min_log_level: log_level,
    log_file_path,
    write_spans_to_jsonl_file: true,
    trace_jsonl_filter: 'openllmetry',
    trace_file_path,
    otlp_traces_endpoint,
    otlp_logs_endpoint,
    enable_auto_instrumentation,
    metrics_otlp_endpoint,
    metrics_export_interval_ms,
    metrics_service_name,
  };
  if (prometheus_metrics_port != null) updates['prometheus_metrics_port'] = prometheus_metrics_port;
  if (prometheus_metrics_host != null) updates['prometheus_metrics_host'] = prometheus_metrics_host;
  Object.assign(merged, updates);
  configure_observability_logging({ config: new ObservabilityLoggingConfig(merged) });
}

export async function shutdown_observability(): Promise<void> {
  await _shutdownOurNodeSdk();
  if (_traceloopActive) {
    await _maybeShutdownTraceloopProvider().catch(() => undefined);
    _traceloopActive = false;
  }
  if (_longLivedMeterProvider) {
    await _longLivedMeterProvider.shutdown();
    _longLivedMeterProvider = null;
  }
  if (_shortLivedMeterProvider) {
    await _shortLivedMeterProvider.shutdown();
    _shortLivedMeterProvider = null;
  }
  _promExporter = null;
  log4js.shutdown();
  _configured = false;
  _logger = null;
}

export function get_business_meter(name = 'domain', version = '1.0.0'): Meter {
  return getLongLivedMeter(name, version);
}

export function get_long_lived_meter(name = 'domain', version = '1.0.0'): Meter {
  return getLongLivedMeter(name, version);
}

export function get_short_lived_meter(name = 'domain.short', version = '1.0.0'): Meter {
  return getShortLivedMeter(name, version);
}

/**
 * One-call bootstrap for Node services.
 *
 * Sets AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME and OTEL_SERVICE_NAME
 * from `serviceName` (only if the env vars are not already set), then calls
 * configure_logging_from_packaged_default() to initialise the full observability
 * pipeline: log4js JSONL file logging, OTel tracing, Prometheus RED metrics.
 *
 * Equivalent to the Python configure_observability_minimal() pattern.
 *
 * Environment variables that tune the pipeline (all optional):
 *   AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH           — log file path
 *   AGENT_STUDIO_OBSERVABILITY_OTLP_TRACES_ENDPOINT    — OTLP collector endpoint
 *   AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT — Prometheus scrape port
 *   LOG_LEVEL                                          — min log level (default: info)
 */
export function configure_observability_for_service(serviceName: string): void {
  if (!process.env['AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME']) {
    process.env['AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME'] = serviceName;
  }
  if (!process.env['OTEL_SERVICE_NAME']) {
    process.env['OTEL_SERVICE_NAME'] = serviceName;
  }
  try {
    // Importing here to avoid circular dep between logger_handler and logging_config.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { configure_logging_from_packaged_default } = require('./logging_config') as {
      configure_logging_from_packaged_default: () => void;
    };
    configure_logging_from_packaged_default();
  } catch (err) {
    console.error('[observability] configure_observability_for_service failed:', err);
  }
}

export function with_otel_span<T>(
  name: string,
  fn: (span: ReturnType<ReturnType<typeof trace.getTracer>['startActiveSpan']> extends (
    n: string,
    o: object,
    f: (s: infer S) => T,
  ) => T
    ? S
    : never) => T,
  attributes: Record<string, string | number | boolean> = {},
): T {
  const tracer = trace.getTracer(_TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      return fn(span as Parameters<typeof fn>[0]);
    } finally {
      span.end();
    }
  });
}

// Re-export for convenience
export {
  LogLevel,
  LEVEL_RANK,
  VALID_MIN_LOG_LEVEL_KEYS,
  normalizeLevelName,
  observability_env_overrides,
  observability_static_defaults,
};
