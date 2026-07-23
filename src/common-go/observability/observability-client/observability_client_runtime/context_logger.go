package observability_client_runtime

import "context"

type contextKey int

const projectIDKey contextKey = iota

// BindProjectIDToContext returns a new context carrying the given project_id.
// HTTP middleware uses this after extracting X-Project-ID from the request.
// Temporal workers and other non-HTTP callers may call it directly at the
// start of an activity / workflow.
func BindProjectIDToContext(ctx context.Context, projectID string) context.Context {
	return context.WithValue(ctx, projectIDKey, projectID)
}

// ProjectIDFromContext retrieves the project_id stored by BindProjectIDToContext.
// Returns an empty string when no project_id is present.
func ProjectIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(projectIDKey).(string); ok {
		return v
	}
	return ""
}
