/** Matches config-service `catalog/platformMcpDefaults.ts`. */
export const PLATFORM_MCP_DEFAULT_EXTRA_HEADERS = [
  "Authorization",
  "X-Project-ID",
  "X-User-ID",
  "X-Session-ID",
] as const

/** Headers to show in the UI for a platform MCP (DB value or defaults). */
export function resolveDisplayedForwardedHeaders(
  deploymentType: string | null | undefined,
  extraHeaders: string[] | null | undefined,
): string[] {
  const existing = (extraHeaders ?? []).filter((name) => name.trim().length > 0)
  if (existing.length > 0) return existing
  if (deploymentType === "platform") return [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS]
  return []
}
