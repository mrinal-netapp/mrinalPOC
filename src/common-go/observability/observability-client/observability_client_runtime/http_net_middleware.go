package observability_client_runtime

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
)

// requestIDKey is the context key used to store the request ID.
type requestIDKey struct{}

// RequestIDMiddleware propagates the X-Request-Id header through the request
// context and echoes it in the response. If no header is present a new UUID
// is generated so every request carries a unique ID for log correlation.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = uuid.New().String()
		}
		w.Header().Set("X-Request-Id", reqID)
		ctx := context.WithValue(r.Context(), requestIDKey{}, reqID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// GetRequestID returns the request ID stored in ctx by RequestIDMiddleware.
func GetRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey{}).(string); ok {
		return id
	}
	return ""
}

// LoggingMiddleware emits a structured access log entry for every HTTP request
// via the client lib Zap logger so access logs appear in the same JSONL file
// as application logs, with OTel trace/span IDs injected automatically.
func LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := newLoggingResponseWriter(w)
		next.ServeHTTP(ww, r)
		duration := time.Since(start)

		reqID := GetRequestID(r.Context())
		fields := []LogField{
			String("method", r.Method),
			String("path", r.URL.Path),
			Int("status", ww.statusCode),
			String("duration", duration.String()),
			String("remote_addr", r.RemoteAddr),
		}
		if reqID != "" {
			fields = append(fields, String("request_id", reqID))
		}

		// Suppress health-check noise at Debug level; everything else at Info.
		if r.URL.Path == "/health" || r.URL.Path == "/ready" {
			LogDebug(r.Context(), "request", fields...)
		} else {
			LogInfo(r.Context(), "request", fields...)
		}
	})
}

// MetricsHandler exposes domain-specific Prometheus metrics registered in the
// global prometheus registry on the service's app port.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

// InjectTraceHeaders copies the active OTel span context and X-Request-Id from
// the incoming request into outgoing proxy requests so downstream services
// participate in the same distributed trace.
func InjectTraceHeaders(outReq *http.Request, inReq *http.Request) {
	otel.GetTextMapPropagator().Inject(inReq.Context(), propagation.HeaderCarrier(outReq.Header))
	if v := inReq.Header.Get("X-Request-Id"); v != "" {
		outReq.Header.Set("X-Request-Id", v)
	}
}

// loggingResponseWriter wraps http.ResponseWriter to capture the response
// status code for access log entries. It implements http.Hijacker and
// http.Flusher so WebSocket upgrades and streaming responses work correctly.
type loggingResponseWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func newLoggingResponseWriter(w http.ResponseWriter) *loggingResponseWriter {
	return &loggingResponseWriter{ResponseWriter: w, statusCode: http.StatusOK}
}

func (rw *loggingResponseWriter) WriteHeader(code int) {
	if !rw.written {
		rw.statusCode = code
		rw.written = true
	}
	rw.ResponseWriter.WriteHeader(code)
}

// Hijack delegates to the underlying ResponseWriter for WebSocket/protocol upgrades.
func (rw *loggingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("upstream ResponseWriter does not implement http.Hijacker")
}

// Flush delegates to the underlying ResponseWriter for streaming responses.
func (rw *loggingResponseWriter) Flush() {
	if fl, ok := rw.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}
