package observability_client_runtime

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/enums"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

const tracerNameHandler = "logging.logger_handler"

var (
	configMu       sync.RWMutex
	configured     bool
	currentCfg     ObservabilityLoggingConfig
	zapLogger      *zap.Logger
	minLevelRank   int
	hasMinLevel    bool
	tracerProvider *sdktrace.TracerProvider
	traceJSONLProc *fileJSONLSpanProcessor
	promServer     *http.Server
	shutdownOnce   sync.Once
)

// ConfigureObservabilityLogging wires Zap logging, OTLP traces, metrics, and optional span JSONL.
func ConfigureObservabilityLogging(cfg ObservabilityLoggingConfig) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	ApplyOTLPUnreachableExportSilencing()

	configMu.Lock()
	defer configMu.Unlock()

	if err := teardownLocked(context.Background()); err != nil {
		return err
	}

	currentCfg = cfg
	if cfg.MetricsServiceName != nil && *cfg.MetricsServiceName != "" {
		_ = os.Setenv("OTEL_SERVICE_NAME", envOrDefault("OTEL_SERVICE_NAME", *cfg.MetricsServiceName))
	}

	logPath := resolveLogOutputPath(cfg.LogFilePath)
	if cfg.CreateLogParentDirs {
		if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
			return fmt.Errorf("create log parent dirs: %w", err)
		}
	}

	if err := setupZap(cfg, logPath); err != nil {
		return err
	}

	if err := setupTracing(cfg); err != nil {
		return err
	}

	if err := ConfigureMeterProviders(cfg); err != nil {
		return err
	}

	setupLogExport(cfg)

	configured = true
	registerProcessShutdown()
	return nil
}

// setupLogExport propagates the configured OTLP logs endpoint to the standard OTel env var so that
// any auto-instrumentation or SDK components that read OTEL_EXPORTER_OTLP_LOGS_ENDPOINT pick it up.
// Full otelzap→OTelLoggerProvider bridge (go.opentelemetry.io/contrib/bridges/otelzap +
// go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp) is wired once those deps are added
// to go.mod and go.sum via `go get`.
func setupLogExport(cfg ObservabilityLoggingConfig) {
	logsEndpoint := ""
	if cfg.OTLPLogsEndpoint != nil && *cfg.OTLPLogsEndpoint != "" {
		logsEndpoint = *cfg.OTLPLogsEndpoint
	} else if v := os.Getenv("AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT"); v != "" {
		logsEndpoint = v
	}
	if logsEndpoint == "" {
		return
	}
	base := strings.TrimRight(logsEndpoint, "/")
	if !strings.HasSuffix(base, "/v1/logs") {
		base += "/v1/logs"
	}
	// Propagate to the standard OTel env var so downstream SDK/auto-instrumentation reads it.
	if os.Getenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") == "" {
		_ = os.Setenv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", base)
	}
	if zapLogger != nil {
		zapLogger.Info("otlp_log_export_configured", zap.String("endpoint", base))
	}
}

func setupZap(cfg ObservabilityLoggingConfig, logPath string) error {
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}

	encCfg := zap.NewProductionEncoderConfig()
	encCfg.TimeKey = "timestamp"
	encCfg.EncodeTime = zapcore.ISO8601TimeEncoder
	encCfg.MessageKey = "event"
	encCfg.LevelKey = "level"

	var enc zapcore.Encoder
	if cfg.Format == "console" {
		enc = zapcore.NewConsoleEncoder(encCfg)
	} else {
		enc = zapcore.NewJSONEncoder(encCfg)
	}

	ws := zapcore.AddSync(file)
	core := zapcore.NewCore(enc, ws, zapcore.DebugLevel)
	zapLogger = zap.New(core)

	hasMinLevel = false
	if cfg.MinLogLevel != nil && stringsTrim(*cfg.MinLogLevel) != "" {
		norm := enums.NormalizeLevelName(*cfg.MinLogLevel)
		if rank, ok := enums.LevelRank[norm]; ok {
			minLevelRank = rank
			hasMinLevel = true
		}
	}
	return nil
}

func setupTracing(cfg ObservabilityLoggingConfig) error {
	if cfg.EnsureTracerProvider || traceExportNeeded(cfg) {
		if err := EnsureSDKTracerProvider(cfg); err != nil {
			return err
		}
	}

	tp := getSDKTracerProvider()
	if tp == nil {
		return nil
	}

	traceEndpoint := resolveTraceEndpoint(cfg.OTLPTracesEndpoint)
	if traceEndpoint != "" {
		exporter, err := otlptracehttp.New(
			context.Background(),
			otlptracehttp.WithEndpointURL(NormalizeOTLPHttpTracesEndpoint(traceEndpoint)),
		)
		if err != nil {
			zapLogger.Warn("otlp_trace_exporter_failed", zap.Error(err))
		} else {
			tp.RegisterSpanProcessor(sdktrace.NewBatchSpanProcessor(exporter,
				sdktrace.WithBatchTimeout(500*time.Millisecond),
				sdktrace.WithMaxExportBatchSize(128),
			))
		}
	}

	if cfg.EnableRedMetrics {
		attachREDMetricsProcessor(tp)
	}

	tracePath := effectiveTraceJSONLPath(cfg)
	if tracePath != "" {
		if cfg.CreateLogParentDirs {
			_ = os.MkdirAll(filepath.Dir(tracePath), 0o755)
		}
		proc, err := newFileJSONLSpanProcessor(tracePath, cfg.TraceFileEncoding, cfg.TraceJSONLFilter)
		if err != nil {
			zapLogger.Warn("trace_jsonl_open_failed", zap.Error(err))
		} else {
			traceJSONLProc = proc
			tp.RegisterSpanProcessor(proc)
		}
	}

	tracerProvider = tp
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))
	return nil
}

func traceExportNeeded(cfg ObservabilityLoggingConfig) bool {
	return resolveTraceEndpoint(cfg.OTLPTracesEndpoint) != "" || effectiveTraceJSONLPath(cfg) != ""
}

// EnsureSDKTracerProvider installs an SDK TracerProvider when the global provider is not SDK-backed.
func EnsureSDKTracerProvider(cfg ObservabilityLoggingConfig) error {
	if tp := getSDKTracerProvider(); tp != nil {
		return nil
	}
	var res *resource.Resource
	if cfg.MetricsServiceName != nil && *cfg.MetricsServiceName != "" {
		res, _ = resource.Merge(
			resource.Default(),
			resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(*cfg.MetricsServiceName)),
		)
	} else {
		res = resource.Default()
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res))
	tracerProvider = tp
	otel.SetTracerProvider(tp)
	return nil
}

func getSDKTracerProvider() *sdktrace.TracerProvider {
	if tracerProvider != nil {
		return tracerProvider
	}
	if tp, ok := otel.GetTracerProvider().(*sdktrace.TracerProvider); ok {
		return tp
	}
	return nil
}

// GetLogger returns the configured Zap logger. Auto-configures with defaults if not yet configured.
func GetLogger() *zap.Logger {
	configMu.RLock()
	ok := configured && zapLogger != nil
	configMu.RUnlock()
	if !ok {
		cfg := ObservabilityStaticDefaults()
		_ = ApplyEnvDefaults(&cfg)
		_ = ConfigureObservabilityLogging(cfg)
	}
	configMu.RLock()
	defer configMu.RUnlock()
	return zapLogger
}

// LogEvent ingests one log at an explicit level. Pass request/worker context for trace correlation.
func LogEvent(ctx context.Context, level enums.LogLevel, message string, fields ...zap.Field) error {
	return logEvent(ctx, string(level), message, fields...)
}

// sanitizeFields returns a copy of fields with all string-typed values sanitized
// to prevent log-injection via embedded newlines in user-provided field values.
func sanitizeFields(fields []zap.Field) []zap.Field {
	out := make([]zap.Field, len(fields))
	for i, f := range fields {
		if f.Type == zapcore.StringType {
			out[i] = zap.String(f.Key, sanitizeLogString(f.String))
		} else {
			out[i] = f
		}
	}
	return out
}

func logEvent(ctx context.Context, levelRaw, message string, fields ...zap.Field) error {
	norm := enums.NormalizeLevelName(levelRaw)
	if _, ok := enums.LogEventMethods[norm]; !ok {
		return fmt.Errorf("invalid log level %q", levelRaw)
	}
	if hasMinLevel {
		if rank, ok := enums.LevelRank[norm]; ok && rank < minLevelRank {
			return nil
		}
	}
	all := append(otelLogFields(ctx), zap.String("record_type", AppLogRecordType))
	if projectID := ProjectIDFromContext(ctx); projectID != "" {
		all = append(all, zap.String("project_id", projectID))
	}
	all = append(all, sanitizeFields(fields)...)
	log := GetLogger()
	safe := sanitizeLogString(message)
	switch norm {
	case string(enums.LogLevelDebug):
		log.Debug(safe, all...)
	case string(enums.LogLevelInfo):
		log.Info(safe, all...)
	case string(enums.LogLevelWarning):
		log.Warn(safe, all...)
	case string(enums.LogLevelError), string(enums.LogLevelException):
		log.Error(safe, all...)
	case string(enums.LogLevelCritical):
		log.Fatal(safe, all...)
	}
	return nil
}

func otelLogFields(ctx context.Context) []zap.Field {
	span := trace.SpanFromContext(ctx)
	sc := span.SpanContext()
	if !sc.IsValid() {
		return nil
	}
	return []zap.Field{
		zap.String("trace_id", sc.TraceID().String()),
		zap.String("span_id", sc.SpanID().String()),
	}
}

// WithOtelSpan runs fn inside a new span so logs in fn receive trace_id / span_id.
func WithOtelSpan(ctx context.Context, name string, fn func(context.Context) error, opts ...trace.SpanStartOption) error {
	if name == "" {
		name = "request"
	}
	tracer := otel.Tracer(tracerNameHandler)
	ctx, span := tracer.Start(ctx, name, opts...)
	defer span.End()
	return fn(ctx)
}

// ConfigureObservabilityMinimal is a one-call setup with explicit paths and endpoints.
func ConfigureObservabilityMinimal(opts MinimalConfig) error {
	merged := ObservabilityStaticDefaults()
	if err := ApplyEnvDefaults(&merged); err != nil {
		return err
	}
	if opts.LogFilePath != "" {
		merged.LogFilePath = opts.LogFilePath
	}
	if opts.LogLevel != "" {
		lvl := enums.NormalizeLevelName(opts.LogLevel)
		merged.MinLogLevel = &lvl
	}
	if opts.OTLPTracesEndpoint != nil {
		merged.OTLPTracesEndpoint = opts.OTLPTracesEndpoint
	}
	if opts.TraceFilePath != nil {
		merged.TraceFilePath = opts.TraceFilePath
	}
	merged.EnableAutoInstrumentation = opts.EnableAutoInstrumentation
	if opts.MetricsOTLPEndpoint != nil {
		merged.MetricsOTLPEndpoint = opts.MetricsOTLPEndpoint
	}
	if opts.MetricsExportIntervalMs > 0 {
		merged.MetricsExportIntervalMs = opts.MetricsExportIntervalMs
	}
	if opts.MetricsServiceName != nil {
		merged.MetricsServiceName = opts.MetricsServiceName
	}
	if opts.PrometheusMetricsPort != nil {
		merged.PrometheusMetricsPort = opts.PrometheusMetricsPort
	}
	if opts.PrometheusMetricsHost != nil {
		merged.PrometheusMetricsHost = *opts.PrometheusMetricsHost
	}
	return ConfigureObservabilityLogging(merged)
}

// MinimalConfig holds parameters for ConfigureObservabilityMinimal.
type MinimalConfig struct {
	LogFilePath               string
	LogLevel                  string
	OTLPTracesEndpoint        *string
	TraceFilePath             *string
	EnableAutoInstrumentation bool
	MetricsOTLPEndpoint       *string
	MetricsExportIntervalMs   int
	MetricsServiceName        *string
	PrometheusMetricsPort     *int
	PrometheusMetricsHost     *string
}

// ShutdownObservability flushes and shuts down exporters.
func ShutdownObservability(ctx context.Context) error {
	configMu.Lock()
	defer configMu.Unlock()
	return teardownLocked(ctx)
}

func teardownLocked(ctx context.Context) error {
	if promServer != nil {
		_ = promServer.Shutdown(ctx)
		promServer = nil
	}
	if traceJSONLProc != nil {
		_ = traceJSONLProc.Shutdown(ctx)
		traceJSONLProc = nil
	}
	if tracerProvider != nil {
		_ = tracerProvider.Shutdown(ctx)
		tracerProvider = nil
	}
	shutdownMeterProvidersLocked(ctx)
	if zapLogger != nil {
		_ = zapLogger.Sync()
		zapLogger = nil
	}
	configured = false
	return nil
}

func resolveTraceEndpoint(cfgEndpoint *string) string {
	if cfgEndpoint != nil && stringsTrim(*cfgEndpoint) != "" {
		return *cfgEndpoint
	}
	if v := os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"); v != "" {
		return v
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
}

func resolveMetricsEndpoint(cfgEndpoint *string) string {
	if cfgEndpoint != nil && stringsTrim(*cfgEndpoint) != "" {
		return *cfgEndpoint
	}
	if v := os.Getenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"); v != "" {
		return v
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func stringsTrim(s string) string {
	return strings.TrimSpace(s)
}

func registerProcessShutdown() {
	shutdownOnce.Do(func() {
		// Best-effort flush on exit; services should call ShutdownObservability explicitly.
	})
}
