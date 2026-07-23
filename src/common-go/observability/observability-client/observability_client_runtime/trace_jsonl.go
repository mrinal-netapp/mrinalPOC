package observability_client_runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

var openllmetryScopeMarkers = []string{
	"traceloop.tracer",
	"instrumentation.openai",
	"instrumentation.langchain",
	"instrumentation.mcp",
	"instrumentation.crewai",
	"instrumentation.llamaindex",
	"instrumentation.chromadb",
}

type fileJSONLSpanProcessor struct {
	path   string
	filter string
	mu     sync.Mutex
	file   *os.File
}

func newFileJSONLSpanProcessor(path, encoding, filter string) (*fileJSONLSpanProcessor, error) {
	_ = encoding
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &fileJSONLSpanProcessor{path: path, filter: filter, file: f}, nil
}

func (p *fileJSONLSpanProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}

func (p *fileJSONLSpanProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	sc := s.SpanContext()
	if !sc.IsValid() {
		return
	}
	if p.filter == "openllmetry" && !spanMatchesOpenllmetryFilter(s) {
		return
	}
	line, err := spanToJSONLine(s)
	if err != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file != nil {
		_, _ = p.file.Write(append(line, '\n'))
	}
}

func (p *fileJSONLSpanProcessor) Shutdown(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file != nil {
		err := p.file.Close()
		p.file = nil
		return err
	}
	return nil
}

func (p *fileJSONLSpanProcessor) ForceFlush(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.file != nil {
		return p.file.Sync()
	}
	return nil
}

func spanMatchesOpenllmetryFilter(s sdktrace.ReadOnlySpan) bool {
	for _, kv := range s.Attributes() {
		k := string(kv.Key)
		if strings.HasPrefix(k, "traceloop.") || strings.HasPrefix(k, "gen_ai.") {
			return true
		}
	}
	scope := ""
	if is := s.InstrumentationScope(); is.Name != "" {
		scope = is.Name
	}
	if scope == "" || scope == tracerNameHandler {
		return false
	}
	if scope == "traceloop.tracer" {
		return true
	}
	for _, m := range openllmetryScopeMarkers {
		if strings.Contains(scope, m) {
			return true
		}
	}
	return false
}

func spanToJSONLine(s sdktrace.ReadOnlySpan) ([]byte, error) {
	sc := s.SpanContext()
	rec := map[string]any{
		"trace_id": sc.TraceID().String(),
		"span_id":  sc.SpanID().String(),
		"name":     s.Name(),
		"kind":     s.SpanKind().String(),
		"status":   s.Status().Code.String(),
	}
	if !s.EndTime().IsZero() && !s.StartTime().IsZero() {
		rec["duration_ms"] = float64(s.EndTime().Sub(s.StartTime()).Milliseconds())
	}
	attrs := make(map[string]any)
	for _, kv := range s.Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsInterface()
	}
	if len(attrs) > 0 {
		rec["attributes"] = attrs
	}
	return json.Marshal(rec)
}

func effectiveTraceJSONLPath(cfg ObservabilityLoggingConfig) string {
	if !cfg.WriteSpansToJSONLFile {
		return ""
	}
	if cfg.TraceFilePath != nil && strings.TrimSpace(*cfg.TraceFilePath) != "" {
		return resolveTraceOutputPath(*cfg.TraceFilePath)
	}
	return filepath.Join(defaultTraceDir, defaultTraceFilename)
}

func resolveTraceOutputPath(traceFilePath string) string {
	raw := strings.TrimSpace(traceFilePath)
	if raw == "" {
		return ""
	}
	path := filepath.Clean(raw)
	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			return filepath.Join(path, defaultTraceFilename)
		}
		return path
	}
	if filepath.Ext(path) != "" {
		return path
	}
	return filepath.Join(path, defaultTraceFilename)
}

func resolveLogOutputPath(logFilePath string) string {
	if strings.TrimSpace(logFilePath) == "" {
		return filepath.Join(defaultLogDir, defaultLogFilename)
	}
	path := filepath.Clean(logFilePath)
	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			return filepath.Join(path, defaultLogFilename)
		}
		return path
	}
	if filepath.Ext(path) != "" {
		return path
	}
	return filepath.Join(path, defaultLogFilename)
}
