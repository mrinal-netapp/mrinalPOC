package observability_client_runtime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/enums"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
)

func TestConfigureAndLogWithSpan(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "app.jsonl")

	cfg := ObservabilityStaticDefaults()
	cfg.LogFilePath = logPath
	cfg.WriteSpansToJSONLFile = false
	cfg.OTLPTracesEndpoint = nil
	cfg.MetricsOTLPEndpoint = nil
	cfg.PrometheusMetricsPort = nil
	cfg.EnableRedMetrics = false

	if err := ConfigureObservabilityLogging(cfg); err != nil {
		t.Fatalf("configure: %v", err)
	}
	t.Cleanup(func() {
		_ = ShutdownObservability(context.Background())
	})

	err := WithOtelSpan(context.Background(), "test-span", func(ctx context.Context) error {
		return LogEvent(ctx, enums.LogLevelInfo, "hello", zap.String("key", "value"))
	}, trace.WithSpanKind(trace.SpanKindServer))
	if err != nil {
		t.Fatalf("log: %v", err)
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	var rec map[string]any
	if err := json.Unmarshal(data[:len(data)-1], &rec); err != nil {
		t.Fatalf("parse json: %v", err)
	}
	if rec["event"] != "hello" {
		t.Fatalf("event=%v", rec["event"])
	}
	if _, ok := rec["trace_id"]; !ok {
		t.Fatalf("missing trace_id: %v", rec)
	}
}

func TestNormalizeOTLPEndpoints(t *testing.T) {
	if got := NormalizeOTLPHttpTracesEndpoint("http://localhost:4318"); got != "http://localhost:4318/v1/traces" {
		t.Fatalf("traces: %q", got)
	}
	if got := NormalizeOTLPHttpMetricsEndpoint("http://localhost:4318/v1/metrics"); got != "http://localhost:4318/v1/metrics" {
		t.Fatalf("metrics: %q", got)
	}
}

func TestHTTPTraceMiddleware(t *testing.T) {
	dir := t.TempDir()
	cfg := ObservabilityStaticDefaults()
	cfg.LogFilePath = filepath.Join(dir, "app.jsonl")
	cfg.WriteSpansToJSONLFile = false
	cfg.EnableRedMetrics = false
	if err := ConfigureObservabilityLogging(cfg); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ShutdownObservability(context.Background()) })

	h := HTTPTraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = LogEvent(r.Context(), enums.LogLevelInfo, "handled")
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/hello", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d", rr.Code)
	}
}
