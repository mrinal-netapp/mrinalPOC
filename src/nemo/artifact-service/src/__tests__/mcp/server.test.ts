import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { handleMcpRequest, TOOL_NAMES } from '../../mcp/server';
import { HandlerDeps } from '../../mcp/handlers';
import { Principal, RequestContext } from '../../types/Principal';

/**
 * End-to-end wiring test for the per-request MCP server. We stand up the real
 * Express route -> handleMcpRequest path and drive it with the official MCP
 * client over StreamableHTTP. whoami and the list_stores forbidden path do not
 * touch the repositories, so empty deps are sufficient here (handler logic is
 * covered separately in handlers.test.ts).
 */

const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  principal: { kind: 'user', id: 'user-owner' } as Principal,
  projectId: 'projtest',
  sessionId: 'sess-1',
  ...overrides,
});

describe('handleMcpRequest (MCP server wiring)', () => {
  let server: Server;
  let baseUrl: string;
  const deps = {} as unknown as HandlerDeps;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/mcp', (req, res, next) => {
      handleMcpRequest(req, res, deps, ctx()).catch(next);
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  it('registers all 10 tools with descriptions', async () => {
    const tools = await withClient((client) => client.listTools());
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(TOOL_NAMES.length);
    for (const tool of tools.tools) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
    }
  });

  it('tools/call whoami returns content with isError false', async () => {
    const result = await withClient((client) =>
      client.callTool({ name: 'whoami', arguments: {} }),
    );
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe('text');
    const payload = JSON.parse(content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.principal.encoded).toBe('user:user-owner');
  });

  it('tools/call surfaces a handler ok:false as isError true', async () => {
    const result = await withClient((client) =>
      client.callTool({ name: 'list_stores', arguments: { project_id: 'wrong' } }),
    );
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('forbidden');
  });
});
