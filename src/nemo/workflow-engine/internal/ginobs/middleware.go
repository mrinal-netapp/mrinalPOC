// Package ginobs provides thin Gin adapter middleware that delegates to the
// common obslib client library for logging, tracing, and metrics.
// Keeping Gin adapters here avoids pulling a gin dependency into the shared
// client library, while still routing all telemetry through the unified stack.
package ginobs

import (
	"fmt"
	"net/http"
	"time"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// GinRequestIDMiddleware propagates the X-Request-Id header through the Gin
// context so every handler can retrieve it via c.GetString("request_id").
func GinRequestIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		reqID := c.GetHeader("X-Request-Id")
		if reqID == "" {
			reqID = uuid.New().String()
		}
		c.Set("request_id", reqID)
		c.Header("X-Request-Id", reqID)
		c.Next()
	}
}

// GinTracingMiddleware creates a SERVER span for every request and propagates
// W3C trace-context from incoming headers into the Gin request context so that
// downstream obslib.LogEvent calls automatically carry trace_id / span_id.
func GinTracingMiddleware() gin.HandlerFunc {
	tracer := otel.Tracer("logging.client_library")
	prop := otel.GetTextMapPropagator()

	return func(c *gin.Context) {
		ctx := prop.Extract(c.Request.Context(), propagation.HeaderCarrier(c.Request.Header))

		method := c.Request.Method
		path := c.FullPath()
		if path == "" {
			path = c.Request.URL.Path
		}

		// X-Project-ID is injected by the edge gateway's parity-headers
		// EnvoyFilter for project-scoped paths. Stamp it onto the span (so
		// obslib's RED-metric deriver labels metrics with project_id) and bind
		// it to the context (so obslib.LogInfo/LogDebug auto-include it). This
		// mirrors the shared obslib HTTPTraceMiddleware, which this Gin adapter
		// stands in for.
		projectID := c.Request.Header.Get("X-Project-ID")

		spanAttrs := []attribute.KeyValue{
			attribute.String("http.request.method", method),
			attribute.String("url.path", path),
		}
		if projectID != "" {
			spanAttrs = append(spanAttrs, attribute.String("project_id", projectID))
		}

		ctx, span := tracer.Start(ctx, fmt.Sprintf("%s %s", method, path),
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(spanAttrs...),
		)
		defer span.End()

		if projectID != "" {
			ctx = obslib.BindProjectIDToContext(ctx, projectID)
		}

		c.Request = c.Request.WithContext(ctx)
		c.Next()

		span.SetAttributes(attribute.Int("http.response.status_code", c.Writer.Status()))
		if c.Writer.Status() >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(c.Writer.Status()))
		}
	}
}

// GinLoggingMiddleware emits a structured access log entry per request using
// the obslib Zap logger so access logs appear in the same JSONL file as
// application logs with OTel trace/span IDs.
func GinLoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		duration := time.Since(start)

		path := c.FullPath()
		if path == "" {
			path = c.Request.URL.Path
		}

		fields := []obslib.LogField{
			obslib.String("method", c.Request.Method),
			obslib.String("path", path),
			obslib.Int("status", c.Writer.Status()),
			obslib.String("duration", duration.String()),
			obslib.String("remote_addr", c.ClientIP()),
		}
		if reqID := c.GetString("request_id"); reqID != "" {
			fields = append(fields, obslib.String("request_id", reqID))
		}

		if c.Request.URL.Path == "/health" || c.Request.URL.Path == "/ready" {
			obslib.LogDebug(c.Request.Context(), "request", fields...)
		} else {
			obslib.LogInfo(c.Request.Context(), "request", fields...)
		}
	}
}

// GinPrometheusMiddleware is a pass-through. HTTP RED metrics are produced by
// the OTel span processor in the client lib and exported on the dedicated
// Prometheus port (default 8000).
func GinPrometheusMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) { c.Next() }
}

// GinMetricsHandler serves the global Prometheus registry on the app port via
// a Gin handler, delegating to obslib.MetricsHandler under the hood.
func GinMetricsHandler() gin.HandlerFunc {
	h := obslib.MetricsHandler()
	return func(c *gin.Context) {
		h.ServeHTTP(c.Writer, c.Request)
	}
}
