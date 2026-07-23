package handlers

import (
	"encoding/json"
	"net/http"

	"agentstudio/nemo/analytics-engine/services"
)

// MetricsHandler handles health and metrics endpoints
type MetricsHandler struct {
	flightSQLHandler *FlightSQLHandler
}

// NewMetricsHandler creates a new metrics handler
func NewMetricsHandler(flightSQLHandler *FlightSQLHandler) *MetricsHandler {
	return &MetricsHandler{
		flightSQLHandler: flightSQLHandler,
	}
}

// Health returns health check information
func (h *MetricsHandler) Health(w http.ResponseWriter, r *http.Request) {
	cache := services.GetQueryCache()
	stats := h.flightSQLHandler.metrics.GetStats()

	cacheStats := cache.GetStats()

	response := map[string]interface{}{
		"status":           "healthy",
		"duckdb_available": true,
		"cache":            cacheStats,
		"metrics":          stats,
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}

// Metrics returns detailed metrics
func (h *MetricsHandler) Metrics(w http.ResponseWriter, r *http.Request) {
	cache := services.GetQueryCache()
	stats := h.flightSQLHandler.metrics.GetStats()

	cacheStats := cache.GetStats()

	// Calculate error rate
	errorRate := 0.0
	totalQueries := stats["total_queries"].(int64)
	if totalQueries > 0 {
		errorRate = float64(stats["query_errors"].(int64)) / float64(totalQueries)
	}

	response := map[string]interface{}{
		"cache": map[string]interface{}{
			"size":        cacheStats.Size,
			"maxsize":     cacheStats.MaxSize,
			"ttl_seconds": cacheStats.TTL,
			"hits":        cacheStats.Hits,
			"misses":      cacheStats.Misses,
			"hit_rate":    cacheStats.HitRate,
		},
		"queries": map[string]interface{}{
			"total":      stats["total_queries"],
			"errors":     stats["query_errors"],
			"error_rate": errorRate,
		},
		"connections": map[string]interface{}{
			"errors":  stats["connection_errors"],
			"retries": stats["retries"],
		},
		"performance": map[string]interface{}{
			"avg_response_time_seconds": stats["avg_response_time_seconds"],
			"p95_response_time_seconds": stats["p95_response_time_seconds"],
			"p99_response_time_seconds": stats["p99_response_time_seconds"],
			"total_requests":            stats["total_requests"],
		},
		"requests_by_endpoint": stats["requests_by_endpoint"],
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(response)
}
