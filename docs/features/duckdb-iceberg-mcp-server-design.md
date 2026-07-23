# DuckDB Iceberg MCP Server — Design Document

## Executive Summary

This document describes the design of a **custom DuckDB MCP server** (`server.py`) that provides SQL access to Apache Iceberg tables via DuckDB, with **automatic OAuth2 token refresh**. It replaces the upstream `mcp-server-motherduck` CLI to solve a critical issue: DuckDB's Iceberg extension fetches an OAuth2 token at catalog `ATTACH` time and **never refreshes it**, causing HTTP 401 errors after the Keycloak token expires (default 5 minutes).

The custom server preserves full compatibility with the existing MCP tool interface while adding a three-layer token refresh strategy that is transparent to callers.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Why mcp-server-motherduck Is Not Used](#why-mcp-server-motherduck-is-not-used)
3. [Solution Overview](#solution-overview)
4. [Architecture](#architecture)
5. [Token Refresh Strategy](#token-refresh-strategy)
6. [What Persists vs. What Gets Refreshed](#what-persists-vs-what-gets-refreshed)
7. [Component Design](#component-design)
8. [MCP Tool Interface](#mcp-tool-interface)
9. [Configuration Reference](#configuration-reference)
10. [Container Image](#container-image)
11. [Deployment](#deployment)
12. [Concurrency and Thread Safety](#concurrency-and-thread-safety)
13. [Alternatives Considered](#alternatives-considered)
14. [Future Work](#future-work)

---

## Problem Statement

### Observed Failure

When a user chats with an agent that queries Iceberg datasets, the conversation errors out after ~5 minutes with:

> "It seems that there was an issue accessing the docs dataset, resulting in an unauthorized request error."

The MCP server logs show:

```
Error calling tool 'execute_query'
ValueError: {
  "success": false,
  "error": "HTTP Error: Unauthorized request to endpoint
    'http://lakekeeper.nemo.svc.cluster.local:8181/catalog/v1/...'
    returned an error response (HTTP 401). Reason: Unauthorized",
  "errorType": "HTTPException"
}
```

### Root Cause

DuckDB's Iceberg extension follows this sequence during `ATTACH`:

1. Reads `CLIENT_ID`, `CLIENT_SECRET`, and `OAUTH2_SERVER_URI` from the DuckDB `SECRET`.
2. Performs a `client_credentials` OAuth2 grant against Keycloak.
3. Receives an access token with `expires_in: 300` (5 minutes).
4. **Caches the token in memory** for the lifetime of the catalog attachment.
5. Uses the cached token for all subsequent REST catalog requests.

DuckDB **does not** monitor token expiry or attempt to refresh. After 5 minutes the cached token expires and every catalog request returns HTTP 401. This is a known limitation of the DuckDB Iceberg extension (see [duckdb/duckdb-iceberg#102](https://github.com/duckdb/duckdb-iceberg/issues/102)).

---

## Why mcp-server-motherduck Is Not Used

The upstream [`mcp-server-motherduck`](https://github.com/motherduckdb/mcp-server-motherduck) (v1.0.1) was the original MCP server used in this deployment. It was replaced for the following reasons:

### 1. No Token Refresh Mechanism

`mcp-server-motherduck` initializes DuckDB via an `--init-sql` file that runs **once at startup**. The `CREATE SECRET` + `ATTACH` SQL executes during initialization, and the resulting OAuth2 token is cached by DuckDB for the lifetime of the process. The server provides no hook, callback, or configuration to re-run these statements when the token expires.

### 2. No Error Recovery

When a tool call fails with HTTP 401, `mcp-server-motherduck` catches the DuckDB exception and returns it as a structured error (`{"success": false, "error": "...", "errorType": "..."}`). It does **not** attempt to refresh the token or retry the query. The error propagates to the LLM agent, which surfaces it to the user.

### 3. DuckDB Limitation (Not a MotherDuck Bug)

The token expiry problem is in DuckDB's Iceberg extension, not in `mcp-server-motherduck` itself. The upstream server is designed primarily for local DuckDB files and MotherDuck cloud connections, where OAuth2 token refresh against an Iceberg REST catalog is not a concern.

### 4. Restart-Based Workarounds Are Not Scalable

An earlier proposed workaround was to periodically restart the MCP server pod (e.g., via a Kubernetes `CronJob` or liveness probe). This was rejected because:

- Active user sessions / in-flight queries would be interrupted.
- MCP connections from the Bifrost gateway would need to reconnect.
- Any in-memory state (temp tables, cached results) would be lost.
- It introduces unpredictable latency at restart boundaries.

### 5. What We Retain from mcp-server-motherduck

The `mcp-server-motherduck` pip package is still installed in the Docker image — **not for its CLI**, but as a dependency carrier. It pins the exact `duckdb` and `fastmcp` versions that are compatible with the pre-built DuckDB extensions (iceberg, httpfs, avro) installed during the image build. This avoids version mismatches between the DuckDB Python library and the native extension binaries.

---

## Solution Overview

Replace the `mcp-server-motherduck` CLI with a custom `server.py` that:

1. Uses the **DuckDB Python API** directly (same `duckdb` package).
2. Uses **FastMCP** to expose MCP tools over Streamable HTTP.
3. Manages the **Iceberg catalog lifecycle** (`DETACH` / `ATTACH`) independently of the DuckDB process lifecycle.
4. Implements a **three-layer token refresh strategy** (proactive, pre-query, reactive).
5. Exposes the **same tool names and response format** as `mcp-server-motherduck` for full compatibility.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Server Pod (:8000)                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  entrypoint.sh                                           │   │
│  │  • Waits for Lakekeeper + Keycloak DNS/HTTP readiness    │   │
│  │  • Tests OAuth2 client_credentials grant                 │   │
│  │  • exec python3 /app/server.py                           │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  server.py                                               │   │
│  │                                                          │   │
│  │  ┌────────────────────┐   ┌───────────────────────────┐  │   │
│  │  │  FastMCP Server     │   │  CatalogManager           │  │   │
│  │  │                    │   │                           │  │   │
│  │  │  • execute_query   │──▶│  • DuckDB :memory: conn   │  │   │
│  │  │  • list_databases  │   │  • Extensions (iceberg,   │  │   │
│  │  │  • list_tables     │   │    httpfs, avro)          │  │   │
│  │  │  • list_columns    │   │  • S3 settings            │  │   │
│  │  │                    │   │  • Token lifecycle mgmt   │  │   │
│  │  └────────────────────┘   │  • Background refresh     │  │   │
│  │                           │    timer (daemon thread)  │  │   │
│  │                           └──────┬────────────────────┘  │   │
│  └──────────────────────────────────┼───────────────────────┘   │
│                                     │                            │
│            ┌────────────────────────┼────────────────────┐       │
│            │   Refreshed every ~4m  │  Set once           │       │
│            ▼                        ▼                     │       │
│  ┌──────────────────┐    ┌──────────────────────┐        │       │
│  │  ATTACH iceberg   │    │  SET s3_endpoint     │        │       │
│  │  (Lakekeeper)     │    │  SET s3_access_key   │        │       │
│  │  + CREATE SECRET  │    │  LOAD iceberg/httpfs │        │       │
│  └────────┬─────────┘    └──────────────────────┘        │       │
│           │                                               │       │
└───────────┼───────────────────────────────────────────────┘       │
            │                                                       │
            ▼                                                       │
   ┌─────────────────┐     ┌──────────────────┐                    │
   │  Lakekeeper      │     │  Keycloak         │                    │
   │  :8181/catalog   │     │  :8080            │                    │
   │  (Iceberg REST)  │     │  (token endpoint) │                    │
   └────────┬─────────┘     └──────────────────┘                    │
            │                                                       │
            ▼                                                       │
   ┌─────────────────┐                                              │
   │  S3 Gateway      │                                              │
   │  :7070           │                                              │
   │  (object store)  │                                              │
   └──────────────────┘
```

---

## Token Refresh Strategy

Three independent layers ensure the token is always valid:

### Layer 1: Proactive Background Refresh

A daemon `threading.Timer` fires at `token_lifetime - REFRESH_MARGIN_S` seconds (e.g., 240s for a 300s token with a 60s margin).

- Acquires the lock, verifies the token is actually near expiry (skip if already refreshed by Layer 2).
- Runs `DETACH iceberg` → `DROP SECRET` → `CREATE SECRET` → `ATTACH iceberg`.
- DuckDB fetches a fresh OAuth2 token from Keycloak during `ATTACH`.
- Reschedules itself for the next cycle.
- On failure, retries in 30 seconds.

**Impact on queries**: None during normal operation — the refresh happens between queries.

### Layer 2: Pre-Query Freshness Check

Before **every** tool call, `_ensure_fresh()` checks `_token_remaining()`. If the remaining lifetime is less than `REFRESH_MARGIN_S`, it acquires the lock and re-attaches (double-checked locking to avoid redundant refreshes).

This catches cases where:
- No queries were made for a long time and the background timer already fired.
- The background timer failed and hasn't recovered yet.

**Impact on queries**: ~1-2 seconds of latency for the one query that triggers the refresh.

### Layer 3: Reactive Retry on HTTP 401

If a query execution raises a DuckDB exception containing "401" or "Unauthorized", the server:

1. Re-attaches the catalog (fresh token).
2. Retries the query **exactly once**.
3. If the retry also fails, returns the error to the caller.

This catches edge cases where the token expired between the freshness check and the actual HTTP call to Lakekeeper.

### Refresh Timeline (5-minute token)

```
t=0m   ATTACH (token fetched, expires at t=5m)
       ▼
t=0-4m Queries execute normally with cached token
       ▼
t=4m   Background timer fires → DETACH + ATTACH (new token, expires t=9m)
       ▼
t=4-8m Queries execute with new token
       ▼
t=8m   Background timer fires again → DETACH + ATTACH
       ...
```

---

## What Persists vs. What Gets Refreshed

| Component | Lifecycle | Notes |
|---|---|---|
| DuckDB process (PID) | **Permanent** | Never restarted |
| In-memory connection | **Permanent** | Created once at init |
| Loaded extensions (iceberg, httpfs, avro) | **Permanent** | `LOAD` runs once |
| S3 settings (endpoint, keys, url_style) | **Permanent** | `SET` runs once |
| User-created temp tables/views | **Permanent** | In `memory` database |
| `lakekeeper_secret` (DuckDB SECRET) | **Cycled** | `DROP` + `CREATE` every refresh |
| `iceberg` database attachment | **Cycled** | `DETACH` + `ATTACH` every refresh |
| OAuth2 access token (inside DuckDB) | **Cycled** | New token fetched each `ATTACH` |

---

## Component Design

### `Config`

Simple class that reads all configuration from environment variables with sensible defaults. All values are read once at import time.

| Attribute | Env Var | Default |
|---|---|---|
| `WAREHOUSE_NAME` | `WAREHOUSE_NAME` | `nemo` |
| `LAKEKEEPER_CATALOG_URL` | `LAKEKEEPER_CATALOG_URL` | `http://lakekeeper:8181/catalog` |
| `KEYCLOAK_TOKEN_URL` | `KEYCLOAK_TOKEN_URL` | `""` |
| `CLIENT_ID` | `LAKEKEEPER_CLIENT_ID` | `""` |
| `CLIENT_SECRET` | `LAKEKEEPER_CLIENT_SECRET` | `""` |
| `OAUTH2_SCOPE` | `OAUTH2_SCOPE` | `openid profile email` |
| `S3_ENDPOINT` | `S3_ENDPOINT` | `""` |
| `S3_ACCESS_KEY` | `S3_ACCESS_KEY` | `""` |
| `S3_SECRET_KEY` | `S3_SECRET_KEY` | `""` |
| `MAX_ROWS` | `MAX_ROWS` | `500` |
| `EXTENSION_DIR` | `DUCKDB_EXTENSION_DIR` | `/opt/duckdb/extensions` |
| `REFRESH_MARGIN_S` | `TOKEN_REFRESH_MARGIN_SECONDS` | `60` |

### `CatalogManager`

Core class that owns the DuckDB connection and manages the Iceberg catalog lifecycle.

**State**:
- `_conn` — single DuckDB in-memory connection (long-lived).
- `_lock` — `threading.Lock` serializing all DuckDB operations and refreshes.
- `_attached` — whether the `iceberg` database is currently attached.
- `_token_fetched_at` — `time.monotonic()` timestamp of last `ATTACH`.
- `_token_lifetime` — `expires_in` from Keycloak (probed once, cached).
- `_refresh_timer` — daemon `threading.Timer` for proactive refresh.

**Key methods**:

| Method | Visibility | Description |
|---|---|---|
| `initialize()` | Public | First-time catalog attachment (called once at startup) |
| `query(sql)` | Public | Execute SQL with pre-check + retry-on-401 |
| `_init_connection()` | Private | Create DuckDB conn, load extensions, set S3 config |
| `_probe_token_lifetime()` | Private | One-time client_credentials fetch to read `expires_in` |
| `_attach_catalog()` | Private | `DROP SECRET` → `CREATE SECRET` → `ATTACH` (lock must be held) |
| `_ensure_fresh()` | Private | Pre-query double-checked locking freshness gate |
| `_background_refresh()` | Private | Timer callback for proactive refresh |
| `_query_locked(sql, is_retry)` | Private | Execute + fetch inside lock; retry once on 401 |

### `create_server(catalog)`

Factory function that creates and returns a `FastMCP` instance with all tool registrations. Each tool delegates to `CatalogManager.query()`.

---

## MCP Tool Interface

All tools return JSON strings matching the `mcp-server-motherduck` response format.

### `execute_query(sql: str) -> str`

Execute arbitrary DuckDB SQL.

**Success response**:
```json
{
  "success": true,
  "columns": ["id", "name"],
  "columnTypes": ["INTEGER", "VARCHAR"],
  "rows": [[1, "alice"], [2, "bob"]],
  "rowCount": 2
}
```

**Truncated response** (when rows exceed `MAX_ROWS`):
```json
{
  "success": true,
  "columns": ["id"],
  "columnTypes": ["INTEGER"],
  "rows": [[1], [2], "..."],
  "rowCount": 500,
  "truncated": true,
  "warning": "Results limited to 500 rows."
}
```

**Error response** (raised as `ValueError` so FastMCP marks `isError=true`):
```json
{
  "success": false,
  "error": "Table 'foo' does not exist",
  "errorType": "CatalogException"
}
```

### `list_databases() -> str`

Returns `duckdb_databases()` output (attached databases and their types).

### `list_tables(database?, schema?) -> str`

Returns `SHOW ALL TABLES` with optional client-side filtering by database and/or schema name.

### `list_columns(table, database?, schema?) -> str`

Returns `DESCRIBE <qualified_table>` with fully-qualified name construction.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WAREHOUSE_NAME` | No | Lakekeeper warehouse name (default: `nemo`) |
| `LAKEKEEPER_CATALOG_URL` | No | Iceberg REST catalog endpoint (default: `http://lakekeeper:8181/catalog`) |
| `KEYCLOAK_TOKEN_URL` | Yes | Keycloak OIDC token endpoint for `client_credentials` grant |
| `LAKEKEEPER_CLIENT_ID` | Yes | OAuth2 client ID (from K8s secret `keycloak-oidc-secrets`) |
| `LAKEKEEPER_CLIENT_SECRET` | Yes | OAuth2 client secret (from K8s secret `keycloak-oidc-secrets`) |
| `OAUTH2_SCOPE` | No | OAuth2 scope (default: `openid profile email`) |
| `S3_ENDPOINT` | No | S3-compatible object store URL (e.g., `http://s3gateway:7070`) |
| `S3_ACCESS_KEY` | No | S3 access key (from K8s secret `nemo-s3gateway-credentials`) |
| `S3_SECRET_KEY` | No | S3 secret key (from K8s secret `nemo-s3gateway-credentials`) |
| `MAX_ROWS` | No | Maximum rows returned per query (default: `500`) |
| `DUCKDB_EXTENSION_DIR` | No | Path to pre-installed extensions (default: `/opt/duckdb/extensions`) |
| `TOKEN_REFRESH_MARGIN_SECONDS` | No | Seconds before expiry to trigger refresh (default: `60`) |

### CLI Arguments

| Argument | Default | Description |
|---|---|---|
| `--host` | `0.0.0.0` | Bind address |
| `--port` | `8000` | Listen port |
| `--transport` | `streamable-http` | MCP transport (`streamable-http` or `stdio`) |

---

## Container Image

### Dockerfile

```dockerfile
FROM python:3.12-slim

# mcp-server-motherduck pulls in duckdb + fastmcp at compatible versions.
RUN pip install --no-cache-dir mcp-server-motherduck==1.0.1

ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
RUN mkdir -p ${DUCKDB_EXTENSION_DIR} && \
    python -c "..." && \          # INSTALL iceberg, httpfs, avro
    chmod -R a+rX ${DUCKDB_EXTENSION_DIR}

COPY server.py /app/server.py
COPY entrypoint.sh /entrypoint.sh

USER 1000
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
```

### Entrypoint

The `entrypoint.sh` performs pre-flight checks before `exec`-ing the server:

1. **DNS resolution** for `lakekeeper` and `keycloak.agentstudio-identity.svc.cluster.local`.
2. **HTTP readiness polling** for Lakekeeper (`/catalog/v1/config`) and Keycloak realm URL.
3. **OAuth2 smoke test** — fetches a `client_credentials` token to verify credentials before DuckDB tries them.
4. **`exec python3 /app/server.py`** — replaces the shell process.

---

## Deployment

The DuckDB MCP server is deployed as a managed Kubernetes workload by config-service's `MCPRuntimeManager`. No changes to the deployment model are needed — only the container image behavior changes.

### Provisioned Resources (unchanged)

- **Deployment** (1 replica) with the `nemo/mcp-server-duckdb:latest` image
- **ClusterIP Service** on port 8000
- **NetworkPolicy** (ingress from Bifrost gateway, egress to Lakekeeper:8181, Keycloak:8080, S3:7070)
- **K8s Secret** for sensitive env vars (OAuth2 + S3 credentials)

### Health Probing

TCP probe on port 8000 (same as before). FastMCP's Streamable HTTP transport accepts TCP connections as soon as the server starts.

---

## Concurrency and Thread Safety

DuckDB's Python API is **not thread-safe**. All access to the connection is serialized via `threading.Lock`:

```
MCP Tool Call (main thread)          Background Timer (daemon thread)
        │                                       │
        ▼                                       ▼
   _ensure_fresh()                    _background_refresh()
        │                                       │
        ├─ check remaining ─┐                   ├─ acquire _lock ──┐
        │  (no lock needed)  │                   │   (may wait)     │
        │                    │                   │                  │
        ▼                    │                   ▼                  │
   if near expiry:           │              if still near expiry:   │
     acquire _lock ───────┐  │                _attach_catalog()     │
     _attach_catalog()    │  │                release _lock ────────┘
     release _lock ───────┘  │
        │                    │
        ▼                    │
   acquire _lock ────────────┘
   _query_locked(sql)
   release _lock
```

**Guarantees**:
- No concurrent DuckDB operations (queries or catalog mutations).
- No `DETACH` during an in-flight query.
- Background refresh waits for any running query to finish before proceeding.
- Pre-query check and background timer cannot both refresh simultaneously (double-check after lock acquisition).

---

## Alternatives Considered

### 1. Restart the MCP Server Pod Periodically

Rejected. Kills in-flight queries, drops MCP connections, loses in-memory state.

### 2. Pass the User's GUI Token Through to Lakekeeper

Architecturally cleaner for per-user RBAC but requires changes across 5 components (agent-service, Agno SDK, Bifrost gateway, MCP protocol, DuckDB connection model) and fundamentally conflicts with the shared/pooled MCP connection model. See discussion in the conversation history for a detailed feasibility analysis.

### 3. Increase Keycloak Token Lifetime

A band-aid, not a fix. Longer tokens increase the window of vulnerability if a token is leaked, and the problem reoccurs with any finite lifetime. Also violates the principle of short-lived credentials.

### 4. Patch mcp-server-motherduck

Possible (subclass `DatabaseClient`, override `query()` to add retry logic) but fragile — tightly coupled to an upstream package's internal API surface, which could break on any version update. The custom server is only ~280 lines and gives full control.

### 5. HTTP Proxy Between DuckDB and Lakekeeper

Place a token-refreshing reverse proxy (e.g., OAuth2 Proxy) between DuckDB and Lakekeeper that transparently injects fresh tokens. Adds a network hop, a new failure domain, and operational complexity for a problem solvable in ~280 lines of Python.

---

## Future Work

1. **Per-user token forwarding**: Pass the user's Keycloak access token through the MCP call chain for user-level RBAC at Lakekeeper. Requires architectural changes to agent-service, the Bifrost gateway, and the MCP protocol.

2. **DuckDB upstream fix**: Monitor [duckdb/duckdb-iceberg#102](https://github.com/duckdb/duckdb-iceberg/issues/102) for native token refresh support. Once available, the custom server can be simplified or replaced.

3. **Metrics / observability**: Emit Prometheus metrics for token refresh count, refresh latency, and retry count.

4. **Graceful refresh**: Investigate whether DuckDB supports `ALTER SECRET` or in-place token replacement to avoid the `DETACH`/`ATTACH` cycle entirely.
