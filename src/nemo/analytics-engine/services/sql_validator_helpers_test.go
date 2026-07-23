package services

import (
	"context"
	"strings"
	"testing"
)

// --- QualifiedTable.String ---

func TestQualifiedTable_String(t *testing.T) {
	tbl := QualifiedTable{Catalog: "iceberg", Schema: "proj-123", TableName: "orders"}
	got := tbl.String()
	if got != "iceberg.proj-123.orders" {
		t.Errorf("expected %q, got %q", "iceberg.proj-123.orders", got)
	}
}

func TestQualifiedTable_String_Empty(t *testing.T) {
	tbl := QualifiedTable{}
	got := tbl.String()
	if got != ".." {
		t.Errorf("expected '..' for empty table, got %q", got)
	}
}

// --- hasMultipleStatements ---

func TestHasMultipleStatements(t *testing.T) {
	cases := []struct {
		name     string
		query    string
		expected bool
	}{
		{"single statement", "SELECT 1", false},
		{"trailing semicolon only", "SELECT 1;", false},
		{"trailing semicolon with spaces", "SELECT 1;   ", false},
		{"trailing semicolon with newline", "SELECT 1;\n", false},
		{"two statements", "SELECT 1; SELECT 2", true},
		{"DDL after select", "SELECT 1; DROP TABLE t", true},
		{"semicolon in string literal", "SELECT ';' AS val", false},
		{"semicolon in double-quoted identifier", `SELECT "a;b" FROM t`, false},
		{"line comment before semicolon", "SELECT 1 -- comment\n", false},
		{"block comment", "SELECT /* ; */ 1", false},
		{"escaped quote in string", "SELECT 'it''s fine;' AS v", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := hasMultipleStatements(tc.query)
			if got != tc.expected {
				t.Errorf("hasMultipleStatements(%q) = %v, want %v", tc.query, got, tc.expected)
			}
		})
	}
}

// --- isAllowedStatementType ---

func TestIsAllowedStatementType(t *testing.T) {
	allowed := []string{"SELECT_NODE", "SET_OPERATION_NODE", "select_node", "set_operation_node"}
	for _, s := range allowed {
		if !isAllowedStatementType(s) {
			t.Errorf("expected %q to be allowed", s)
		}
	}

	blocked := []string{"CREATE_TABLE_NODE", "INSERT_NODE", "UPDATE_NODE", "DELETE_NODE", "PRAGMA_NODE", ""}
	for _, s := range blocked {
		if isAllowedStatementType(s) {
			t.Errorf("expected %q to be blocked", s)
		}
	}
}

// --- isBlockedNodeType ---

func TestIsBlockedNodeType(t *testing.T) {
	blocked := []string{
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
	for _, nt := range blocked {
		if !isBlockedNodeType(nt) {
			t.Errorf("expected %q to be blocked", nt)
		}
		// lowercase should also match — actually lowercase to verify case-insensitivity
		lower := strings.ToLower(nt)
		if !isBlockedNodeType(lower) {
			t.Errorf("expected lowercase %q to be blocked", lower)
		}
	}

	allowed := []string{"SELECT_NODE", "SET_OPERATION_NODE", "BASE_TABLE", "SUBQUERY", ""}
	for _, nt := range allowed {
		if isBlockedNodeType(nt) {
			t.Errorf("expected %q NOT to be blocked", nt)
		}
	}
}

// --- getString ---

func TestGetString_Present(t *testing.T) {
	m := map[string]interface{}{"key": "value"}
	got := getString(m, "key")
	if got != "value" {
		t.Errorf("expected %q, got %q", "value", got)
	}
}

func TestGetString_Missing(t *testing.T) {
	m := map[string]interface{}{}
	got := getString(m, "key")
	if got != "" {
		t.Errorf("expected empty string for missing key, got %q", got)
	}
}

func TestGetString_WrongType(t *testing.T) {
	m := map[string]interface{}{"key": 42}
	got := getString(m, "key")
	if got != "" {
		t.Errorf("expected empty string for non-string value, got %q", got)
	}
}

// --- extractBaseTable ---

func TestExtractBaseTable_Full(t *testing.T) {
	m := map[string]interface{}{
		"table_name":   "orders",
		"schema_name":  "proj-123",
		"catalog_name": "iceberg",
	}
	tbl := extractBaseTable(m)
	if tbl == nil {
		t.Fatal("expected non-nil table")
	}
	if tbl.TableName != "orders" {
		t.Errorf("expected TableName %q, got %q", "orders", tbl.TableName)
	}
	if tbl.Schema != "proj-123" {
		t.Errorf("expected Schema %q, got %q", "proj-123", tbl.Schema)
	}
	if tbl.Catalog != "iceberg" {
		t.Errorf("expected Catalog %q, got %q", "iceberg", tbl.Catalog)
	}
}

func TestExtractBaseTable_MissingTableName(t *testing.T) {
	m := map[string]interface{}{
		"schema_name":  "proj-123",
		"catalog_name": "iceberg",
	}
	tbl := extractBaseTable(m)
	if tbl != nil {
		t.Error("expected nil when table_name is missing")
	}
}

// --- extractTableFunctionName ---

func TestExtractTableFunctionName_Present(t *testing.T) {
	m := map[string]interface{}{
		"function": map[string]interface{}{
			"function_name": "read_parquet",
		},
	}
	got := extractTableFunctionName(m)
	if got != "read_parquet" {
		t.Errorf("expected %q, got %q", "read_parquet", got)
	}
}

func TestExtractTableFunctionName_Missing(t *testing.T) {
	got := extractTableFunctionName(map[string]interface{}{})
	if got != "unknown" {
		t.Errorf("expected %q for missing function, got %q", "unknown", got)
	}
}

// --- validateAST: edge cases ---

func TestValidateAST_EmptyJSON(t *testing.T) {
	v := &SQLValidator{}
	result := v.validateAST([]byte("not-json"), "proj")
	if result.Valid {
		t.Error("expected invalid for malformed JSON")
	}
}

func TestValidateAST_WrongTopType(t *testing.T) {
	v := &SQLValidator{}
	result := v.validateAST([]byte("[1,2,3]"), "proj")
	if result.Valid {
		t.Error("expected invalid for non-object JSON")
	}
}

func TestValidateAST_ErrorFlag(t *testing.T) {
	v := &SQLValidator{}
	raw := []byte(`{"error": true, "error_message": "Only SELECT can be serialized"}`)
	result := v.validateAST(raw, "proj")
	if result.Valid {
		t.Error("expected invalid when error=true")
	}
}

func TestValidateAST_MissingStatements(t *testing.T) {
	v := &SQLValidator{}
	raw := []byte(`{"error": false}`)
	result := v.validateAST(raw, "proj")
	if result.Valid {
		t.Error("expected invalid when statements key is missing")
	}
}

func TestValidateAST_EmptyStatements(t *testing.T) {
	v := &SQLValidator{}
	raw := []byte(`{"error": false, "statements": []}`)
	result := v.validateAST(raw, "proj")
	if result.Valid {
		t.Error("expected invalid for empty statements")
	}
}

func TestValidateAST_MultipleStatements(t *testing.T) {
	v := &SQLValidator{}
	raw := []byte(`{"error": false, "statements": [{}, {}]}`)
	result := v.validateAST(raw, "proj")
	if result.Valid {
		t.Error("expected invalid for multiple statements")
	}
}

// --- walkAST ---

func TestWalkAST_BaseTable(t *testing.T) {
	node := map[string]interface{}{
		"type":         "BASE_TABLE",
		"table_name":   "orders",
		"schema_name":  "proj",
		"catalog_name": "iceberg",
	}
	var tables []QualifiedTable
	var blocked []string
	walkAST(node, map[string]bool{}, &tables, &blocked)

	if len(tables) != 1 {
		t.Fatalf("expected 1 table, got %d", len(tables))
	}
	if tables[0].TableName != "orders" {
		t.Errorf("expected orders, got %q", tables[0].TableName)
	}
}

func TestWalkAST_TableFunction(t *testing.T) {
	node := map[string]interface{}{
		"type": "TABLE_FUNCTION",
		"function": map[string]interface{}{
			"function_name": "read_parquet",
		},
	}
	var tables []QualifiedTable
	var blocked []string
	walkAST(node, map[string]bool{}, &tables, &blocked)

	if len(blocked) == 0 {
		t.Error("expected TABLE_FUNCTION to be blocked")
	}
}

func TestWalkAST_BlockedNodeType(t *testing.T) {
	node := map[string]interface{}{
		"type": "DROP_NODE",
	}
	var tables []QualifiedTable
	var blocked []string
	walkAST(node, map[string]bool{}, &tables, &blocked)

	if len(blocked) == 0 {
		t.Error("expected DROP_NODE to be blocked")
	}
}

func TestWalkAST_CTESkipped(t *testing.T) {
	// A BASE_TABLE with no catalog/schema that matches a CTE name should be skipped
	node := map[string]interface{}{
		"type":       "BASE_TABLE",
		"table_name": "my_cte",
	}
	cteNames := map[string]bool{"my_cte": true}
	var tables []QualifiedTable
	var blocked []string
	walkAST(node, cteNames, &tables, &blocked)

	if len(tables) != 0 {
		t.Errorf("CTE reference should be skipped, got %d tables", len(tables))
	}
}

func TestWalkAST_SliceNode(t *testing.T) {
	nodes := []interface{}{
		map[string]interface{}{
			"type":         "BASE_TABLE",
			"table_name":   "orders",
			"schema_name":  "proj",
			"catalog_name": "iceberg",
		},
	}
	var tables []QualifiedTable
	var blocked []string
	walkAST(nodes, map[string]bool{}, &tables, &blocked)
	if len(tables) != 1 {
		t.Errorf("expected 1 table from slice walk, got %d", len(tables))
	}
}

// --- qualifyProjectTables ---

func TestQualifyProjectTables_BareName(t *testing.T) {
	tables := []QualifiedTable{{TableName: "orders"}}
	got := qualifyProjectTables(`SELECT * FROM orders LIMIT 10`, tables, "proj-123")
	want := `SELECT * FROM iceberg."proj-123"."orders" LIMIT 10`
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestQualifyProjectTables_QuotedBareName(t *testing.T) {
	tables := []QualifiedTable{{TableName: `"users"`}}
	got := qualifyProjectTables(`SELECT id FROM "users"`, tables, "proj-123")
	want := `SELECT id FROM iceberg."proj-123"."users"`
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestQualifyProjectTables_SchemaTable(t *testing.T) {
	tables := []QualifiedTable{{Schema: "proj-123", TableName: "orders"}}
	got := qualifyProjectTables(`SELECT * FROM proj-123.orders`, tables, "proj-123")
	want := `SELECT * FROM iceberg."proj-123"."orders"`
	if got != want {
		t.Errorf("expected %q, got %q", want, got)
	}
}

func TestQualifyProjectTables_Join(t *testing.T) {
	tables := []QualifiedTable{
		{TableName: "orders"},
		{TableName: "users"},
	}
	got := qualifyProjectTables(`SELECT o.id FROM orders o JOIN users u ON o.user_id = u.id`, tables, "proj-123")
	if !strings.Contains(got, `iceberg."proj-123"."orders"`) {
		t.Errorf("orders not qualified: %q", got)
	}
	if !strings.Contains(got, `iceberg."proj-123"."users"`) {
		t.Errorf("users not qualified: %q", got)
	}
}

// --- ValidateQuery: pre-parser checks ---

func TestValidateQuery_EmptyQuery(t *testing.T) {
	v := &SQLValidator{}
	result := v.ValidateQuery(nil, "", "proj")
	if result.Valid {
		t.Error("expected invalid for empty query")
	}
}

func TestValidateQuery_WhitespaceQuery(t *testing.T) {
	v := &SQLValidator{}
	result := v.ValidateQuery(nil, "   ", "proj")
	if result.Valid {
		t.Error("expected invalid for whitespace-only query")
	}
}

func TestValidateQuery_MultipleStatements(t *testing.T) {
	v := &SQLValidator{}
	result := v.ValidateQuery(nil, "SELECT 1; SELECT 2", "proj")
	if result.Valid {
		t.Error("expected invalid for multiple statements")
	}
	if result.RejectReason == "" {
		t.Error("expected a reject reason")
	}
}

// TestValidateQuery_ParseASTError exercises the parseToAST error branch in
// ValidateQuery by cancelling the context before the DB round-trip.
func TestValidateQuery_ParseASTError(t *testing.T) {
	v, err := NewSQLValidator("")
	if err != nil {
		t.Skipf("Skipping: cannot create SQLValidator: %v", err)
	}
	defer v.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled → DB QueryRowContext returns immediately with error

	result := v.ValidateQuery(ctx, "SELECT 1", "proj")
	// With a cancelled context the parse must fail → result is invalid
	if result.Valid {
		t.Error("expected invalid result when context is cancelled")
	}
	if result.RejectReason == "" {
		t.Error("expected a non-empty reject reason")
	}
}
