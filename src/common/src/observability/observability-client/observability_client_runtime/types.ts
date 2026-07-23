/**
 * Shared TypeScript interfaces for the observability client runtime.
 */

/** Full configuration object accepted by ObservabilityLoggingConfig. */
export interface ObservabilityConfigOptions {
  format?: string;
  ensure_tracer_provider?: boolean;
  enable_auto_instrumentation?: boolean;
  enable_auto_span_logging?: boolean;
  auto_span_log_level?: string | null;
  enable_red_metrics?: boolean;
  enable_openllmetry?: boolean;
  traceloop_disable_batch?: boolean;
  otlp_traces_endpoint?: string | null;
  otlp_logs_endpoint?: string | null;
  metrics_otlp_endpoint?: string | null;
  metrics_export_interval_ms?: number;
  metrics_service_name?: string | null;
  prometheus_metrics_port?: number | null;
  prometheus_metrics_host?: string;
  min_log_level?: string | null;
  log_file_path?: string | null;
  log_file_name?: string;
  log_file_encoding?: string;
  create_log_parent_dirs?: boolean;
  write_spans_to_jsonl_file?: boolean;
  trace_jsonl_filter?: string;
  trace_file_path?: string | null;
  trace_file_encoding?: string;
  service_name?: string | null;
  service_version?: string | null;
  environment?: string | null;
}

/** Resolved (fully-populated) observability defaults dict. */
export interface ObservabilityDefaults {
  [key: string]: unknown;
  format: string;
  ensure_tracer_provider: boolean;
  enable_auto_instrumentation: boolean;
  enable_auto_span_logging: boolean;
  auto_span_log_level: string;
  enable_red_metrics: boolean;
  enable_openllmetry: boolean;
  traceloop_disable_batch: boolean;
  otlp_traces_endpoint: string | null;
  otlp_logs_endpoint: string | null;
  metrics_otlp_endpoint: string | null;
  metrics_export_interval_ms: number;
  metrics_service_name: string | null;
  prometheus_metrics_port: number | null;
  prometheus_metrics_host: string;
  min_log_level: string | null;
  log_file_path: string | null;
  log_file_name: string;
  log_file_encoding: string;
  create_log_parent_dirs: boolean;
  write_spans_to_jsonl_file: boolean;
  trace_jsonl_filter: string;
  trace_file_path: string | null;
  trace_file_encoding: string;
  service_name?: string | null;
  service_version?: string | null;
  environment?: string | null;
}

/** Public logger object returned by get_logger(). */
export interface ObservabilityLogger {
  [method: string]: (event: string, fields?: unknown) => void;
  trace(event: string, fields?: unknown): void;
  debug(event: string, fields?: unknown): void;
  info(event: string, fields?: unknown): void;
  warning(event: string, fields?: unknown): void;
  warn(event: string, fields?: unknown): void;
  error(event: string, fields?: unknown): void;
  critical(event: string, fields?: unknown): void;
  exception(event: string, fields?: unknown): void;
}

/** Return value of configure_observability_logging(). */
export interface ConfigureResult {
  log_file_path: string;
  trace_file_path: string | null;
}

/** Minimal interface for the Traceloop SDK, which is an optional dependency. */
export interface TraceloopSdkModule {
  initialize: (options: {
    appName: string;
    baseUrl?: string;
    disableBatch?: boolean;
    processor?: unknown;
    silenceInitializationMessage?: boolean;
  }) => void;
  forceFlush?: () => Promise<void>;
}
