/**
 * Unit tests for `services/bifrost/bifrostMcpOps.ts`.
 *
 * Run: node --require ts-node/register --test tests/bifrostMcpOps.unit.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import {
  parseBifrostMcpListEntry,
  parseToolsFromListEntry,
  extractClientIdFromAddResponse,
  bifrostPrefixedToolName,
  reconnectBifrostMcpClient,
} from '../services/bifrost/bifrostMcpOps';
import { clearModule, loadFresh } from './helpers/moduleMock';

// ─── parseBifrostMcpListEntry ───────────────────────────────────────────────

test('parseBifrostMcpListEntry: reads nested config fields', () => {
  const parsed = parseBifrostMcpListEntry({
    config: {
      id: 'client-1',
      name: 'github',
      connection_string: 'http://mcp:8080',
      connection_type: 'sse',
      auth_type: 'none',
    },
    state: 'connected',
  });
  assert.deepEqual(parsed, {
    server_id: 'client-1',
    server_name: 'github',
    url: 'http://mcp:8080',
    transport: 'sse',
    auth_type: 'none',
    state: 'connected',
  });
});

test('parseBifrostMcpListEntry: falls back to top-level ids and names', () => {
  const parsed = parseBifrostMcpListEntry({
    client_id: 'top-id',
    name: 'artifact_store',
    connection_string: 'stdio',
    connection_type: 'stdio',
  });
  assert.equal(parsed?.server_id, 'top-id');
  assert.equal(parsed?.server_name, 'artifact_store');
});

test('parseBifrostMcpListEntry: returns null when both id and name are empty', () => {
  assert.equal(parseBifrostMcpListEntry({}), null);
  assert.equal(parseBifrostMcpListEntry({ config: { id: '  ', name: '' } }), null);
});

test('parseBifrostMcpListEntry: uses name as id when only name is present', () => {
  const parsed = parseBifrostMcpListEntry({ name: 'analytics_datasets_mcp' });
  assert.deepEqual(parsed, {
    server_id: 'analytics_datasets_mcp',
    server_name: 'analytics_datasets_mcp',
    url: undefined,
    transport: undefined,
    auth_type: undefined,
    state: undefined,
  });
});

// ─── parseToolsFromListEntry ────────────────────────────────────────────────

test('parseToolsFromListEntry: normalizes tool schema fields', () => {
  const tools = parseToolsFromListEntry({
    tools: [
      { name: 'search', description: 'Search code', input_schema: { type: 'object' } },
      { name: 'read', inputSchema: { type: 'object', properties: {} } },
    ],
  });
  assert.deepEqual(tools, [
    { name: 'search', description: 'Search code', inputSchema: { type: 'object' } },
    { name: 'read', description: undefined, inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('parseToolsFromListEntry: empty when tools missing', () => {
  assert.deepEqual(parseToolsFromListEntry({}), []);
});

// ─── extractClientIdFromAddResponse ─────────────────────────────────────────

test('extractClientIdFromAddResponse: reads nested client config ids', () => {
  assert.equal(
    extractClientIdFromAddResponse({
      client: { config: { client_id: 'nested-id' } },
    }),
    'nested-id',
  );
  assert.equal(extractClientIdFromAddResponse({ id: 'flat-id' }), 'flat-id');
  assert.equal(extractClientIdFromAddResponse({}), undefined);
});

// ─── bifrostPrefixedToolName ────────────────────────────────────────────────

test('bifrostPrefixedToolName: prefixes unless already prefixed', () => {
  assert.equal(bifrostPrefixedToolName('github', 'search'), 'github_search');
  assert.equal(bifrostPrefixedToolName('github', 'github_search'), 'github_search');
});

// ─── fetchBifrostMcpClients ─────────────────────────────────────────────────

const ORIGINAL_DEBUG = process.env.DEBUG;

afterEach(() => {
  if (ORIGINAL_DEBUG === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = ORIGINAL_DEBUG;
  clearModule('services/bifrost/bifrostMcpOps');
});

async function loadMcpOps() {
  clearModule('services/bifrost/bifrostMcpOps');
  return loadFresh<typeof import('../services/bifrost/bifrostMcpOps')>('services/bifrost/bifrostMcpOps');
}

test('fetchBifrostMcpClients: returns array from /api/mcp/clients', async () => {
  const { fetchBifrostMcpClients } = await loadMcpOps();
  const fake = {
    get: async (url: string) => {
      if (url === '/api/mcp/clients') return { data: [{ id: 'a' }] };
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await fetchBifrostMcpClients(fake), [{ id: 'a' }]);
});

test('fetchBifrostMcpClients: unwraps clients array from primary endpoint', async () => {
  const { fetchBifrostMcpClients } = await loadMcpOps();
  const fake = {
    get: async (url: string) => {
      if (url === '/api/mcp/clients') return { data: { clients: [{ id: 'wrapped' }] } };
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await fetchBifrostMcpClients(fake), [{ id: 'wrapped' }]);
});

test('fetchBifrostMcpClients: falls back to /api/mcp/client on primary failure', async () => {
  const { fetchBifrostMcpClients } = await loadMcpOps();
  const calls: string[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push(url);
      if (url === '/api/mcp/clients') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/mcp/client') return { data: [{ id: 'fallback' }] };
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await fetchBifrostMcpClients(fake), [{ id: 'fallback' }]);
  assert.deepEqual(calls, ['/api/mcp/clients', '/api/mcp/client']);
});

test('fetchBifrostMcpClients: logs debug warning on primary failure when DEBUG is set', async () => {
  process.env.DEBUG = 'true';
  const { fetchBifrostMcpClients } = await loadMcpOps();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => {
    warnings.push(String(msg));
  };
  try {
    const fake = {
      get: async (url: string) => {
        if (url === '/api/mcp/clients') {
          const err: any = new Error('unavailable');
          err.response = { status: 503 };
          throw err;
        }
        if (url === '/api/mcp/client') return { data: [{ id: 'fb' }] };
        throw new Error(`unexpected ${url}`);
      },
    } as unknown as AxiosInstance;
    await fetchBifrostMcpClients(fake);
    assert.ok(
      warnings.some((w) => w.includes('GET /api/mcp/clients failed') && w.includes('/api/mcp/client')),
    );
  } finally {
    console.warn = origWarn;
  }
});

test('fetchBifrostMcpClients: returns [] when fallback has no list', async () => {
  const { fetchBifrostMcpClients } = await loadMcpOps();
  const fake = {
    get: async (url: string) => {
      if (url === '/api/mcp/clients') throw new Error('primary down');
      if (url === '/api/mcp/client') return { data: {} };
      throw new Error(`unexpected ${url}`);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await fetchBifrostMcpClients(fake), []);
});

// ─── reconnectBifrostMcpClient ──────────────────────────────────────────────

test('reconnectBifrostMcpClient: posts to reconnect endpoint', async () => {
  const calls: string[] = [];
  const fake = {
    post: async (url: string) => {
      calls.push(url);
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  await reconnectBifrostMcpClient(fake, 'client/with space');
  assert.deepEqual(calls, ['/api/mcp/client/client%2Fwith%20space/reconnect']);
});

test('reconnectBifrostMcpClient: swallows 404 and 405', async () => {
  for (const status of [404, 405]) {
    const fake = {
      post: async () => {
        const err: any = new Error('gone');
        err.response = { status };
        throw err;
      },
    } as unknown as AxiosInstance;
    await reconnectBifrostMcpClient(fake, 'missing');
  }
});

test('reconnectBifrostMcpClient: rethrows other errors', async () => {
  const fake = {
    post: async () => {
      const err: any = new Error('server error');
      err.response = { status: 500 };
      throw err;
    },
  } as unknown as AxiosInstance;
  await assert.rejects(
    () => reconnectBifrostMcpClient(fake, 'client-1'),
    (err: any) => err.response?.status === 500,
  );
});
