/**
 * MCP utilities
 * Stub implementation for pipeline editor
 */

/**
 * Creates an MCP tool ID from server and tool names
 */
export function createMcpToolId(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`
}

