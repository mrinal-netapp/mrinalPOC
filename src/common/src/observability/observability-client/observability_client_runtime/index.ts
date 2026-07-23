/**
 * @agentstudio/observability-client-runtime — main entry point.
 *
 * Re-exports the full public API so callers can require the package root:
 *   const { configure_observability_logging, get_logger, log_event } = require('@agentstudio/observability-client-runtime');
 */

export {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  APP_LOG_RECORD_TYPE,
  DEFAULT_CONFIG,
  DEFAULT_LOG_DIR,
  DEFAULT_LOG_FILENAME,
  LogLevel,
  ObservabilityLoggingConfig,
  TRACE_SPAN_RECORD_TYPE,
  configure_observability_for_service,
  configure_observability_logging,
  configure_observability_minimal,
  ensure_sdk_tracer_provider,
  get_business_meter,
  get_long_lived_meter,
  get_short_lived_meter,
  get_logger,
  log_event,
  observability_env_overrides,
  observability_static_defaults,
  shutdown_observability,
  with_otel_span,
} from './logger_handler';

export { express_request_logging_middleware } from './express_middleware';

export { runWithContext, getProjectId } from './context_store';

export {
  configure_logging_from_env,
  configure_logging_from_json_file,
  configure_logging_from_packaged_default,
  load_logging_config_dict,
  CONFIG_VERSION,
} from './logging_config';

export type {
  ObservabilityConfigOptions,
  ObservabilityDefaults,
  ObservabilityLogger,
  ConfigureResult,
} from './types';
