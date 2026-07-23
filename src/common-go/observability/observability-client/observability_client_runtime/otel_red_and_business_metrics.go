package observability_client_runtime

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

// HTTP semantic attribute keys (aligned with Python).
const (
	AttrHTTPRequestMethod        = "http.request.method"
	AttrURLPath                  = "url.path"
	AttrHTTPRoute                = "http.route"
	AttrHTTPResponseStatusCode   = "http.response.status_code"
)

const (
	meterNameRED    = "agent_studio.observability.red"
	meterVersionRED = "1.0.0"
)

var loopbackPromBind = map[string]struct{}{
	"localhost": {}, "127.0.0.1": {}, "::1": {},
}

var (
	longLivedMeterProvider  *sdkmetric.MeterProvider
	shortLivedMeterProvider *sdkmetric.MeterProvider
	meterMu                 sync.RWMutex

	redOnce       sync.Once
	redRequest    metric.Int64Counter
	redErrors     metric.Int64Counter
	redDurationMs metric.Float64Histogram
)

func effectivePrometheusBindAddr(host string) string {
	stripped := strings.TrimSpace(host)
	if stripped == "" {
		return "0.0.0.0"
	}
	if _, ok := loopbackPromBind[strings.ToLower(stripped)]; ok {
		log.Printf("prometheus_metrics_host=%q is loopback; using 0.0.0.0 for remote scrape access", stripped)
		return "0.0.0.0"
	}
	return stripped
}

// GetLongLivedMeter returns the meter for RED and stable business metrics (Prometheus when configured).
func GetLongLivedMeter(name string, version string) metric.Meter {
	if version == "" {
		version = meterVersionRED
	}
	meterMu.RLock()
	defer meterMu.RUnlock()
	if longLivedMeterProvider != nil {
		return longLivedMeterProvider.Meter(name, metric.WithInstrumentationVersion(version))
	}
	if shortLivedMeterProvider != nil {
		return shortLivedMeterProvider.Meter(name, metric.WithInstrumentationVersion(version))
	}
	return otel.Meter(name, metric.WithInstrumentationVersion(version))
}

// GetShortLivedMeter returns the OTLP-push meter for high-churn series.
func GetShortLivedMeter(name string, version string) (metric.Meter, error) {
	if version == "" {
		version = meterVersionRED
	}
	meterMu.RLock()
	defer meterMu.RUnlock()
	if shortLivedMeterProvider != nil {
		return shortLivedMeterProvider.Meter(name, metric.WithInstrumentationVersion(version)), nil
	}
	if longLivedMeterProvider != nil {
		return nil, fmt.Errorf("short-lived OTLP metrics are not configured: set metrics_otlp_endpoint while using prometheus_metrics_port, or use OTLP-only mode")
	}
	return otel.Meter(name, metric.WithInstrumentationVersion(version)), nil
}

// GetBusinessMeter is an alias for GetLongLivedMeter.
func GetBusinessMeter(name string, version string) metric.Meter {
	return GetLongLivedMeter(name, version)
}

// FlushMeterProviders forces export of pending metric data.
func FlushMeterProviders(ctx context.Context) error {
	meterMu.RLock()
	defer meterMu.RUnlock()
	var err error
	if longLivedMeterProvider != nil {
		if e := longLivedMeterProvider.ForceFlush(ctx); e != nil {
			err = e
		}
	}
	if shortLivedMeterProvider != nil {
		if e := shortLivedMeterProvider.ForceFlush(ctx); e != nil {
			err = e
		}
	}
	return err
}

// ConfigureMeterProviders sets up Prometheus and/or OTLP metric export.
func ConfigureMeterProviders(cfg ObservabilityLoggingConfig) error {
	meterMu.Lock()
	defer meterMu.Unlock()

	shutdownMeterProvidersLocked(context.Background())

	ApplyOTLPUnreachableExportSilencing()

	var res *resource.Resource
	if cfg.MetricsServiceName != nil && *cfg.MetricsServiceName != "" {
		res, _ = resource.Merge(
			resource.Default(),
			resource.NewWithAttributes(semconv.SchemaURL, semconv.ServiceName(*cfg.MetricsServiceName)),
		)
	} else {
		res = resource.Default()
	}

	if cfg.PrometheusMetricsPort != nil && *cfg.PrometheusMetricsPort > 0 {
		bindHost := effectivePrometheusBindAddr(cfg.PrometheusMetricsHost)
		reg := prometheus.NewRegistry()
		exporter, err := otelprom.New(otelprom.WithRegisterer(reg), otelprom.WithoutUnits())
		if err != nil {
			log.Printf("prometheus metrics exporter init failed: %v", err)
		} else {
			longLivedMeterProvider = sdkmetric.NewMeterProvider(
				sdkmetric.WithResource(res),
				sdkmetric.WithReader(exporter),
			)
			otel.SetMeterProvider(longLivedMeterProvider)
			mux := http.NewServeMux()
			mux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
			addr := fmt.Sprintf("%s:%d", bindHost, *cfg.PrometheusMetricsPort)
			promServer = &http.Server{Addr: addr, Handler: mux}
			go func() {
				if err := promServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					log.Printf("prometheus /metrics server failed: %v", err)
				}
			}()
		}
	}

	metricsEndpoint := resolveMetricsEndpoint(cfg.MetricsOTLPEndpoint)
	if metricsEndpoint != "" {
		exporter, err := otlpmetrichttp.New(
			context.Background(),
			otlpmetrichttp.WithEndpointURL(NormalizeOTLPHttpMetricsEndpoint(metricsEndpoint)),
		)
		if err != nil {
			log.Printf("otlp metrics exporter init failed: %v", err)
		} else {
			interval := time.Duration(cfg.MetricsExportIntervalMs) * time.Millisecond
			reader := sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(interval))
			shortLivedMeterProvider = sdkmetric.NewMeterProvider(
				sdkmetric.WithResource(res),
				sdkmetric.WithReader(reader),
			)
			if longLivedMeterProvider == nil {
				otel.SetMeterProvider(shortLivedMeterProvider)
			}
		}
	}
	return nil
}

func shutdownMeterProvidersLocked(ctx context.Context) {
	if longLivedMeterProvider != nil {
		_ = longLivedMeterProvider.Shutdown(ctx)
		longLivedMeterProvider = nil
	}
	if shortLivedMeterProvider != nil {
		_ = shortLivedMeterProvider.Shutdown(ctx)
		shortLivedMeterProvider = nil
	}
}

func initREDInstruments() {
	redOnce.Do(func() {
		m := GetLongLivedMeter(meterNameRED, meterVersionRED)
		var err error
		redRequest, err = m.Int64Counter("http.server.request.count",
			metric.WithDescription("Total HTTP server requests (RED: rate)"),
			metric.WithUnit("1"))
		if err != nil {
			return
		}
		redErrors, err = m.Int64Counter("http.server.request.error.count",
			metric.WithDescription("HTTP server requests that ended with ERROR status (RED: errors)"),
			metric.WithUnit("1"))
		if err != nil {
			return
		}
		redDurationMs, err = m.Float64Histogram("http.server.request.duration_ms",
			metric.WithDescription("HTTP server request duration in milliseconds (RED: duration)"),
			metric.WithUnit("1"))
		if err != nil {
			return
		}
	})
}

// redMetricsSpanProcessor records RED metrics for SERVER spans.
type redMetricsSpanProcessor struct{}

func (redMetricsSpanProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}

func (redMetricsSpanProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	if s.SpanKind() != trace.SpanKindServer {
		return
	}
	initREDInstruments()
	if redRequest == nil {
		return
	}
	attrs := metricAttributesFromSpan(s)
	ctx := context.Background()
	redRequest.Add(ctx, 1, metric.WithAttributes(attrs...))
	if s.Status().Code == codes.Error {
		redErrors.Add(ctx, 1, metric.WithAttributes(attrs...))
	}
	start, end := s.StartTime(), s.EndTime()
	if !end.IsZero() && !start.IsZero() {
		ms := float64(end.Sub(start)) / float64(time.Millisecond)
		redDurationMs.Record(ctx, ms, metric.WithAttributes(attrs...))
	}
}

func (redMetricsSpanProcessor) Shutdown(context.Context) error   { return nil }
func (redMetricsSpanProcessor) ForceFlush(context.Context) error { return nil }

func attachREDMetricsProcessor(tp *sdktrace.TracerProvider) {
	if tp == nil {
		return
	}
	tp.RegisterSpanProcessor(redMetricsSpanProcessor{})
}

func metricAttributesFromSpan(s sdktrace.ReadOnlySpan) []attribute.KeyValue {
	method := ""
	path := ""
	projectID := ""
	statusCode := ""
	for _, kv := range s.Attributes() {
		switch string(kv.Key) {
		case AttrHTTPRequestMethod:
			method = kv.Value.AsString()
		case AttrURLPath, AttrHTTPRoute:
			if path == "" {
				path = kv.Value.AsString()
			}
		case AttrHTTPResponseStatusCode:
			if kv.Value.Type() == attribute.INT64 {
				statusCode = strconv.FormatInt(kv.Value.AsInt64(), 10)
			} else {
				statusCode = kv.Value.AsString()
			}
		case "project_id":
			projectID = kv.Value.AsString()
		}
	}
	if method == "" || path == "" {
		parts := strings.SplitN(s.Name(), " ", 2)
		if len(parts) >= 2 {
			if method == "" {
				method = parts[0]
			}
			if path == "" {
				path = parts[1]
			}
		} else if len(parts) == 1 && path == "" {
			path = parts[0]
		}
	}
	if method == "" {
		method = "GET"
	}
	if path == "" {
		path = "/"
	}
	result := []attribute.KeyValue{
		attribute.String(AttrHTTPRequestMethod, method),
		attribute.String(AttrURLPath, path),
	}
	if statusCode != "" {
		result = append(result, attribute.String(AttrHTTPResponseStatusCode, statusCode))
	}
	if projectID != "" {
		result = append(result, attribute.String("project_id", projectID))
	}
	return result
}
