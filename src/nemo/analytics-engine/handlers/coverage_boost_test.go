package handlers

// Additional tests targeting lower-coverage code paths:
// buildQueryClauses, DatasetPreview, DatasetHistogram, DatasetStats scan,
// AgentStats scan, agentDatasetsShowTables, loadArrowData (valid IPC),
// cache hit path, and more.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"agentstudio/nemo/analytics-engine/services"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

// describeCallFn returns a QueryContextArgsFn that answers the first
// `describeCount` calls with rows shaped like DESCRIBE output (6 string cols),
// then falls through to `dataFn` for subsequent calls.
func describeCallFn(db *MockDB, describeCount int, descQuery string, dataFn func(context.Context, string, ...interface{}) (*sql.Rows, error)) func(context.Context, string, ...interface{}) (*sql.Rows, error) {
	call := 0
	return func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call <= describeCount {
			return db.simpleRows(descQuery)
		}
		if dataFn != nil {
			return dataFn(ctx, query, args...)
		}
		return db.simpleRows("SELECT 1 AS result")
	}
}

// buildDescribeSQL returns a DuckDB UNION ALL query that looks like DESCRIBE output.
// Each pair in cols is (columnName, columnType).
func buildDescribeSQL(cols [][2]string) string {
	q := ""
	for i, c := range cols {
		row := fmt.Sprintf("SELECT '%s' AS c1, '%s' AS c2, 'YES' AS c3, '' AS c4, '' AS c5, '' AS c6", c[0], c[1])
		if i == 0 {
			q = row
		} else {
			q += " UNION ALL " + row
		}
	}
	if q == "" {
		q = "SELECT '' AS c1, '' AS c2, 'YES' AS c3, '' AS c4, '' AS c5, '' AS c6 LIMIT 0"
	}
	return q
}

// makeArrowIPCBytes builds a minimal Arrow IPC stream with one int64 column.
func makeArrowIPCBytes(t *testing.T) []byte {
	t.Helper()
	schema := arrow.NewSchema([]arrow.Field{
		{Name: "value", Type: arrow.PrimitiveTypes.Int64, Nullable: false},
	}, nil)
	bldr := array.NewInt64Builder(memory.DefaultAllocator)
	bldr.AppendValues([]int64{1, 2, 3}, nil)
	col := bldr.NewArray()
	defer col.Release()
	bldr.Release()
	rec := array.NewRecord(schema, []arrow.Array{col}, 3)
	defer rec.Release()

	var buf bytes.Buffer
	w := ipc.NewWriter(&buf, ipc.WithSchema(schema))
	if err := w.Write(rec); err != nil {
		t.Fatalf("write IPC record: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close IPC writer: %v", err)
	}
	return buf.Bytes()
}

// buildMultipart creates a multipart body with one file and optional fields.
func buildMultipart(t *testing.T, fileField, fileName string, fileData []byte, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile(fileField, fileName)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	fw.Write(fileData)
	for k, v := range fields {
		w.WriteField(k, v)
	}
	w.Close()
	return &buf, w.FormDataContentType()
}

// --- LoadArrow with valid Arrow IPC ---

func TestLoadArrow_ValidIPC(t *testing.T) {
	db := newMockDB(t)
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return db.db.ExecContext(ctx, query)
	}
	h := NewFlightSQLHandler(db)

	ipcData := makeArrowIPCBytes(t)
	buf, ct := buildMultipart(t, "arrowData", "data.arrow", ipcData, map[string]string{"tableName": "arrow_test"})

	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/load-arrow", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.LoadArrow(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for valid Arrow IPC, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- Upload TSV ---

func TestUpload_TSVSuccess_Boost(t *testing.T) {
	db := newMockDB(t)
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return db.db.ExecContext(ctx, query)
	}
	h := NewFlightSQLHandler(db)

	tsvData := []byte("id\tname\n1\talice\n2\tbob\n")
	buf, ct := buildMultipart(t, "file", "data.tsv", tsvData, map[string]string{"tableName": "test_tsv_boost"})
	req := httptest.NewRequest(http.MethodPost, "/api/flightsql/upload", buf)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.Upload(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for TSV upload, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- buildQueryClauses via DatasetPreview ---

func TestDatasetPreview_WithFiltersAndOrderBy(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}, {"name", "VARCHAR"}, {"amount", "DOUBLE"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id, 'alice' AS name, 10.5 AS amount")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Filters: []FilterCriteria{
			{Column: "amount", Op: ">", Value: "5"},
		},
		OrderBy: &OrderByParam{Column: "id", Direction: "DESC"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDatasetPreview_InvalidFilterColumn(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Filters:   []FilterCriteria{{Column: "nonexistent", Op: "=", Value: "1"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid filter column, got %d", rr.Code)
	}
}

func TestDatasetPreview_InvalidOperator(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Filters:   []FilterCriteria{{Column: "id", Op: "BADOP", Value: "1"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid operator, got %d", rr.Code)
	}
}

func TestDatasetPreview_IsNullFilter(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}, {"name", "VARCHAR"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id, 'alice' AS name")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Filters:   []FilterCriteria{{Column: "name", Op: "IS NULL"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDatasetPreview_InFilter(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}, {"status", "VARCHAR"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id, 'active' AS status")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Filters:   []FilterCriteria{{Column: "status", Op: "IN", Value: "active,pending"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with IN filter, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDatasetPreview_InvalidOrderByColumn(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		OrderBy:   &OrderByParam{Column: "nonexistent", Direction: "ASC"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid orderBy column, got %d", rr.Code)
	}
}

func TestDatasetPreview_OffsetCapped(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}})
	db.QueryContextArgsFn = describeCallFn(db, 1, descSQL, nil)
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		Offset:    10000, // exceeds maxOffset=5000
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["offsetCapped"] != true {
		t.Errorf("expected offsetCapped=true, got %v", resp["offsetCapped"])
	}
}

func TestDatasetPreview_PiiViewWithout(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{
		{"id", "INTEGER"}, {"name", "VARCHAR"}, {"pii_entities", "VARCHAR"}, {"has_pii", "BOOLEAN"},
	})
	// Called twice: once in buildQueryClauses, once for piiView=without column list
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		return db.simpleRows(descSQL)
	}
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id, 'alice' AS name")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		PiiView:   "without",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for piiView=without, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestDatasetPreview_PiiViewBoth(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{
		{"id", "INTEGER"}, {"pii_entities", "VARCHAR"},
	})
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		return db.simpleRows(descSQL)
	}
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		rows, err := db.simpleRows("SELECT 1 AS id, 'entity' AS pii_entities")
		return 1, rows, err
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(PreviewRequest{
		Namespace: "proj",
		Table:     "orders",
		Limit:     10,
		PiiView:   "both",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/preview", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for piiView=both, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if _, ok := resp["withoutPii"]; !ok {
		t.Error("expected 'withoutPii' key in response for piiView=both")
	}
}

// --- DatasetStats: SUMMARIZE scan path ---

func TestDatasetStats_SummarizeScanRows(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"amount", "DOUBLE"}})
	summarizeSQL := "SELECT 'amount' AS c1, 'DOUBLE' AS c2, '0.0' AS c3, '100.0' AS c4, '50' AS c5, '42.5' AS c6, '10.0' AS c7, '10.0' AS c8, '42.0' AS c9, '75.0' AS c10, '100' AS c11, '0.0' AS c12"

	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call == 1 {
			return db.simpleRows(descSQL) // buildQueryClauses
		}
		return db.simpleRows(summarizeSQL) // SUMMARIZE
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(StatsRequest{Namespace: "proj", Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- DatasetHistogram success paths ---

func TestDatasetHistogram_CategoricalSuccess(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"category", "VARCHAR"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call <= 2 { // describe + buildQueryClauses describe
			return db.simpleRows(descSQL)
		}
		// categorical histogram
		return db.simpleRows("SELECT 'electronics' AS val, 30 AS cnt UNION ALL SELECT 'clothing', 20")
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "category"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["type"] != "categorical" {
		t.Errorf("expected type=categorical, got %v", resp["type"])
	}
}

func TestDatasetHistogram_NumericSuccess(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"amount", "DOUBLE"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call <= 2 {
			return db.simpleRows(descSQL)
		}
		// Numeric histogram: 4 columns (bucket, lo, hi, cnt)
		return db.simpleRows("SELECT 1 AS bucket_idx, 0.0 AS bucket_lo, 10.0 AS bucket_hi, 5 AS cnt UNION ALL SELECT 2, 10.0, 20.0, 8")
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "amount"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["type"] != "numeric" {
		t.Errorf("expected type=numeric, got %v", resp["type"])
	}
}

func TestDatasetHistogram_NumericQueryError(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"amount", "DOUBLE"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call <= 2 {
			return db.simpleRows(descSQL)
		}
		return nil, fmt.Errorf("histogram query failed")
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "amount"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	// Numeric histogram error returns 200 with error field
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with error field, got %d", rr.Code)
	}
}

func TestDatasetHistogram_CategoricalQueryError(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"status", "VARCHAR"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call <= 2 {
			return db.simpleRows(descSQL)
		}
		return nil, fmt.Errorf("categorical query failed")
	}
	h := NewFlightSQLHandler(db)

	body, _ := json.Marshal(HistogramRequest{Namespace: "proj", Table: "orders", Column: "status"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/histogram", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetHistogram(rr, req)
	// Same pattern: 200 with error field
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with error field, got %d", rr.Code)
	}
}

// --- AgentStats with actual scan rows ---

func TestAgentStats_ScanRows(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		// 12-column result matching the SUMMARIZE SELECT
		return db.simpleRows(
			"SELECT 'col1' AS a, 'INTEGER' AS b, '1' AS c, '100' AS d, '50' AS e, '50.5' AS f, '10.0' AS g, '25' AS h, '50' AS i, '75' AS j, '100' AS k, '5.0' AS l",
		)
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/stats", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentStats(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- agentDatasetsShowTables with rows ---

func TestAgentDatasets_ShowTablesScanRows(t *testing.T) {
	db := newMockDB(t)
	call := 0
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		call++
		if call == 1 {
			return nil, fmt.Errorf("info_schema not supported")
		}
		// SHOW ALL TABLES: return rows with database, schema, name columns
		return db.simpleRows(
			"SELECT 'iceberg' AS database, 'proj-123' AS schema, 'orders' AS name" +
				" UNION ALL SELECT 'iceberg', 'proj-123', 'products'" +
				" UNION ALL SELECT 'memory', 'main', 'other'",
		)
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/datasets", "proj-123", nil)
	rr := httptest.NewRecorder()
	h.AgentDatasets(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

// --- AgentPreview invalid body (empty table) ---

func TestAgentPreview_EmptyTable(t *testing.T) {
	db := newMockDB(t)
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]interface{}{"table": "", "limit": 10})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/preview", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentPreview(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty table, got %d", rr.Code)
	}
}

// --- AgentPreview scan rows ---

func TestAgentPreview_ScanRows(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 1 AS id, 'alice' AS name, 42.5 AS score")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]interface{}{"table": "orders", "limit": 10})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/preview", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentPreview(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if cols, ok := resp["columns"].([]interface{}); !ok || len(cols) == 0 {
		t.Errorf("expected columns, got %v", resp["columns"])
	}
}

// --- DatasetStats: manualStats fallback ---

func TestDatasetStats_ManualStatsFallback(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}, {"name", "VARCHAR"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		switch call {
		case 1:
			return db.simpleRows(descSQL) // buildQueryClauses/describeColumns
		case 2:
			return nil, fmt.Errorf("SUMMARIZE not supported") // SUMMARIZE fails → manualStats
		default:
			return db.simpleRows(descSQL) // manualStats DESCRIBE
		}
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(StatsRequest{Namespace: "proj", Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for manualStats fallback, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if _, ok := resp["stats"]; !ok {
		t.Error("expected 'stats' key in fallback response")
	}
}

func TestDatasetStats_ManualStatsFallback_DescribeFails(t *testing.T) {
	db := newMockDB(t)
	descSQL := buildDescribeSQL([][2]string{{"id", "INTEGER"}})
	call := 0
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		call++
		if call == 1 {
			return db.simpleRows(descSQL) // buildQueryClauses
		}
		if call == 2 {
			return nil, fmt.Errorf("SUMMARIZE failed") // SUMMARIZE fails
		}
		return nil, fmt.Errorf("DESCRIBE also failed") // manualStats describe fails
	}
	h := NewFlightSQLHandler(db)
	body, _ := json.Marshal(StatsRequest{Namespace: "proj", Table: "orders"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/datasets/stats", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	h.DatasetStats(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 with error field, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp map[string]interface{}
	json.NewDecoder(rr.Body).Decode(&resp)
	if resp["partial"] != true {
		t.Errorf("expected partial=true on double failure, got %v", resp["partial"])
	}
}

// --- Query: cache hit path ---

func TestQuery_MetadataCacheHit(t *testing.T) {
	db := newMockDB(t)
	h := NewFlightSQLHandler(db)

	// First request with a DESCRIBE metadata query
	body, _ := json.Marshal(QueryRequest{Query: "DESCRIBE test"})
	req1 := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body))
	req1.Header.Set("Accept", "application/json")
	rr1 := httptest.NewRecorder()
	h.Query(rr1, req1)

	// Second identical request: should be a cache hit
	body2, _ := json.Marshal(QueryRequest{Query: "DESCRIBE test"})
	req2 := httptest.NewRequest(http.MethodPost, "/api/flightsql/query", bytes.NewReader(body2))
	req2.Header.Set("Accept", "application/json")
	rr2 := httptest.NewRecorder()
	h.Query(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Errorf("expected 200 on second (cached) request, got %d", rr2.Code)
	}
}

// --- AgentDescribe with empty result (no columns in scan) ---

func TestAgentDescribe_EmptyColumns(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		// Return 0 rows → empty columns list
		return db.simpleRows("SELECT '' AS c1, '' AS c2, '' AS c3, '' AS c4, '' AS c5, '' AS c6 LIMIT 0")
	}
	h := &AgentHandler{dbMgr: db, metrics: NewMetrics(), tenantQueue: services.NewTenantQueue(), maxRows: 500, stmtTimeout: 30 * time.Second}
	body, _ := json.Marshal(map[string]string{"table": "orders"})
	req := requestWithProjectID(http.MethodPost, "/api/v1/agent/describe", "proj-123", body)
	rr := httptest.NewRecorder()
	h.AgentDescribe(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

// --- AgentHistogram success (scan path) ---

func TestAgentHistogram_ScanRows(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT 'cat_a' AS val, 10 AS cnt UNION ALL SELECT NULL::VARCHAR, 5")
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

// --- AgentQuery: rows.Err path ---

func TestAgentQuery_Success_MultipleRows(t *testing.T) {
	db := newMockDB(t)
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return db.simpleRows("SELECT * FROM (VALUES (1, 'a'), (2, 'b'), (3, 'c')) t(id, name)")
	}

	v, err := services.NewSQLValidator("")
	if err != nil {
		t.Skipf("Skipping: %v", err)
	}
	defer v.Close()

	h := &AgentHandler{
		dbMgr:       db,
		validator:   v,
		tenantQueue: services.NewTenantQueue(),
		metrics:     NewMetrics(),
		maxRows:     500,
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
	rows, ok := resp["rows"].([]interface{})
	if !ok {
		t.Errorf("expected rows array, got %T: %v", resp["rows"], resp["rows"])
	}
	_ = rows
}

// --- requireProjectID: missing header returns empty string and 403 ---

func TestRequireProjectID_MissingHeader_Returns403(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	// No X-Project-ID header and no claims in context → should return empty string and write 403.
	pid := requireProjectID(rr, req)
	if pid != "" {
		t.Errorf("expected empty project ID, got %q", pid)
	}
	if rr.Code != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden, got %d", rr.Code)
	}
}
