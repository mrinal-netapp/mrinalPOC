import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"

/** Normalized display health for a tool/MCP server. */
export type ToolHealth = "healthy" | "unhealthy" | "deploying" | "unknown"

/**
 * Derive a tool's display health from its MCP server row.
 *
 * Catalog-deployed ("managed") tools provision a K8s pod asynchronously. While
 * `runtimeStatus === 'provisioning'` the pod isn't ready, Bifrost health hasn't
 * been probed yet, and `status` sits at a meaningless `'unknown'`. Surface that
 * as `'deploying'` so users see progress instead of a scary "Unknown"; a failed
 * provision maps to `'unhealthy'`. Otherwise fall back to Bifrost connectivity
 * (`status`). Non-managed servers have no `runtimeStatus`, so they are unaffected.
 */
export function deriveToolHealth(
  server: Pick<McpServerSummary, "status" | "runtimeStatus">,
): ToolHealth {
  if (server.runtimeStatus === "provisioning") return "deploying"
  if (server.runtimeStatus === "failed") return "unhealthy"

  switch (server.status) {
    case "connected":
      return "healthy"
    case "error":
    case "disconnected":
      return "unhealthy"
    default:
      return "unknown"
  }
}
