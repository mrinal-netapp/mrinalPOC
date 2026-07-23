//go:build !duckdb_arrow

package handlers

import (
	"context"
	"net/http"
	"time"

	"agentstudio/nemo/analytics-engine/services"
)

func (h *FlightSQLHandler) queryArrowIPC(ctx context.Context, w http.ResponseWriter, req QueryRequest, cache *services.QueryCache, cacheKey string, startTime time.Time, queryErr *error) {
	h.writeError(w, http.StatusNotImplemented, "Arrow IPC responses require the duckdb_arrow build tag")
}
