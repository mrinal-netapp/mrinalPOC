package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"agentstudio/nemo/analytics-engine/utils"
)

// SQLValidator validates SQL queries using DuckDB's json_serialize_sql parser.
// It uses a dedicated parse-only DuckDB connection (no catalog, no I/O extensions)
// to avoid contending with the main engine's serialized query slot.
type SQLValidator struct {
	mu   sync.Mutex
	db   *sql.DB
	conn interface{ Close() error }
}

// NewSQLValidator creates a parse-only DuckDB instance with only the json extension.
func NewSQLValidator(extensionDir string) (*SQLValidator, error) {
	connector, err := openParseDuckDB(extensionDir)
	if err != nil {
		return nil, fmt.Errorf("parse-only DuckDB init failed: %w", err)
	}

	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)

	return &SQLValidator{db: db, conn: connector}, nil
}

func (v *SQLValidator) Close() {
	if v.db != nil {
		v.db.Close()
	}
	if v.conn != nil {
		v.conn.Close()
	}
}

// ValidationResult contains the outcome of SQL validation.
type ValidationResult struct {
	Valid         bool
	Tables        []QualifiedTable
	RejectReason  string
	StatementType string
}

// QualifiedTable represents a fully-qualified table reference from the AST.
type QualifiedTable struct {
	Catalog   string
	Schema    string
	TableName string
}

func (t QualifiedTable) String() string {
	return fmt.Sprintf("%s.%s.%s", t.Catalog, t.Schema, t.TableName)
}

// ValidateQuery parses the SQL and enforces the project isolation policy:
// - Single SELECT statement only
// - All base table refs must be iceberg."<projectID>"."<table>"
// - No table functions, ATTACH, COPY, INSTALL, LOAD, PRAGMA, DDL, DML
func (v *SQLValidator) ValidateQuery(ctx context.Context, query string, projectID string) ValidationResult {
	_, result := v.PrepareQuery(ctx, query, projectID)
	return result
}

// PrepareQuery qualifies bare project table references (e.g. FROM orders) to
// iceberg."<projectID>"."orders", then validates the rewritten SQL. Agents
// should not need to know the Iceberg namespace — preview/describe already
// hide it server-side; execute_query gets the same ergonomics here.
func (v *SQLValidator) PrepareQuery(ctx context.Context, query string, projectID string) (string, ValidationResult) {
	if strings.TrimSpace(query) == "" {
		return query, ValidationResult{RejectReason: "empty query"}
	}

	// Reject multi-statement input up front. DuckDB's json_serialize_sql
	// errors out on multi-statement input with a generic "Only SELECT
	// statements can be serialized" message, which would mask the actual
	// reason ("multiple statements") from the caller. Catching it here
	// also makes statement smuggling rejections deterministic regardless
	// of what the underlying parser decides to do.
	if hasMultipleStatements(query) {
		return query, ValidationResult{RejectReason: "multiple statements not allowed"}
	}

	astJSON, err := v.parseToAST(ctx, query)
	if err != nil {
		utils.Warn("SQL parse failed (rejection): %v", err)
		return query, ValidationResult{RejectReason: "invalid SQL syntax"}
	}

	qualified := qualifyProjectTables(query, collectTablesFromAST(astJSON), projectID)
	if qualified != query {
		return v.PrepareQuery(ctx, qualified, projectID)
	}

	return qualified, v.validateAST(astJSON, projectID)
}

// hasMultipleStatements is a defensive lexer that scans for a semicolon
// outside of string/identifier literals or comments. A trailing
// semicolon followed only by whitespace to end-of-input is tolerated,
// since that's a common formatting convention and doesn't introduce a
// second statement. A trailing semicolon followed by a comment (e.g.
// `SELECT 1; -- note`) is conservatively *not* tolerated here — the
// caller is expected to strip comments upstream if it wants that
// shape accepted. Mismatch caught by Copilot review on PR #3.
func hasMultipleStatements(query string) bool {
	var (
		inSingleQuote  bool
		inDoubleQuote  bool
		inLineComment  bool
		inBlockComment bool
	)
	runes := []rune(query)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch {
		case inLineComment:
			if c == '\n' {
				inLineComment = false
			}
		case inBlockComment:
			if c == '*' && i+1 < len(runes) && runes[i+1] == '/' {
				inBlockComment = false
				i++
			}
		case inSingleQuote:
			if c == '\'' {
				if i+1 < len(runes) && runes[i+1] == '\'' {
					i++
				} else {
					inSingleQuote = false
				}
			}
		case inDoubleQuote:
			if c == '"' {
				inDoubleQuote = false
			}
		default:
			switch c {
			case '\'':
				inSingleQuote = true
			case '"':
				inDoubleQuote = true
			case '-':
				if i+1 < len(runes) && runes[i+1] == '-' {
					inLineComment = true
					i++
				}
			case '/':
				if i+1 < len(runes) && runes[i+1] == '*' {
					inBlockComment = true
					i++
				}
			case ';':
				// A semicolon followed only by whitespace to EOF is
				// just a trailing separator, not a second statement.
				// Anything else (including comments) is treated as a
				// second statement — see hasMultipleStatements doc.
				for j := i + 1; j < len(runes); j++ {
					switch runes[j] {
					case ' ', '\t', '\n', '\r':
						continue
					}
					return true
				}
				return false
			}
		}
	}
	return false
}

func (v *SQLValidator) parseToAST(ctx context.Context, query string) (json.RawMessage, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	escaped := strings.ReplaceAll(query, "'", "''")
	// Cast to VARCHAR because newer DuckDB drivers decode the native JSON
	// return type of json_serialize_sql() into a map[string]interface{}
	// (which Scan(*string) rejects with "unsupported Scan"). VARCHAR makes
	// the return type unambiguous and stable across driver versions.
	parseSQL := fmt.Sprintf("SELECT CAST(json_serialize_sql('%s') AS VARCHAR)", escaped)

	var raw string
	err := v.db.QueryRowContext(ctx, parseSQL).Scan(&raw)
	if err != nil {
		return nil, fmt.Errorf("json_serialize_sql failed: %w", err)
	}

	return json.RawMessage(raw), nil
}

func (v *SQLValidator) validateAST(raw json.RawMessage, projectID string) ValidationResult {
	var top interface{}
	if err := json.Unmarshal(raw, &top); err != nil {
		return ValidationResult{RejectReason: "failed to parse AST JSON"}
	}

	topObj, ok := top.(map[string]interface{})
	if !ok {
		return ValidationResult{RejectReason: "unexpected AST structure"}
	}

	// json_serialize_sql signals "couldn't serialize this statement" by
	// returning {"error": true, "error_message": "...", "error_type": "..."}
	// instead of a parse-error from the driver. This is how non-SELECT
	// statements (DDL/DML/PRAGMA/COPY/ATTACH/INSTALL/LOAD) and
	// multi-statement input land here. Surface the underlying reason
	// rather than the generic "missing statements" so the caller can tell
	// the user *why* the query was rejected.
	if errFlag, ok := topObj["error"].(bool); ok && errFlag {
		msg := getString(topObj, "error_message")
		if msg == "" {
			msg = "statement not allowed"
		} else {
			msg = msg + " (not allowed)"
		}
		return ValidationResult{RejectReason: msg}
	}

	// json_serialize_sql wraps in {"error": false, "statements": [...]}
	stmts, hasStatements := topObj["statements"]
	if !hasStatements {
		return ValidationResult{RejectReason: "missing statements in AST"}
	}

	stmtList, ok := stmts.([]interface{})
	if !ok {
		return ValidationResult{RejectReason: "statements is not an array"}
	}

	if len(stmtList) == 0 {
		return ValidationResult{RejectReason: "no statements found"}
	}
	if len(stmtList) > 1 {
		return ValidationResult{RejectReason: "multiple statements not allowed"}
	}

	stmt := stmtList[0]
	stmtObj, ok := stmt.(map[string]interface{})
	if !ok {
		return ValidationResult{RejectReason: "unexpected statement structure"}
	}

	// Extract the node wrapper — DuckDB wraps in {"node": {"type": "SELECT_NODE", ...}}
	node, hasNode := stmtObj["node"]
	if !hasNode {
		return ValidationResult{RejectReason: "missing node in statement"}
	}

	nodeObj, ok := node.(map[string]interface{})
	if !ok {
		return ValidationResult{RejectReason: "unexpected node structure"}
	}

	stmtType := getString(nodeObj, "type")

	// Only allow SELECT-type statements
	if !isAllowedStatementType(stmtType) {
		return ValidationResult{
			RejectReason:  fmt.Sprintf("statement type %q not allowed; only SELECT is permitted", stmtType),
			StatementType: stmtType,
		}
	}

	// Walk the full AST tree to collect all table references and check for blocked patterns
	var tables []QualifiedTable
	var blocked []string
	var cteNames = make(map[string]bool)

	walkAST(nodeObj, cteNames, &tables, &blocked)

	if len(blocked) > 0 {
		return ValidationResult{
			RejectReason:  fmt.Sprintf("blocked construct: %s", blocked[0]),
			StatementType: stmtType,
		}
	}

	// Validate all base table references are in the project's namespace
	normalizedProject := strings.Trim(projectID, `"`)
	for _, tbl := range tables {
		catalog := strings.Trim(strings.ToLower(tbl.Catalog), `"`)
		schema := strings.Trim(tbl.Schema, `"`)

		if catalog != "iceberg" {
			return ValidationResult{
				RejectReason:  fmt.Sprintf("access denied: catalog %q not allowed (only 'iceberg')", tbl.Catalog),
				Tables:        tables,
				StatementType: stmtType,
			}
		}
		if schema != normalizedProject {
			return ValidationResult{
				RejectReason:  fmt.Sprintf("access denied: namespace %q does not match project", tbl.Schema),
				Tables:        tables,
				StatementType: stmtType,
			}
		}
	}

	return ValidationResult{
		Valid:         true,
		Tables:        tables,
		StatementType: stmtType,
	}
}

func isAllowedStatementType(t string) bool {
	t = strings.ToUpper(t)
	return t == "SELECT_NODE" || t == "SET_OPERATION_NODE"
}

// walkAST recursively walks the DuckDB AST JSON and collects table references
// and blocked constructs.
func walkAST(node interface{}, cteNames map[string]bool, tables *[]QualifiedTable, blocked *[]string) {
	switch v := node.(type) {
	case map[string]interface{}:
		nodeType := getString(v, "type")

		// Collect CTE names to distinguish from real table refs.
		// DuckDB's cte_map.map is a list of entries; the entry key under
		// which the CTE name lives changed across DuckDB releases:
		//   - older: {"name": "<cte>", ...}
		//   - newer: {"key": "<cte>", "value": {...}}
		// Accept both so we work on either driver.
		if ctes, ok := v["cte_map"]; ok {
			if cteMap, ok := ctes.(map[string]interface{}); ok {
				if cteList, ok := cteMap["map"]; ok {
					if list, ok := cteList.([]interface{}); ok {
						for _, entry := range list {
							if entryMap, ok := entry.(map[string]interface{}); ok {
								if name, ok := entryMap["name"].(string); ok && name != "" {
									cteNames[strings.ToLower(name)] = true
								} else if key, ok := entryMap["key"].(string); ok && key != "" {
									cteNames[strings.ToLower(key)] = true
								}
							}
						}
					}
				}
			}
		}

		switch nodeType {
		case "BASE_TABLE":
			tbl := extractBaseTable(v)
			if tbl != nil {
				// Skip if this is a CTE reference
				if tbl.Catalog == "" && tbl.Schema == "" {
					name := strings.ToLower(strings.Trim(tbl.TableName, `"`))
					if cteNames[name] {
						break
					}
				}
				*tables = append(*tables, *tbl)
			}

		case "TABLE_FUNCTION":
			funcName := extractTableFunctionName(v)
			*blocked = append(*blocked, fmt.Sprintf("table function %q not allowed", funcName))
			return

		case "SUBQUERY":
			// Walk into subquery normally

		default:
			if isBlockedNodeType(nodeType) {
				*blocked = append(*blocked, fmt.Sprintf("node type %q not allowed", nodeType))
				return
			}
		}

		// Recurse into all children
		for key, child := range v {
			_ = key
			walkAST(child, cteNames, tables, blocked)
		}

	case []interface{}:
		for _, item := range v {
			walkAST(item, cteNames, tables, blocked)
		}
	}
}

func isBlockedNodeType(nodeType string) bool {
	nodeType = strings.ToUpper(nodeType)
	blockedTypes := []string{
		"CREATE_TABLE_NODE", "CREATE_VIEW_NODE", "CREATE_INDEX_NODE",
		"CREATE_SCHEMA_NODE", "CREATE_SEQUENCE_NODE", "CREATE_TYPE_NODE",
		"DROP_NODE", "ALTER_TABLE_NODE", "ALTER_VIEW_NODE",
		"INSERT_NODE", "UPDATE_NODE", "DELETE_NODE", "MERGE_NODE",
		"COPY_NODE", "EXPORT_NODE",
		"ATTACH_NODE", "DETACH_NODE",
		"LOAD_NODE", "INSTALL_NODE",
		"PRAGMA_NODE",
		"VACUUM_NODE", "CHECKPOINT_NODE",
		"TRANSACTION_NODE",
	}
	for _, b := range blockedTypes {
		if nodeType == b {
			return true
		}
	}
	return false
}

func extractBaseTable(v map[string]interface{}) *QualifiedTable {
	tbl := QualifiedTable{}

	if tableName, ok := v["table_name"].(string); ok {
		tbl.TableName = tableName
	}
	if schemaName, ok := v["schema_name"].(string); ok {
		tbl.Schema = schemaName
	}
	if catalogName, ok := v["catalog_name"].(string); ok {
		tbl.Catalog = catalogName
	}

	if tbl.TableName == "" {
		return nil
	}
	return &tbl
}

func extractTableFunctionName(v map[string]interface{}) string {
	if fn, ok := v["function"].(map[string]interface{}); ok {
		if name, ok := fn["function_name"].(string); ok {
			return name
		}
	}
	return "unknown"
}

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func collectTablesFromAST(raw json.RawMessage) []QualifiedTable {
	var top interface{}
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil
	}
	topObj, ok := top.(map[string]interface{})
	if !ok {
		return nil
	}
	if errFlag, ok := topObj["error"].(bool); ok && errFlag {
		return nil
	}
	stmts, ok := topObj["statements"].([]interface{})
	if !ok || len(stmts) != 1 {
		return nil
	}
	stmtObj, ok := stmts[0].(map[string]interface{})
	if !ok {
		return nil
	}
	nodeObj, ok := stmtObj["node"].(map[string]interface{})
	if !ok {
		return nil
	}
	var tables []QualifiedTable
	var blocked []string
	walkAST(nodeObj, make(map[string]bool), &tables, &blocked)
	return tables
}

func qualifyProjectTables(query string, tables []QualifiedTable, projectID string) string {
	if len(tables) == 0 {
		return query
	}

	ns := strings.ReplaceAll(strings.Trim(projectID, `"`), `"`, `""`)
	sorted := append([]QualifiedTable(nil), tables...)
	sort.Slice(sorted, func(i, j int) bool {
		return len(sorted[i].TableName) > len(sorted[j].TableName)
	})

	result := query
	for _, tbl := range sorted {
		catalog := strings.Trim(strings.ToLower(tbl.Catalog), `"`)
		schema := strings.Trim(tbl.Schema, `"`)
		tableName := strings.Trim(tbl.TableName, `"`)
		if tableName == "" {
			continue
		}

		qualified := fmt.Sprintf(`iceberg."%s"."%s"`, ns, strings.ReplaceAll(tableName, `"`, `""`))

		switch {
		case catalog == "" && schema == "":
			result = replaceBareTableRef(result, tableName, qualified)
		case catalog == "" && schema == ns:
			result = replaceSchemaTableRef(result, schema, tableName, qualified)
		case catalog == "iceberg" && schema == "":
			result = replaceIcebergTableRef(result, tableName, qualified)
		}
	}
	return result
}

func replaceBareTableRef(query, tableName, qualified string) string {
	ident := tableIdentPattern(tableName)
	clause := `(?i)(FROM|JOIN|,)\s+` + ident
	re := regexp.MustCompile(clause)
	return re.ReplaceAllString(query, `$1 `+qualified)
}

func replaceSchemaTableRef(query, schema, tableName, qualified string) string {
	schemaIdent := tableIdentPattern(schema)
	tableIdent := tableIdentPattern(tableName)
	clause := `(?i)(FROM|JOIN|,)\s+` + schemaIdent + `\s*\.\s*` + tableIdent
	re := regexp.MustCompile(clause)
	return re.ReplaceAllString(query, `$1 `+qualified)
}

func replaceIcebergTableRef(query, tableName, qualified string) string {
	tableIdent := tableIdentPattern(tableName)
	clause := `(?i)(FROM|JOIN|,)\s+iceberg\s*\.\s*` + tableIdent
	re := regexp.MustCompile(clause)
	return re.ReplaceAllString(query, `$1 `+qualified)
}

// tableIdentPattern matches a bare SQL identifier in either quoted or unquoted form.
// Word boundary (\b) applies only to the unquoted branch: a trailing \b after the
// alternation breaks quoted refs at end-of-string because " is not a word char.
func tableIdentPattern(name string) string {
	escaped := regexp.QuoteMeta(name)
	return `("` + escaped + `"|` + escaped + `\b)`
}
