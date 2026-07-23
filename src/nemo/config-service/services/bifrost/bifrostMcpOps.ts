/**
 * Bifrost MCP client API helpers (POST/GET /api/mcp/client*, /v1/mcp/tool/execute).
 */
import { AxiosInstance } from 'axios';
import { MCPToolInfo } from '../LLMGatewayClient';
import { safeLog } from '../../utils/safeStrings';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

export interface BifrostMcpClientSummary {
  server_id: string;
  server_name: string;
  url?: string;
  transport?: string;
  auth_type?: string;
  state?: string;
}

/** Raw list entry from GET /api/mcp/clients */
export function parseBifrostMcpListEntry(raw: Record<string, unknown>): BifrostMcpClientSummary | null {
  const cfg = (raw.config as Record<string, unknown> | undefined) || raw;
  const server_id = String(
    cfg.id ?? cfg.client_id ?? raw.client_id ?? raw.id ?? '',
  ).trim();
  const server_name = String(cfg.name ?? raw.name ?? '').trim();
  if (!server_id && !server_name) return null;
  return {
    server_id: server_id || server_name,
    server_name: server_name || server_id,
    url: (cfg.connection_string ?? raw.connection_string) as string | undefined,
    transport: (cfg.connection_type ?? raw.connection_type) as string | undefined,
    auth_type: (cfg.auth_type ?? raw.auth_type) as string | undefined,
    state: raw.state as string | undefined,
  };
}

export function parseToolsFromListEntry(raw: Record<string, unknown>): MCPToolInfo[] {
  const tools = (raw.tools as Array<Record<string, unknown>> | undefined) || [];
  return tools.map((t) => ({
    name: String(t.name ?? ''),
    description: t.description as string | undefined,
    inputSchema: (t.input_schema ?? t.inputSchema) as Record<string, unknown> | undefined,
  }));
}

export function extractClientIdFromAddResponse(data: Record<string, unknown>): string | undefined {
  const client = (data.client as Record<string, unknown> | undefined) || data;
  const cfg = (client.config as Record<string, unknown> | undefined) || client;
  const id = cfg.id ?? cfg.client_id ?? client.client_id ?? client.id ?? data.client_id ?? data.id;
  return id != null ? String(id) : undefined;
}

/** Bifrost prefixes tool names as `{clientName}_{tool}` for /v1/mcp/tool/execute */
export function bifrostPrefixedToolName(clientName: string, toolName: string): string {
  const prefix = `${clientName}_`;
  if (toolName.startsWith(prefix)) return toolName;
  return `${clientName}_${toolName}`;
}

export async function fetchBifrostMcpClients(
  client: AxiosInstance,
): Promise<Array<Record<string, unknown>>> {
  try {
    const resp = await client.get('/api/mcp/clients');
    const data = resp.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.clients)) return data.clients;
  } catch (err: any) {
    if (DEBUG) {
      console.warn(
        `[bifrostMcpOps] GET /api/mcp/clients failed (${safeLog(err.response?.status ?? err.message)}), trying /api/mcp/client`,
      );
    }
  }
  const fallback = await client.get('/api/mcp/client');
  const data = fallback.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.clients)) return data.clients;
  return [];
}

export async function reconnectBifrostMcpClient(
  client: AxiosInstance,
  clientId: string,
): Promise<void> {
  try {
    await client.post(`/api/mcp/client/${encodeURIComponent(clientId)}/reconnect`);
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 404 || status === 405) return;
    throw err;
  }
}
