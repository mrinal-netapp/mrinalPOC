# FlightSQL Proxy Service Design

## Overview

The FlightSQL Proxy is a Python-based sidecar service that acts as a FlightSQL proxy to execute SQL queries on GizmoSQL. This service provides the same API as the analytics-engine query and schema endpoints, allowing clients to execute SQL queries without directly connecting to GizmoSQL's FlightSQL interface.

## Motivation

The current analytics-engine service is implemented in Go and uses the Apache Arrow Flight SQL Go client. This new Python-based service provides an alternative implementation that:

1. **Uses ADBC (Arrow Database Connectivity)**: Leverages the Python ADBC FlightSQL driver, which provides a DB-API compatible interface
2. **Sidecar Architecture**: Runs as a sidecar container alongside GizmoSQL in the same pod
3. **API Compatibility**: Maintains the same REST API as analytics-engine for seamless integration
4. **Simplified Deployment**: Can be deployed as part of the GizmoSQL pod without additional orchestration

## Architecture

### Current Architecture (Analytics-Engine)

```
┌─────────────────────────────────────────┐
│         Analytics-Engine (Go)             │
│  ┌─────────────────────────────────────┐ │
│  │  REST API                          │ │
│  │  - POST /sessions/{id}/query       │ │
│  │  - GET /sessions/{id}/schema/{tbl} │ │
│  └──────────────┬──────────────────────┘ │
│                 │                         │
│  ┌──────────────▼──────────────────────┐ │
│  │  FlightSQL Client (Go)              │ │
│  └──────────────┬──────────────────────┘ │
└─────────────────┼─────────────────────────┘
                  │
                  │ FlightSQL Protocol
                  │
┌─────────────────▼─────────────────────────┐
│         GizmoSQL Pod                       │
│  ┌─────────────────────────────────────┐   │
│  │  GizmoSQL Container                 │   │
│  │  (port 31337)                       │   │
│  └─────────────────────────────────────┘   │
└────────────────────────────────────────────┘
```

### New Architecture (FlightSQL Proxy)

```
┌─────────────────────────────────────────┐
│         Client (GUI/API Gateway)         │
└──────────────┬──────────────────────────┘
               │
               │ REST API
               │
┌──────────────▼──────────────────────────┐
│         GizmoSQL Pod                     │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │   GizmoSQL   │  │  FlightSQL Proxy │ │
│  │  Container   │  │  (Python)        │ │
│  │  (port 31337)│  │  (port 8080)     │ │
│  └──────┬───────┘  └──────┬───────────┘ │
│         │                  │             │
│         └────────┬─────────┘             │
│                  │                       │
│         FlightSQL Protocol               │
│         (via ADBC)                       │
└──────────────────────────────────────────┘
```

## API Design

### Endpoints

The service provides the same endpoints as analytics-engine:

1. **Query Execution**
   - `POST /api/v1/sessions/{sessionId}/query`
   - Request: `{ "sql": "SELECT * FROM table LIMIT 10" }`
   - Response: `{ "columns": [...], "rows": [[...]], "rowCount": int, "executionTime": int }`

2. **Schema Retrieval**
   - `GET /api/v1/sessions/{sessionId}/schema/{tableName}`
   - Response: `{ "tableName": "...", "columns": [{ "name": "...", "type": "...", "nullable": bool }] }`

3. **Health Checks**
   - `GET /health` - Basic health check
   - `GET /ready` - Readiness check (tests GizmoSQL connection)

### Request/Response Format

The API matches the analytics-engine format exactly:

**Query Request:**
```json
{
  "sql": "SELECT col1, col2 FROM dataset WHERE col1 > 100 LIMIT 10"
}
```

**Query Response:**
```json
{
  "columns": ["col1", "col2"],
  "rows": [
    [101, "value1"],
    [102, "value2"]
  ],
  "rowCount": 2,
  "executionTime": 45
}
```

**Schema Response:**
```json
{
  "tableName": "dataset",
  "columns": [
    {
      "name": "col1",
      "type": "int64",
      "nullable": true
    },
    {
      "name": "col2",
      "type": "string",
      "nullable": false
    }
  ]
}
```

## Implementation Details

### Technology Stack

- **Framework**: Flask (lightweight, simple REST API)
- **FlightSQL Driver**: `adbc_driver_flightsql.dbapi` (ADBC FlightSQL driver)
- **Arrow Support**: PyArrow (required by ADBC)
- **Container**: Python 3.11-slim base image

### Connection Management

The service connects to GizmoSQL using ADBC:

```python
conn = adbc_driver_flightsql.dbapi.connect(
    'grpc://gizmosql-service:31337',
    db_kwargs={
        adbc_driver_manager.DatabaseOptions.USERNAME.value: "gizmosql_user",
        adbc_driver_manager.DatabaseOptions.PASSWORD.value: "password",
    },
)
```

### Data Conversion

Results from GizmoSQL are returned as Arrow tables. The service converts these to JSON-compatible Python types:

- **Primitive types**: int, float, string, bool → native Python types
- **Timestamps**: Arrow timestamp → ISO format string
- **Dates**: Arrow date → ISO format string (YYYY-MM-DD)
- **Time**: Arrow time → string representation
- **Null values**: Arrow null → Python None

### Error Handling

- **Connection errors**: Return 503 with error message
- **Query errors**: Return 500 with SQL error message
- **Validation errors**: Return 400 with validation message

## Deployment

### Sidecar Container Configuration

The service runs as a sidecar container in the GizmoSQL pod:

```yaml
containers:
  - name: gizmosql
    image: gizmodata/gizmosql:latest
    ports:
      - containerPort: 31337
    env:
      - name: GIZMOSQL_PASSWORD
        value: "password"
  
  - name: flightsql-proxy
    image: flightsql-proxy:latest
    ports:
      - containerPort: 8080
    env:
      - name: GIZMOSQL_ENDPOINT
        value: "localhost:31337"  # Same pod, use localhost
      - name: GIZMOSQL_USERNAME
        value: "gizmosql_user"
      - name: GIZMOSQL_PASSWORD
        value: "password"  # Same as GizmoSQL container
      - name: PORT
        value: "8080"
```

### Service Configuration

A Kubernetes Service can be created to expose the proxy:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: gizmosql-proxy-{sessionId}
spec:
  selector:
    app: gizmosql
    session: {sessionId}
  ports:
    - name: proxy
      port: 8080
      targetPort: 8080
```

## Integration with Analytics-Engine

The FlightSQL Proxy can be used as an alternative to analytics-engine for query execution:

### Option 1: Replace Analytics-Engine

- Update deployment manager to include flightsql-proxy sidecar
- Update API gateway to route to flightsql-proxy instead of analytics-engine
- Remove analytics-engine query service dependency

### Option 2: Coexistence

- Keep analytics-engine for session management
- Use flightsql-proxy for query execution (sidecar in GizmoSQL pod)
- Clients can choose which endpoint to use

### Option 3: Hybrid

- Analytics-proxy handles session lifecycle
- FlightSQL proxy handles query execution (sidecar)
- Both services available, clients use appropriate one

## Advantages

1. **Simplified Architecture**: No separate service needed for query execution
2. **Reduced Latency**: Sidecar in same pod reduces network hops
3. **Python Ecosystem**: Easier integration with Python-based analytics tools
4. **ADBC Standard**: Uses standard ADBC interface for FlightSQL
5. **API Compatibility**: Same API as analytics-engine, easy migration

## Limitations

1. **Single Pod**: Each GizmoSQL pod needs its own proxy instance
2. **Resource Usage**: Additional container per pod
3. **No Session Management**: Only handles query execution, not session lifecycle
4. **Python Performance**: May be slower than Go for high-throughput scenarios

## Future Enhancements

1. **Connection Pooling**: Implement connection pooling for better performance
2. **Query Caching**: Cache frequently used queries
3. **Metrics**: Add Prometheus metrics for monitoring
4. **Async Support**: Add async/await support for better concurrency
5. **Streaming Results**: Support streaming large result sets

## Testing

### Unit Tests

- Test query execution with mock Arrow tables
- Test schema retrieval
- Test error handling
- Test data type conversion

### Integration Tests

- Test with real GizmoSQL instance
- Test connection handling
- Test concurrent queries
- Test error scenarios

### Performance Tests

- Compare performance with analytics-engine
- Test with large result sets
- Test concurrent connections
- Measure latency

## Migration Path

1. **Phase 1**: Deploy flightsql-proxy as sidecar (optional)
2. **Phase 2**: Update clients to use flightsql-proxy endpoint
3. **Phase 3**: Monitor performance and usage
4. **Phase 4**: Decide on keeping both or migrating fully

## Implementation Checklist

### Status

- [x] Python service implementation with Flask
- [x] Query execution endpoint (`POST /api/v1/sessions/{sessionId}/query`)
- [x] Schema retrieval endpoint (`GET /api/v1/sessions/{sessionId}/schema/{tableName}`)
- [x] Health and readiness checks
- [x] Dockerfile and requirements.txt
- [x] Documentation
- [ ] Update deployment manager to add flightsql-proxy sidecar
- [ ] Create Kubernetes Service to expose proxy port
- [ ] Update API Gateway to optionally route queries to flightsql-proxy
- [ ] Integration testing with real GizmoSQL instances
- [ ] Monitoring and metrics

### Service Location

```
src/ray/flightsql-proxy/
├── app.py              # Main Flask application
├── requirements.txt    # Python dependencies
├── Dockerfile          # Container image definition
└── README.md           # Usage documentation
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GIZMOSQL_ENDPOINT` | `localhost:31337` | GizmoSQL endpoint |
| `GIZMOSQL_USERNAME` | `gizmosql_user` | GizmoSQL username |
| `GIZMOSQL_PASSWORD` | *(required)* | GizmoSQL password |
| `PORT` | `8080` | Service port |

### Dependencies

- Flask 3.0.0
- flask-cors 4.0.0
- adbc-driver-manager 0.18.0
- adbc-driver-flightsql 0.18.0
- pyarrow >= 14.0.0

### Building

```bash
cd src/ray/flightsql-proxy
docker build -t flightsql-proxy:latest .
```

### Deployment Manager Integration

To add the sidecar to GizmoSQL deployments, update `deployment_manager.go`:

```go
{
    Name:  "flightsql-proxy",
    Image: "flightsql-proxy:latest",
    Ports: []corev1.ContainerPort{
        {
            ContainerPort: 8080,
            Name:          "proxy",
            Protocol:      corev1.ProtocolTCP,
        },
    },
    Env: []corev1.EnvVar{
        {Name: "GIZMOSQL_ENDPOINT", Value: "localhost:31337"},
        {Name: "GIZMOSQL_USERNAME", Value: username},
        {Name: "GIZMOSQL_PASSWORD", Value: password},
        {Name: "PORT", Value: "8080"},
    },
}
```

### Usage Examples

**Execute a query:**
```bash
curl -X POST http://gizmosql-proxy:8080/api/v1/sessions/session-123/query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT 1, 2.0, '\''Hello, world!'\''"}'
```

**Get table schema:**
```bash
curl http://gizmosql-proxy:8080/api/v1/sessions/session-123/schema/dataset
```

## Conclusion

The FlightSQL Proxy service provides a Python-based alternative to the Go-based analytics-engine for query execution. It maintains API compatibility while offering a simpler deployment model as a sidecar container. The service leverages ADBC for FlightSQL connectivity, providing a standard interface for database operations.


