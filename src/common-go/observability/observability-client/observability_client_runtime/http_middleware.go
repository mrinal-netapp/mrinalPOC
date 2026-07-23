package observability_client_runtime

import (
	"fmt"
	"net/http"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const tracerNameClientLibrary = "logging.client_library"

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// HTTPTraceMiddleware wraps an http.Handler with one SERVER span per request.
// Logs emitted with the request context share the same trace_id / span_id.
func HTTPTraceMiddleware(next http.Handler) http.Handler {
	tracer := otel.Tracer(tracerNameClientLibrary)
	prop := otel.GetTextMapPropagator()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := prop.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		method := r.Method
		if method == "" {
			method = http.MethodGet
		}
		path := r.URL.Path
		if path == "" {
			path = "/"
		}
		spanName := fmt.Sprintf("%s %s", method, path)

		spanAttrs := []attribute.KeyValue{
			attribute.String(AttrHTTPRequestMethod, method),
			attribute.String(AttrURLPath, path),
		}
		projectID := r.Header.Get("X-Project-ID")
		if projectID != "" {
			spanAttrs = append(spanAttrs, attribute.String("project_id", projectID))
		}

		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(spanAttrs...),
		)
		defer span.End()
		if projectID != "" {
			ctx = BindProjectIDToContext(ctx, projectID)
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r.WithContext(ctx))

		span.SetAttributes(attribute.Int(AttrHTTPResponseStatusCode, rec.status))
		if rec.status >= http.StatusInternalServerError {
			span.SetStatus(codes.Error, http.StatusText(rec.status))
		}
	})
}
