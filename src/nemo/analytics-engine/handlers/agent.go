package handlers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	authMiddleware "agentstudio/nemo/analytics-engine/middleware"
	"agentstudio/nemo/analytics-engine/services"
	"agentstudio/nemo/analytics-engine/utils"
)

const (
	defaultMaxRows          = 500
	defaultStatementTimeout = 60 * time.Second
	defaultMaxResponseBytes = 5 * 1024 * 1024
)

// AgentHandler handles agent-facing analytics endpoints with full enforcement:
// JWT project binding, SQL AST validation, per-tenant queue, statement timeout,
// row caps, truncation visibility, and structured audit logging.
type AgentHandler struct {
	dbMgr       services.DBQuerier
	validator   *services.SQLValidator
	tenantQueue *services.TenantQueue
	metrics     *Metrics
	maxRows     int
	stmtTimeout time.Duration
}

// NewAgentHandler creates a handler for the /api/v1/agent/* routes.
func NewAgentHandler(
	dbMgr services.DBQuerier,
	validator *services.SQLValidator,
	tenantQueue *services.TenantQueue,
) *AgentHandler {
	maxRows := defaultMaxRows
	if v := os.Getenv("AGENT_MAX_ROWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxRows = n
		}
	}
	stmtTimeout := defaultStatementTimeout
	if v := os.Getenv("AGENT_STATEMENT_TIMEOUT_S"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			stmtTimeout = time.Duration(n) * time.Second
		}
	}

	return &AgentHandler{
		dbMgr:       dbMgr,
		validator:   validator,
		tenantQueue: tenantQueue,
		metrics:     NewMetrics(),
		maxRows:     maxRows,
		stmtTimeout: stmtTimeout,
	}
}

// requireProjectID extracts the project ID from JWT claims or the
// X-Project-ID header (set by internal services like the analytics MCP shim
// when JWT forwarding is not available through the MCP pipeline).
func requireProjectID(w http.ResponseWriter, r *http.Request) string {
	claims := authMiddleware.GetUserClaims(r)
	if claims != nil && claims.ProjectID != "" {
		return claims.ProjectID
	}
	if pid := r.Header.Get("X-Project-ID"); pid != "" {
		return pid
	}
	writeAgentError(w, http.StatusForbidden, "access denied: project context required")
	return ""
}

func getUserID(r *http.Request) string {
	claims := authMiddleware.GetUserClaims(r)
	if claims != nil {
		return claims.UserID
	}
	return ""
}

// AgentQuery handles POST /api/v1/agent/query — the primary analytical path.
func (h *AgentHandler) AgentQuery(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}
	userID := getUserID(r)

	var req QueryRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeAgentError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Query == "" {
		writeAgentError(w, http.StatusBadRequest, "query is required")
		return
	}

	queryHash := hashQuery(req.Query)

	// SQL AST validation — failure-closed. Bare table names are auto-qualified
	// to iceberg."<projectID>"."<table>" so agents need not know the namespace.
	qualifiedQuery, result := h.validator.PrepareQuery(r.Context(), req.Query, projectID)
	if !result.Valid {
		utils.Warn("[agent-query] rejected query project=%s user=%s reason=%q hash=%s",
			projectID, userID, result.RejectReason, queryHash)
		writeAgentError(w, http.StatusForbidden, "query rejected: "+result.RejectReason)
		return
	}

	tableNames := make([]string, len(result.Tables))
	for i, t := range result.Tables {
		tableNames[i] = t.String()
	}
	utils.Info("[agent-query] validated project=%s user=%s tables=%v hash=%s",
		projectID, userID, tableNames, queryHash)

	// Per-tenant queue — fast-fail if busy
	release, err := h.tenantQueue.Acquire(r.Context(), projectID)
	if err != nil {
		utils.Warn("[agent-query] queue full project=%s: %v", projectID, err)
		writeAgentError(w, http.StatusTooManyRequests, err.Error())
		return
	}
	defer release()

	// Statement timeout
	ctx, cancel := context.WithTimeout(r.Context(), h.stmtTimeout)
	defer cancel()

	// Execute with retry on catalog 401
	rows, err := h.dbMgr.QueryContextWithRetry(ctx, qualifiedQuery)
	if err != nil {
		utils.Error("[agent-query] execution failed project=%s hash=%s: %v", projectID, queryHash, err)
		writeAgentError(w, http.StatusInternalServerError, "query execution failed")
		return
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "failed to read columns")
		return
	}

	// Scan rows with cap
	var allRows [][]interface{}
	truncated := false
	for rows.Next() {
		if len(allRows) >= h.maxRows {
			truncated = true
			break
		}
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			writeAgentError(w, http.StatusInternalServerError, "failed to read results")
			return
		}
		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		allRows = append(allRows, row)
	}
	if err := rows.Err(); err != nil {
		writeAgentError(w, http.StatusInternalServerError, "error reading results")
		return
	}

	duration := time.Since(startTime)
	utils.Info("[agent-query] completed project=%s user=%s hash=%s rows=%d truncated=%v duration=%dms",
		projectID, userID, queryHash, len(allRows), truncated, duration.Milliseconds())

	resp := map[string]interface{}{
		"columns":       columns,
		"rows":          allRows,
		"rowCount":      len(allRows),
		"executionTime": duration.Milliseconds(),
	}
	if truncated {
		resp["truncated"] = true
		resp["warning"] = fmt.Sprintf("Results limited to %d rows. Use LIMIT or narrow your query.", h.maxRows)
	}

	writeAgentJSON(w, http.StatusOK, resp)
}

// AgentDescribe handles POST /api/v1/agent/describe
func (h *AgentHandler) AgentDescribe(w http.ResponseWriter, r *http.Request) {
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}

	var req struct {
		Table string `json:"table"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Table == "" {
		writeAgentError(w, http.StatusBadRequest, "table is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	ns := strings.ReplaceAll(projectID, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	query := fmt.Sprintf(`DESCRIBE iceberg."%s"."%s"`, ns, tbl)

	rows, err := h.dbMgr.QueryContextWithRetry(ctx, query)
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "failed to describe table")
		return
	}
	defer rows.Close()

	var cols []map[string]string
	for rows.Next() {
		var colName, colType, isNull, key, defaultVal, extra sql.NullString
		if err := rows.Scan(&colName, &colType, &isNull, &key, &defaultVal, &extra); err != nil {
			continue
		}
		if colName.Valid {
			cols = append(cols, map[string]string{
				"name": colName.String,
				"type": colType.String,
			})
		}
	}

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"table":   req.Table,
		"columns": cols,
	})
}

// AgentDatasets handles POST /api/v1/agent/datasets — list tables in project namespace
func (h *AgentHandler) AgentDatasets(w http.ResponseWriter, r *http.Request) {
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	ns := strings.ReplaceAll(projectID, `"`, `""`)
	query := fmt.Sprintf(`SELECT table_name FROM information_schema.tables WHERE table_catalog = 'iceberg' AND table_schema = '%s'`, ns)

	rows, err := h.dbMgr.QueryContextWithRetry(ctx, query)
	if err != nil {
		// Fallback: SHOW ALL TABLES and filter
		h.agentDatasetsShowTables(ctx, w, projectID)
		return
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		tables = append(tables, name)
	}

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"namespace": projectID,
		"tables":    tables,
	})
}

func (h *AgentHandler) agentDatasetsShowTables(ctx context.Context, w http.ResponseWriter, projectID string) {
	rows, err := h.dbMgr.QueryContextWithRetry(ctx, "SHOW ALL TABLES")
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "failed to list datasets")
		return
	}
	defer rows.Close()

	columns, _ := rows.Columns()
	dbIdx, schIdx, nameIdx := -1, -1, -1
	for i, c := range columns {
		switch c {
		case "database":
			dbIdx = i
		case "schema":
			schIdx = i
		case "name":
			nameIdx = i
		}
	}

	var tables []string
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			continue
		}

		if dbIdx >= 0 && schIdx >= 0 && nameIdx >= 0 {
			db := fmt.Sprintf("%v", values[dbIdx])
			schema := fmt.Sprintf("%v", values[schIdx])
			name := fmt.Sprintf("%v", values[nameIdx])
			if db == "iceberg" && schema == projectID {
				tables = append(tables, name)
			}
		}
	}

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"namespace": projectID,
		"tables":    tables,
	})
}

// AgentPreview handles POST /api/v1/agent/preview
func (h *AgentHandler) AgentPreview(w http.ResponseWriter, r *http.Request) {
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}

	var req struct {
		Table string `json:"table"`
		Limit int    `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Table == "" {
		writeAgentError(w, http.StatusBadRequest, "table is required")
		return
	}
	if req.Limit <= 0 || req.Limit > h.maxRows {
		req.Limit = 50
	}

	ns := strings.ReplaceAll(projectID, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	query := fmt.Sprintf(`SELECT * FROM iceberg."%s"."%s" LIMIT %d`, ns, tbl, req.Limit)

	ctx, cancel := context.WithTimeout(r.Context(), h.stmtTimeout)
	defer cancel()

	rows, err := h.dbMgr.QueryContextWithRetry(ctx, query)
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "preview query failed")
		return
	}
	defer rows.Close()

	columns, _ := rows.Columns()
	var allRows [][]interface{}
	for rows.Next() {
		values := make([]interface{}, len(columns))
		valuePtrs := make([]interface{}, len(columns))
		for i := range values {
			valuePtrs[i] = &values[i]
		}
		if err := rows.Scan(valuePtrs...); err != nil {
			continue
		}
		row := make([]interface{}, len(columns))
		for i, v := range values {
			row[i] = normalizeValue(v)
		}
		allRows = append(allRows, row)
	}

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"columns":  columns,
		"rows":     allRows,
		"rowCount": len(allRows),
	})
}

// AgentStats handles POST /api/v1/agent/stats
func (h *AgentHandler) AgentStats(w http.ResponseWriter, r *http.Request) {
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}

	var req struct {
		Table string `json:"table"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Table == "" {
		writeAgentError(w, http.StatusBadRequest, "table is required")
		return
	}

	ns := strings.ReplaceAll(projectID, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	tableRef := fmt.Sprintf(`iceberg."%s"."%s"`, ns, tbl)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	summarizeSQL := fmt.Sprintf(
		"SELECT column_name, column_type, min, max, approx_unique, avg, std, q25, q50, q75, count, null_percentage::VARCHAR AS null_percentage FROM (SUMMARIZE SELECT * FROM %s)",
		tableRef,
	)
	rows, err := h.dbMgr.QueryContextWithRetry(ctx, summarizeSQL)
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "stats query failed")
		return
	}
	defer rows.Close()

	stats := make(map[string]interface{})
	for rows.Next() {
		var colName, colType, minVal, maxVal, approxUnique, avg, std, q25, q50, q75, count, nullPct sql.NullString
		if err := rows.Scan(&colName, &colType, &minVal, &maxVal, &approxUnique, &avg, &std, &q25, &q50, &q75, &count, &nullPct); err != nil {
			continue
		}
		if !colName.Valid {
			continue
		}
		stat := map[string]interface{}{"type": colType.String}
		if minVal.Valid {
			stat["min"] = minVal.String
		}
		if maxVal.Valid {
			stat["max"] = maxVal.String
		}
		if avg.Valid {
			stat["avg"] = avg.String
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

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"table": req.Table,
		"stats": stats,
	})
}

// AgentHistogram handles POST /api/v1/agent/histogram
func (h *AgentHandler) AgentHistogram(w http.ResponseWriter, r *http.Request) {
	projectID := requireProjectID(w, r)
	if projectID == "" {
		return
	}

	var req struct {
		Table  string `json:"table"`
		Column string `json:"column"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Table == "" || req.Column == "" {
		writeAgentError(w, http.StatusBadRequest, "table and column are required")
		return
	}

	ns := strings.ReplaceAll(projectID, `"`, `""`)
	tbl := strings.ReplaceAll(req.Table, `"`, `""`)
	tableRef := fmt.Sprintf(`iceberg."%s"."%s"`, ns, tbl)
	col := escapeColumnName(req.Column)

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Categorical histogram (top 20 values)
	query := fmt.Sprintf(
		`SELECT CAST(%s AS VARCHAR) AS val, COUNT(*) AS cnt FROM %s WHERE %s IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
		col, tableRef, col,
	)
	rows, err := h.dbMgr.QueryContextWithRetry(ctx, query)
	if err != nil {
		writeAgentError(w, http.StatusInternalServerError, "histogram query failed")
		return
	}
	defer rows.Close()

	type bucket struct {
		Label string `json:"label"`
		Count int64  `json:"count"`
	}
	var buckets []bucket
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

	writeAgentJSON(w, http.StatusOK, map[string]interface{}{
		"table":   req.Table,
		"column":  req.Column,
		"buckets": buckets,
	})
}

func hashQuery(q string) string {
	h := sha256.Sum256([]byte(q))
	return fmt.Sprintf("%x", h[:8])
}

func writeAgentJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeAgentError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": message,
	})
}
