package services

import (
	"context"
	"database/sql"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

// DBQuerier is the interface satisfied by *DuckDBManager.
// Handlers accept this interface so they can be unit-tested with a mock.
type DBQuerier interface {
	QueryContext(ctx context.Context, query string) (*sql.Rows, error)
	QueryContextArgs(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
	QueryWithCountContext(ctx context.Context, countSQL string, countArgs []interface{}, dataSQL string, dataArgs []interface{}) (int64, *sql.Rows, error)
	ExecContext(ctx context.Context, query string) (sql.Result, error)
	QueryContextWithRetry(ctx context.Context, query string) (*sql.Rows, error)
	DB() *sql.DB
	WithArrowConn(fn func(conn *duckdb.Conn) error) error
}
