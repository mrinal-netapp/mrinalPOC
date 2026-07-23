/**
 * Route-handler tests for routes/platformMcpRoutes.ts.
 *
 * LiteLLM is module-mocked; all DB access flows through the AppDataSource
 * fake-repo seam (no DB, no network). These routes are not project-scoped,
 * so no Project seed is required.
 *
 * Run: node --require ts-node/register --test tests/platformMcpRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

const BASE = '/api/v1/platform/mcp-servers';

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;
let litellm: any;

beforeEach(() => {
  handle = installFakeRepositories({});
  litellm = {
    enabled: false,
    isEnabled() {
      return this.enabled;
    },
    addMCPServer: async () => ({ server_id: 'lite-1' }),
    removeMCPServer: async () => ({}),
    editMCPServer: async () => ({}),
  };
  scope = restoreScope();
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => litellm }));
  const router = loadFresh('routes/platformMcpRoutes').default;
  app = buildApp({ basePath: BASE, router });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/platformMcpRoutes');
  mock.restoreAll();
  handle.restore();
});

function seedServer(overrides: Record<string, any>) {
  handle.repos.MCPServer = makeFakeRepo(overrides);
}

// ── Create ──
test('POST /: creates a new platform server with litellm disabled (201)', async () => {
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'plat-1' }),
    save: async (e: any) => ({ ...e }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'plat1', url: 'http://example.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.deploymentType, 'platform');
  assert.equal(res.body.syncStatus, 'pending');
  assert.equal(res.body.llmproxyGatewayServerName, 'plat1');
});

test('POST /: litellm enabled registers and marks synced (201)', async () => {
  litellm.enabled = true;
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'plat-1' }),
    save: async (e: any) => ({ ...e }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'my-server', url: 'http://example.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.syncStatus, 'synced');
  assert.equal(res.body.llmproxyGatewayServerId, 'lite-1');
  // dashes are normalized to underscores for the litellm server name
  assert.equal(res.body.llmproxyGatewayServerName, 'my_server');
});

test('POST /: converges an already-synced server and returns 200', async () => {
  litellm.enabled = true;
  const existing = {
    id: 'plat-1',
    llmproxyGatewayServerId: 'lite-1',
    syncStatus: 'synced',
    url: 'http://old.example.com',
  };
  let edited = false;
  litellm.editMCPServer = async () => {
    edited = true;
    return {};
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async (q: any) =>
      q?.where?.name ? existing : { ...existing, url: 'http://new.example.com' },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'plat1', url: 'http://new.example.com' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'http://new.example.com');
  assert.equal(edited, true);
});

test('POST /: web_search disabled by rollout guard returns 403', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'websearch', catalogId: 'web_search_mcp' },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /disabled by rollout guard/);
});

test('POST /: repository error surfaces as 400', async () => {
  seedServer({
    findOne: async () => {
      throw new Error('db boom');
    },
  });
  const res = await request(app, 'POST', BASE, { body: { name: 'plat1', url: 'http://x' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /db boom/);
});

// ── List ──
test('GET /: lists platform servers (200)', async () => {
  seedServer({ find: async () => [{ id: 'plat-1', name: 'plat1', deploymentType: 'platform' }] });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'plat-1');
});

test('GET /: repository error surfaces as 500', async () => {
  seedServer({
    find: async () => {
      throw new Error('list boom');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

// ── Delete ──
test('DELETE /:id: not found returns 404', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/missing`)).status, 404);
});

test('DELETE /:id: deletes and deregisters from litellm (200)', async () => {
  litellm.enabled = true;
  let removed = false;
  litellm.removeMCPServer = async () => {
    removed = true;
    return {};
  };
  seedServer({
    findOne: async () => ({ id: 'plat-1', deploymentType: 'platform', llmproxyGatewayServerId: 'lite-1' }),
    delete: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'DELETE', `${BASE}/plat-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
  assert.equal(removed, true);
});

test('POST /: searxng web search disabled by rollout guard returns 403', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'searxng', catalogId: 'searxng_web_search_mcp' },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /disabled by rollout guard/);
});

test('POST /: litellm registration failure marks syncStatus error (201)', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('gateway registration failed');
  };
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'plat-err' }),
    save: async (e: any) => ({ ...e }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'broken-server', url: 'http://example.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.syncStatus, 'error');
});

test('POST /: updates unsynced existing server without gateway registration (200)', async () => {
  const existing = {
    id: 'plat-2',
    llmproxyGatewayServerId: null,
    syncStatus: 'pending',
    url: 'http://old.example.com',
  };
  seedServer({
    findOne: async (q: any) => {
      if (q?.where?.id) {
        return { ...existing, url: 'http://new.example.com', syncStatus: 'pending' };
      }
      return existing;
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'plat2', url: 'http://new.example.com', catalogId: 'analytics_datasets_mcp' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'http://new.example.com');
});

test('POST /: converges synced server even when litellm edit fails (200)', async () => {
  litellm.enabled = true;
  litellm.editMCPServer = async () => {
    throw new Error('edit failed');
  };
  const existing = {
    id: 'plat-3',
    llmproxyGatewayServerId: 'lite-3',
    syncStatus: 'synced',
    url: 'http://old.example.com',
    extraHeaders: null,
  };
  seedServer({
    findOne: async (q: any) =>
      q?.where?.name ? existing : { ...existing, url: 'http://new.example.com' },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'plat3', url: 'http://new.example.com' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'http://new.example.com');
});

test('DELETE /:id: still deletes when litellm removal fails (200)', async () => {
  litellm.enabled = true;
  litellm.removeMCPServer = async () => {
    throw new Error('remove failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'plat-4',
      deploymentType: 'platform',
      llmproxyGatewayServerId: 'lite-4',
      name: 'plat-four',
    }),
    delete: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'DELETE', `${BASE}/plat-4`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
});

test('DELETE /:id: repository error surfaces as 500', async () => {
  seedServer({
    findOne: async () => ({ id: 'plat-5', deploymentType: 'platform' }),
    delete: async () => {
      throw new Error('delete boom');
    },
  });
  const res = await request(app, 'DELETE', `${BASE}/plat-5`);
  assert.equal(res.status, 500);
});
