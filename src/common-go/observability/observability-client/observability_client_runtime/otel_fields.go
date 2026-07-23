package observability_client_runtime

import (
	"context"

	"go.uber.org/zap"
)

// OtelFields returns zap fields for trace_id and span_id when the context carries a valid span.
func OtelFields(ctx context.Context) []zap.Field {
	return otelLogFields(ctx)
}
