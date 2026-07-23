package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"agentstudio/nemo/analytics-engine/services"
)

// newAgentHandlerWithValidator builds an AgentHandler with a real SQLValidator.
// Skips the test if the validator cannot be initialised (missing DuckDB extensions).
func newAgentHandlerWithValidator(t *testing.T, db *MockDB) *AgentHandler {
	t.Helper()
	v, err := services.NewSQLValidator("")
	if err != nil {
		t.Skipf("Skipping: cannot create SQLValidator: %v", err)
	}
	t.Cleanup(func() { v.Close() })
	return &AgentHandler{
		dbMgr:       db,
		validator:   v,
		tenantQueue: services.NewTenantQueue(),
		metrics:     NewMetrics(),
		maxRows:     500,
		stmtTimeout: 30 * time.Second,
	}
}

// requestWithProjectID creates an http.Request with X-Project-ID header set.
func requestWithProjectID(method, path, projectID string, body []byte) *http.Request {
	var r *http.Request
	if body != nil {
		r = httptest.NewRequest(method, path, bytes.NewReader(body))
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	r.Header.Set("X-Project-ID", projectID)
	return r
}

// --- hashQuery ---

func TestHashQuery(t *testing.T) {
	h1 := hashQuery("SELECT 1")
	h2 := hashQuery("SELECT 1")
	if h1 != h2 {
		t.Error("expected same hash for same query")
	}
	h3 := hashQuery("SELECT 2")
	if h1 == h3 {
		t.Error("expected different hash for different query")
	}
	if len(h1) != 16 { // 8 bytes → 16 hex chars
		t.Errorf("expected 16-char hash, got %d: %s", len(h1), h1)
	}
}

// --- requireProjectID ---

func TestRequireProjectID_FromHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Project-ID", "proj-abc")
	rr := httptest.NewRecorder()
	pid := requireProjectID(rr, req)
	if pid != "proj-abc" {
		t.Errorf("expected %q, got %q", "proj-abc", pid)
	}
}

func TestRequireProjectID_Missing(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	pid := requireProjectID(rr, req)
	if pid != "" {
		t.Errorf("expected empty string, got %q", pid)
	}
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

// --- getUserID ---

func TestGetUserID_NoClaims(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	uid := getUserID(req)
	if uid != "" {
		t.Errorf("expected empty string, got %q", uid)
	}
}

// --- AgentQuery ---

func TestAgentQuery_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{
		dbMgr:       db,
		metrics:     NewMetrics(),
		tenantQueue: services.NewTenantQueue(),
		maxRows:     500,
		stmtTimeout: 30 * time.Second,
	}
	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/query", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentQuery_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := newAgentHandlerWithValidator(t, db)
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", []byte("bad-json"))
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestAgentQuery_EmptyQuery(t *testing.T) {
	db := newMockDB(t)
	h := newAgentHandlerWithValidator(t, db)
	body, _ := json.Marshal(QueryRequest{Query: ""})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestAgentQuery_ValidatorRejects(t *testing.T) {
	db := newMockDB(t)
	h := newAgentHandlerWithValidator(t, db)

	// DDL is not allowed by the validator
	body, _ := json.Marshal(QueryRequest{Query: "DROP TABLE t"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 for rejected query, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAgentQuery_QueueFull(t *testing.T) {
	db := newMockDB(t)

	// 1 slot, 50ms wait — handler fails fast when slot is occupied
	tq := services.NewTenantQueueWithConfig(1, 50*time.Millisecond)

	v, err := services.NewSQLValidator("")
	if err != nil {
		t.Skipf("Skipping: cannot create SQLValidator: %v", err)
	}
	defer v.Close()

	h := &AgentHandler{
		dbMgr:       db,
		validator:   v,
		tenantQueue: tq,
		metrics:     NewMetrics(),
		maxRows:     500,
		stmtTimeout: 30 * time.Second,
	}

	// Pre-fill the only slot so the handler's acquire fails
	release, err := tq.Acquire(context.Background(), "proj-123")
	if err != nil {
		t.Fatalf("failed to pre-acquire slot: %v", err)
	}
	defer release()

	// SELECT 1 passes validator (no table references)
	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 when queue full, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAgentQuery_DBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("db error")
	}

	h := newAgentHandlerWithValidator(t, db)

	// SELECT 1 passes validator (no table references)
	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAgentQuery_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 1 AS id, 'alice' AS name")
	}

	h := newAgentHandlerWithValidator(t, db)

	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if _, ok := resp["columns"]; !ok {
		t.Error("expected 'columns' in response")
	}
}

func TestAgentQuery_Truncated(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT * FROM (VALUES (1),(2),(3),(4),(5)) t(id)")
	}

	v, err := services.NewSQLValidator("")
	if err != nil {
		t.Skipf("Skipping: cannot create SQLValidator: %v", err)
	}
	defer v.Close()

	h := &AgentHandler{
		dbMgr:       db,
		validator:   v,
		tenantQueue: services.NewTenantQueue(),
		metrics:     NewMetrics(),
		maxRows:     2,
		stmtTimeout: 30 * time.Second,
	}

	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/query", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentQuery(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["truncated"] != true {
		t.Errorf("expected truncated=true, got %v (resp=%v)", resp["truncated"], resp)
	}
}

// --- AgentDescribe ---

func TestAgentDescribe_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/describe", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.AgentDescribe(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentDescribe_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/describe", "proj-123", []byte("bad"))
	rr := httptest.NewRecorder()
	h.AgentDescribe(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestAgentDescribe_DBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("describe failed")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/describe", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentDescribe(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestAgentDescribe_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 'id' AS column_name, 'INTEGER' AS column_type, 'YES' AS null_col, '' AS key_col, '' AS default_expr, '' AS extra_col")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/describe", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentDescribe(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- AgentDatasets ---

func TestAgentDatasets_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/datasets", nil)
	rr := httptest.NewRecorder()
	h.AgentDatasets(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentDatasets_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 'orders' AS table_name")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/datasets", "proj-123", nil)
	rr := httptest.NewRecorder()
	h.AgentDatasets(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestAgentDatasets_FallbackToShowTables(t *testing.T) {
	db := newMockDB(t)
	callCount := 0
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		callCount++
		if strings.Contains(query, "information_schema") {
			return nil, fmt.Errorf("not supported")
		}
		// SHOW ALL TABLES fallback - return empty
		return db.simpleRows("SELECT 'iceberg' AS database_col, 'proj-123' AS schema_col, 'orders' AS name_col LIMIT 0")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/datasets", "proj-123", nil)
	rr := httptest.NewRecorder()
	h.AgentDatasets(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 on fallback, got %d", rr.Code)
	}
}

// --- AgentPreview ---

func TestAgentPreview_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]interface{}{"table": "orders", "limit": 10})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.AgentPreview(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentPreview_DBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("preview failed")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]interface{}{"table": "orders", "limit": 10})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/preview", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentPreview(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestAgentPreview_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 1 AS id, 'alice' AS name")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]interface{}{"table": "orders", "limit": 10})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/preview", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- AgentStats ---

func TestAgentStats_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.AgentStats(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentStats_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/stats", "proj-123", []byte("bad"))
	rr := httptest.NewRecorder()
	h.AgentStats(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestAgentStats_DBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("stats failed")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/stats", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentStats(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestAgentStats_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		// Return empty SUMMARIZE-like result
		return db.simpleRows("SELECT '' AS col_name, '' AS col_type, '' AS mn, '' AS mx, '' AS aprx, '' AS avg_col, '' AS std_col, '' AS q25, '' AS q50, '' AS q75, '' AS cnt, '' AS null_pct LIMIT 0")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/stats", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentStats(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

// --- AgentHistogram ---

func TestAgentHistogram_MissingProjectID(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders", "column": "amount"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.AgentHistogram(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", rr.Code)
	}
}

func TestAgentHistogram_MissingFields(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"}) // missing column
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/histogram", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentHistogram(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestAgentHistogram_DBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("histogram failed")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders", "column": "amount"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/histogram", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentHistogram(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestAgentHistogram_Success(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 'cat_a' AS val, 10 AS cnt")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders", "column": "category"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/histogram", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentHistogram(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}
