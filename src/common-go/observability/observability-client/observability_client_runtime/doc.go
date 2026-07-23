// Package observability_client_runtime provides the Go observability client library for AgentStudio services.
//
// It wraps Uber Zap for structured application logs, OpenTelemetry for traces and metrics,
// and mirrors the Python structlog runtime API (configure_observability_logging, get_logger,
// log_event, with_otel_span, HTTP middleware, JSON config, AGENT_STUDIO_OBSERVABILITY_* env vars).
//
// OpenLLMetry (Traceloop) is not supported in Go; enable_openllmetry must remain false.
package observability_client_runtime
