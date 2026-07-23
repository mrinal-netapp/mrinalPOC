# Web Search Provider Acceptance Gates

This checklist defines pass/fail gates for Tavily and SearxNG managed MCP providers.

## Provider Health Gates
- Pass: managed MCP pod reaches `runtimeStatus=running`.
- Pass: MCP server `syncStatus=synced` in config-service.
- Fail: provider unavailable, sync error, or runtime status failed/deleting.

## Tool Discovery Gates
- Pass: `GET /projects/:projectId/mcp-servers/:id/tools` returns at least one tool.
- Pass: default allowlist entries match one or more provider-reported tools.
- Fail: empty tools list with non-empty allowlist mismatch.

## Runtime Invocation Gates
- Pass: `POST /projects/:projectId/mcp-servers/:id/tools/call` succeeds for an allowed tool.
- Pass: agent invoke path can call provider tool and complete response without session breakage.
- Fail: tool call forbidden due to default filter mismatch or stream/session failure.

## Failure-Path Gates
- Pass: invalid/missing required env values are rejected at create/update with clear 4xx messages.
- Pass: unreachable provider URL/timeouts surface actionable errors without crashing services.
- Pass: rollout-disabled providers return explicit rollout-guard errors.
- Fail: silent failures, non-actionable errors, or regressions in unrelated MCP providers.

## Backward-Compatibility Gates
- Pass: existing `web_search_mcp` records continue to work after Tavily rename.
- Pass: legacy `web_search` allowlist value maps to `tavily_search`.
- Fail: existing saved MCP records become unusable without manual DB intervention.
