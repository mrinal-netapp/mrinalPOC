# Azure NetApp Files MCP server

> Status: implemented (v1)
> Owners: Connectors / MCP Server platform

Managed MCP server (`anf_mcp`) for reading and resizing Azure NetApp Files
capacity pools and volumes via Azure Resource Manager. Shares `anf_common` with
the connector-worker ANF metrics adapter.

## Components

| Piece | Path |
|-------|------|
| Canonical ARM client | `src/nemo/workers/connector-worker/anf_common/` |
| Metrics adapter | `adapters/anf_metrics_adapter.py` (Monitor ingest only) |
| MCP image | `src/images/mcp-server-anf/` |
| Catalog | `config-service/catalog/mcpServerCatalog.ts` → `anf_mcp` |

## Credentials

Link a runtime credential with provider `azure_cloud` (`tenant_id`,
`client_id`, `client_secret`). Non-secret env: `AZURE_SUBSCRIPTION_ID`,
`AZURE_DEFAULT_REGION`, optional `AZURE_RESOURCE_GROUP`.

## Tool surface

**Read (default):** `anf_capacity_pool_list`, `anf_capacity_pool_get`,
`anf_volume_list`, `anf_volume_get`

**Write (opt-in via `ANF_ALLOWED_TOOLS`):** `anf_resize_capacity_pool`,
`anf_resize_volume`

Write tools emit structured audit JSON (`audit=true`) before PATCH.

## RBAC

Service principal needs at least Reader on NetApp resources; resize requires
`Microsoft.NetApp/netAppAccounts/capacityPools/write` and
`.../volumes/write`.

## Integration tests

Set `ANF_INTEGRATION=1` and pool/volume ARM IDs to run
`tests/test_anf_mcp_integration.py` (grow-only).
