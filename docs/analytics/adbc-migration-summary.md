# ADBC Migration Summary

## Overview

Migrated the analytics-engine query service from using the direct Apache Arrow Flight SQL client to using ADBC (Arrow Database Connectivity) library, matching the approach used in the Python flightsql-proxy service.

## Changes Made

### 1. Dependencies (`go.mod`)
- Added `github.com/apache/arrow-adbc/go/adbc v1.9.0`
- Added `github.com/apache/arrow-adbc/go/adbc/driver/flightsql v1.9.0`
- **Note**: Go ADBC packages use v1.x.x versioning (latest: v1.9.0), while Python uses 0.x.x (0.18.0)

### 2. Query Service (`src/ray/analytics-engine/services/query.go`)

#### Removed:
- Direct Flight SQL client imports (`github.com/apache/arrow-go/v18/arrow/flight/flightsql`)
- Custom `basicAuthHandler` implementation
- gRPC dial options and manual client creation

#### Added:
- ADBC imports (`github.com/apache/arrow-adbc/go/adbc` and `github.com/apache/arrow-adbc/go/adbc/driver/flightsql`)
- New `createADBCConnection()` method that:
  - Creates an ADBC driver instance
  - Creates a database with connection options (URI, username, password)
  - Opens a connection
  - Returns connection with cleanup function

#### Updated Methods:
- **`ExecuteQuery()`**: Now uses ADBC connection, statement, and query execution
- **`GetSchema()`**: Now uses ADBC connection and statement for schema queries

## Version Compatibility

The Go and Python ADBC packages use **different versioning schemes**:

| Language | Package | Version Scheme | Latest |
|----------|---------|---------------|--------|
| Go | `github.com/apache/arrow-adbc/go/adbc` | v1.x.x | v1.9.0 |
| Python | `adbc-driver-flightsql` | 0.x.x | 0.18.0 |

The Go module system cannot resolve version `v0.18.0` for the Go packages because that tag does not exist in the Go module namespace. The correct version to use in `go.mod` is `v1.9.0`.

### Resolving Version Issues

If `go mod tidy` fails to find a version, try these approaches in order:

1. **Check available versions**: `go list -m -versions github.com/apache/arrow-adbc/go/adbc`
2. **Use latest**: `go get github.com/apache/arrow-adbc/go/adbc@latest`
3. **Bypass proxy**: `GOPROXY=direct go get github.com/apache/arrow-adbc/go/adbc@latest`
4. **Pin to commit**: `go get github.com/apache/arrow-adbc/go/adbc@<commit-hash>`

If the Go ADBC packages prove unavailable or unstable, the fallback is to revert to the direct Apache Arrow Flight SQL client (`github.com/apache/arrow-go/v18/arrow/flight/flightsql`) or rely on the Python flightsql-proxy service instead.

## Implementation Details

### Connection Creation
The new `createADBCConnection()` method:
1. Ensures the endpoint has `grpc://` protocol prefix
2. Creates an ADBC FlightSQL driver instance
3. Sets database options including:
   - URI (endpoint)
   - Username (multiple option key formats tried for compatibility)
   - Password (multiple option key formats tried for compatibility)
4. Opens the connection
5. Returns connection with cleanup function

### Authentication
The implementation tries multiple option key formats for username/password:
- `username` / `password`
- `adbc.flight.sql.username` / `adbc.flight.sql.password`

**Note**: The exact option keys may need adjustment based on the ADBC FlightSQL driver implementation. Refer to the driver documentation or test different formats if authentication fails.

### Query Execution
The new flow:
1. Create ADBC connection
2. Create statement from connection
3. Set SQL query on statement
4. Execute query (returns Arrow record reader)
5. Read results from record batches
6. Convert Arrow arrays to Go interfaces

## Next Steps

### 1. Download Dependencies
Run the following to download ADBC dependencies:
```bash
cd src/ray/analytics-engine
go mod tidy
```

### 2. Verify Option Keys
If authentication fails, check the ADBC FlightSQL driver documentation for the correct option keys. The Python example uses:
- `adbc_driver_manager.DatabaseOptions.USERNAME.value`
- `adbc_driver_manager.DatabaseOptions.PASSWORD.value`

The Go equivalent may be different. Check:
- ADBC Go driver source code
- ADBC documentation
- Test with different option key formats

### 3. Test Connection
Test the connection with a real GizmoSQL instance:
```bash
# Build and test
cd src/ray/analytics-engine
go build
```

### 4. Compare with Python Implementation
The Python implementation in `src/ray/flightsql-proxy/app.py` successfully uses:
```python
conn = flightsql.connect(
    grpc_url,
    db_kwargs={
        adbc_driver_manager.DatabaseOptions.USERNAME.value: GIZMOSQL_USERNAME,
        adbc_driver_manager.DatabaseOptions.PASSWORD.value: GIZMOSQL_PASSWORD,
    },
)
```

Ensure the Go implementation uses equivalent option keys.

## References

- [Apache Arrow ADBC Go Example](https://raw.githubusercontent.com/apache/arrow-adbc/main/go/adbc/driver/flightsql/example_usage_test.go)
- [ADBC FlightSQL Driver Documentation](https://arrow.apache.org/adbc/current/driver/flight_sql.html)
- Python flightsql-proxy implementation: `src/ray/flightsql-proxy/app.py`

## Potential Issues

1. **Option Keys**: The username/password option keys may need adjustment
2. **Authentication Method**: Some FlightSQL servers may require different authentication methods
3. **Context Metadata**: Session ID metadata may need to be passed differently in ADBC
4. **Error Handling**: ADBC error messages may differ from direct Flight SQL client

## Testing Checklist

- [ ] Dependencies download successfully (`go mod tidy`)
- [ ] Code compiles without errors
- [ ] Connection to GizmoSQL succeeds
- [ ] Authentication works correctly
- [ ] Query execution returns correct results
- [ ] Schema retrieval works correctly
- [ ] Session ID metadata is passed correctly
- [ ] Error handling works as expected

