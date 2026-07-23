# Analytics MCP Server — Design Document

> **Note (gateway migration):** Earlier revisions of this doc described
> the MCP proxy as LiteLLM. AgentStudio has since migrated entirely to
> the **Bifrost** LLM gateway, which owns the same MCP-client registry,
> header forwarding, and per-server allowlist semantics. Read every
> "LiteLLM" / "LiteLLM proxy" reference below as "Bifrost" / "Bifrost
> gateway"; the on-the-wire shape (header forwarding, /mcp endpoint) is
> unchanged. See [bifrost-migration.md](../design/bifrost-migration.md).

## Overview

A platform-wide MCP (Model Context Protocol) server that gives agents SQL analytics
capabilities on project datasets registered in the Iceberg catalog. Unlike the existing
per-project `duckdb_iceberg` MCP servers, this is a single shared service backed by
the analytics-engine, with strict tenant isolation enforced through JWT binding and
SQL AST validation.

## Architecture

```
User → agent-service → Bifrost MCP proxy → analytics-mcp-server → analytics-engine (DuckDB)
                                                                         ↓
                                                                  Iceberg catalog
                                                                  (Lakekeeper + S3)
```

### Components

| Component | Language | Deployment | Purpose |
|-----------|----------|------------|---------|
| analytics-mcp-server | Python (FastMCP) | Separate K8s Deployment | MCP tool definitions, request routing, response formatting |
| analytics-engine | Go (DuckDB) | Existing Deployment | SQL execution, AST validation, tenant queue, auth |
| config-service | TypeScript | Existing Deployment | Platform MCP registration, health tracking |
| Bifrost gateway | Go | Existing Deployment | MCP proxy, header forwarding, per-project virtual keys |

### Identity Propagation (Outcome A)

Bifrost forwards the user's `Authorization` header (plus other identity
headers — `X-User-ID`, `X-Project-ID`, etc. — when on the gateway-side
allowlist) to the MCP shim. The shim passes it to analytics-engine,
where existing JWT middleware validates it and extracts
`agentstudio.project_id`. All enforcement is bound to this validated claim.

## Tenant Isolation

### Defense in depth

1. **JWT binding**: All agent-facing endpoints require `agentstudio.project_id` from validated JWT
2. **SQL AST validation**: DuckDB `json_serialize_sql` + Go walker enforces relation closure
3. **Namespace = project**: Only `iceberg."<projectId>".*` table references allowed
4. **Blocked constructs**: DDL, DML, table functions, ATTACH, COPY, INSTALL, LOAD, PRAGMA

### SQL Validation

Uses a dedicated parse-only DuckDB connection (json extension only, no catalog) to avoid
contending with the engine's serialized query slot. The validator:

- Parses SQL via `SELECT json_serialize_sql('<query>')`
- Walks the JSON AST to collect all `BASE_TABLE` references
- Rejects `TABLE_FUNCTION` references (read_parquet, read_csv, etc.)
- Rejects blocked node types (CREATE, INSERT, UPDATE, DELETE, ATTACH, etc.)
- Validates every base table is `iceberg."<jwt_project_id>"."<table>"`
- Rejects multi-statement input
- Failure-closed: any parse error → reject

## Endpoints

### Agent API (`/api/v1/agent/*`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/agent/query` | POST | Execute validated SQL (JOINs, CTEs, etc.) |
| `/api/v1/agent/describe` | POST | Describe table columns |
| `/api/v1/agent/datasets` | POST | List tables in project namespace |
| `/api/v1/agent/preview` | POST | Preview rows from a table |
| `/api/v1/agent/stats` | POST | Per-column statistics |
| `/api/v1/agent/histogram` | POST | Histogram for a column |

All endpoints require JWT with `agentstudio.project_id`. The GUI path
(`/api/flightsql/*`) is untouched.

## Operational Guardrails

| Guardrail | Default | Config |
|-----------|---------|--------|
| Statement timeout | 60s | `AGENT_STATEMENT_TIMEOUT_S` |
| Max rows | 500 | `AGENT_MAX_ROWS` |
| Per-tenant queue slots | 2 | `TENANT_QUEUE_SLOTS` |
| Queue max wait | 10s | `TENANT_QUEUE_MAX_WAIT_S` |
| Rate limit (agent) | 120/min | `DefaultAgentRateLimit` |
| Query cache | Disabled on agent path | — |

### Truncation

When the row cap is hit, the response includes `"truncated": true` and a warning
message. The MCP shim surfaces this in tool output so agents don't summarize
incomplete data as complete.

## Token Refresh

### Catalog OAuth (Iceberg/Lakekeeper)

analytics-engine has proactive + timer-based refresh. This design adds reactive
401 retry (`QueryContextWithRetry`) matching the Python MCP server's layer 3.

### User JWT

Forwarded per-request. If expired, analytics-engine returns 401 which the MCP
shim translates to "session may have expired" for the agent.

## Registration and Health

- **Bootstrap**: Helm post-install Job calls `POST /api/v1/platform/mcp-servers`
- **Auto-attach**: `agentRoutes.ts` attaches to all agents when `AUTO_ATTACH_PLATFORM_ANALYTICS_MCP=true`
- **Health**: Temporal `mcp-health-check` workflow probes `tools/list` every 5 minutes
- **Circuit breaker**: 3 consecutive failures → deregister from the Bifrost gateway; re-register on recovery

## Rollout

1. Deploy analytics-mcp-server and analytics-engine with agent endpoints
2. Run Helm bootstrap job to register platform MCP server
3. Set `AUTO_ATTACH_PLATFORM_ANALYTICS_MCP=true` for pilot projects
4. Monitor audit logs, queue depth, and timeout metrics
5. Ramp to all projects

### Kill switch

Set MCPServer row `status: 'error'` to immediately exclude from all agents.

## PII Policy

Default ON — agents can access PII columns. Mitigations:
- Prompt fragment documents PII may be present
- Audit logs record which tables are accessed per query
- Per-project disable flag is a named follow-up

## Related Documents

- [DuckDB Iceberg MCP Server Design](duckdb-iceberg-mcp-server-design.md)
- [MCP Server Gateway Design](mcp-server-gateway-design.md)
