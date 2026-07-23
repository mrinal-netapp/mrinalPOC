/**
 * Route-handler tests for routes/mcpServerRoutes.ts.
 *
 * LiteLLM, CredentialService and MCPRuntimeManager are module-mocked with
 * inert fakes. Validators and ReferenceEdgeService run real against the
 * AppDataSource fake-repo seam (no DB, no network).
 *
 * Run: node --require ts-node/register --test tests/mcpServerRoutes.routes.unit.test.ts
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

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/mcp-servers`;
const UUID = '123e4567-e89b-12d3-a456-426614174000';

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;
let litellm: any;
let cred: any;
let runtime: any;

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: PROJECT, name: 'Test Project' }) }),
  });
  litellm = {
    enabled: false,
    isEnabled() {
      return this.enabled;
    },
    addMCPServer: async () => ({ server_id: 'lite-1' }),
    removeMCPServer: async () => ({}),
    editMCPServer: async () => ({}),
    testMCPConnection: async () => ({ success: true }),
    listMCPTools: async () => [{ name: 't1' }],
    callMCPTool: async () => ({ content: 'ok' }),
  };
  cred = {
    getById: async () => null,
    readSecretData: async () => ({ api_key: 'sk' }),
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
  const router = loadFresh('routes/mcpServerRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/mcp-servers', router });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/mcpServerRoutes');
  mock.restoreAll();
  handle.restore();
});

function seedServer(overrides: Record<string, any>) {
  handle.repos.MCPServer = makeFakeRepo(overrides);
}

// ── List ──
test('GET /: returns servers with dependentsSummary', async () => {
  seedServer({
    find: async (q: any) =>
      q?.where?.deploymentType === 'platform'
        ? []
        : [{ id: 'mcp-1', name: 'srv', projectId: PROJECT }],
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'mcp-1');
  assert.ok(res.body[0].dependentsSummary);
});

test('GET /: empty list returns [] (200)', async () => {
  seedServer({ find: async () => [] });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /refresh: probes project and platform MCP servers', async () => {
  litellm.enabled = true;
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  seedServer({
    find: async (q: any) => {
      if (q?.where?.deploymentType === 'platform') {
        return [{
          id: 'plat-1',
          projectId: '__platform__',
          name: 'artifact-store',
          llmproxyGatewayServerName: 'artifact_store',
          syncStatus: 'synced',
          deploymentType: 'platform',
        }];
      }
      return [{
        id: 'mcp-1',
        projectId: PROJECT,
        name: 'srv',
        llmproxyGatewayServerName: 'projtest0001_srv',
        syncStatus: 'synced',
      }];
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return { affected: 1 };
    },
  });
  litellm.testMCPConnection = async (name: string) => ({
    success: name === 'artifact_store',
    message: name,
  });

  const res = await request(app, 'POST', `${BASE}/refresh`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.refreshed, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.find((u) => u.id === 'plat-1')?.patch,
    { status: 'connected', syncStatus: 'synced' },
  );
  assert.deepEqual(
    updates.find((u) => u.id === 'mcp-1')?.patch,
    { status: 'error', syncStatus: 'synced' },
  );
});

test('GET /: project not found returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 404);
});

// ── Get by id ──
test('GET /:id: found (200) and not found (404)', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', name: 'srv' }) });
  assert.equal((await request(app, 'GET', `${BASE}/mcp-1`)).status, 200);

  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing`)).status, 404);
});

// ── Create ──
test('POST /: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'bad name!' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /: remote create with litellm enabled syncs gateway (201)', async () => {
  litellm.enabled = true;
  let saved: any = null;
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'mcp-remote' }),
    save: async (e: any) => {
      saved = e;
      return { ...e, id: 'mcp-remote' };
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.syncStatus, 'synced');
  assert.equal(saved.llmproxyGatewayServerId, 'lite-1');
});

test('POST /validate-managed-config: missing catalogId returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-managed-config`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /catalogId is required/);
});

test('POST /validate-managed-config: delegates to validator', async () => {
  scope.add(
    mockModule('services/managedMcpConfigValidator', {
      validateManagedMcpConfig: async () => ({
        success: true,
        message: 'Configuration valid',
        status: 'connected',
      }),
    }),
  );
  const router = loadFresh('routes/mcpServerRoutes').default;
  const validateApp = buildApp({ basePath: '/api/v1/projects/:projectId/mcp-servers', router });
  const res = await request(validateApp, 'POST', `${BASE}/validate-managed-config`, {
    body: { catalogId: 'memory_mcp', runtimeCredentialId: UUID },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('POST /validate-connection: success probes ephemeral gateway client', async () => {
  litellm.enabled = true;
  const calls: string[] = [];
  litellm.addMCPServer = async () => {
    calls.push('add');
    return { server_id: 'validate-1', server_name: 'validate_tmp' };
  };
  litellm.testMCPConnection = async () => {
    calls.push('test');
    return { success: true, message: 'ok' };
  };
  litellm.listMCPTools = async () => {
    calls.push('tools');
    return [{ name: 'tool-a' }];
  };
  litellm.removeMCPServer = async () => {
    calls.push('remove');
  };
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(calls, ['add', 'test', 'tools', 'remove']);
});

test('POST /validate-connection: gateway disabled returns 503', async () => {
  litellm.enabled = false;
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 503);
});

test('POST /: remote create with litellm disabled (201)', async () => {
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'srv', transport: 'http', url: 'http://example.com' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'srv');
  assert.equal(res.body.syncStatus, 'pending');
});

test('POST /: duplicate name returns 409', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', name: 'srv' }) });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'srv', transport: 'http', url: 'http://example.com' },
  });
  assert.equal(res.status, 409);
});

test('POST /: managed create provisions runtime (201)', async () => {
  let provisioned = false;
  runtime.provisionAsync = () => {
    provisioned = true;
  };
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'mcp-managed' }),
    save: async (e: any) => ({ ...e }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'mem', deploymentType: 'managed', catalogId: 'memory_mcp' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.deploymentType, 'managed');
  assert.equal(res.body.runtimeStatus, 'provisioning');
  assert.equal(provisioned, true);
});

test('POST /: managed missing runtimeCredentialId returns 400', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'ontap', deploymentType: 'managed', catalogId: 'Ontap_mcp_logs' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /runtimeCredentialId is required/);
});

test('POST /: managed runtimeCredentialId not found returns 400', async () => {
  cred.getById = async () => null;
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'ontap',
      deploymentType: 'managed',
      catalogId: 'Ontap_mcp_logs',
      runtimeCredentialId: UUID,
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /not found in project/);
});

test('POST /: managed web_search disabled by rollout guard returns 403', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'websearch', deploymentType: 'managed', catalogId: 'web_search_mcp' },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /disabled by rollout guard/);
});

// ── Update ──
test('PUT /:id: not found returns 404', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/missing`, { body: { description: 'd' } });
  assert.equal(res.status, 404);
});

test('PUT /:id: remote update succeeds (200)', async () => {
  let row: any = { id: 'mcp-1', projectId: PROJECT, deploymentType: 'remote', name: 'srv' };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { description: 'updated' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'updated');
});

test('PUT /:id: platform server returns 403', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'platform', name: 'srv' }) });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { description: 'd' } });
  assert.equal(res.status, 403);
});

test('PUT /:id: duplicate name returns 409', async () => {
  const existing = { id: 'mcp-1', projectId: PROJECT, deploymentType: 'remote', name: 'srv' };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async (q: any) => {
      if (Array.isArray(q?.where)) return existing;
      if (q?.where?.name) return { id: 'mcp-2', name: 'other' };
      return existing;
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { name: 'other' } });
  assert.equal(res.status, 409);
});

test('PUT /:id: validation error returns 400', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }) });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { name: 'bad name!' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

// ── Delete ──
test('DELETE /:id: deletes when no dependents (200)', async () => {
  seedServer({
    findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mcp-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
});

test('DELETE /:id: blocked when dependents exist (409)', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  const res = await request(app, 'DELETE', `${BASE}/mcp-1`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HAS_DEPENDENTS');
});

test('DELETE /:id: not found returns 404', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/missing`)).status, 404);
});

test('DELETE /:id: platform server returns 403', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'platform' }) });
  assert.equal((await request(app, 'DELETE', `${BASE}/mcp-1`)).status, 403);
});

// ── Dependents ──
test('GET /:id/dependents: returns a page (200) / 404', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', projectId: PROJECT }) });
  const ok = await request(app, 'GET', `${BASE}/mcp-1/dependents?limit=10`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.items));

  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing/dependents`)).status, 404);
});

// ── Test connection ──
test('POST /:id/test-connection: 404, 503, 400, 200', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'POST', `${BASE}/missing/test-connection`, { body: {} })).status, 404);

  litellm.enabled = false;
  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  assert.equal((await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} })).status, 503);

  litellm.enabled = true;
  seedServer({ findOne: async () => ({ id: 'mcp-1' }) });
  assert.equal((await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} })).status, 400);

  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1', syncStatus: 'synced' }), update: async () => ({ affected: 1 }) });
  const ok = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'connected');
  assert.equal(ok.body.success, true);
});

// ── Tools ──
test('GET /:id/tools: 404, 503, 400, 200', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing/tools`)).status, 404);

  litellm.enabled = false;
  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  assert.equal((await request(app, 'GET', `${BASE}/mcp-1/tools`)).status, 503);

  litellm.enabled = true;
  seedServer({ findOne: async () => ({ id: 'mcp-1' }) });
  assert.equal((await request(app, 'GET', `${BASE}/mcp-1/tools`)).status, 400);

  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  const ok = await request(app, 'GET', `${BASE}/mcp-1/tools`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body[0].name, 't1');
});

test('POST /:id/tools/call: missing toolName 400, allowlist 403, success 200', async () => {
  litellm.enabled = true;
  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  assert.equal((await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: {} })).status, 400);

  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1', allowedTools: ['bar'] }) });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: { toolName: 'foo' } })).status,
    403,
  );

  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  const ok = await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: { toolName: 'foo' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.content, 'ok');
});

test('POST /:id/tools/call: not found returns 404', async () => {
  seedServer({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/missing/tools/call`, { body: { toolName: 'foo' } })).status,
    404,
  );
});

// ── History ──
test('GET /:id/history: 404 server, 404 no history, 200 with history', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing/history`)).status, 404);

  seedServer({ findOne: async () => ({ id: 'mcp-1' }) });
  handle.repos.MCPServerHistory = makeFakeRepo({ find: async () => [] });
  assert.equal((await request(app, 'GET', `${BASE}/mcp-1/history`)).status, 404);

  handle.repos.MCPServerHistory = makeFakeRepo({ find: async () => [{ version: 2 }, { version: 1 }] });
  const ok = await request(app, 'GET', `${BASE}/mcp-1/history`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 2);
});

// ── Runtime status ──
test('GET /:id/runtime-status: 404, 400 non-managed, 200 managed', async () => {
  seedServer({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing/runtime-status`)).status, 404);

  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }) });
  assert.equal((await request(app, 'GET', `${BASE}/mcp-1/runtime-status`)).status, 400);

  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'managed' }) });
  const ok = await request(app, 'GET', `${BASE}/mcp-1/runtime-status`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.phase, 'Running');
});

// ── Restore version ──
test('POST /:id/restore-version: validation 400, 404 server, 200 restore', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }) });
  assert.equal((await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: {} })).status, 400);

  seedServer({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/missing/restore-version`, { body: { version: 1 } })).status,
    404,
  );

  let row: any = { id: 'mcp-1', projectId: PROJECT, deploymentType: 'remote', name: 'srv' };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  handle.repos.MCPServerHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'mcp-1', name: 'srv', description: 'old' } }),
  });
  const ok = await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restored, true);
});

test('POST /:id/restore-version: managed not supported (400), version not found (404)', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'managed' }) });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } })).status,
    400,
  );

  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote' }) });
  handle.repos.MCPServerHistory = makeFakeRepo({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 9 } })).status,
    404,
  );
});

test('POST /:id/restore-version: platform server returns 403', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'platform' }) });
  const res = await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 403);
});

test('POST /:id/restore-version: syncs restored config to gateway when enabled', async () => {
  litellm.enabled = true;
  let edited: any = null;
  litellm.editMCPServer = async (cfg: Record<string, unknown>) => {
    edited = cfg;
    return {};
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    llmproxyGatewayServerId: 'gw-1',
    llmproxyGatewayServerName: 'projtest0001_srv',
    syncStatus: 'synced',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  handle.repos.MCPServerHistory = makeFakeRepo({
    findOne: async () => ({
      version: 1,
      data: {
        id: 'mcp-1',
        name: 'srv',
        description: 'restored-desc',
        transport: 'http',
        url: 'http://example.com/mcp',
      },
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.restored, true);
  assert.equal(edited?.server_id, 'gw-1');
  assert.equal(row.syncStatus, 'synced');
});

test('POST /:id/restore-version: marks syncStatus error when gateway edit fails', async () => {
  litellm.enabled = true;
  litellm.editMCPServer = async () => {
    throw new Error('gateway edit failed');
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    llmproxyGatewayServerId: 'gw-1',
    syncStatus: 'synced',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  handle.repos.MCPServerHistory = makeFakeRepo({
    findOne: async () => ({
      version: 1,
      data: { id: 'mcp-1', name: 'srv', transport: 'http', url: 'http://example.com/mcp' },
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(row.syncStatus, 'error');
});

test('PUT /:id: managed update patches runtime config and syncs gateway', async () => {
  litellm.enabled = true;
  let patched = false;
  runtime.patchConfig = async () => {
    patched = true;
  };
  let row: any = {
    id: 'mcp-managed',
    projectId: PROJECT,
    deploymentType: 'managed',
    catalogId: 'memory_mcp',
    name: 'mem',
    llmproxyGatewayServerId: 'gw-1',
    syncStatus: 'synced',
    url: 'http://mcp.local',
    managedConfig: { envOverrides: { FOO: 'bar' } },
  };
  seedServer({
    findOne: async (q: any) => {
      if (q?.where?.name) return null;
      return row;
    },
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: {
      description: 'updated',
      allowedTools: ['search'],
      managedConfig: { envOverrides: { FOO: 'baz' } },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'updated');
  assert.equal(patched, true);
});

test('POST /:id/tools/call: returns 500 when gateway call fails', async () => {
  litellm.enabled = true;
  litellm.callMCPTool = async () => {
    throw new Error('gateway call failed');
  };
  seedServer({ findOne: async () => ({ id: 'mcp-1', llmproxyGatewayServerName: 'n1' }) });
  const res = await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: { toolName: 'foo' } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /gateway call failed/);
});

test('GET /:id/history: returns 500 when history query fails', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1' }) });
  handle.repos.MCPServerHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/mcp-1/history`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /history query failed/);
});

test('GET /:id/runtime-status: returns 500 when runtime manager fails', async () => {
  runtime.getStatus = async () => {
    throw new Error('runtime status failed');
  };
  seedServer({ findOne: async () => ({ id: 'mcp-1', deploymentType: 'managed' }) });
  const res = await request(app, 'GET', `${BASE}/mcp-1/runtime-status`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /runtime status failed/);
});

test('POST /:id/tools/call: blocks disallowed tools (403)', async () => {
  litellm.enabled = true;
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      llmproxyGatewayServerName: 'n1',
      disallowedTools: ['blocked-tool'],
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/tools/call`, {
    body: { toolName: 'blocked-tool' },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /blocked by the disallowed tools list/);
});

test('POST /:id/tools/call: 400 when server not synced to gateway', async () => {
  litellm.enabled = true;
  seedServer({ findOne: async () => ({ id: 'mcp-1', name: 'srv' }) });
  const res = await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: { toolName: 'foo' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /not synced to Bifrost gateway/);
});

test('POST /:id/restore-version: returns 500 when restore update fails', async () => {
  litellm.enabled = false;
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async () => {
      throw new Error('restore update failed');
    },
  });
  handle.repos.MCPServerHistory = makeFakeRepo({
    findOne: async () => ({
      version: 1,
      data: { id: 'mcp-1', name: 'srv', transport: 'http', url: 'http://example.com/mcp' },
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /restore update failed/);
});

test('POST /refresh: counts probe failures without failing the request', async () => {
  litellm.enabled = true;
  litellm.testMCPConnection = async () => {
    throw new Error('probe exploded');
  };
  seedServer({
    find: async (q: any) => {
      if (q?.where?.deploymentType === 'platform') return [];
      return [{
        id: 'mcp-1',
        projectId: PROJECT,
        name: 'srv',
        llmproxyGatewayServerName: 'projtest0001_srv',
        syncStatus: 'synced',
      }];
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', `${BASE}/refresh`);
  assert.equal(res.status, 200);
  assert.equal(res.body.failed, 1);
});

test('GET /:id/tools: returns 500 when gateway list fails', async () => {
  litellm.enabled = true;
  litellm.listMCPTools = async () => {
    throw new Error('tools list failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      name: 'srv',
      llmproxyGatewayServerName: 'proj_srv',
      syncStatus: 'synced',
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mcp-1/tools`);
  assert.equal(res.status, 500);
});

test('POST /validate-connection: returns 400 when gateway registration fails', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('registration failed');
  };
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'https://example.com/mcp' },
  });
  assert.equal(res.status, 400);
});

test('POST /: remote create rejects when gateway connection test fails and cleans up', async () => {
  litellm.enabled = true;
  let removed = false;
  litellm.addMCPServer = async () => ({ server_id: 'lite-1' });
  litellm.testMCPConnection = async () => ({ success: false, message: 'connection refused' });
  litellm.removeMCPServer = async () => {
    removed = true;
  };
  seedServer({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (e: any) => e,
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /validation failed/i);
  assert.equal(removed, true);
});

test('POST /: remote create rejects when no tools are discovered', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => ({ server_id: 'lite-1' });
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [];
  seedServer({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (e: any) => e,
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /no tools discovered/i);
});

test('POST /: remote create reuses orphaned gateway client on duplicate name', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('server already exists');
  };
  litellm.listMCPServers = async () => [
    { server_name: 'projtest0001_remote_srv', server_id: 'existing-lite-1' },
  ];
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [{ name: 'tool-a' }];
  let saved: any = null;
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'mcp-remote' }),
    save: async (e: any) => {
      saved = e;
      return e;
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 201);
  assert.equal(saved.llmproxyGatewayServerId, 'existing-lite-1');
});

test('POST /: remote create rolls back gateway client when DB save fails', async () => {
  litellm.enabled = true;
  let removed = false;
  litellm.addMCPServer = async () => ({ server_id: 'lite-1' });
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [{ name: 'tool-a' }];
  litellm.removeMCPServer = async () => {
    removed = true;
  };
  seedServer({
    findOne: async () => null,
    create: (d: any) => d,
    save: async () => {
      throw new Error('db save failed');
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /db save failed/);
  assert.equal(removed, true);
});

test('DELETE /:id: returns 502 when stale gateway clients remain', async () => {
  litellm.enabled = true;
  litellm.removeMCPServer = async () => undefined;
  litellm.listMCPServers = async () => [
    { server_name: 'projtest0001_srv', server_id: 'stale-1' },
  ];
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      name: 'srv',
      deploymentType: 'remote',
      llmproxyGatewayServerId: 'lite-1',
      llmproxyGatewayServerName: 'projtest0001_srv',
    }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mcp-1`);
  assert.equal(res.status, 502);
  assert.ok(Array.isArray(res.body.remainingGatewayClients));
});

test('DELETE /:id: managed deprovision failure still deletes row', async () => {
  litellm.enabled = false;
  runtime.deprovision = async () => {
    throw new Error('deprovision failed');
  };
  let deleted = false;
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      name: 'managed-srv',
      deploymentType: 'managed',
      catalogId: 'artifact_store_mcp',
    }),
    update: async () => ({ affected: 1 }),
    delete: async () => {
      deleted = true;
      return { affected: 1 };
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mcp-1`);
  assert.equal(res.status, 200);
  assert.equal(deleted, true);
});

test('POST /: searxng managed server disabled by rollout guard returns 403', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'searx',
      deploymentType: 'managed',
      catalogId: 'searxng_web_search_mcp',
      runtimeCredentialId: UUID,
    },
  });
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /searxng_web_search_mcp is disabled/);
});

test('GET /: returns 500 when list query fails', async () => {
  seedServer({
    find: async () => {
      throw new Error('list query failed');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('GET /: omits dependentsSummary when include=dependentsSummary=false', async () => {
  seedServer({
    find: async (q: any) =>
      q?.where?.deploymentType === 'platform'
        ? []
        : [{ id: 'mcp-1', name: 'srv', projectId: PROJECT }],
  });
  const res = await request(app, 'GET', `${BASE}?include=dependentsSummary=false`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'mcp-1');
  assert.equal(res.body[0].dependentsSummary, undefined);
});

test('GET /:id: returns 500 when query fails', async () => {
  seedServer({
    findOne: async () => {
      throw new Error('get by id failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/mcp-1`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /get by id failed/);
});

test('GET /:id/dependents: returns 500 when dependents query fails', async () => {
  seedServer({ findOne: async () => ({ id: 'mcp-1', projectId: PROJECT }) });
  scope.add(
    mockModule('services/ReferenceEdgeService', {
      applyForEntity: async () => undefined,
      removeForSource: async () => undefined,
      hasDependents: async () => false,
      summaryForTargets: async () => new Map(),
      listDependents: async () => {
        throw new Error('dependents query failed');
      },
    }),
  );
  const router = loadFresh('routes/mcpServerRoutes').default;
  const depApp = buildApp({ basePath: '/api/v1/projects/:projectId/mcp-servers', router });
  const res = await request(depApp, 'GET', `${BASE}/mcp-1/dependents`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /dependents query failed/);
});

test('POST /validate-connection: invalid transport returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'stdio', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /transport must be one of/);
});

test('POST /validate-connection: missing url returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /url is required/);
});

test('POST /validate-connection: private local URL returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://127.0.0.1/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: invalid URL returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'not-a-valid-url' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Invalid MCP URL/);
});

test('POST /validate-connection: returns error when connection test fails', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => ({ server_id: 'validate-1' });
  litellm.testMCPConnection = async () => ({ success: false, message: 'timeout' });
  litellm.removeMCPServer = async () => undefined;
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'sse', url: 'https://example.com/mcp' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(res.body.status, 'error');
  assert.match(String(res.body.message), /timeout/);
});

test('POST /validate-connection: returns error when no tools discovered', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => ({ server_id: 'validate-1' });
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [];
  litellm.removeMCPServer = async () => undefined;
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'streamable-http', url: 'https://example.com/mcp' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.match(String(res.body.message), /no tools discovered/i);
});

test('POST /: managed create unknown catalog returns 400', async () => {
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'mem', deploymentType: 'managed', catalogId: 'nonexistent_catalog_xyz' },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
  assert.match(String(res.body.errors[0]?.msg), /Unknown catalog ID/);
});

test('PUT /:id: remote update marks syncStatus error when gateway edit fails', async () => {
  litellm.enabled = true;
  litellm.editMCPServer = async () => {
    throw new Error('gateway edit failed');
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    llmproxyGatewayServerId: 'gw-1',
    llmproxyGatewayServerName: 'projtest0001_srv',
    syncStatus: 'synced',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { description: 'updated' } });
  assert.equal(res.status, 200);
  assert.equal(row.syncStatus, 'error');
});

test('PUT /:id: remote unsynced registers on gateway during update', async () => {
  litellm.enabled = true;
  let added = false;
  litellm.addMCPServer = async () => {
    added = true;
    return { server_id: 'gw-new' };
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    syncStatus: 'pending',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { description: 'synced now' } });
  assert.equal(res.status, 200);
  assert.equal(added, true);
  assert.equal(row.llmproxyGatewayServerId, 'gw-new');
  assert.equal(row.syncStatus, 'synced');
});

test('PUT /:id: remote unsynced marks syncStatus error when gateway add fails', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('gateway add failed');
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    syncStatus: 'pending',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, { body: { description: 'still pending' } });
  assert.equal(res.status, 200);
  assert.equal(row.syncStatus, 'error');
});

test('PUT /:id: managed update tolerates gateway edit failure', async () => {
  litellm.enabled = true;
  litellm.editMCPServer = async () => {
    throw new Error('managed gateway edit failed');
  };
  let row: any = {
    id: 'mcp-managed',
    projectId: PROJECT,
    deploymentType: 'managed',
    catalogId: 'memory_mcp',
    name: 'mem',
    llmproxyGatewayServerId: 'gw-1',
    syncStatus: 'synced',
    url: 'http://mcp.local',
  };
  seedServer({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { allowedTools: ['search'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.allowedTools, ['search']);
});

test('POST /:id/test-connection: re-registers suspended server', async () => {
  litellm.enabled = true;
  let reRegistered = false;
  litellm.addMCPServer = async () => {
    reRegistered = true;
    return { server_id: 'gw-rereg' };
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    llmproxyGatewayServerName: 'projtest0001_srv',
    syncStatus: 'suspended',
  };
  seedServer({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  litellm.testMCPConnection = async () => ({ success: true, serverInstructions: 'use tools wisely' });
  const res = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(reRegistered, true);
  assert.equal(row.syncStatus, 'synced');
  assert.equal(row.llmproxyGatewayServerId, 'gw-rereg');
  assert.equal(res.body.status, 'connected');
});

test('POST /:id/test-connection: returns error when re-registration fails', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('re-register failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      name: 'srv',
      transport: 'http',
      url: 'http://example.com/mcp',
      llmproxyGatewayServerName: 'projtest0001_srv',
      syncStatus: 'suspended',
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.match(String(res.body.message), /Re-registration failed/);
});

test('POST /refresh: returns 503 when gateway disabled', async () => {
  litellm.enabled = false;
  seedServer({ find: async () => [] });
  const res = await request(app, 'POST', `${BASE}/refresh`);
  assert.equal(res.status, 503);
});

test('POST /refresh: counts pending and failed runtime servers without gateway name', async () => {
  litellm.enabled = true;
  seedServer({
    find: async (q: any) => {
      if (q?.where?.deploymentType === 'platform') return [];
      return [
        {
          id: 'mcp-pending',
          projectId: PROJECT,
          name: 'pending-srv',
          runtimeStatus: 'provisioning',
        },
        {
          id: 'mcp-failed',
          projectId: PROJECT,
          name: 'failed-srv',
          runtimeStatus: 'failed',
        },
      ];
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', `${BASE}/refresh`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.pending, 1);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.refreshed, 0);
});

test('DELETE /:id: returns 500 when delete throws', async () => {
  litellm.enabled = false;
  seedServer({
    findOne: async () => ({ id: 'mcp-1', deploymentType: 'remote', name: 'srv' }),
    delete: async () => {
      throw new Error('delete failed');
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mcp-1`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /delete failed/);
});

test('POST /:id/test-connection: returns 500 when probe throws', async () => {
  litellm.enabled = true;
  litellm.testMCPConnection = async () => {
    throw new Error('probe failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      llmproxyGatewayServerName: 'projtest0001_srv',
      syncStatus: 'synced',
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /probe failed/);
});

test('POST /:id/tools/call: returns 503 when gateway disabled', async () => {
  litellm.enabled = false;
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      llmproxyGatewayServerName: 'projtest0001_srv',
      syncStatus: 'synced',
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/tools/call`, { body: { toolName: 'foo' } });
  assert.equal(res.status, 503);
});

test('POST /:id/test-connection: stores serverInstructions on successful probe', async () => {
  litellm.enabled = true;
  let updated: Record<string, unknown> | undefined;
  litellm.testMCPConnection = async () => ({
    success: true,
    serverInstructions: 'Always cite sources',
  });
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      llmproxyGatewayServerName: 'projtest0001_srv',
      syncStatus: 'synced',
    }),
    update: async (_id: string, patch: Record<string, unknown>) => {
      updated = patch;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(updated?.serverInstructions, 'Always cite sources');
  assert.equal(updated?.consecutiveFailures, 0);
});

test('PUT /:id: managed update returns 400 when runtime patchConfig throws', async () => {
  runtime.patchConfig = async () => {
    throw new Error('patch config failed');
  };
  seedServer({
    findOne: async () => ({
      id: 'mcp-managed',
      projectId: PROJECT,
      deploymentType: 'managed',
      catalogId: 'memory_mcp',
      name: 'mem',
      managedConfig: { envOverrides: {} },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { managedConfig: { envOverrides: { PLAIN: 'value' } } },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /patch config failed/);
});

test('POST /validate-managed-config: returns 400 when validator throws', async () => {
  scope.add(
    mockModule('services/managedMcpConfigValidator', {
      validateManagedMcpConfig: async () => {
        throw new Error('validator exploded');
      },
    }),
  );
  const router = loadFresh('routes/mcpServerRoutes').default;
  const validateApp = buildApp({ basePath: '/api/v1/projects/:projectId/mcp-servers', router });
  const res = await request(validateApp, 'POST', `${BASE}/validate-managed-config`, {
    body: { catalogId: 'memory_mcp' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.match(String(res.body.message), /validator exploded/);
});

test('POST /: managed Ontap runtime credential provider mismatch returns 400', async () => {
  cred.getById = async () => ({ id: UUID, provider: 'openai', metadata: {} });
  seedServer({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'ontap',
      deploymentType: 'managed',
      catalogId: 'Ontap_mcp_logs',
      runtimeCredentialId: UUID,
      managedConfig: { envOverrides: { ONTAP_CLUSTER_URL: 'https://cluster.example.com' } },
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /provider mismatch/);
});

test('POST /: remote create rejects duplicate gateway name with no orphan server', async () => {
  litellm.enabled = true;
  litellm.addMCPServer = async () => {
    throw new Error('server already exists');
  };
  litellm.listMCPServers = async () => [];
  seedServer({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (e: any) => e,
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'remote_srv', transport: 'http', url: 'http://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /already exists/);
});

test('POST /refresh: returns 500 when list query fails', async () => {
  seedServer({
    find: async () => {
      throw new Error('refresh list failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/refresh`);
  assert.equal(res.status, 500);
});

test('PUT /:id: remote update sanitizes authConfig queryParams headerParams staticHeaders', async () => {
  litellm.enabled = true;
  let edited: any = null;
  litellm.editMCPServer = async (cfg: Record<string, unknown>) => {
    edited = cfg;
    return {};
  };
  let row: any = {
    id: 'mcp-1',
    projectId: PROJECT,
    deploymentType: 'remote',
    name: 'srv',
    transport: 'http',
    url: 'http://example.com/mcp',
    llmproxyGatewayServerId: 'gw-1',
    llmproxyGatewayServerName: 'projtest0001_srv',
    syncStatus: 'synced',
  };
  handle.repos.MCPServer = makeFakeRepo({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-1`, {
    body: {
      staticHeaders: { 'X-Custom': 'value' },
      queryParams: [{ name: 'q', value: '1' }],
      headerParams: [{ name: 'h', value: '2' }],
      authConfig: { type: 'bearer', secretRef: { credentialId: UUID, field: 'api_key' } },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(edited?.server_id, 'gw-1');
});

test('POST /validate-connection: probes with credential-backed auth params', async () => {
  litellm.enabled = true;
  let addedConfig: any = null;
  litellm.addMCPServer = async (cfg: Record<string, unknown>) => {
    addedConfig = cfg;
    return { server_id: 'validate-2', server_name: 'validate_tmp' };
  };
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [{ name: 'tool-a' }];
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: {
      transport: 'http',
      url: 'https://example.com/mcp',
      authType: 'api_key',
      credentialId: UUID,
      queryParams: [{ name: 'tenant', value: 'abc' }],
      headerParams: [{ name: 'X-Trace', value: '1' }],
      staticHeaders: { 'X-Static': 'yes' },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(addedConfig);
});

test('PUT /:id: managed update rejects runtimeCredentialId provider mismatch', async () => {
  cred.getById = async () => ({ id: UUID, provider: 'openai', metadata: {} });
  seedServer({
    findOne: async () => ({
      id: 'mcp-managed',
      projectId: PROJECT,
      deploymentType: 'managed',
      catalogId: 'Ontap_mcp_logs',
      name: 'ontap',
      managedConfig: { envOverrides: {} },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { runtimeCredentialId: UUID },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /provider mismatch/);
});

test('POST /:id/test-connection: failed probe sets error status without serverInstructions', async () => {
  litellm.enabled = true;
  litellm.testMCPConnection = async () => ({ success: false, message: 'connection refused' });
  let updated: Record<string, unknown> | undefined;
  seedServer({
    findOne: async () => ({
      id: 'mcp-1',
      llmproxyGatewayServerName: 'projtest0001_srv',
      syncStatus: 'synced',
    }),
    update: async (_id: string, patch: Record<string, unknown>) => {
      updated = patch;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'POST', `${BASE}/mcp-1/test-connection`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, false);
  assert.equal(updated?.status, 'error');
  assert.equal(updated?.serverInstructions, undefined);
});

test('GET /:id/dependents: uses platform server owning project for lookup', async () => {
  seedServer({
    findOne: async () => ({
      id: 'plat-1',
      projectId: '__platform__',
      name: 'artifact-store',
      deploymentType: 'platform',
    }),
  });
  const res = await request(app, 'GET', `${BASE}/plat-1/dependents?limit=5`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
});

test('POST /: remote create tolerates credential read failure', async () => {
  litellm.enabled = true;
  cred.readSecretData = async () => {
    throw new Error('secret unreadable');
  };
  litellm.addMCPServer = async () => ({ server_id: 'lite-1' });
  litellm.testMCPConnection = async () => ({ success: true });
  litellm.listMCPTools = async () => [{ name: 'tool-a' }];
  seedServer({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'mcp-remote' }),
    save: async (e: any) => ({ ...e, id: 'mcp-remote' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'remote_srv',
      transport: 'http',
      url: 'http://example.com/mcp',
      credentialId: UUID,
    },
  });
  assert.equal(res.status, 201);
});

test('PUT /:id: managed update with managedConfig envOverrides patches runtime', async () => {
  let patched = false;
  runtime.patchConfig = async () => {
    patched = true;
  };
  let row: any = {
    id: 'mcp-managed',
    projectId: PROJECT,
    deploymentType: 'managed',
    catalogId: 'memory_mcp',
    name: 'mem',
    managedConfig: { envOverrides: { PLAIN: 'old' } },
  };
  seedServer({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { managedConfig: { envOverrides: { PLAIN: 'new', SECRET: '***' } } },
  });
  assert.equal(res.status, 200);
  assert.equal(patched, true);
});

test('PUT /:id: managed update unknown catalog returns 400', async () => {
  seedServer({
    findOne: async () => ({
      id: 'mcp-managed',
      projectId: PROJECT,
      deploymentType: 'managed',
      catalogId: 'nonexistent_catalog_xyz',
      name: 'mem',
      managedConfig: { envOverrides: {} },
    }),
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { managedConfig: { envOverrides: { FOO: 'bar' } } },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Catalog entry not found/);
});

test('PUT /:id: managed update ignores runtimeCredentialId when catalog has no mapping', async () => {
  let row: any = {
    id: 'mcp-managed',
    projectId: PROJECT,
    deploymentType: 'managed',
    catalogId: 'memory_mcp',
    name: 'mem',
  };
  seedServer({
    findOne: async () => row,
    update: async (_id: string, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mcp-managed`, {
    body: { runtimeCredentialId: UUID, description: 'still ok' },
  });
  assert.equal(res.status, 200);
  assert.equal(row.description, 'still ok');
  assert.equal(row.runtimeCredentialId, undefined);
});

test('POST /validate-connection: rejects RFC1918 10.x private URLs', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://10.0.0.5/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects 172.16-31 private URLs', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'sse', url: 'http://172.20.1.1/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects 192.168.x private URLs', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'streamable-http', url: 'http://192.168.0.42/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects link-local 169.254.x URLs', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://169.254.169.254/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects localhost hostname', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://localhost/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects IPv6 loopback without brackets', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://::1/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Invalid MCP URL|Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects non-http protocols', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'ftp://example.com/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Only http\/https/);
});

test('POST /validate-connection: rejects 0.0.0.0 private range', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: 'http://0.0.0.0/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects host ending with .localhost', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'sse', url: 'http://app.localhost/mcp' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /Private\/local MCP URLs/);
});

test('POST /validate-connection: rejects empty url string', async () => {
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'http', url: '   ' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.message), /url is required/);
});

test('POST /validate-connection: accepts streamable-http public URL', async () => {
  litellm.enabled = true;
  litellm.testMCPConnection = async () => ({ success: true });
  const res = await request(app, 'POST', `${BASE}/validate-connection`, {
    body: { transport: 'streamable-http', url: 'https://mcp.example.com/sse' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('POST /: web_search enabled rejects missing TAVILY_API_KEY', async () => {
  const prev = process.env.WEB_SEARCH_MCP_ENABLED;
  process.env.WEB_SEARCH_MCP_ENABLED = 'true';
  clearModule('routes/mcpServerRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/mcp-servers',
    router: loadFresh('routes/mcpServerRoutes').default,
  });
  try {
    seedServer({ findOne: async () => null });
    const res = await request(localApp, 'POST', BASE, {
      body: {
        name: 'websearch',
        deploymentType: 'managed',
        catalogId: 'web_search_mcp',
        managedConfig: { envOverrides: {} },
      },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /TAVILY_API_KEY is required/);
  } finally {
    if (prev === undefined) delete process.env.WEB_SEARCH_MCP_ENABLED;
    else process.env.WEB_SEARCH_MCP_ENABLED = prev;
    clearModule('routes/mcpServerRoutes');
  }
});

test('POST /: web_search enabled rejects invalid TAVILY_TIMEOUT_MS', async () => {
  const prev = process.env.WEB_SEARCH_MCP_ENABLED;
  process.env.WEB_SEARCH_MCP_ENABLED = 'true';
  clearModule('routes/mcpServerRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/mcp-servers',
    router: loadFresh('routes/mcpServerRoutes').default,
  });
  try {
    seedServer({ findOne: async () => null });
    const res = await request(localApp, 'POST', BASE, {
      body: {
        name: 'websearch',
        deploymentType: 'managed',
        catalogId: 'web_search_mcp',
        managedConfig: { envOverrides: { TAVILY_API_KEY: 'tvly-1', TAVILY_TIMEOUT_MS: '99999' } },
      },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /TAVILY_TIMEOUT_MS/);
  } finally {
    if (prev === undefined) delete process.env.WEB_SEARCH_MCP_ENABLED;
    else process.env.WEB_SEARCH_MCP_ENABLED = prev;
    clearModule('routes/mcpServerRoutes');
  }
});

test('POST /: web_search enabled creates managed server with normalized config', async () => {
  const prev = process.env.WEB_SEARCH_MCP_ENABLED;
  process.env.WEB_SEARCH_MCP_ENABLED = 'true';
  clearModule('routes/mcpServerRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/mcp-servers',
    router: loadFresh('routes/mcpServerRoutes').default,
  });
  try {
    seedServer({
      findOne: async () => null,
      create: (d: any) => ({ ...d, id: 'mcp-web' }),
      save: async (e: any) => ({ ...e, id: 'mcp-web' }),
    });
    const res = await request(localApp, 'POST', BASE, {
      body: {
        name: 'websearch',
        deploymentType: 'managed',
        catalogId: 'web_search_mcp',
        allowedTools: ['web_search'],
        managedConfig: {
          envOverrides: {
            TAVILY_API_KEY: 'tvly-1',
            TAVILY_TIMEOUT_MS: '5000',
            TAVILY_MAX_RETRIES: '2',
            TAVILY_MAX_RESULTS: '8',
          },
        },
      },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.allowedTools, ['tavily_search']);
    assert.equal(res.body.managedConfig.envOverrides.TAVILY_TIMEOUT_MS, '5000');
  } finally {
    if (prev === undefined) delete process.env.WEB_SEARCH_MCP_ENABLED;
    else process.env.WEB_SEARCH_MCP_ENABLED = prev;
    clearModule('routes/mcpServerRoutes');
  }
});

test('POST /: searxng enabled rejects missing SEARXNG_URL', async () => {
  const prev = process.env.WEB_SEARCH_MCP_ENABLED;
  process.env.WEB_SEARCH_MCP_ENABLED = 'true';
  clearModule('routes/mcpServerRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/mcp-servers',
    router: loadFresh('routes/mcpServerRoutes').default,
  });
  try {
    seedServer({ findOne: async () => null });
    const res = await request(localApp, 'POST', BASE, {
      body: {
        name: 'searx',
        deploymentType: 'managed',
        catalogId: 'searxng_web_search_mcp',
        managedConfig: { envOverrides: {} },
      },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /SEARXNG_URL/);
  } finally {
    if (prev === undefined) delete process.env.WEB_SEARCH_MCP_ENABLED;
    else process.env.WEB_SEARCH_MCP_ENABLED = prev;
    clearModule('routes/mcpServerRoutes');
  }
});

