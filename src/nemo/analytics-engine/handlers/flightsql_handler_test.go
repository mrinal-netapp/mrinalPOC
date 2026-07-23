package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// --- Connect ---

func TestConnect_Success(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/connect", nil)
	rr := httptest.NewRecorder()
	h.Connect(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestConnect_DBError(t *testing.T) {
	db := errMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/connect", nil)
	rr := httptest.NewRecorder()
	h.Connect(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

// --- Disconnect ---

func TestDisconnect_AlwaysSuccess(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/disconnect", nil)
	rr := httptest.NewRecorder()
	h.Disconnect(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

// --- Query ---

func TestQuery_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", strings.NewReader("not-json"))
	rr := httptest.NewRecorder()
	h.Query(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestQuery_EmptyQuery(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(QueryRequest{Query: ""})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.Query(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestQuery_JSONSuccess(t *testing.T) {
	db := newMockDB(t)
	// Return simple rows
	db.QueryContextFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 1 AS id, 'hello' AS name")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(QueryRequest{Query: "SELECT * FROM test"})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
	req.Header.Set("Accept", "application/json")
	rr := httptest.NewRecorder()
	h.Query(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := resp["columns"]; !ok {
		t.Error("expected 'columns' in response")
	}
}

func TestQuery_JSONDBError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, fmt.Errorf("db error")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(QueryRequest{Query: "SELECT * FROM test"})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
	req.Header.Set("Accept", "application/json")
	rr := httptest.NewRecorder()
	h.Query(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

func TestQuery_CacheHit(t *testing.T) {
	db := newMockDB(t)
	queryCalls := 0
	db.QueryContextFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		queryCalls++
		return db.simpleRows("SELECT 'orders' AS table_name")
	}
	h := NewFlightSQLHandler(db)

	// SHOW TABLES is a metadata query → result gets cached after the first call.
	send := func() *httptest.ResponseRecorder {
		body, _ := json.Marshal(QueryRequest{Query: "SHOW TABLES"})
		req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
		req.Header.Set("Accept", "application/json")
		rr := httptest.NewRecorder()
		h.Query(rr, req)
		return rr
	}

	rr1 := send()
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request: expected 200, got %d: %s", rr1.Code, rr1.Body.String())
	}
	firstCalls := queryCalls

	rr2 := send()
	if rr2.Code != http.StatusOK {
		t.Fatalf("second request: expected 200, got %d: %s", rr2.Code, rr2.Body.String())
	}
	// The DB should not have been called again — the second response came from cache.
	if queryCalls > firstCalls {
		t.Errorf("expected cache hit on second request (DB call count should not increase); calls before=%d after=%d", firstCalls, queryCalls)
	}
}

func TestQuery_ArrowIPC_NotImplemented(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(QueryRequest{Query: "SELECT 1"})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
	// No Accept: application/json header → handler tries the Arrow IPC path.
	rr := httptest.NewRecorder()
	h.Query(rr, req)
	// Without the duckdb_arrow build tag the handler returns 501 Not Implemented.
	// With the tag it returns 200. Both are valid; any other code is a bug.
	switch rr.Code {
	case http.StatusNotImplemented, http.StatusOK:
		// expected
	default:
		t.Errorf("unexpected status code %d for Arrow IPC path (expected 200 or 501)", rr.Code)
	}
}

// --- Upload ---

func TestUpload_InvalidMultipart(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", strings.NewReader("not-multipart"))
	req.Header.Set("Content-Type", "text/plain")
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestUpload_MissingFile(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("tableName", "mytable")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestUpload_MissingTableName(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "data.csv")
	fw.Write([]byte("id,name\n1,alice\n"))
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestUpload_UnsupportedFileType(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "data.xlsx")
	fw.Write([]byte("some binary data"))
	w.WriteField("tableName", "mytable")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_CSVSuccess(t *testing.T) {
	db := newMockDB(t)
	// loadCSVFile calls ExecContext with a CREATE TABLE ... AS SELECT * FROM read_csv(...)
	// We need a real DuckDB to actually parse the CSV. Since MockDB's ExecContextFn defaults
	// to success with rowsAffected=1, we can test this path.
	// But the actual query runs on a real file — so we let it use the real db.
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		// Execute the actual query on the embedded DuckDB
		return db.db.ExecContext(ctx, query)
	}
	h := NewFlightSQLHandler(db)

	csvData := "id,name,amount\n1,alice,10.5\n2,bob,20.0\n"
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "data.csv")
	fw.Write([]byte(csvData))
	w.WriteField("tableName", "test_csv_upload")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_JSONSuccess(t *testing.T) {
	db := newMockDB(t)
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return db.db.ExecContext(ctx, query)
	}
	h := NewFlightSQLHandler(db)

	jsonData := `[{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}]`
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "data.json")
	fw.Write([]byte(jsonData))
	w.WriteField("tableName", "test_json_upload")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestUpload_ExecError(t *testing.T) {
	db := newMockDB(t)
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return nil, fmt.Errorf("exec failed")
	}
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("file", "data.csv")
	fw.Write([]byte("id\n1\n"))
	w.WriteField("tableName", "mytable")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

// --- LoadObjects ---

func TestLoadObjects_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-objects", strings.NewReader("not-json"))
	rr := httptest.NewRecorder()
	h.LoadObjects(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadObjects_EmptyData(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(map[string]interface{}{
		"data":      []interface{}{},
		"tableName": "test",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-objects", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.LoadObjects(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadObjects_MissingTableName(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(map[string]interface{}{
		"data": []map[string]interface{}{{"id": 1}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-objects", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.LoadObjects(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadObjects_Success(t *testing.T) {
	db := newMockDB(t)
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return db.db.ExecContext(ctx, query)
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(map[string]interface{}{
		"data":      []map[string]interface{}{{"id": 1, "name": "alice"}},
		"tableName": "test_objects",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-objects", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.LoadObjects(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- LoadArrow ---

func TestLoadArrow_InvalidMultipart(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-arrow", strings.NewReader("not-multipart"))
	req.Header.Set("Content-Type", "text/plain")
	rr := httptest.NewRecorder()
	h.LoadArrow(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadArrow_MissingArrowData(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("tableName", "mytable")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-arrow", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.LoadArrow(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadArrow_MissingTableName(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("arrowData", "data.arrow")
	fw.Write([]byte("somedata"))
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-arrow", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.LoadArrow(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestLoadArrow_InvalidArrowData(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, _ := w.CreateFormFile("arrowData", "data.arrow")
	fw.Write([]byte("not-valid-arrow-ipc"))
	w.WriteField("tableName", "mytable")
	w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-arrow", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.LoadArrow(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500 for invalid arrow data, got %d", rr.Code)
	}
}

// --- DatasetPreview ---

func TestDatasetPreview_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", strings.NewReader("bad-json"))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetPreview_MissingNamespace(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(PreviewRequest{Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetPreview_MissingTable(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(PreviewRequest{Namespace: "proj-123"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetPreview_DescribeError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		return nil, fmt.Errorf("DESCRIBE failed")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj-123",
		Table:     "orders",
		Limit:     10,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for DESCRIBE failure, got %d", rr.Code)
	}
}

func TestDatasetPreview_QueryError(t *testing.T) {
	db := newMockDB(t)
	// describeColumns succeeds (returns rows with DESCRIBE shape)
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		// Return empty DESCRIBE result (no columns means no filters to validate)
		return db.simpleRows("SELECT '' AS column_name, '' AS column_type, '' AS null, '' AS key, '' AS default_expr, '' AS extra LIMIT 0")
	}
	// QueryWithCountContext fails
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		return 0, nil, fmt.Errorf("query failed")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj-123",
		Table:     "orders",
		Limit:     10,
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %d", rr.Code)
	}
}

// --- DatasetStats ---

func TestDatasetStats_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", strings.NewReader("bad"))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetStats_MissingNamespace(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(StatsRequest{Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetStats_DescribeError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		return nil, fmt.Errorf("describe failed")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(StatsRequest{Namespace: "proj", Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetStats_SummarizeFailsFallback(t *testing.T) {
	db := newMockDB(t)
	callCount := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		callCount++
		if callCount == 1 {
			// DESCRIBE returns empty result
			return db.simpleRows("SELECT '' AS column_name, '' AS column_type, '' AS null, '' AS key, '' AS default_expr, '' AS extra LIMIT 0")
		}
		// SUMMARIZE fails → fallback
		return nil, fmt.Errorf("summarize not supported")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(StatsRequest{Namespace: "proj", Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	// With fallback failing (DESCRIBE on tableRef also uses QueryContextArgs), returns 200 with empty stats
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with fallback stats, got %d", rr.Code)
	}
}

// --- DatasetHistogram ---

func TestDatasetHistogram_InvalidJSON(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", strings.NewReader("bad"))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetHistogram_MissingFields(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders"}) // missing column
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetHistogram_DescribeError(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		return nil, fmt.Errorf("describe failed")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "amount"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rr.Code)
	}
}

func TestDatasetHistogram_InvalidColumn(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		// DESCRIBE returns a result with one column "id"
		return db.simpleRows("SELECT 'id' AS column_name, 'INTEGER' AS column_type, 'YES' AS null, '' AS key, '' AS default_expr, '' AS extra")
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "nonexistent"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid column, got %d", rr.Code)
	}
}
