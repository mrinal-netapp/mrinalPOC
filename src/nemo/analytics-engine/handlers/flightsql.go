package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"agentstudio/nemo/analytics-engine/services"
	"agentstudio/nemo/analytics-engine/utils"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
)

// FlightSQLHandler handles flightSQL proxy endpoints
type FlightSQLHandler struct {
	metrics *Metrics
	dbMgr   services.DBQuerier
}

// NewFlightSQLHandler creates a new FlightSQL handler
func NewFlightSQLHandler(dbMgr services.DBQuerier) *FlightSQLHandler {
	return &FlightSQLHandler{
		metrics: NewMetrics(),
		dbMgr:   dbMgr,
	}
}

// QueryRequest represents a query request
type QueryRequest struct {
	Query string `json:"query"`
}

// SuccessResponse represents a success response
type SuccessResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Detail string `json:"detail"`
}

// Connect tests the DuckDB connection
func (h *FlightSQLHandler) Connect(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/connect", time.Since(startTime), nil)
	}()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	rows, err := h.dbMgr.QueryContext(ctx, "SELECT 1")
	if err != nil {
		utils.Error("Connection test failed: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to connect: %v", err))
		h.metrics.RecordConnectionError()
		return
	}
	rows.Close()

	utils.Info("Connection test successful")
	h.writeJSON(w, http.StatusOK, SuccessResponse{
		Success: true,
		Message: "Connected successfully",
	})
}

// Disconnect is a no-op (in-process DuckDB, no per-request connection)
func (h *FlightSQLHandler) Disconnect(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/disconnect", time.Since(startTime), nil)
	}()

	h.writeJSON(w, http.StatusOK, SuccessResponse{
		Success: true,
		Message: "Disconnected successfully",
	})
}

// --- Dataset Preview Request/Response types ---

type FilterCriteria struct {
	Column string `json:"column"`
	Op     string `json:"op"`
	Value  string `json:"value,omitempty"`
}

type OrderByParam struct {
	Column    string `json:"column"`
	Direction string `json:"direction"`
}

type PreviewRequest struct {
	Namespace string           `json:"namespace"`
	Table     string           `json:"table"`
	Limit     int              `json:"limit"`
	Offset    int              `json:"offset"`
	Filters   []FilterCriteria `json:"filters,omitempty"`
	OrderBy   *OrderByParam    `json:"orderBy,omitempty"`
	// PiiView controls projection of PII columns in the response:
	//   "with"    (default) — include all columns
	//   "without"           — exclude pii_* / sensitivity_class / has_pii columns
	//   "both"              — return two result blocks side-by-side (withPii / withoutPii)
	PiiView string `json:"piiView,omitempty"`
}

// piiColumnNames are the per-file PII metadata columns added by the
// dataset-processor PII reprocessor (see workers/dataset-processor/processing/pii.py).
// They are filtered out in piiView=without and split into two blocks in piiView=both.
var piiColumnNames = map[string]struct{}{
	"pii_entities":      {},
	"pii_count":         {},
	"pii_risk_level":    {},
	"sensitivity_class": {},
	"has_pii":           {},
}

// isPiiColumn reports whether a column belongs to the PII metadata projection.
func isPiiColumn(name string) bool {
	_, ok := piiColumnNames[strings.ToLower(name)]
	return ok
}

// projectionFromColumns returns the columns to SELECT given a desired piiView.
// Returns nil to mean "SELECT *". The fallback to *-projection prevents this
// helper from breaking older tables that have no PII columns.
func projectionFromColumns(allColumns []string, piiView string) []string {
	view := strings.ToLower(strings.TrimSpace(piiView))
	if view == "" || view == "with" {
		return nil
	}
	if view != "without" {
		return nil
	}
	kept := make([]string, 0, len(allColumns))
	for _, c := range allColumns {
		if isPiiColumn(c) {
			continue
		}
		kept = append(kept, c)
	}
	return kept
}

// filterRowToColumns returns a new row containing only values whose column
// name is in keepCols. Used to build the `withoutPii` block of a side-by-side
// response without re-querying.
func filterRowToColumns(row []interface{}, allColumns []string, keepCols map[string]struct{}) []interface{} {
	out := make([]interface{}, 0, len(keepCols))
	for i, c := range allColumns {
		if _, ok := keepCols[c]; ok && i < len(row) {
			out = append(out, row[i])
		}
	}
	return out
}

type StatsRequest struct {
	Namespace string           `json:"namespace"`
	Table     string           `json:"table"`
	Filters   []FilterCriteria `json:"filters,omitempty"`
}

type HistogramRequest struct {
	Namespace string           `json:"namespace"`
	Table     string           `json:"table"`
	Column    string           `json:"column"`
	Filters   []FilterCriteria `json:"filters,omitempty"`
}

// validOps is the whitelist of allowed SQL operators for filter criteria.
var validOps = map[string]string{
	"=": "=", "!=": "!=", ">": ">", "<": "<",
	">=": ">=", "<=": "<=",
	"LIKE": "LIKE", "NOT LIKE": "NOT LIKE",
	"IS NULL": "IS NULL", "IS NOT NULL": "IS NOT NULL",
	"IN": "IN",
}

const maxOffset = 5000

// escapeColumnName double-quotes a column name, escaping internal quotes.
func escapeColumnName(col string) string {
	return `"` + strings.ReplaceAll(col, `"`, `""`) + `"`
}

// describeColumns fetches valid column names for an Iceberg table via DESCRIBE.
func (h *FlightSQLHandler) describeColumns(ctx context.Context, namespace, table string) (map[string]string, error) {
	ns := strings.ReplaceAll(namespace, `"`, `""`)
	tbl := strings.ReplaceAll(table, `"`, `""`)
	query := fmt.Sprintf(`DESCRIBE iceberg."%s"."%s"`, ns, tbl)

	rows, err := h.dbMgr.QueryContextWithRetry(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("DESCRIBE failed: %w", err)
	}
	defer rows.Close()

	cols := make(map[string]string)
	for rows.Next() {
		var colName, colType, isNull, key, defaultVal, extra sql.NullString
		if err := rows.Scan(&colName, &colType, &isNull, &key, &defaultVal, &extra); err != nil {
			return nil, fmt.Errorf("scanning DESCRIBE row: %w", err)
		}
		if colName.Valid {
			cols[colName.String] = colType.String
		}
	}
	return cols, rows.Err()
}

// buildQueryClauses constructs validated WHERE and ORDER BY clauses from structured input.
// It validates all column names against the schema via DESCRIBE and uses ? parameterized values.
func (h *FlightSQLHandler) buildQueryClauses(
	ctx context.Context,
	namespace, table string,
	filters []FilterCriteria,
	orderBy *OrderByParam,
) (whereClause string, orderByClause string, args []interface{}, err error) {
	validColumns, err := h.describeColumns(ctx, namespace, table)
	if err != nil {
		return "", "", nil, err
	}

	// Build WHERE clause
	var conditions []string
	for _, f := range filters {
		if _, ok := validColumns[f.Column]; !ok {
			return "", "", nil, fmt.Errorf("invalid filter column: %q", f.Column)
		}
		sqlOp, ok := validOps[strings.ToUpper(f.Op)]
		if !ok {
			return "", "", nil, fmt.Errorf("invalid operator: %q", f.Op)
		}

		col := escapeColumnName(f.Column)
		switch sqlOp {
		case "IS NULL", "IS NOT NULL":
			conditions = append(conditions, fmt.Sprintf("%s %s", col, sqlOp))
		case "IN":
			parts := strings.Split(f.Value, ",")
			placeholders := make([]string, len(parts))
			for i, p := range parts {
				placeholders[i] = "?"
				args = append(args, strings.TrimSpace(p))
			}
			conditions = append(conditions, fmt.Sprintf("%s IN (%s)", col, strings.Join(placeholders, ", ")))
		default:
			conditions = append(conditions, fmt.Sprintf("%s %s ?", col, sqlOp))
			args = append(args, f.Value)
		}
	}

	if len(conditions) > 0 {
		whereClause = " WHERE " + strings.Join(conditions, " AND ")
	}

	// Build ORDER BY clause
	if orderBy != nil && orderBy.Column != "" {
		if _, ok := validColumns[orderBy.Column]; !ok {
			return "", "", nil, fmt.Errorf("invalid orderBy column: %q", orderBy.Column)
		}
		dir := "ASC"
		if strings.ToUpper(orderBy.Direction) == "DESC" {
			dir = "DESC"
		}
		orderByClause = fmt.Sprintf(" ORDER BY %s %s", escapeColumnName(orderBy.Column), dir)
	}

	return whereClause, orderByClause, args, nil
}

// DatasetPreview returns a paginated, filterable preview of an Iceberg dataset table.
// POST /api/v1/datasets/preview
func (h *FlightSQLHandler) DatasetPreview(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var queryErr error
	defer func() {
		h.metrics.RecordRequest("/api/v1/datasets/preview", time.Since(startTime), queryErr)
	}()

	var req PreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Namespace == "" || req.Table == "" {
		h.writeError(w, http.StatusBadRequest, "namespace and table are required")
		return
	}

	if req.Limit <= 0 || req.Limit > 500 {
		req.Limit = 50
	}
	if req.Offset < 0 {
		req.Offset = 0
	}

	offsetCapped := false
	if req.Offset > maxOffset {
		req.Offset = maxOffset
		offsetCapped = true
	}

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	whereClause, orderByClause, args, err := h.buildQueryClauses(ctx, req.Namespace, req.Table, req.Filters, req.OrderBy)
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid filter/sort: %v", err))
		return
	}

	ns := strings.ReplaceAll(req.Namespace, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	tableRef := fmt.Sprintf(`iceberg."%s"."%s"`, ns, tbl)

	// Resolve the SELECT list once based on piiView. For `without` we trim the
	// PII columns at the SQL level; for `with` and `both` we keep SELECT *.
	view := strings.ToLower(strings.TrimSpace(req.PiiView))
	selectList := "*"
	if view == "without" {
		schemaCols, descErr := h.describeColumns(ctx, req.Namespace, req.Table)
		if descErr != nil {
			queryErr = descErr
			h.writeError(w, http.StatusBadRequest, fmt.Sprintf("DESCRIBE failed: %v", descErr))
			return
		}
		// Map iteration in Go is nondeterministic. Sort column names so the
		// resulting SELECT list (and therefore the response column order) is
		// stable across requests for the same table.
		colNames := make([]string, 0, len(schemaCols))
		for c := range schemaCols {
			colNames = append(colNames, c)
		}
		sort.Strings(colNames)
		kept := projectionFromColumns(colNames, "without")
		if len(kept) > 0 {
			quoted := make([]string, len(kept))
			for i, c := range kept {
				quoted[i] = escapeColumnName(c)
			}
			selectList = strings.Join(quoted, ", ")
		}
	}

	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM %s%s", tableRef, whereClause)
	dataSQL := fmt.Sprintf("SELECT %s FROM %s%s%s LIMIT %d OFFSET %d", selectList, tableRef, whereClause, orderByClause, req.Limit, req.Offset)

	totalCount, rows, err := h.dbMgr.QueryWithCountContext(ctx, countSQL, args, dataSQL, args)
	if err != nil {
		queryErr = err
		utils.Error("Dataset preview query failed: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Query failed: %v", err))
		h.metrics.RecordQueryError()
		return
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to get columns: %v", err))
		return
	}

	colTypes, err := rows.ColumnTypes()
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to get column types: %v", err))
		return
	}

	typeNames := make([]string, len(colTypes))
	for i, ct := range colTypes {
		typeNames[i] = ct.DatabaseTypeName()
	}

	var allRows [][]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			queryErr = err
			h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to read results: %v", err))
			return
		}
		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		allRows = append(allRows, row)
	}
	if err := rows.Err(); err != nil {
		queryErr = err
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Error reading results: %v", err))
		return
	}

	resp := map[string]interface{}{
		"columns":       columns,
		"columnTypes":   typeNames,
		"rows":          allRows,
		"rowCount":      len(allRows),
		"totalCount":    totalCount,
		"offsetCapped":  offsetCapped,
		"executionTime": time.Since(startTime).Milliseconds(),
	}

	// piiView=both: also include a parallel `withoutPii` projection so the GUI
	// can render a side-by-side preview. The primary response continues to be
	// the with-PII view (so existing clients keep working).
	if view == "both" {
		keep := make(map[string]struct{}, len(columns))
		keptCols := make([]string, 0, len(columns))
		keptTypes := make([]string, 0, len(columns))
		for i, c := range columns {
			if isPiiColumn(c) {
				continue
			}
			keep[c] = struct{}{}
			keptCols = append(keptCols, c)
			if i < len(typeNames) {
				keptTypes = append(keptTypes, typeNames[i])
			}
		}
		filteredRows := make([][]interface{}, 0, len(allRows))
		for _, row := range allRows {
			filteredRows = append(filteredRows, filterRowToColumns(row, columns, keep))
		}
		resp["withoutPii"] = map[string]interface{}{
			"columns":     keptCols,
			"columnTypes": keptTypes,
			"rows":        filteredRows,
		}
	}

	h.writeJSON(w, http.StatusOK, resp)
}

// DatasetStats returns per-column statistics for an Iceberg dataset table.
// POST /api/v1/datasets/stats
func (h *FlightSQLHandler) DatasetStats(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var queryErr error
	defer func() {
		h.metrics.RecordRequest("/api/v1/datasets/stats", time.Since(startTime), queryErr)
	}()

	var req StatsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Namespace == "" || req.Table == "" {
		h.writeError(w, http.StatusBadRequest, "namespace and table are required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	whereClause, _, args, err := h.buildQueryClauses(ctx, req.Namespace, req.Table, req.Filters, nil)
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid filters: %v", err))
		return
	}

	ns := strings.ReplaceAll(req.Namespace, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	tableRef := fmt.Sprintf(`iceberg."%s"."%s"`, ns, tbl)

	summarizeSQL := fmt.Sprintf(
		"SELECT column_name, column_type, min, max, approx_unique, avg, std, q25, q50, q75, count, null_percentage::VARCHAR AS null_percentage FROM (SUMMARIZE SELECT * FROM %s%s)",
		tableRef, whereClause,
	)
	rows, err := h.dbMgr.QueryContextArgs(ctx, summarizeSQL, args...)
	if err != nil {
		utils.Warn("SUMMARIZE failed, falling back to manual aggregates: %v", err)
		stats, partial, fallbackErr := h.manualStats(ctx, tableRef, whereClause, args)
		if fallbackErr != nil {
			queryErr = fallbackErr
			h.writeJSON(w, http.StatusOK, map[string]interface{}{
				"stats":   map[string]interface{}{},
				"partial": true,
				"error":   fmt.Sprintf("Stats unavailable: %v", fallbackErr),
			})
			return
		}
		h.writeJSON(w, http.StatusOK, map[string]interface{}{
			"stats":   stats,
			"partial": partial,
			"error":   "",
		})
		return
	}
	defer rows.Close()

	stats := make(map[string]interface{})
	for rows.Next() {
		var colName, colType, minVal, maxVal, approxUnique, avg, std, q25, q50, q75, count, nullPct sql.NullString
		if err := rows.Scan(&colName, &colType, &minVal, &maxVal, &approxUnique, &avg, &std, &q25, &q50, &q75, &count, &nullPct); err != nil {
			queryErr = err
			h.writeJSON(w, http.StatusOK, map[string]interface{}{
				"stats":   stats,
				"partial": true,
				"error":   fmt.Sprintf("Error reading SUMMARIZE results: %v", err),
			})
			return
		}
		if !colName.Valid {
			continue
		}
		stat := map[string]interface{}{
			"type": colType.String,
		}
		if minVal.Valid {
			stat["min"] = minVal.String
		}
		if maxVal.Valid {
			stat["max"] = maxVal.String
		}
		if avg.Valid {
			stat["avg"] = avg.String
		}
		if q25.Valid {
			stat["q25"] = q25.String
		}
		if q50.Valid {
			stat["q50"] = q50.String
		}
		if q75.Valid {
			stat["q75"] = q75.String
		}
		if approxUnique.Valid {
			if v, err := strconv.ParseInt(approxUnique.String, 10, 64); err == nil {
				stat["approxUnique"] = v
			}
		}
		if count.Valid {
			if v, err := strconv.ParseInt(count.String, 10, 64); err == nil {
				stat["count"] = v
			}
		}
		if nullPct.Valid {
			if v, err := strconv.ParseFloat(nullPct.String, 64); err == nil {
				stat["nullPercentage"] = v
			}
		}
		stats[colName.String] = stat
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"stats":   stats,
		"partial": false,
		"error":   "",
	})
}

// manualStats computes basic statistics when SUMMARIZE fails.
func (h *FlightSQLHandler) manualStats(ctx context.Context, tableRef, whereClause string, args []interface{}) (map[string]interface{}, bool, error) {
	describeRows, err := h.dbMgr.QueryContextArgs(ctx, fmt.Sprintf("DESCRIBE %s", tableRef))
	if err != nil {
		return nil, true, err
	}
	defer describeRows.Close()

	type colInfo struct {
		name    string
		colType string
	}
	var cols []colInfo
	for describeRows.Next() {
		var cName, cType, isNull, key, defaultVal, extra sql.NullString
		if err := describeRows.Scan(&cName, &cType, &isNull, &key, &defaultVal, &extra); err != nil {
			return nil, true, err
		}
		if cName.Valid {
			cols = append(cols, colInfo{cName.String, cType.String})
		}
	}

	if len(cols) > 10 {
		cols = cols[:10]
	}

	stats := make(map[string]interface{})
	for _, c := range cols {
		col := escapeColumnName(c.name)
		q := fmt.Sprintf(
			`SELECT COUNT(*) AS cnt, COUNT(DISTINCT %s) AS uniq, MIN(%s) AS min_val, MAX(%s) AS max_val FROM %s%s`,
			col, col, col, tableRef, whereClause,
		)
		var cnt, uniq sql.NullInt64
		var minVal, maxVal sql.NullString
		if err := h.dbMgr.DB().QueryRowContext(ctx, q, args...).Scan(&cnt, &uniq, &minVal, &maxVal); err != nil {
			continue
		}
		stat := map[string]interface{}{"type": c.colType}
		if cnt.Valid {
			stat["count"] = cnt.Int64
		}
		if uniq.Valid {
			stat["approxUnique"] = uniq.Int64
		}
		if minVal.Valid {
			stat["min"] = minVal.String
		}
		if maxVal.Valid {
			stat["max"] = maxVal.String
		}
		stats[c.name] = stat
	}
	return stats, false, nil
}

// DatasetHistogram returns histogram data for a single column.
// POST /api/v1/datasets/histogram
func (h *FlightSQLHandler) DatasetHistogram(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var queryErr error
	defer func() {
		h.metrics.RecordRequest("/api/v1/datasets/histogram", time.Since(startTime), queryErr)
	}()

	var req HistogramRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Namespace == "" || req.Table == "" || req.Column == "" {
		h.writeError(w, http.StatusBadRequest, "namespace, table, and column are required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	validCols, err := h.describeColumns(ctx, req.Namespace, req.Table)
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Failed to describe table: %v", err))
		return
	}
	colType, ok := validCols[req.Column]
	if !ok {
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid column: %q", req.Column))
		return
	}

	whereClause, _, args, err := h.buildQueryClauses(ctx, req.Namespace, req.Table, req.Filters, nil)
	if err != nil {
		queryErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Invalid filters: %v", err))
		return
	}

	ns := strings.ReplaceAll(req.Namespace, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	tableRef := fmt.Sprintf(`iceberg."%s"."%s"`, ns, tbl)
	col := escapeColumnName(req.Column)

	isNumeric := isNumericType(colType)

	type bucket struct {
		Label string `json:"label"`
		Count int64  `json:"count"`
	}
	var buckets []bucket
	histType := "categorical"

	if isNumeric {
		histType = "numeric"
		q := fmt.Sprintf(
			`WITH bounds AS (SELECT MIN(%s)::DOUBLE AS lo, MAX(%s)::DOUBLE AS hi FROM %s%s)
			SELECT WIDTH_BUCKET(%s::DOUBLE, lo, CASE WHEN hi = lo THEN lo + 1 ELSE hi END, 10) AS bucket,
			       lo + (CASE WHEN hi = lo THEN 1 ELSE hi - lo END) * (WIDTH_BUCKET(%s::DOUBLE, lo, CASE WHEN hi = lo THEN lo + 1 ELSE hi END, 10) - 1) / 10.0 AS bucket_lo,
			       lo + (CASE WHEN hi = lo THEN 1 ELSE hi - lo END) * WIDTH_BUCKET(%s::DOUBLE, lo, CASE WHEN hi = lo THEN lo + 1 ELSE hi END, 10) / 10.0 AS bucket_hi,
			       COUNT(*) AS cnt
			FROM %s, bounds%s
			WHERE %s IS NOT NULL
			GROUP BY 1,2,3 ORDER BY 1`,
			col, col, tableRef, whereClause,
			col, col, col,
			tableRef, whereClause,
			col,
		)
		doubleArgs := append(args, args...)
		rows, err := h.dbMgr.QueryContextArgs(ctx, q, doubleArgs...)
		if err != nil {
			queryErr = err
			h.writeJSON(w, http.StatusOK, map[string]interface{}{
				"column":  req.Column,
				"type":    histType,
				"buckets": []interface{}{},
				"error":   fmt.Sprintf("Histogram query failed: %v", err),
			})
			return
		}
		defer rows.Close()

		for rows.Next() {
			var bucketIdx sql.NullInt64
			var lo, hi sql.NullFloat64
			var cnt int64
			if err := rows.Scan(&bucketIdx, &lo, &hi, &cnt); err != nil {
				continue
			}
			label := fmt.Sprintf("%.2f-%.2f", lo.Float64, hi.Float64)
			buckets = append(buckets, bucket{Label: label, Count: cnt})
		}
	} else {
		q := fmt.Sprintf(
			`SELECT CAST(%s AS VARCHAR) AS val, COUNT(*) AS cnt FROM %s%s WHERE %s IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
			col, tableRef, whereClause, col,
		)
		rows, err := h.dbMgr.QueryContextArgs(ctx, q, args...)
		if err != nil {
			queryErr = err
			h.writeJSON(w, http.StatusOK, map[string]interface{}{
				"column":  req.Column,
				"type":    histType,
				"buckets": []interface{}{},
				"error":   fmt.Sprintf("Histogram query failed: %v", err),
			})
			return
		}
		defer rows.Close()

		for rows.Next() {
			var val sql.NullString
			var cnt int64
			if err := rows.Scan(&val, &cnt); err != nil {
				continue
			}
			label := ""
			if val.Valid {
				label = val.String
			}
			buckets = append(buckets, bucket{Label: label, Count: cnt})
		}
	}

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"column":  req.Column,
		"type":    histType,
		"buckets": buckets,
		"error":   "",
	})
}

func isNumericType(t string) bool {
	upper := strings.ToUpper(t)
	numericTypes := []string{"INTEGER", "BIGINT", "SMALLINT", "TINYINT", "DOUBLE", "FLOAT", "REAL", "DECIMAL", "HUGEINT", "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "NUMERIC"}
	for _, n := range numericTypes {
		if strings.Contains(upper, n) {
			return true
		}
	}
	return false
}

// Query executes a SQL query and returns JSON or Arrow IPC format
func (h *FlightSQLHandler) Query(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var queryErr error
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/query", time.Since(startTime), queryErr)
	}()

	var req QueryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Query == "" {
		h.writeError(w, http.StatusBadRequest, "Query is required")
		return
	}

	cache := services.GetQueryCache()
	cacheKey := services.GetCacheKey(req.Query)
	if cachedData, found := cache.Get(cacheKey); found {
		utils.Debug("Cache hit for query: %s", req.Query[:min(50, len(req.Query))])
		h.metrics.RecordCacheHit()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(cachedData)
		return
	}
	h.metrics.RecordCacheMiss()

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	acceptHeader := r.Header.Get("Accept")
	returnJSON := acceptHeader == "application/json" || strings.Contains(acceptHeader, "application/json")

	if returnJSON {
		h.queryJSON(ctx, w, req, cache, cacheKey, startTime, &queryErr)
	} else {
		h.queryArrowIPC(ctx, w, req, cache, cacheKey, startTime, &queryErr)
	}
}

func (h *FlightSQLHandler) queryJSON(ctx context.Context, w http.ResponseWriter, req QueryRequest, cache *services.QueryCache, cacheKey string, startTime time.Time, queryErr *error) {
	rows, err := h.dbMgr.QueryContext(ctx, req.Query)
	if err != nil {
		*queryErr = err
		utils.Error("Query execution failed: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Query failed: %v", err))
		h.metrics.RecordQueryError()
		return
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		*queryErr = err
		utils.Error("Failed to get columns: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to get columns: %v", err))
		return
	}

	var allRows [][]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			*queryErr = err
			utils.Error("Failed to scan row: %v", err)
			h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to read results: %v", err))
			return
		}

		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		allRows = append(allRows, row)
	}

	if err := rows.Err(); err != nil {
		*queryErr = err
		utils.Error("Error reading results: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Error reading results: %v", err))
		return
	}

	result := map[string]interface{}{
		"columns":       columns,
		"rows":          allRows,
		"rowCount":      len(allRows),
		"executionTime": time.Since(startTime).Milliseconds(),
	}

	if cacheKey != "" {
		jsonData, _ := json.Marshal(result)
		cache.Set(cacheKey, jsonData)
		utils.Debug("Cached query result (JSON): %s", req.Query[:min(50, len(req.Query))])
	}

	h.writeJSON(w, http.StatusOK, result)
}

// queryArrowIPC is implemented in flightsql_arrow.go (requires duckdb_arrow build tag)

// Upload handles file upload and loads into database
func (h *FlightSQLHandler) Upload(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var uploadErr error
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/upload", time.Since(startTime), uploadErr)
	}()

	if err := r.ParseMultipartForm(100 << 20); err != nil {
		h.writeError(w, http.StatusBadRequest, "Failed to parse multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "File is required")
		return
	}
	defer file.Close()

	tableName := r.FormValue("tableName")
	if tableName == "" {
		h.writeError(w, http.StatusBadRequest, "tableName is required")
		return
	}

	fileContent, err := io.ReadAll(file)
	if err != nil {
		uploadErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Failed to read file: %v", err))
		return
	}

	fileName := header.Filename
	fileExt := ""
	if idx := strings.LastIndex(fileName, "."); idx >= 0 {
		fileExt = strings.ToLower(fileName[idx+1:])
	}

	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()

	var rows int64
	switch fileExt {
	case "parquet":
		rows, err = h.loadParquetFile(ctx, fileContent, tableName)
	case "csv", "tsv":
		delimiter := ","
		if fileExt == "tsv" {
			delimiter = "\t"
		}
		rows, err = h.loadCSVFile(ctx, fileContent, tableName, delimiter)
	case "json":
		rows, err = h.loadJSONFile(ctx, fileContent, tableName)
	default:
		uploadErr = fmt.Errorf("unsupported file type: %s", fileExt)
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Unsupported file type: %s. Supported: csv, tsv, parquet, json", fileExt))
		return
	}

	if err != nil {
		uploadErr = err
		utils.Error("Failed to load file: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to load file: %v", err))
		return
	}

	cache := services.GetQueryCache()
	cache.Clear()

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("File uploaded successfully. %d rows loaded into %s", rows, tableName),
		"rows":    rows,
	})
}

// LoadArrow loads Arrow IPC data into database
func (h *FlightSQLHandler) LoadArrow(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var loadErr error
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/load-arrow", time.Since(startTime), loadErr)
	}()

	if err := r.ParseMultipartForm(100 << 20); err != nil {
		h.writeError(w, http.StatusBadRequest, "Failed to parse multipart form")
		return
	}

	arrowDataFile, _, err := r.FormFile("arrowData")
	if err != nil {
		h.writeError(w, http.StatusBadRequest, "arrowData is required")
		return
	}
	defer arrowDataFile.Close()

	tableName := r.FormValue("tableName")
	if tableName == "" {
		h.writeError(w, http.StatusBadRequest, "tableName is required")
		return
	}

	arrowData, err := io.ReadAll(arrowDataFile)
	if err != nil {
		loadErr = err
		h.writeError(w, http.StatusBadRequest, fmt.Sprintf("Failed to read arrow data: %v", err))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()

	rows, err := h.loadArrowData(ctx, arrowData, tableName)
	if err != nil {
		loadErr = err
		utils.Error("Failed to load arrow data: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to load arrow data: %v", err))
		return
	}

	cache := services.GetQueryCache()
	cache.Clear()

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Arrow data loaded into table %s", tableName),
		"rows":    rows,
	})
}

// LoadObjects loads JavaScript objects into database
func (h *FlightSQLHandler) LoadObjects(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	var loadErr error
	defer func() {
		h.metrics.RecordRequest("/api/flightsql/load-objects", time.Since(startTime), loadErr)
	}()

	var req struct {
		Data      []map[string]interface{} `json:"data"`
		TableName string                   `json:"tableName"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(req.Data) == 0 {
		h.writeError(w, http.StatusBadRequest, "data must be a non-empty array")
		return
	}

	if req.TableName == "" {
		h.writeError(w, http.StatusBadRequest, "tableName is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()

	rows, err := h.loadObjects(ctx, req.Data, req.TableName)
	if err != nil {
		loadErr = err
		utils.Error("Failed to load objects: %v", err)
		h.writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to load objects: %v", err))
		return
	}

	cache := services.GetQueryCache()
	cache.Clear()

	h.writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Objects loaded into table %s", req.TableName),
		"rows":    rows,
	})
}

// --- File loading helpers (write to temp file, load via DuckDB's native file readers) ---

func (h *FlightSQLHandler) loadParquetFile(ctx context.Context, data []byte, tableName string) (int64, error) {
	tmpFile, err := writeTempFile(data, "upload_*.parquet")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmpFile)

	query := fmt.Sprintf("CREATE OR REPLACE TABLE \"%s\" AS SELECT * FROM read_parquet('%s')", tableName, tmpFile)
	result, err := h.dbMgr.ExecContext(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("read_parquet failed: %w", err)
	}
	return result.RowsAffected()
}

func (h *FlightSQLHandler) loadCSVFile(ctx context.Context, data []byte, tableName string, delimiter string) (int64, error) {
	tmpFile, err := writeTempFile(data, "upload_*.csv")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmpFile)

	query := fmt.Sprintf("CREATE OR REPLACE TABLE \"%s\" AS SELECT * FROM read_csv('%s', delim='%s', auto_detect=true)", tableName, tmpFile, delimiter)
	result, err := h.dbMgr.ExecContext(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("read_csv failed: %w", err)
	}
	return result.RowsAffected()
}

func (h *FlightSQLHandler) loadJSONFile(ctx context.Context, data []byte, tableName string) (int64, error) {
	tmpFile, err := writeTempFile(data, "upload_*.json")
	if err != nil {
		return 0, err
	}
	defer os.Remove(tmpFile)

	query := fmt.Sprintf("CREATE OR REPLACE TABLE \"%s\" AS SELECT * FROM read_json('%s', auto_detect=true)", tableName, tmpFile)
	result, err := h.dbMgr.ExecContext(ctx, query)
	if err != nil {
		return 0, fmt.Errorf("read_json failed: %w", err)
	}
	return result.RowsAffected()
}

func (h *FlightSQLHandler) loadArrowData(ctx context.Context, data []byte, tableName string) (int64, error) {
	records, err := services.ConvertArrowIPCToRecords(data)
	if err != nil {
		return 0, fmt.Errorf("failed to decode Arrow IPC: %w", err)
	}
	defer func() {
		for _, rec := range records {
			rec.Release()
		}
	}()

	var jsonRows []map[string]interface{}
	for _, record := range records {
		schema := record.Schema()
		for i := 0; i < int(record.NumRows()); i++ {
			row := make(map[string]interface{})
			for j, field := range schema.Fields() {
				row[field.Name] = convertArrowValueToInterface(record.Column(j), i)
			}
			jsonRows = append(jsonRows, row)
		}
	}

	jsonData, err := json.Marshal(jsonRows)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal Arrow data to JSON: %w", err)
	}

	return h.loadJSONFile(ctx, jsonData, tableName)
}

func (h *FlightSQLHandler) loadObjects(ctx context.Context, objects []map[string]interface{}, tableName string) (int64, error) {
	jsonData, err := json.Marshal(objects)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal objects: %w", err)
	}
	return h.loadJSONFile(ctx, jsonData, tableName)
}

func writeTempFile(data []byte, pattern string) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	path := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return "", fmt.Errorf("failed to write temp file: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", fmt.Errorf("failed to close temp file: %w", err)
	}
	return path, nil
}

// normalizeValue converts database/sql scanned values to JSON-friendly types.
func normalizeValue(v interface{}) interface{} {
	if v == nil {
		return nil
	}
	switch val := v.(type) {
	case []byte:
		return string(val)
	case time.Time:
		return val.Format(time.RFC3339)
	default:
		return val
	}
}

// Helper methods

func (h *FlightSQLHandler) writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func (h *FlightSQLHandler) writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Detail: message})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// convertArrowValueToInterface converts an Arrow array value at index to Go interface{}.
// Retained for planned future tool; also used by loadArrowData.
func convertArrowValueToInterface(arr arrow.Array, index int) interface{} {
	if arr.IsNull(index) {
		return nil
	}

	switch a := arr.(type) {
	case *array.Boolean:
		return a.Value(index)
	case *array.Int8:
		return a.Value(index)
	case *array.Int16:
		return a.Value(index)
	case *array.Int32:
		return a.Value(index)
	case *array.Int64:
		return a.Value(index)
	case *array.Uint8:
		return a.Value(index)
	case *array.Uint16:
		return a.Value(index)
	case *array.Uint32:
		return a.Value(index)
	case *array.Uint64:
		return a.Value(index)
	case *array.Float32:
		return a.Value(index)
	case *array.Float64:
		return a.Value(index)
	case *array.String:
		return a.Value(index)
	case *array.Binary:
		return a.Value(index)
	case *array.LargeString:
		return a.Value(index)
	case *array.Timestamp:
		return a.Value(index).ToTime(a.DataType().(*arrow.TimestampType).Unit).Format(time.RFC3339)
	case *array.Date32:
		return a.Value(index).ToTime().Format("2006-01-02")
	case *array.Date64:
		return a.Value(index).ToTime().Format("2006-01-02")
	case *array.Time32:
		val := a.Value(index)
		return fmt.Sprintf("%d", val)
	case *array.Time64:
		val := a.Value(index)
		return fmt.Sprintf("%d", val)
	default:
		return fmt.Sprintf("%v", arr)
	}
}

// Metrics tracks request metrics
type Metrics struct {
	mu                 sync.RWMutex
	totalQueries       int64
	cacheHits          int64
	cacheMisses        int64
	connectionErrors   int64
	queryErrors        int64
	retries            int64
	responseTimes      []float64
	requestsByEndpoint map[string]int64
}

func NewMetrics() *Metrics {
	return &Metrics{
		responseTimes:      make([]float64, 0, 1000),
		requestsByEndpoint: make(map[string]int64),
	}
}

func (m *Metrics) RecordRequest(endpoint string, duration time.Duration, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.requestsByEndpoint[endpoint]++
	m.totalQueries++
	m.responseTimes = append(m.responseTimes, duration.Seconds())
	if len(m.responseTimes) > 1000 {
		m.responseTimes = m.responseTimes[1:]
	}

	if err != nil {
		m.queryErrors++
	}
}

func (m *Metrics) RecordConnectionError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.connectionErrors++
}

func (m *Metrics) RecordQueryError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.queryErrors++
}

func (m *Metrics) RecordCacheHit() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cacheHits++
}

func (m *Metrics) RecordCacheMiss() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cacheMisses++
}

func (m *Metrics) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var avgResponseTime float64
	var p95ResponseTime float64
	var p99ResponseTime float64

	if len(m.responseTimes) > 0 {
		var sum float64
		for _, rt := range m.responseTimes {
			sum += rt
		}
		avgResponseTime = sum / float64(len(m.responseTimes))

		sortedTimes := make([]float64, len(m.responseTimes))
		copy(sortedTimes, m.responseTimes)
		for i := 0; i < len(sortedTimes)-1; i++ {
			for j := 0; j < len(sortedTimes)-i-1; j++ {
				if sortedTimes[j] > sortedTimes[j+1] {
					sortedTimes[j], sortedTimes[j+1] = sortedTimes[j+1], sortedTimes[j]
				}
			}
		}

		if len(sortedTimes) > 0 {
			p95Idx := int(float64(len(sortedTimes)) * 0.95)
			if p95Idx >= len(sortedTimes) {
				p95Idx = len(sortedTimes) - 1
			}
			p95ResponseTime = sortedTimes[p95Idx]

			p99Idx := int(float64(len(sortedTimes)) * 0.99)
			if p99Idx >= len(sortedTimes) {
				p99Idx = len(sortedTimes) - 1
			}
			p99ResponseTime = sortedTimes[p99Idx]
		}
	}

	return map[string]interface{}{
		"total_queries":             m.totalQueries,
		"cache_hits":                m.cacheHits,
		"cache_misses":              m.cacheMisses,
		"connection_errors":         m.connectionErrors,
		"query_errors":              m.queryErrors,
		"retries":                   m.retries,
		"avg_response_time_seconds": avgResponseTime,
		"p95_response_time_seconds": p95ResponseTime,
		"p99_response_time_seconds": p99ResponseTime,
		"total_requests":            int64(len(m.responseTimes)),
		"requests_by_endpoint":      m.requestsByEndpoint,
	}
}
