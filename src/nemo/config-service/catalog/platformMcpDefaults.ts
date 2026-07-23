import {
  ANALYTICS_DATASETS_CATALOG_ID,
  SEARXNG_WEB_SEARCH_CATALOG_ID,
  WEB_SEARCH_CATALOG_ID,
} from './mcpServerCatalog';

/** Rollout gates controlling which platform MCP servers auto-attach to projects. */
export interface PlatformMcpAutoAttachFlags {
  webSearch: boolean;
  analytics: boolean;
}

/**
 * Whether a platform MCP server (identified by its catalog id) should be
 * auto-attached to every project. Web-search and analytics are behind rollout
 * flags; every other platform MCP (e.g. artifact-store) is always on.
 *
 * This is the single source of truth shared by:
 *   - the agent read-shape (`GET /agents/:id` `_resolvedMCPServers` in
 *     `agentRoutes.ts`), which advertises platform servers to agent-service, and
 *   - the project virtual-key attachment
 *     (`attachPlatformMcpServersToProjectVirtualKey` in
 *     `bifrostProjectGovernance.ts`), which makes those servers reachable
 *     through the project's Bifrost VK.
 * Keeping both on one predicate guarantees a project's VK exposes exactly the
 * platform MCP clients its agents are told about.
 */
export function isPlatformMcpAutoAttachable(
  catalogId: string | null | undefined,
  flags: PlatformMcpAutoAttachFlags,
): boolean {
  if (
    (catalogId === WEB_SEARCH_CATALOG_ID ||
      catalogId === SEARXNG_WEB_SEARCH_CATALOG_ID) &&
    !flags.webSearch
  ) {
    return false;
  }
  if (catalogId === ANALYTICS_DATASETS_CATALOG_ID && !flags.analytics) {
    return false;
  }
  return true;
}

/** Read the platform-MCP auto-attach rollout flags from the environment. */
export function readPlatformMcpAutoAttachFlags(): PlatformMcpAutoAttachFlags {
  return {
    webSearch:
      String(process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP || '').toLowerCase() ===
      'true',
    analytics:
      String(process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP || '').toLowerCase() ===
      'true',
  };
}

/**
 * Identity headers agent-service injects on MCP tool calls (see
 * agent-service/src/mcp_pool.py). Platform MCP servers must allowlist
 * these in Bifrost via `extraHeaders` so they reach downstream services
 * (artifact-store ACL/audit, analytics tenant isolation, etc.).
 *
 * X-Agent-ID / X-Team-ID are injected by agent-service but are not
 * required by platform MCP backends today.
 */
export const PLATFORM_MCP_DEFAULT_EXTRA_HEADERS = [
  'Authorization',
  'X-Project-ID',
  'X-User-ID',
  'X-Session-ID',
] as const;

/** Merge request/existing headers with the platform defaults (defaults first). */
export function mergePlatformMcpExtraHeaders(existing?: string[] | null): string[] {
  const extras = (existing ?? []).filter(
    (h) => !PLATFORM_MCP_DEFAULT_EXTRA_HEADERS.includes(h as (typeof PLATFORM_MCP_DEFAULT_EXTRA_HEADERS)[number]),
  );
  return [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS, ...extras];
}

/** True when the stored allowlist is missing defaults or has stale extras. */
export function platformMcpExtraHeadersNeedUpdate(existing?: string[] | null): boolean {
  const expected = [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS];
  if (!existing?.length) return true;
  if (existing.length !== expected.length) return true;
  return !expected.every((h, i) => existing[i] === h);
}

/** Resolve extraHeaders for platform MCP create/register (always includes defaults). */
export function resolvePlatformMcpExtraHeaders(requested?: string[] | null): string[] {
  return mergePlatformMcpExtraHeaders(requested);
}
