/**
 * Route-handler tests for routers that previously had 0% coverage:
 *   - routes/evaluationCatalogRoutes.ts
 *   - routes/gatewayRoutes.ts
 *   - routes/governanceRoutes.ts
 *   - routes/guardrailRoutes.ts
 *   - routes/modelProviderRoutes.ts
 *
 * Run: node --require ts-node/register --test tests/zeroCoverageRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const PROVIDER_ID = 'openai';
const UUID = '123e4567-e89b-12d3-a456-426614174000';

const GUARDRAIL_BODY = {
  key: 'pii_masker',
  stage: 'input',
  display_name: 'PII Masker',
  description: 'Masks PII in prompts',
  type: 'builtin',
  supported_actions: ['block', 'log'],
  default_action: 'block',
  message: 'PII detected',
};

const GUARDRAIL_ENTITY = {
  id: UUID,
  key: 'pii_masker',
  stage: 'input',
  displayName: 'PII Masker',
  description: 'Masks PII in prompts',
  type: 'builtin',
  supportedActions: ['block', 'log'],
  defaultAction: 'block',
  message: 'PII detected',
  enabled: true,
  priority: 1,
  config: {},
  configSchema: null,
  version: 1,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let gatewayEnabled: boolean;
let bifrostOps: Record<string, any>;
let bifrostProviderOps: Record<string, any>;
let modelProviderSvc: Record<string, any>;
let guardrailSvc: Record<string, any>;

let evalCatalogApp: Express;
let gatewayApp: Express;
let governanceApp: Express;
let guardrailApp: Express;
let modelProviderApp: Express;

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  gatewayEnabled = true;

  bifrostOps = {
    listVirtualKeys: async () => [{ id: 'vk-1' }],
    createVirtualKey: async (body: any) => ({ id: 'vk-new', ...body }),
    updateVirtualKey: async (id: string, body: any) => ({ id, ...body }),
    deleteVirtualKey: async () => undefined,
    listBudgets: async () => [{ id: 'b1' }],
    listRateLimits: async () => [{ id: 'rl1' }],
    listModelConfigs: async () => [{ id: 'mc1' }],
    createModelConfig: async (body: any) => ({ id: 'mc-new', ...body }),
    updateModelConfig: async (id: string, body: any) => ({ id, ...body }),
    deleteModelConfig: async () => undefined,
  };

  bifrostProviderOps = {
    listGatewayProviders: async () => ({ providers: [{ name: 'openai' }], total: 1 }),
    listGatewayModels: async () => ({
      models: [
        { id: 'm1', provider: 'openai', name: 'gpt-4' },
        { id: 'm2', provider: 'azure', name: 'gpt-4o' },
      ],
      total: 2,
      providers: ['openai', 'azure'],
    }),
    mapLlmProviderToBifrost: (p: string) => (p === 'azure' ? 'azure-openai' : p),
    appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'key-1' }),
    deleteProviderKeyById: async () => undefined,
  };

  modelProviderSvc = {
    listProjectProviders: async () => [{ id: PROVIDER_ID, name: 'OpenAI' }],
    refreshProjectProvidersFromBifrost: async () => [{ id: PROVIDER_ID, status: 'connected' }],
    updateProviderProxyConfig: async () => ({
      id: PROVIDER_ID,
      concurrentRequests: 4,
      bufferSize: 8,
    }),
  };

  guardrailSvc = {
    list: async () => [GUARDRAIL_ENTITY],
    create: async (data: any) => ({ ...GUARDRAIL_ENTITY, ...data }),
    getById: async (id: string) => (id === UUID ? GUARDRAIL_ENTITY : null),
    update: async (id: string, data: any) => ({ ...GUARDRAIL_ENTITY, id, ...data }),
    delete: async () => undefined,
  };

  scope.add(mockModule('services/bifrost/bifrostOps', bifrostOps));
  scope.add(mockModule('services/bifrost/bifrostProviderOps', bifrostProviderOps));
  scope.add(mockModule('services/gatewayClient', {
    getLLMGatewayClient: () => ({ isEnabled: () => gatewayEnabled }),
  }));
  scope.add(mockModule('services/ModelProviderService', modelProviderSvc));
  scope.add(mockModule('services/GuardrailCatalogService', { GuardrailCatalogService: guardrailSvc }));

  evalCatalogApp = buildApp({
    basePath: '/api/v1/evaluation',
    router: loadFresh('routes/evaluationCatalogRoutes').default,
  });
  gatewayApp = buildApp({
    basePath: '/api/v1/gateway',
    router: loadFresh('routes/gatewayRoutes').default,
  });
  governanceApp = buildApp({
    basePath: '/api/v1/governance',
    router: loadFresh('routes/governanceRoutes').default,
  });
  guardrailApp = buildApp({
    basePath: '/api/v1/guardrails',
    router: loadFresh('routes/guardrailRoutes').default,
  });
  modelProviderApp = buildApp({
    basePath: '/',
    router: loadFresh('routes/modelProviderRoutes').default,
  });
});

afterEach(() => {
  scope.restoreAll();
  clearModule(
    'routes/evaluationCatalogRoutes',
    'routes/gatewayRoutes',
    'routes/governanceRoutes',
    'routes/guardrailRoutes',
    'routes/modelProviderRoutes',
  );
  handle.restore();
});

// ─── evaluationCatalogRoutes ────────────────────────────────────────────────

test('GET /api/v1/evaluation/rubric-catalog returns static catalog', async () => {
  const res = await request(evalCatalogApp, 'GET', '/api/v1/evaluation/rubric-catalog');
  assert.equal(res.status, 200);
  assert.ok(res.body);
});

// ─── gatewayRoutes ──────────────────────────────────────────────────────────

test('GET /gateway/providers: 502 when gateway disabled', async () => {
  gatewayEnabled = false;
  const res = await request(gatewayApp, 'GET', '/api/v1/gateway/providers');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /not configured/);
});

test('GET /gateway/providers and /models: success and provider filter', async () => {
  const providers = await request(gatewayApp, 'GET', '/api/v1/gateway/providers');
  assert.equal(providers.status, 200);
  assert.equal(providers.body.success, true);
  assert.equal(providers.body.total, 1);

  const allModels = await request(gatewayApp, 'GET', '/api/v1/gateway/models');
  assert.equal(allModels.status, 200);
  assert.equal(allModels.body.models.length, 2);

  const filtered = await request(gatewayApp, 'GET', '/api/v1/gateway/models?provider=azure');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.models.length, 1);
  assert.equal(filtered.body.models[0].provider, 'azure');
});

test('GET /gateway/providers: upstream error surfaces as 502', async () => {
  bifrostProviderOps.listGatewayProviders = async () => {
    const err: any = new Error('upstream');
    err.response = { data: { error: { message: 'gateway down' } } };
    throw err;
  };
  const res = await request(gatewayApp, 'GET', '/api/v1/gateway/providers');
  assert.equal(res.status, 502);
  assert.equal(res.body.message, 'gateway down');
});

test('GET /gateway/models: upstream detail fallback when listing models fails', async () => {
  bifrostProviderOps.listGatewayModels = async () => {
    const err: any = new Error('');
    err.response = { data: { detail: 'models unavailable' } };
    throw err;
  };
  const res = await request(gatewayApp, 'GET', '/api/v1/gateway/models');
  assert.equal(res.status, 502);
  assert.equal(res.body.message, 'models unavailable');
});

test('POST /gateway/providers/:provider/keys: validation and success', async () => {
  const bad = await request(gatewayApp, 'POST', '/api/v1/gateway/providers/openai/keys', {
    body: { modelId: 'm1' },
  });
  assert.equal(bad.status, 400);

  const ok = await request(gatewayApp, 'POST', '/api/v1/gateway/providers/openai/keys', {
    body: { modelId: 'm1', providerModelId: 'gpt-4', apiKey: 'sk-test' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.keyName, 'key-1');
});

test('POST /gateway/providers/:provider/keys: upstream detail and invalid status clamped to 502', async () => {
  bifrostProviderOps.appendProviderKey = async () => {
    const err: any = new Error('fallback');
    err.response = { status: 999, data: { detail: 'bad gateway detail' } };
    throw err;
  };
  const detail = await request(gatewayApp, 'POST', '/api/v1/gateway/providers/openai/keys', {
    body: { modelId: 'm1', providerModelId: 'gpt-4' },
  });
  assert.equal(detail.status, 502);
  assert.equal(detail.body.message, 'bad gateway detail');
});

test('DELETE /gateway/providers/:provider/keys/:keyId: success and error', async () => {
  const ok = await request(gatewayApp, 'DELETE', '/api/v1/gateway/providers/openai/keys/key-1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);

  bifrostProviderOps.deleteProviderKeyById = async () => {
    const err: any = new Error('delete failed');
    err.response = { data: { error: { message: 'not found' } } };
    throw err;
  };
  const fail = await request(gatewayApp, 'DELETE', '/api/v1/gateway/providers/openai/keys/missing');
  assert.equal(fail.status, 502);
  assert.equal(fail.body.message, 'not found');
});

test('GET /gateway/models: 502 when gateway disabled', async () => {
  gatewayEnabled = false;
  const res = await request(gatewayApp, 'GET', '/api/v1/gateway/models');
  assert.equal(res.status, 502);
});

test('POST /gateway/providers/:provider/keys: propagates valid upstream 4xx status', async () => {
  bifrostProviderOps.appendProviderKey = async () => {
    const err: any = new Error('rate limited');
    err.response = { status: 429, data: { error: { message: 'too many requests' } } };
    throw err;
  };
  const res = await request(gatewayApp, 'POST', '/api/v1/gateway/providers/openai/keys', {
    body: { modelId: 'm1', providerModelId: 'gpt-4' },
  });
  assert.equal(res.status, 429);
  assert.equal(res.body.message, 'too many requests');
});

test('GET /gateway/models: filters by mapped bifrost provider name', async () => {
  bifrostProviderOps.listGatewayModels = async () => ({
    models: [
      { id: 'm1', provider: 'azure-openai', name: 'gpt-4o' },
      { id: 'm2', provider: 'openai', name: 'gpt-4' },
    ],
    total: 2,
    providers: ['azure-openai', 'openai'],
  });
  const res = await request(gatewayApp, 'GET', '/api/v1/gateway/models?provider=azure');
  assert.equal(res.status, 200);
  assert.equal(res.body.models.length, 1);
  assert.equal(res.body.models[0].provider, 'azure-openai');
});

// ─── governanceRoutes ───────────────────────────────────────────────────────

test('governanceRoutes: virtual-keys CRUD happy paths', async () => {
  const list = await request(governanceApp, 'GET', '/api/v1/governance/virtual-keys');
  assert.equal(list.status, 200);
  assert.equal(list.body.success, true);

  const created = await request(governanceApp, 'POST', '/api/v1/governance/virtual-keys', {
    body: { name: 'team-a' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.id, 'vk-new');

  const updated = await request(governanceApp, 'PUT', '/api/v1/governance/virtual-keys/vk-1', {
    body: { name: 'renamed' },
  });
  assert.equal(updated.status, 200);

  const deleted = await request(governanceApp, 'DELETE', '/api/v1/governance/virtual-keys/vk-1');
  assert.equal(deleted.status, 204);
});

test('governanceRoutes: budgets, rate-limits, model-configs', async () => {
  assert.equal((await request(governanceApp, 'GET', '/api/v1/governance/budgets')).status, 200);
  assert.equal((await request(governanceApp, 'GET', '/api/v1/governance/rate-limits')).status, 200);

  const created = await request(governanceApp, 'POST', '/api/v1/governance/model-configs', {
    body: { model: 'gpt-4' },
  });
  assert.equal(created.status, 201);

  const updated = await request(governanceApp, 'PUT', '/api/v1/governance/model-configs/mc-1', {
    body: { model: 'gpt-4o' },
  });
  assert.equal(updated.status, 200);

  const deleted = await request(governanceApp, 'DELETE', '/api/v1/governance/model-configs/mc-1');
  assert.equal(deleted.status, 204);
});

test('governanceRoutes: gatewayError uses upstream status and detail', async () => {
  bifrostOps.listVirtualKeys = async () => {
    const err: any = new Error('fallback');
    err.response = { status: 503, data: { detail: 'service unavailable' } };
    throw err;
  };
  const res = await request(governanceApp, 'GET', '/api/v1/governance/virtual-keys');
  assert.equal(res.status, 503);
  assert.equal(res.body.message, 'service unavailable');
});

test('governanceRoutes: gatewayError fallbacks for budgets, rate-limits, and model-config mutations', async () => {
  const mkErr = (status: number, payload?: Record<string, unknown>) => {
    const err: any = new Error('Gateway request failed');
    err.response = { status, data: payload };
    return err;
  };

  bifrostOps.listBudgets = async () => {
    throw mkErr(999);
  };
  assert.equal((await request(governanceApp, 'GET', '/api/v1/governance/budgets')).status, 502);

  bifrostOps.listRateLimits = async () => {
    throw mkErr(401, { error: { message: 'unauthorized' } });
  };
  const rate = await request(governanceApp, 'GET', '/api/v1/governance/rate-limits');
  assert.equal(rate.status, 401);
  assert.equal(rate.body.message, 'unauthorized');

  bifrostOps.createModelConfig = async () => {
    throw mkErr(400, { detail: 'invalid config' });
  };
  const create = await request(governanceApp, 'POST', '/api/v1/governance/model-configs', { body: {} });
  assert.equal(create.status, 400);
  assert.equal(create.body.message, 'invalid config');

  bifrostOps.updateModelConfig = async () => {
    throw new Error('plain failure');
  };
  const update = await request(governanceApp, 'PUT', '/api/v1/governance/model-configs/mc-1', { body: {} });
  assert.equal(update.status, 502);
  assert.equal(update.body.message, 'plain failure');

  bifrostOps.deleteModelConfig = async () => {
    throw mkErr(204);
  };
  assert.equal((await request(governanceApp, 'DELETE', '/api/v1/governance/model-configs/mc-1')).status, 502);

  bifrostOps.createVirtualKey = async () => {
    throw mkErr(500);
  };
  const vk = await request(governanceApp, 'POST', '/api/v1/governance/virtual-keys', { body: {} });
  assert.equal(vk.status, 500);
  assert.equal(vk.body.message, 'Gateway request failed');

  bifrostOps.updateVirtualKey = async () => {
    throw mkErr(422, { error: { message: 'invalid vk' } });
  };
  assert.equal(
    (await request(governanceApp, 'PUT', '/api/v1/governance/virtual-keys/vk-1', { body: {} })).status,
    422,
  );

  bifrostOps.deleteVirtualKey = async () => {
    throw new Error('delete vk failed');
  };
  const del = await request(governanceApp, 'DELETE', '/api/v1/governance/virtual-keys/vk-1');
  assert.equal(del.status, 502);
  assert.equal(del.body.message, 'delete vk failed');
});

// ─── guardrailRoutes ────────────────────────────────────────────────────────

test('guardrailRoutes: list, create, get, update, delete', async () => {
  const list = await request(guardrailApp, 'GET', '/api/v1/guardrails');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(list.body[0].display_name, 'PII Masker');

  const created = await request(guardrailApp, 'POST', '/api/v1/guardrails', { body: GUARDRAIL_BODY });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, UUID);

  const got = await request(guardrailApp, 'GET', `/api/v1/guardrails/${UUID}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.supported_actions[0], 'block');

  const updated = await request(guardrailApp, 'PUT', `/api/v1/guardrails/${UUID}`, {
    body: { display_name: 'Renamed' },
  });
  assert.equal(updated.status, 200);

  const deleted = await request(guardrailApp, 'DELETE', `/api/v1/guardrails/${UUID}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
});

test('guardrailRoutes: validation errors return 400', async () => {
  const badList = await request(guardrailApp, 'GET', '/api/v1/guardrails?id=not-a-uuid');
  assert.equal(badList.status, 400);

  const badCreate = await request(guardrailApp, 'POST', '/api/v1/guardrails', { body: { key: 'x' } });
  assert.equal(badCreate.status, 400);

  const badId = await request(guardrailApp, 'GET', '/api/v1/guardrails/not-uuid');
  assert.equal(badId.status, 400);
});

test('guardrailRoutes: list applies query filters', async () => {
  let captured: any = null;
  guardrailSvc.list = async (filters: any) => {
    captured = filters;
    return [];
  };
  const res = await request(
    guardrailApp,
    'GET',
    `/api/v1/guardrails?id=${UUID}&key=pii_masker&stage=input&type=builtin&enabled=true`,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(captured, {
    id: UUID,
    key: 'pii_masker',
    stage: 'input',
    type: 'builtin',
    enabled: true,
  });
});

// ─── modelProviderRoutes ────────────────────────────────────────────────────

test('modelProviderRoutes: list providers', async () => {
  const res = await request(modelProviderApp, 'GET', `/api/v1/projects/${PROJECT}/providers`);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.total, 1);
});

test('modelProviderRoutes: refresh from Bifrost success and upstream error', async () => {
  const ok = await request(modelProviderApp, 'POST', `/api/v1/projects/${PROJECT}/providers/refresh`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.providers[0].status, 'connected');

  modelProviderSvc.refreshProjectProvidersFromBifrost = async () => {
    const err: any = new Error('refresh failed');
    err.response = { status: 429, data: { error: { message: 'rate limited' } } };
    throw err;
  };
  const fail = await request(modelProviderApp, 'POST', `/api/v1/projects/${PROJECT}/providers/refresh`);
  assert.equal(fail.status, 429);
  assert.equal(fail.body.message, 'rate limited');
});

test('modelProviderRoutes: update proxy config validation and success', async () => {
  const bad = await request(
    modelProviderApp,
    'PUT',
    `/api/v1/projects/${PROJECT}/providers/${PROVIDER_ID}`,
    { body: { concurrentRequests: 0 } },
  );
  assert.equal(bad.status, 400);

  const ok = await request(
    modelProviderApp,
    'PUT',
    `/api/v1/projects/${PROJECT}/providers/${PROVIDER_ID}`,
    { body: { concurrentRequests: 4, bufferSize: 8 } },
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.provider.concurrentRequests, 4);
});

test('modelProviderRoutes: list and update surface 500 on service errors', async () => {
  modelProviderSvc.listProjectProviders = async () => {
    throw new Error('db unavailable');
  };
  const listFail = await request(modelProviderApp, 'GET', `/api/v1/projects/${PROJECT}/providers`);
  assert.equal(listFail.status, 500);
  assert.equal(listFail.body.success, false);
  assert.match(String(listFail.body.message), /db unavailable/i);

  modelProviderSvc.updateProviderProxyConfig = async () => {
    throw new Error('update failed');
  };
  const updateFail = await request(
    modelProviderApp,
    'PUT',
    `/api/v1/projects/${PROJECT}/providers/${PROVIDER_ID}`,
    { body: { concurrentRequests: 2, bufferSize: 4 } },
  );
  assert.equal(updateFail.status, 500);
  assert.equal(updateFail.body.success, false);
  assert.match(String(updateFail.body.message), /update failed/i);
});

test('modelProviderRoutes: refresh uses detail fallback and non-Error values stringify', async () => {
  modelProviderSvc.refreshProjectProvidersFromBifrost = async () => {
    const err: any = new Error('ignored');
    err.response = { status: 418, data: { detail: 'teapot' } };
    throw err;
  };
  const detail = await request(modelProviderApp, 'POST', `/api/v1/projects/${PROJECT}/providers/refresh`);
  assert.equal(detail.status, 418);
  assert.equal(detail.body.message, 'teapot');

  modelProviderSvc.refreshProjectProvidersFromBifrost = async () => {
    throw 'plain string err';
  };
  const plain = await request(modelProviderApp, 'POST', `/api/v1/projects/${PROJECT}/providers/refresh`);
  assert.equal(plain.status, 502);
  assert.equal(plain.body.message, 'plain string err');

  modelProviderSvc.listProjectProviders = async () => {
    throw { message: undefined };
  };
  const list = await request(modelProviderApp, 'GET', `/api/v1/projects/${PROJECT}/providers`);
  assert.equal(list.status, 500);
  assert.equal(list.body.message, '[object Object]');

  modelProviderSvc.updateProviderProxyConfig = async () => {
    throw 42;
  };
  const update = await request(
    modelProviderApp,
    'PUT',
    `/api/v1/projects/${PROJECT}/providers/${PROVIDER_ID}`,
    { body: { concurrentRequests: 2, bufferSize: 4 } },
  );
  assert.equal(update.status, 500);
  assert.equal(update.body.message, '42');
});
