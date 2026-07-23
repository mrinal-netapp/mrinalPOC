package handlers

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

// fakeResult implements sql.Result for use in MockDB.
type fakeResult struct {
	rowsAffected int64
}

func (f fakeResult) LastInsertId() (int64, error) { return 0, nil }
func (f fakeResult) RowsAffected() (int64, error) { return f.rowsAffected, nil }

// MockDB implements services.DBQuerier for handler unit tests.
// If a Fn field is set it is called; otherwise a sensible default is used.
type MockDB struct {
	db *sql.DB // real in-memory DuckDB used to produce valid *sql.Rows

	QueryContextFn          func(ctx context.Context, query string) (*sql.Rows, error)
	QueryContextArgsFn      func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
	QueryWithCountContextFn func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error)
	ExecContextFn           func(ctx context.Context, query string) (sql.Result, error)
	QueryContextWithRetryFn func(ctx context.Context, query string) (*sql.Rows, error)
	DBFn                    func() *sql.DB
	WithArrowConnFn         func(fn func(conn *duckdb.Conn) error) error
}

func newMockDB(t *testing.T) *MockDB {
	t.Helper()
	db, err := sql.Open("duckdb", "")
	if err != nil {
		t.Fatalf("failed to open in-memory DuckDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &MockDB{db: db}
}

// simpleRows executes a query on the embedded DuckDB and returns *sql.Rows.
func (m *MockDB) simpleRows(query string) (*sql.Rows, error) {
	return m.db.QueryContext(context.Background(), query)
}

func (m *MockDB) QueryContext(ctx context.Context, query string) (*sql.Rows, error) {
	if m.QueryContextFn != nil {
		return m.QueryContextFn(ctx, query)
	}
	return m.simpleRows("SELECT 1 AS result")
}

func (m *MockDB) QueryContextArgs(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	if m.QueryContextArgsFn != nil {
		return m.QueryContextArgsFn(ctx, query, args...)
	}
	return m.simpleRows("SELECT 1 AS result")
}

func (m *MockDB) QueryWithCountContext(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
	if m.QueryWithCountContextFn != nil {
		return m.QueryWithCountContextFn(ctx, cSQL, cArgs, dSQL, dArgs)
	}
	rows, err := m.simpleRows("SELECT 1 AS result")
	return 0, rows, err
}

func (m *MockDB) ExecContext(ctx context.Context, query string) (sql.Result, error) {
	if m.ExecContextFn != nil {
		return m.ExecContextFn(ctx, query)
	}
	return fakeResult{rowsAffected: 1}, nil
}

func (m *MockDB) QueryContextWithRetry(ctx context.Context, query string) (*sql.Rows, error) {
	if m.QueryContextWithRetryFn != nil {
		return m.QueryContextWithRetryFn(ctx, query)
	}
	if m.QueryContextArgsFn != nil {
		return m.QueryContextArgsFn(ctx, query)
	}
	return m.simpleRows("SELECT 1 AS result")
}

func (m *MockDB) DB() *sql.DB {
	if m.DBFn != nil {
		return m.DBFn()
	}
	return m.db
}

func (m *MockDB) WithArrowConn(fn func(conn *duckdb.Conn) error) error {
	if m.WithArrowConnFn != nil {
		return m.WithArrowConnFn(fn)
	}
	return fmt.Errorf("WithArrowConn: not implemented in mock")
}

// errMockDB returns an error from every DB call.
func errMockDB(t *testing.T) *MockDB {
	t.Helper()
	db := newMockDB(t)
	dbErr := fmt.Errorf("mock database error")
	db.QueryContextFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, dbErr
	}
	db.QueryContextArgsFn = func(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
		return nil, dbErr
	}
	db.QueryWithCountContextFn = func(ctx context.Context, cSQL string, cArgs []interface{}, dSQL string, dArgs []interface{}) (int64, *sql.Rows, error) {
		return 0, nil, dbErr
	}
	db.ExecContextFn = func(ctx context.Context, query string) (sql.Result, error) {
		return nil, dbErr
	}
	db.QueryContextWithRetryFn = func(ctx context.Context, query string) (*sql.Rows, error) {
		return nil, dbErr
	}
	return db
}
