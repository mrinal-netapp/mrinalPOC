package services

import (
	"context"
	"os"
	"strings"
	"testing"
)

func TestSQLValidatorCorpus(t *testing.T) {
	extDir := os.Getenv("DUCKDB_EXTENSION_DIR")
	if extDir == "" {
		extDir = "/opt/duckdb/extensions"
	}

	v, err := NewSQLValidator(extDir)
	if err != nil {
		t.Skipf("Skipping: cannot create validator (extensions may not be installed): %v", err)
	}
	defer v.Close()

	projectID := "test-project-123"
	ctx := context.Background()

	type testCase struct {
		name     string
		sql      string
		expectOK bool
		reason   string // substring expected in RejectReason when not OK
	}

	tests := []testCase{
		// ---- ALLOWED ----
		{
			name:     "simple select",
			sql:      `SELECT * FROM iceberg."test-project-123"."orders" LIMIT 10`,
			expectOK: true,
		},
		{
			name:     "select with where",
			sql:      `SELECT id, name FROM iceberg."test-project-123"."users" WHERE age > 18`,
			expectOK: true,
		},
		{
			name:     "join two tables same project",
			sql:      `SELECT o.id, u.name FROM iceberg."test-project-123"."orders" o JOIN iceberg."test-project-123"."users" u ON o.user_id = u.id`,
			expectOK: true,
		},
		{
			name:     "CTE with project tables",
			sql:      `WITH active AS (SELECT * FROM iceberg."test-project-123"."users" WHERE active = true) SELECT * FROM active LIMIT 100`,
			expectOK: true,
		},
		{
			name:     "subquery in FROM",
			sql:      `SELECT * FROM (SELECT id, count(*) as cnt FROM iceberg."test-project-123"."orders" GROUP BY id) sub`,
			expectOK: true,
		},
		{
			name:     "union same project",
			sql:      `SELECT id FROM iceberg."test-project-123"."orders" UNION ALL SELECT id FROM iceberg."test-project-123"."returns"`,
			expectOK: true,
		},
		{
			name:     "aggregate with group by",
			sql:      `SELECT category, COUNT(*) as cnt, AVG(price) as avg_price FROM iceberg."test-project-123"."products" GROUP BY category`,
			expectOK: true,
		},
		{
			name:     "window function",
			sql:      `SELECT id, amount, ROW_NUMBER() OVER (ORDER BY amount DESC) as rank FROM iceberg."test-project-123"."orders"`,
			expectOK: true,
		},
		{
			name:     "bare table name auto-qualified",
			sql:      `SELECT * FROM orders LIMIT 10`,
			expectOK: true,
		},
		{
			name:     "quoted bare table name auto-qualified",
			sql:      `SELECT id, name FROM "users" WHERE age > 18`,
			expectOK: true,
		},
		{
			name:     "join bare table names auto-qualified",
			sql:      `SELECT o.id, u.name FROM orders o JOIN users u ON o.user_id = u.id`,
			expectOK: true,
		},

		// ---- BLOCKED: cross-project ----
		{
			name:     "cross-project namespace",
			sql:      `SELECT * FROM iceberg."other-project"."secrets"`,
			expectOK: false,
			reason:   "namespace",
		},
		{
			name:     "cross-project join",
			sql:      `SELECT a.id FROM iceberg."test-project-123"."orders" a JOIN iceberg."other-project"."users" b ON a.user_id = b.id`,
			expectOK: false,
			reason:   "namespace",
		},

		// ---- BLOCKED: non-iceberg catalog ----
		{
			name:     "memory catalog",
			sql:      `SELECT * FROM memory.main.my_table`,
			expectOK: false,
			reason:   "catalog",
		},

		// ---- BLOCKED: DDL/DML ----
		{
			name:     "create table",
			sql:      `CREATE TABLE test AS SELECT 1`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "insert",
			sql:      `INSERT INTO iceberg."test-project-123"."orders" VALUES (1, 2)`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "delete",
			sql:      `DELETE FROM iceberg."test-project-123"."orders" WHERE id = 1`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "update",
			sql:      `UPDATE iceberg."test-project-123"."orders" SET amount = 0`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "drop table",
			sql:      `DROP TABLE iceberg."test-project-123"."orders"`,
			expectOK: false,
			reason:   "not allowed",
		},

		// ---- BLOCKED: dangerous operations ----
		{
			name:     "attach database",
			sql:      `ATTACH '/tmp/evil.db' AS evil`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "copy to file",
			sql:      `COPY (SELECT 1) TO '/tmp/data.csv'`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "install extension",
			sql:      `INSTALL spatial`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "load extension",
			sql:      `LOAD spatial`,
			expectOK: false,
			reason:   "not allowed",
		},
		{
			name:     "pragma",
			sql:      `PRAGMA database_list`,
			expectOK: false,
			reason:   "not allowed",
		},

		// ---- BLOCKED: table functions ----
		{
			name:     "read_parquet",
			sql:      `SELECT * FROM read_parquet('/data/secret.parquet')`,
			expectOK: false,
			reason:   "table function",
		},
		{
			name:     "read_csv_auto",
			sql:      `SELECT * FROM read_csv_auto('/data/secret.csv')`,
			expectOK: false,
			reason:   "table function",
		},
		{
			name:     "read_json_auto",
			sql:      `SELECT * FROM read_json_auto('https://evil.com/data.json')`,
			expectOK: false,
			reason:   "table function",
		},

		// ---- BLOCKED: multi-statement ----
		{
			name:     "multi-statement smuggling",
			sql:      `SELECT 1; DROP TABLE iceberg."test-project-123"."orders"`,
			expectOK: false,
			reason:   "multiple statements",
		},

		// ---- BLOCKED: empty ----
		{
			name:     "empty query",
			sql:      ``,
			expectOK: false,
			reason:   "empty",
		},

		// ---- EDGE CASES ----
		{
			name:     "CTE shadowing iceberg name",
			sql:      `WITH iceberg AS (SELECT 1 as id) SELECT * FROM iceberg`,
			expectOK: true, // CTE named "iceberg" is OK — it's not a base table ref
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := v.ValidateQuery(ctx, tc.sql, projectID)
			if tc.expectOK && !result.Valid {
				t.Errorf("expected valid, got rejected: %s", result.RejectReason)
			}
			if !tc.expectOK && result.Valid {
				t.Errorf("expected rejected (reason containing %q), got valid", tc.reason)
			}
			if !tc.expectOK && !result.Valid && tc.reason != "" {
				if !containsCI(result.RejectReason, tc.reason) {
					t.Errorf("rejection reason %q does not contain %q", result.RejectReason, tc.reason)
				}
			}
		})
	}
}

func containsCI(s, substr string) bool {
	return len(s) > 0 && len(substr) > 0 &&
		(len(s) >= len(substr)) &&
		containsLower(strings.ToLower(s), strings.ToLower(substr))
}

func containsLower(s, sub string) bool {
	return strings.Contains(s, sub)
}
