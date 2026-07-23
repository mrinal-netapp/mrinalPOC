package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newMetricsHandlerForTest(t *testing.T) *MetricsHandler {
	t.Helper()
	db := newMockDB(t)
	flightSQL := NewFlightSQLHandler(db)
	return NewMetricsHandler(flightSQL)
}

func TestHealth_ReturnsOK(t *testing.T) {
	h := newMetricsHandlerForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	h.Health(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}
}

func TestHealth_ResponseBody(t *testing.T) {
	h := newMetricsHandlerForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rr := httptest.NewRecorder()
	h.Health(rr, req)

	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp["status"] != "healthy" {
		t.Errorf("expected status=healthy, got %v", resp["status"])
	}
	if _, ok := resp["cache"]; !ok {
		t.Error("expected 'cache' key in response")
	}
	if _, ok := resp["metrics"]; !ok {
		t.Error("expected 'metrics' key in response")
	}
}

func TestMetrics_ReturnsOK(t *testing.T) {
	h := newMetricsHandlerForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rr := httptest.NewRecorder()
	h.Metrics(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestMetrics_ResponseBody(t *testing.T) {
	h := newMetricsHandlerForTest(t)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rr := httptest.NewRecorder()
	h.Metrics(rr, req)

	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if _, ok := resp["cache"]; !ok {
		t.Error("expected 'cache' key in response")
	}
	if _, ok := resp["queries"]; !ok {
		t.Error("expected 'queries' key in response")
	}
	if _, ok := resp["connections"]; !ok {
		t.Error("expected 'connections' key in response")
	}
	if _, ok := resp["performance"]; !ok {
		t.Error("expected 'performance' key in response")
	}
}

func TestMetrics_AfterRequests(t *testing.T) {
	db := newMockDB(t)
	flightSQL := NewFlightSQLHandler(db)
	// Record some metrics to test non-zero values
	flightSQL.metrics.RecordQueryError()
	flightSQL.metrics.RecordQueryError()

	h := NewMetricsHandler(flightSQL)
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rr := httptest.NewRecorder()
	h.Metrics(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}
