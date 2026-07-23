package observability_client_runtime

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/enums"
)

const (
	AppLogRecordType    = "app_log"
	TraceSpanRecordType = "trace_span"
)

// ObservabilityLoggingConfig is the only supported configuration shape for ConfigureObservabilityLogging.
type ObservabilityLoggingConfig struct {
	Format                    string
	EnsureTracerProvider      bool
	EnableAutoInstrumentation bool
	EnableAutoSpanLogging     bool
	AutoSpanLogLevel          string
	EnableRedMetrics          bool
	EnableOpenllmetry         bool
	TraceloopDisableBatch     bool
	OTLPTracesEndpoint        *string
	OTLPLogsEndpoint          *string
	MetricsOTLPEndpoint       *string
	MetricsExportIntervalMs   int
	MetricsServiceName        *string
	PrometheusMetricsPort     *int
	PrometheusMetricsHost     string
	MinLogLevel               *string
	LogFilePath               string
	LogFileEncoding           string
	CreateLogParentDirs       bool
	WriteSpansToJSONLFile     bool
	TraceJSONLFilter          string
	TraceFilePath             *string
	TraceFileEncoding         string
}

// Validate checks configuration fields.
func (c *ObservabilityLoggingConfig) Validate() error {
	if c.Format != "json" && c.Format != "console" {
		return fmt.Errorf("format must be json or console, got %q", c.Format)
	}
	if c.MinLogLevel != nil {
		if err := enums.ValidateMinLogLevel(*c.MinLogLevel); err != nil {
			return err
		}
	}
	if c.MetricsExportIntervalMs <= 0 {
		return fmt.Errorf("metrics_export_interval_ms must be > 0")
	}
	if c.PrometheusMetricsPort != nil && *c.PrometheusMetricsPort <= 0 {
		return fmt.Errorf("prometheus_metrics_port must be > 0 when set")
	}
	switch c.TraceJSONLFilter {
	case "all", "openllmetry":
	default:
		return fmt.Errorf("trace_jsonl_filter must be all or openllmetry, got %q", c.TraceJSONLFilter)
	}
	if c.EnableOpenllmetry {
		return fmt.Errorf("enable_openllmetry is not supported in the Go runtime; use Python or Node OpenLLMetry integration")
	}
	return nil
}

func mergeConfigMap(cfg *ObservabilityLoggingConfig, m map[string]any) error {
	for k, v := range m {
		switch k {
		case "format":
			cfg.Format = asString(v)
		case "ensure_tracer_provider":
			cfg.EnsureTracerProvider = asBool(v)
		case "enable_auto_instrumentation":
			cfg.EnableAutoInstrumentation = asBool(v)
		case "enable_auto_span_logging":
			cfg.EnableAutoSpanLogging = asBool(v)
		case "auto_span_log_level":
			cfg.AutoSpanLogLevel = asString(v)
		case "enable_red_metrics":
			cfg.EnableRedMetrics = asBool(v)
		case "enable_openllmetry":
			cfg.EnableOpenllmetry = asBool(v)
		case "traceloop_disable_batch":
			cfg.TraceloopDisableBatch = asBool(v)
		case "otlp_traces_endpoint":
			cfg.OTLPTracesEndpoint = asStringPtr(v)
		case "otlp_logs_endpoint":
			cfg.OTLPLogsEndpoint = asStringPtr(v)
		case "metrics_otlp_endpoint":
			cfg.MetricsOTLPEndpoint = asStringPtr(v)
		case "metrics_export_interval_ms":
			cfg.MetricsExportIntervalMs = asInt(v)
		case "metrics_service_name":
			cfg.MetricsServiceName = asStringPtr(v)
		case "prometheus_metrics_port":
			cfg.PrometheusMetricsPort = asIntPtr(v)
		case "prometheus_metrics_host":
			cfg.PrometheusMetricsHost = asString(v)
		case "min_log_level":
			cfg.MinLogLevel = asStringPtr(v)
		case "log_file_path":
			cfg.LogFilePath = asString(v)
		case "log_file_encoding":
			cfg.LogFileEncoding = asString(v)
		case "create_log_parent_dirs":
			cfg.CreateLogParentDirs = asBool(v)
		case "write_spans_to_jsonl_file":
			cfg.WriteSpansToJSONLFile = asBool(v)
		case "trace_jsonl_filter":
			cfg.TraceJSONLFilter = asString(v)
		case "trace_file_path":
			cfg.TraceFilePath = asStringPtr(v)
		case "trace_file_encoding":
			cfg.TraceFileEncoding = asString(v)
		default:
			return fmt.Errorf("unknown config key %q", k)
		}
	}
	return nil
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "true" || s == "1" || s == "yes" || s == "on"
	default:
		return false
	}
}

func asInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	default:
		return 0
	}
}

func asIntPtr(v any) *int {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok && isNullToken(s) {
		return nil
	}
	n := asInt(v)
	return &n
}

func asStringPtr(v any) *string {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		if isNullToken(s) {
			return nil
		}
		out := s
		return &out
	}
	out := fmt.Sprint(v)
	return &out
}
