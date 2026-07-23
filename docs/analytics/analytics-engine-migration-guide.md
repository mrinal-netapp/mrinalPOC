# Analytics Engine Migration Guide

## Overview

This guide helps you migrate from the session-based API to the new connection-based FlightSQL proxy API in analytics-engine.

## Timeline

- **Announcement**: January 2025
- **Parallel Operation**: January - April 2025 (both APIs available)
- **Migration Period**: May - June 2025 (active migration support)
- **Deprecation Date**: July 1, 2025 (session-based API will be removed)

## What's Changing

### Old API (Deprecated)

**Session-based endpoints:**
- `POST /api/v1/sessions/{sessionId}/query` - Execute query
- `GET /api/v1/sessions/{sessionId}/schema/{tableName}` - Get schema
- `POST /api/v1/internal/sessions` - Create session
- `GET /api/v1/internal/sessions/{sessionId}/status` - Get session status
- `DELETE /api/v1/internal/sessions/{sessionId}` - Delete session

**Characteristics:**
- Requires session management
- Session lifecycle tied to Kubernetes pods
- Returns JSON format
- Session-based authentication

### New API (Recommended)

**Connection-based endpoints:**
- `POST /api/flightsql/connect` - Initialize connection pool
- `POST /api/flightsql/disconnect` - Close connection pool
- `POST /api/flightsql/query` - Execute query (returns Arrow IPC or JSON)
- `POST /api/flightsql/upload` - Upload file and load into database
- `POST /api/flightsql/load-arrow` - Load Arrow IPC data
- `POST /api/flightsql/load-objects` - Load JavaScript objects

**Characteristics:**
- Direct connection to FlightSQL server
- No session management required
- Connection pooling with health checks
- Query result caching for metadata queries
- Rate limiting (60 req/min for queries, 10 req/min for uploads)
- Returns Arrow IPC format by default (JSON with Accept header)

## Migration Steps

### Step 1: Update Client Code

#### Before (Session-based)

```typescript
// Old way - using session URLs
const client = new FlightSqlClient(
  `/api/v1/sessions/${sessionId}/query`,
  `/api/v1/sessions/${sessionId}/schema/{tableName}`
)

const result = await client.executeQuery('SELECT * FROM dataset LIMIT 10')
```

#### After (Connection-based)

```typescript
// New way - using connection config
const client = new FlightSqlClient(
  '/api/flightsql', // Base URL
  '', // Schema URL not needed
  {
    url: 'grpc://gizmosql-pod:31337',
    username: 'gizmosql_user',
    password: 'password',
    tls: false
  }
)

const result = await client.executeQuery('SELECT * FROM dataset LIMIT 10')
```

### Step 2: Update API Calls

#### Query Execution

**Old:**
```typescript
POST /api/v1/sessions/{sessionId}/query
Body: { "sql": "SELECT * FROM table" }
```

**New:**
```typescript
POST /api/flightsql/query
Body: {
  "query": "SELECT * FROM table",
  "url": "grpc://host:port",
  "username": "user",
  "password": "pass",
  "tls": false
}
Headers: { "Accept": "application/json" } // For JSON response
```

#### Schema Retrieval

**Old:**
```typescript
GET /api/v1/sessions/{sessionId}/schema/{tableName}
```

**New:**
```typescript
POST /api/flightsql/query
Body: {
  "query": "DESCRIBE tableName",
  "url": "grpc://host:port",
  "username": "user",
  "password": "pass",
  "tls": false
}
Headers: { "Accept": "application/json" }
```

### Step 3: Handle Connection Management

The new API supports connection pooling. You can optionally initialize a connection pool:

```typescript
// Initialize connection pool (optional - auto-created on first query)
POST /api/flightsql/connect
Body: {
  "url": "grpc://host:port",
  "username": "user",
  "password": "pass",
  "tls": false
}

// Close connection pool when done (optional)
POST /api/flightsql/disconnect
Body: {
  "url": "grpc://host:port",
  "username": "user",
  "password": "pass",
  "tls": false
}
```

### Step 4: Update Error Handling

Error response format has changed slightly:

**Old:**
```json
{ "message": "Error message" }
```

**New:**
```json
{ "detail": "Error message" }
```

### Step 5: Handle Response Format

The new API returns Arrow IPC format by default. To get JSON (for easier migration), include the `Accept: application/json` header.

**Arrow IPC (default):**
```typescript
const response = await fetch('/api/flightsql/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '...', url: '...', ... })
})
const arrowData = await response.arrayBuffer()
// Parse Arrow IPC format (requires Apache Arrow JS library)
```

**JSON (for migration):**
```typescript
const response = await fetch('/api/flightsql/query', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json' // Request JSON format
  },
  body: JSON.stringify({ query: '...', url: '...', ... })
})
const data = await response.json()
// Same format as old API
```

## Benefits of New API

1. **No Session Management**: Direct connection to FlightSQL server
2. **Connection Pooling**: Automatic connection reuse and health checks
3. **Query Caching**: Metadata queries are automatically cached
4. **Rate Limiting**: Built-in protection against abuse
5. **Better Performance**: Connection pooling reduces overhead
6. **More Features**: Support for file uploads and data loading

## Deprecation Headers

During the migration period, the old API endpoints will return these headers:

```
Deprecation: true
Sunset: 2025-07-01
Link: </api/flightsql/query>; rel="successor-version"
```

Monitor these headers to track when you're using deprecated endpoints.

## Monitoring

Use the metrics endpoint to monitor API usage:

```bash
GET /metrics
```

Returns detailed metrics including:
- Connection pool statistics
- Cache statistics (hit rate, size)
- Query statistics (total, errors, error rate)
- Performance metrics (avg, p95, p99 response times)
- Request counts by endpoint

## Health Checks

```bash
GET /health
```

Returns health status including:
- Connection pool status
- Cache status
- ADBC availability
- Basic metrics

## Troubleshooting

### Connection Errors

If you see connection errors, verify:
1. FlightSQL server URL is correct
2. Credentials are valid
3. Network connectivity to FlightSQL server
4. TLS settings match server configuration

### Rate Limiting

If you hit rate limits (429 status):
- Query endpoints: 60 requests/minute
- Upload endpoints: 10 requests/minute

Consider implementing client-side rate limiting or request batching.

### Cache Issues

Metadata queries are cached for 5 minutes. If you need fresh data:
- Wait for cache TTL to expire
- Use a data modification query (INSERT/UPDATE/DELETE) which invalidates cache
- Clear cache via connection disconnect/reconnect

## Support

For questions or issues during migration:
1. Check this guide
2. Review API documentation at `/api/flightsql` endpoints
3. Check metrics endpoint for usage patterns
4. Contact the development team

## Example: Complete Migration

### Before

```typescript
// Session-based approach
async function queryData(sessionId: string) {
  const client = new FlightSqlClient(
    `/api/v1/sessions/${sessionId}/query`,
    `/api/v1/sessions/${sessionId}/schema/{tableName}`
  )
  
  const result = await client.executeQuery('SELECT * FROM dataset LIMIT 10')
  return result
}
```

### After

```typescript
// Connection-based approach
async function queryData(connectionConfig: ConnectionConfig) {
  const client = new FlightSqlClient(
    '/api/flightsql',
    '',
    connectionConfig
  )
  
  const result = await client.executeQuery('SELECT * FROM dataset LIMIT 10')
  return result
}

// Usage
const config = {
  url: 'grpc://gizmosql-pod:31337',
  username: 'gizmosql_user',
  password: 'password',
  tls: false
}

const result = await queryData(config)
```

## Additional Resources

- [Analytics Engine](../src/nemo/analytics-engine/)
- [FlightSQL Proxy Design](./flightsql-proxy-design.md)

