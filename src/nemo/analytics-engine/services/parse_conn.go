package services

import (
	"context"
	"database/sql/driver"
	"fmt"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

// openParseDuckDB creates a minimal DuckDB connector for SQL parsing only.
// It loads only the json extension (needed for json_serialize_sql) and
// explicitly does NOT load iceberg, httpfs, or avro. This ensures:
//   - No catalog attachment, no S3 credentials, no I/O capability
//   - No contention with the main engine's serialized query slot
//   - Minimal attack surface even if a statement slips past validation
func openParseDuckDB(extensionDir string) (*duckdb.Connector, error) {
	c, err := duckdb.NewConnector("", func(execer driver.ExecerContext) error {
		bootQueries := []string{
			fmt.Sprintf("SET extension_directory='%s'", extensionDir),
			"SET autoinstall_known_extensions=false",
			"LOAD json",
		}
		for _, q := range bootQueries {
			if _, err := execer.ExecContext(context.Background(), q, nil); err != nil {
				return fmt.Errorf("parse-conn boot %q: %w", q, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create parse-only DuckDB connector: %w", err)
	}
	return c, nil
}
