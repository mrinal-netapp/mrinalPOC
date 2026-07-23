/**
 * Route-handler tests for routes/internalMcpHealthRoutes.ts.
 *
 * This router transitively imports routes/mcpServerRoutes (for
 * buildGatewayServerConfig / resolveCredentialData), so BifrostGatewayClient,
 * CredentialService and MCPRuntimeManager are all module-mocked before
 * loading. DB access flows through the AppDataSource fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/internalMcpHealthRoutes.routes.unit.test.ts
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

const BASE = '/api/v1/internal/mcp-servers';

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;
let litellm: any;
let cred: any;
let runtime: any;

beforeEach(() => {
  handle = installFakeRepositories({});
  litellm = {
    enabled: false,
    isEnabled() {
      return this.enabled;
    },
    addMCPServer: async () => ({ server_id: 'lite-new' }),
    removeMCPServer: async () => ({}),
    editMCPServer: async () => ({}),
  };
  cred = {
    getById: async () => null,
    readSecretData: async () => null,
  };
  runtime = {
    provisionAsync: () => undefined,
    patchConfig: async () => undefined,
    deprovision: async () => undefined,
    getStatus: async () => ({ phase: 'Running' }),
  };
  scope = restoreScope();
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => litellm }));
  scope.add(mockModule('services/CredentialService', { getCredentialService: () => cred }));
  scope.add(mockModule('services/MCPRuntimeManager', { getMCPRuntimeManager: () => runtime }));
  const router = loadFresh('routes/internalMcpHealthRoutes', ['routes/mcpServerRoutes']).default;
  app = buildApp({ basePath: BASE, router });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/internalMcpHealthRoutes', 'routes/mcpServerRoutes');
  mock.restoreAll();
  handle.restore();
});

function seedServer(overrides: Record<string, any>) {
  handle.repos.MCPServer = makeFakeRepo(overrides);
}

// ── /health-eligible ──
test('GET /health-eligible: empty list returns [] (200)', async () => {
  seedServer({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /health-eligible: returns trimmed rows, excludes provisioning/deleting', async () => {
  seedServer({
    find: async () => [
      { id: 'm1', llmproxyGatewayServerName: 'n1', syncStatus: 'synced', llmproxyGatewayServerId: 'l1', runtimeStatus: 'running', deploymentType: 'remote' },
      { id: 'm2', llmproxyGatewayServerName: 'n2', syncStatus: 'synced', llmproxyGatewayServerId: 'l2', runtimeStatus: 'provisioning', deploymentType: 'managed' },
      { id: 'm3', llmproxyGatewayServerName: 'n3', syncStatus: 'synced', llmproxyGatewayServerId: 'l3', runtimeStatus: 'deleting', deploymentType: 'managed' },
    ],
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'm1');
  assert.deepEqual(Object.keys(res.body[0]).sort(), [
    'deploymentType',
    'id',
    'llmproxyGatewayServerName',
    'runtimeStatus',
    'syncStatus',
  ]);
});

test('GET /health-eligible: lazily re-registers non-synced rows when litellm enabled', async () => {
  litellm.enabled = true;
  let updated: any = null;
  seedServer({
    find: async () => [
      { id: 'm1', llmproxyGatewayServerName: 'n1', syncStatus: 'pending', url: 'http://example.com', transport: 'http', projectId: 'p1', runtimeStatus: 'running', deploymentType: 'remote' },
    ],
    update: async (_id: any, data: any) => {
      updated = data;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'm1');
  // re-registration flipped the row to synced with the new litellm id
  assert.equal(updated.syncStatus, 'synced');
  assert.equal(updated.llmproxyGatewayServerId, 'lite-new');
});

// ── PATCH /:id/status ──
test('PATCH /:id/status: invalid status returns 400', async () => {
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'weird' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /connected or error/);
});

test('PATCH /:id/status: server not found returns 404', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'PATCH', `${BASE}/missing/status`, { body: { status: 'connected' } });
  assert.equal(res.status, 404);
});

test('PATCH /:id/status: connected resets failures (200)', async () => {
  seedServer({
    findOne: async () => ({ id: 'm1', syncStatus: 'synced' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'connected' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'connected');
  assert.equal(res.body.consecutiveFailures, 0);
  assert.equal(res.body.syncStatus, 'synced');
});

test('PATCH /:id/status: connected from suspended re-registers and marks synced (200)', async () => {
  litellm.enabled = true;
  seedServer({
    findOne: async () => ({ id: 'm1', syncStatus: 'suspended', llmproxyGatewayServerName: 'n1', url: 'http://example.com' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'connected' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.syncStatus, 'synced');
});

test('PATCH /:id/status: error increments failures below threshold (200)', async () => {
  seedServer({
    findOne: async () => ({ id: 'm1', consecutiveFailures: 0, syncStatus: 'synced', llmproxyGatewayServerId: 'l1' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'error' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.consecutiveFailures, 1);
  assert.equal(res.body.suspended, false);
});

test('PATCH /:id/status: error at threshold suspends and deregisters (200)', async () => {
  litellm.enabled = true;
  let removed = false;
  litellm.removeMCPServer = async () => {
    removed = true;
    return {};
  };
  seedServer({
    findOne: async () => ({ id: 'm1', consecutiveFailures: 2, syncStatus: 'synced', llmproxyGatewayServerId: 'l1', llmproxyGatewayServerName: 'n1' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'error' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.consecutiveFailures, 3);
  assert.equal(res.body.suspended, true);
  assert.equal(removed, true);
});

test('GET /health-eligible: skips re-registration when url missing for non-stdio transport', async () => {
  litellm.enabled = true;
  seedServer({
    find: async () => [
      {
        id: 'm-no-url',
        llmproxyGatewayServerName: 'n1',
        syncStatus: 'pending',
        transport: 'http',
        projectId: 'p1',
        runtimeStatus: 'running',
        deploymentType: 'remote',
      },
    ],
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, 'm-no-url');
});

test('GET /health-eligible: forwards extraHeaders during lazy re-registration', async () => {
  litellm.enabled = true;
  let capturedExtra: string[] | undefined;
  litellm.addMCPServer = async (payload: any) => {
    capturedExtra = payload.extra_headers;
    return { server_id: 'lite-extra' };
  };
  seedServer({
    find: async () => [
      {
        id: 'm-extra',
        llmproxyGatewayServerName: 'n-extra',
        syncStatus: 'pending',
        url: 'http://example.com',
        transport: 'http',
        projectId: 'p1',
        runtimeStatus: 'running',
        deploymentType: 'remote',
        extraHeaders: ['X-Custom'],
      },
    ],
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.deepEqual(capturedExtra, ['X-Custom']);
});

test('GET /health-eligible: keeps row when lazy re-registration fails', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('gateway rejected');
  };
  seedServer({
    find: async () => [
      {
        id: 'm-fail',
        llmproxyGatewayServerName: 'n-fail',
        syncStatus: 'pending',
        url: 'http://example.com',
        transport: 'http',
        projectId: 'p1',
        runtimeStatus: 'running',
        deploymentType: 'remote',
      },
    ],
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'm-fail');
});

test('GET /health-eligible: respects re-registration budget and skips remaining servers', async () => {
  const prevBudget = process.env.MCP_HEALTH_REREGISTER_BUDGET_MS;
  process.env.MCP_HEALTH_REREGISTER_BUDGET_MS = '0';
  clearModule('routes/internalMcpHealthRoutes', 'routes/mcpServerRoutes');
  const budgetApp = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalMcpHealthRoutes', ['routes/mcpServerRoutes']).default,
  });
  litellm.enabled = true;
  try {
    seedServer({
      find: async () =>
        Array.from({ length: 6 }, (_v, i) => ({
          id: `m-${i}`,
          llmproxyGatewayServerName: `n-${i}`,
          syncStatus: 'pending',
          url: 'http://example.com',
          transport: 'http',
          projectId: 'p1',
          runtimeStatus: 'running',
          deploymentType: 'remote',
        })),
      update: async () => ({ affected: 1 }),
    });
    const res = await request(budgetApp, 'GET', `${BASE}/health-eligible`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 6);
  } finally {
    if (prevBudget === undefined) delete process.env.MCP_HEALTH_REREGISTER_BUDGET_MS;
    else process.env.MCP_HEALTH_REREGISTER_BUDGET_MS = prevBudget;
    clearModule('routes/internalMcpHealthRoutes', 'routes/mcpServerRoutes');
    app = buildApp({
      basePath: BASE,
      router: loadFresh('routes/internalMcpHealthRoutes', ['routes/mcpServerRoutes']).default,
    });
  }
});

test('GET /health-eligible: falls back when MCP_CIRCUIT_BREAKER_THRESHOLD is invalid', async () => {
  const prevThreshold = process.env.MCP_CIRCUIT_BREAKER_THRESHOLD;
  process.env.MCP_CIRCUIT_BREAKER_THRESHOLD = 'not-a-number';
  clearModule('routes/internalMcpHealthRoutes', 'routes/mcpServerRoutes');
  const thresholdApp = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalMcpHealthRoutes', ['routes/mcpServerRoutes']).default,
  });
  try {
    seedServer({
      findOne: async () => ({
        id: 'm1',
        consecutiveFailures: 2,
        syncStatus: 'synced',
        llmproxyGatewayServerId: 'l1',
        llmproxyGatewayServerName: 'n1',
      }),
      update: async () => ({ affected: 1 }),
    });
    litellm.enabled = true;
    const res = await request(thresholdApp, 'PATCH', `${BASE}/m1/status`, { body: { status: 'error' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.consecutiveFailures, 3);
    assert.equal(res.body.suspended, true);
  } finally {
    if (prevThreshold === undefined) delete process.env.MCP_CIRCUIT_BREAKER_THRESHOLD;
    else process.env.MCP_CIRCUIT_BREAKER_THRESHOLD = prevThreshold;
    clearModule('routes/internalMcpHealthRoutes', 'routes/mcpServerRoutes');
    app = buildApp({
      basePath: BASE,
      router: loadFresh('routes/internalMcpHealthRoutes', ['routes/mcpServerRoutes']).default,
    });
  }
});

test('PATCH /:id/status: connected from pending marks synced without re-registering', async () => {
  seedServer({
    findOne: async () => ({ id: 'm1', syncStatus: 'pending', llmproxyGatewayServerId: 'l1' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'connected' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.syncStatus, 'synced');
});

test('PATCH /:id/status: suspended re-register failure still marks synced', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('re-register failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'm1',
      syncStatus: 'suspended',
      llmproxyGatewayServerName: 'n1',
      url: 'http://example.com',
      transport: 'http',
      projectId: 'p1',
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'connected' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.syncStatus, 'synced');
});

test('PATCH /:id/status: deregister failure still increments failures', async () => {
  litellm.enabled = true;
  litellm.removeMCPServer = async () => {
    throw new Error('deregister failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'm1',
      consecutiveFailures: 2,
      syncStatus: 'synced',
      llmproxyGatewayServerId: 'l1',
      llmproxyGatewayServerName: 'n1',
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/m1/status`, { body: { status: 'error' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.consecutiveFailures, 3);
  assert.equal(res.body.suspended, false);
});

test('GET /health-eligible: returns 500 when query fails', async () => {
  seedServer({
    find: async () => {
      throw new Error('eligible query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/health-eligible`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /eligible query failed/);
});
