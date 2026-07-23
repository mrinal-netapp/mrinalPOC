/**
 * Observability public API for @agentstudio/common.
 *
 * All exports come from @agentstudio/observability-client-runtime — this file
 * is a pure pass-through so services that depend on @agentstudio/common continue
 * to import observability utilities from a single stable location.
 *
 * Services may also import directly from @agentstudio/observability-client-runtime
 * if they declare it as an explicit dependency in their own package.json.
 */
export {
  configure_observability_for_service,
  configure_observability_logging,
  configure_observability_minimal,
  configure_logging_from_env,
  configure_logging_from_packaged_default,
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
  express_request_logging_middleware,
} from '@agentstudio/observability-client-runtime';

export type { ObservabilityLogger, ConfigureResult } from '@agentstudio/observability-client-runtime';

/**
 * Backward-compatible alias — existing service code that imports
 * `requestLoggingMiddleware` from @agentstudio/common continues to work.
 */
export { express_request_logging_middleware as requestLoggingMiddleware } from '@agentstudio/observability-client-runtime';

/**
 * Backward-compatible no-op — existing code that calls initLogger(name) still
 * compiles; behaviour is now provided by configure_observability_for_service(name).
 *
 * @deprecated Use configure_observability_for_service() instead.
 */
export { configure_observability_for_service as initLogger } from '@agentstudio/observability-client-runtime';

/**
 * Backward-compatible no-op — initTracing was already a no-op; the alias
 * keeps call sites compiling without any behaviour change.
 *
 * @deprecated Tracing is initialised automatically by configure_observability_for_service.
 */
export function initTracing(_serviceName: string): void {
  // No-op: handled by configure_observability_for_service / client lib.
}
