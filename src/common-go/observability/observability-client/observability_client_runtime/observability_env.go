package observability_client_runtime

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// ObservabilityEnvPrefix is the prefix for AGENT_STUDIO_OBSERVABILITY_* variables.
const ObservabilityEnvPrefix = "AGENT_STUDIO_OBSERVABILITY_"

const (
	defaultLogDir          = "App_Logs"
	defaultLogFilename     = "app.jsonl"
	defaultTraceDir        = "Trace_Logs"
	defaultTraceFilename   = "trace.jsonl"
	defaultMetricsExportMS = 60000
)

var envBoolTrue = map[string]struct{}{
	"1": {}, "true": {}, "yes": {}, "on": {},
}

var envBoolFalse = map[string]struct{}{
	"0": {}, "false": {}, "no": {}, "off": {},
}

// ObservabilityStaticDefaults returns built-in defaults without reading the environment.
func ObservabilityStaticDefaults() ObservabilityLoggingConfig {
	return ObservabilityLoggingConfig{
		Format:                    "json",
		EnsureTracerProvider:      true,
		EnableAutoInstrumentation: true,
		EnableAutoSpanLogging:     false,
		AutoSpanLogLevel:          "info",
		EnableRedMetrics:          true,
		EnableOpenllmetry:         false,
		TraceloopDisableBatch:     false,
		MetricsExportIntervalMs:   defaultMetricsExportMS,
		PrometheusMetricsHost:     "0.0.0.0",
		LogFilePath:               defaultLogDir,
		LogFileEncoding:           "utf-8",
		CreateLogParentDirs:       true,
		WriteSpansToJSONLFile:     true,
		TraceJSONLFilter:          "openllmetry",
		TraceFileEncoding:         "utf-8",
	}
}

// ObservabilityEnvOverrides parses AGENT_STUDIO_OBSERVABILITY_* for keys present in the environment.
func ObservabilityEnvOverrides() (map[string]any, error) {
	out := make(map[string]any)
	static := ObservabilityStaticDefaults()
	fields := observabilityFieldNames()
	for _, name := range fields {
		envKey := ObservabilityEnvPrefix + strings.ToUpper(snakeToEnv(name))
		raw, ok := os.LookupEnv(envKey)
		if !ok {
			continue
		}
		val, err := parseObservabilityEnvValue(name, raw, staticFieldValue(static, name))
		if err != nil {
			return nil, err
		}
		out[name] = val
	}
	return out, nil
}

func observabilityFieldNames() []string {
	return []string{
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
		"metrics_export_interval_ms",
		"metrics_service_name",
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
	}
}

func snakeToEnv(snake string) string {
	return strings.ReplaceAll(snake, "_", "_")
}

func staticFieldValue(cfg ObservabilityLoggingConfig, name string) any {
	switch name {
	case "format":
		return cfg.Format
	case "ensure_tracer_provider":
		return cfg.EnsureTracerProvider
	case "enable_auto_instrumentation":
		return cfg.EnableAutoInstrumentation
	case "enable_auto_span_logging":
		return cfg.EnableAutoSpanLogging
	case "auto_span_log_level":
		return cfg.AutoSpanLogLevel
	case "enable_red_metrics":
		return cfg.EnableRedMetrics
	case "enable_openllmetry":
		return cfg.EnableOpenllmetry
	case "traceloop_disable_batch":
		return cfg.TraceloopDisableBatch
	case "otlp_traces_endpoint":
		return cfg.OTLPTracesEndpoint
	case "metrics_otlp_endpoint":
		return cfg.MetricsOTLPEndpoint
	case "metrics_export_interval_ms":
		return cfg.MetricsExportIntervalMs
	case "metrics_service_name":
		return cfg.MetricsServiceName
	case "prometheus_metrics_port":
		return cfg.PrometheusMetricsPort
	case "prometheus_metrics_host":
		return cfg.PrometheusMetricsHost
	case "min_log_level":
		return cfg.MinLogLevel
	case "log_file_path":
		return cfg.LogFilePath
	case "log_file_encoding":
		return cfg.LogFileEncoding
	case "create_log_parent_dirs":
		return cfg.CreateLogParentDirs
	case "write_spans_to_jsonl_file":
		return cfg.WriteSpansToJSONLFile
	case "trace_jsonl_filter":
		return cfg.TraceJSONLFilter
	case "trace_file_path":
		return cfg.TraceFilePath
	case "trace_file_encoding":
		return cfg.TraceFileEncoding
	default:
		return nil
	}
}

func parseObservabilityEnvValue(name, raw string, static any) (any, error) {
	stripped := strings.TrimSpace(raw)
	if stripped == "" {
		return static, nil
	}
	boolFields := map[string]struct{}{
		"ensure_tracer_provider":      {},
		"enable_auto_instrumentation": {},
		"enable_auto_span_logging":    {},
		"enable_red_metrics":          {},
		"enable_openllmetry":          {},
		"traceloop_disable_batch":     {},
		"create_log_parent_dirs":      {},
		"write_spans_to_jsonl_file":   {},
	}
	if _, ok := boolFields[name]; ok {
		return parseEnvBool(stripped, name)
	}
	switch name {
	case "metrics_export_interval_ms":
		v, err := strconv.Atoi(stripped)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("%sMETRICS_EXPORT_INTERVAL_MS must be > 0, got %q", ObservabilityEnvPrefix, raw)
		}
		return v, nil
	case "prometheus_metrics_port":
		if isNullToken(stripped) {
			return nil, nil
		}
		p, err := strconv.Atoi(stripped)
		if err != nil || p <= 0 {
			return nil, fmt.Errorf("%sPROMETHEUS_METRICS_PORT must be > 0 when set, got %q", ObservabilityEnvPrefix, raw)
		}
		return p, nil
	case "min_log_level", "auto_span_log_level":
		if isNullToken(stripped) {
			return nil, nil
		}
		return stripped, nil
	case "otlp_traces_endpoint", "metrics_otlp_endpoint", "metrics_service_name", "log_file_path", "trace_file_path":
		if isNullToken(stripped) {
			return nil, nil
		}
		return stripped, nil
	default:
		return stripped, nil
	}
}

func parseEnvBool(raw, fieldName string) (bool, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if _, ok := envBoolTrue[s]; ok {
		return true, nil
	}
	if _, ok := envBoolFalse[s]; ok {
		return false, nil
	}
	return false, fmt.Errorf("%s%s: expected boolean (true/false/1/0/yes/no/on/off), got %q",
		ObservabilityEnvPrefix, strings.ToUpper(strings.ReplaceAll(fieldName, "_", "_")), raw)
}

func isNullToken(s string) bool {
	switch strings.ToLower(s) {
	case "none", "null", "":
		return true
	default:
		return false
	}
}

// ApplyEnvDefaults mutates cfg with AGENT_STUDIO_OBSERVABILITY_* overrides.
func ApplyEnvDefaults(cfg *ObservabilityLoggingConfig) error {
	overrides, err := ObservabilityEnvOverrides()
	if err != nil {
		return err
	}
	return mergeConfigMap(cfg, overrides)
}
