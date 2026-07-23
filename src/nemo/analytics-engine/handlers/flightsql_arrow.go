//go:build duckdb_arrow

package handlers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"agentstudio/nemo/analytics-engine/services"
	"agentstudio/nemo/analytics-engine/utils"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

func (h *FlightSQLHandler) queryArrowIPC(ctx context.Context, w http.ResponseWriter, req QueryRequest, cache *services.QueryCache, cacheKey string, startTime time.Time, queryErr *error) {
	var arrowData []byte

	err := h.dbMgr.WithArrowConn(func(conn *duckdb.Conn) error {
		arw, err := duckdb.NewArrowFromConn(conn)
		if err != nil {
			return fmt.Errorf("failed to create Arrow interface: %w", err)
		}
		reader, err := arw.QueryContext(ctx, req.Query)
		if err != nil {
			return fmt.Errorf("query failed: %w", err)
		}
		defer reader.Release()

		data, err := services.ConvertToArrowIPC(reader)
		if err != nil {
			return err
		}
		arrowData = data
		return nil
	})

	if err != nil {
		*queryErr = err
		utils.Error("Arrow query failed: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Query failed: %v", err))
		h.metrics.RecordQueryError()
		return
	}

	if cacheKey != "" {
		cache.Set(cacheKey, arrowData)
		utils.Debug("Cached query result (Arrow IPC): %s", req.Query[:min(50, len(req.Query))])
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	w.Write(arrowData)
}
