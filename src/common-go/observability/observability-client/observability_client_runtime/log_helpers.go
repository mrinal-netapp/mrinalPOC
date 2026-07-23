package observability_client_runtime

import (
	"context"
	"os"

	"github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/enums"
)

// ConfigureLoggingForService sets the AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME
// and OTEL_SERVICE_NAME environment variables (if not already set) then
// initialises the full observability stack via the packaged default config.
// Services that are not guaranteed to have these env vars pre-populated by
// their deployment manifests should call this instead of
// ConfigureLoggingFromPackagedDefault.
func ConfigureLoggingForService(serviceName string) error {
	if os.Getenv("AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME") == "" {
		_ = os.Setenv("AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME", serviceName)
	}
	if os.Getenv("OTEL_SERVICE_NAME") == "" {
		_ = os.Setenv("OTEL_SERVICE_NAME", serviceName)
	}
	return ConfigureLoggingFromPackagedDefault()
}

// LogDebug emits a debug-level structured log entry via the Zap logger.
func LogDebug(ctx context.Context, msg string, fields ...LogField) {
	LogEvent(ctx, enums.LogLevelDebug, msg, fields...)
}

// LogInfo emits an info-level structured log entry via the Zap logger.
func LogInfo(ctx context.Context, msg string, fields ...LogField) {
	LogEvent(ctx, enums.LogLevelInfo, msg, fields...)
}

// LogWarn emits a warning-level structured log entry via the Zap logger.
func LogWarn(ctx context.Context, msg string, fields ...LogField) {
	LogEvent(ctx, enums.LogLevelWarning, msg, fields...)
}

// LogError emits an error-level structured log entry via the Zap logger.
func LogError(ctx context.Context, msg string, fields ...LogField) {
	LogEvent(ctx, enums.LogLevelError, msg, fields...)
}

// LogFatal emits a critical-level log entry and terminates the process via
// zap.Logger.Fatal (flushes buffers then calls os.Exit(1)). Use only for
// unrecoverable startup failures.
func LogFatal(ctx context.Context, msg string, fields ...LogField) {
	LogEvent(ctx, enums.LogLevelCritical, msg, fields...)
}
