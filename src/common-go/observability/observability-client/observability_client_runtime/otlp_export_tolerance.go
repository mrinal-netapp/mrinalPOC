package observability_client_runtime

import (
	"log/slog"
	"os"
	"strings"
)

// ApplyOTLPUnreachableExportSilencing reduces OTLP exporter noise when the collector is down.
// Set AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS=1 to skip.
func ApplyOTLPUnreachableExportSilencing() {
	raw := strings.TrimSpace(os.Getenv("AGENT_STUDIO_KEEP_OTLP_EXPORT_LOGS"))
	if raw != "" {
		lower := strings.ToLower(raw)
		if lower == "1" || lower == "true" || lower == "yes" || lower == "on" {
			return
		}
	}
	slog.SetLogLoggerLevel(slog.LevelError)
}
