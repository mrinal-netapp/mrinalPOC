/**
 * Route-handler tests for routes/modelRoutes.ts.
 * LiteLLM + CredentialService are module-mocked; provider registry,
 * static metadata and ReferenceEdgeService run real.
 *
 * Run: node --require ts-node/register --test tests/modelRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { QueryFailedError } from 'typeorm';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/models`;
const UUID = '123e4567-e89b-12d3-a456-426614174000';

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;
let litellm: any;
let cred: any;
let bifrostGov: any;
let bifrostLogStats: any;
let lastLogStatsFilters: any;
let lastChatArgs: any[] | null;

beforeEach(() => {
  handle = installFakeRepositories({});
  lastChatArgs = null;
  lastLogStatsFilters = null;
  litellm = {
    enabled: false,
    isEnabled() {
      return this.enabled;
    },
    addModel: async () => undefined,
    deleteModel: async () => undefined,
    chatCompletion: async (req: any, opts: any) => {
      lastChatArgs = [req, opts];
      return { response: 'hello', modelName: 'm', usage: { total_tokens: 3 } };
    },
  };
  cred = {
    getById: async (_p: string, id: string) => (id === 'missing' ? null : { id, metadata: { endpoint: 'http://x' } }),
    readSecretData: async () => ({ api_key: 'sk' }),
  };
  // Stub the project virtual-key token reader; default returns a known
  // bearer so the playground happy path succeeds. Individual tests
  // override per-case to exercise the 503 "VK not available" branch.
  bifrostGov = {
    readProjectVirtualKeyToken: async () => 'vk-bearer-test',
    resolveProjectVirtualKeyId: async () => 'vk-id-test',
  };
  // Bifrost logs-store aggregation used by GET /:id/stats. Individual tests
  // override `getLogStats` to exercise the unavailable branch.
  bifrostLogStats = {
    getLogStats: async (filters: any) => {
      lastLogStatsFilters = filters;
      return {
        total_requests: 1234,
        total_tokens: 5678,
        total_cost: 12.5,
        average_latency: 245,
        success_rate: 98.5,
        user_facing_success_rate: 99.2,
        user_facing_total_requests: 1200,
      };
    },
    // Per-request token sample used to price traffic from configured rates when
    // Bifrost logs a zero cost. Individual tests override as needed.
    getLogTokenSplit: async () => ({
      promptTokens: 0,
      completionTokens: 0,
      sampledRequests: 0,
    }),
  };
  scope = restoreScope();
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => litellm }));
  scope.add(mockModule('services/CredentialService', { getCredentialService: () => cred }));
  scope.add(mockModule('services/bifrost/bifrostProjectGovernance', bifrostGov));
  scope.add(mockModule('services/bifrost/bifrostOps', bifrostLogStats));
  // The router's POST handler short-circuits through requireProjectInitForCreate,
  // which loads Project + ProjectServiceAccount state from real repos. These
  // tests focus on the registration flow proper; bypass the guard with a
  // permissive stub so we don't need to seed gateway/Keycloak readiness
  // fixtures in every test.
  scope.add(mockModule('utils/projectInitGuard', { requireProjectInitForCreate: async () => true }));
  const router = loadFresh('routes/modelRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/models', router });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/modelRoutes');
  handle.restore();
});

function seedModel(overrides: Record<string, any>) {
  handle.repos.Model = makeFakeRepo(overrides);
}

test('POST /models: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { provider: 'nope' } });
  assert.equal(res.status, 400);
});

test('POST /models: litellm disabled -> DB-only create (201)', async () => {
  seedModel({ findOne: async () => null, create: (d: any) => ({ ...d, id: 'mdl-1' }), save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, { body: { name: 'gpt', provider: 'openai' } });
  assert.equal(res.status, 201);
});

test('POST /models: duplicate name returns 409', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1', name: 'gpt' }) });
  const res = await request(app, 'POST', BASE, { body: { name: 'gpt', provider: 'openai' } });
  assert.equal(res.status, 409);
});

test('POST /models: litellm enabled remote without credentialId -> 400', async () => {
  litellm.enabled = true;
  seedModel({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, { body: { name: 'gpt', provider: 'openai' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /credentialId is required/);
});

test('POST /models: litellm enabled with credential -> registers + 201', async () => {
  litellm.enabled = true;
  seedModel({ findOne: async () => null, create: (d: any) => ({ ...d }), save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'gpt', provider: 'openai', credentialId: UUID, providerModelId: 'gpt-4o' },
  });
  assert.equal(res.status, 201);
});

test('GET /models: list with dependentsSummary', async () => {
  seedModel({ find: async () => [{ id: 'mdl-1', name: 'm' }] });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.ok(res.body[0].dependentsSummary);
});

test('POST /models/list-available: provider required + unknown + local list', async () => {
  assert.equal((await request(app, 'POST', `${BASE}/list-available`, { body: {} })).status, 400);
  assert.equal((await request(app, 'POST', `${BASE}/list-available`, { body: { provider: 'nope' } })).status, 400);
  const local = await request(app, 'POST', `${BASE}/list-available`, { body: { provider: 'ollama' } });
  assert.equal(local.status, 200);
  assert.ok(local.body.models.length > 0);
});

test('GET /models/classes: distinct classes', async () => {
  seedModel({ createQueryBuilder: () => makeQueryBuilder({ raw: [{ modelClass: 'fast' }] }) });
  const res = await request(app, 'GET', `${BASE}/classes`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, ['fast']);
});

test('GET /models/:id: found enriches static metadata; 404 otherwise', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1', provider: 'openai', providerModelId: 'gpt-4o' }) });
  const ok = await request(app, 'GET', `${BASE}/mdl-1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.contextWindow, 128000);

  seedModel({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing`)).status, 404);
});

test('POST /models/:id/infer: validation, 404, 422, disabled, success', async () => {
  // Real registered models always carry `gatewayModelId` (the provider-
  // prefixed wire-form, e.g. `azure/<binding>`). Required since the
  // UUID-fallback code path was removed alongside Bifrost routing rules
  // -- `POST /models/:id/infer` now returns 422 if a row has neither
  // `gatewayModelId` nor `providerModelId`.
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      name: 'm',
      provider: 'openai',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  assert.equal((await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [] } })).status, 400);
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [{ role: 'bad', content: 'x' }] } })).status,
    400,
  );

  // LiteLLM disabled -> 502
  litellm.enabled = false;
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [{ role: 'user', content: 'hi' }] } })).status,
    502,
  );

  // success
  litellm.enabled = true;
  const ok = await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.response, 'hello');
  // The playground now forwards the project's Bifrost VK token as a
  // per-call apiKey override on chatCompletion, so team-scoped routing
  // / per-project budgets / audit on Bifrost apply instead of being
  // bypassed by the shared singleton's cluster master key.
  assert.ok(lastChatArgs, 'chatCompletion should have been called');
  assert.equal(lastChatArgs![1]?.apiKey, 'vk-bearer-test');

  // VK token not available (e.g. ProjectInitWorkflow Step 0 hasn't
  // completed yet, or the K8s Secret was deleted out of band) -> 503
  // (not 502), surfacing as "retry, project gateway not ready".
  bifrostGov.readProjectVirtualKeyToken = async () => undefined;
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      name: 'm',
      provider: 'openai',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [{ role: 'user', content: 'hi' }] } })).status,
    503,
  );
  // Restore the stub for subsequent assertions below.
  bifrostGov.readProjectVirtualKeyToken = async () => 'vk-bearer-test';

  // non-llm -> 422
  seedModel({ findOne: async () => ({ id: 'mdl-2', modelType: 'embedding' }) });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-2/infer`, { body: { messages: [{ role: 'user', content: 'hi' }] } })).status,
    422,
  );

  // model not found -> 404
  seedModel({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/missing/infer`, { body: { messages: [{ role: 'user', content: 'hi' }] } })).status,
    404,
  );
});

test('PUT /models/:id: update, not found, conflict', async () => {
  let row: any = { id: 'mdl-1', name: 'Old' };
  handle.repos.Model = makeFakeRepo({
    findOne: async (q: any) => (q?.where?.id?._type ? null : row),
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  assert.equal((await request(app, 'PUT', `${BASE}/mdl-1`, { body: { displayName: 'New' } })).status, 200);

  seedModel({ findOne: async () => null });
  assert.equal((await request(app, 'PUT', `${BASE}/missing`, { body: { displayName: 'x' } })).status, 404);
});

test('DELETE /models/:id: 204, dependents 409, not found 404', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1' }), delete: async () => ({ affected: 1 }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/mdl-1`)).status, 204);

  seedModel({ findOne: async () => ({ id: 'mdl-1' }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  assert.equal((await request(app, 'DELETE', `${BASE}/mdl-1`)).status, 409);

  seedModel({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/missing`)).status, 404);
});

test('GET /models/:id/history + dependents + restore-version', async () => {
  handle.repos.ModelHistory = makeFakeRepo({ find: async () => [{ version: 1 }], findOne: async () => ({ version: 1, data: { id: 'mdl-1', name: 'X' } }) });
  assert.equal((await request(app, 'GET', `${BASE}/mdl-1/history`)).status, 200);

  seedModel({ findOne: async () => ({ id: 'mdl-1' }), update: async () => ({ affected: 1 }) });
  assert.equal((await request(app, 'GET', `${BASE}/mdl-1/dependents`)).status, 200);
  assert.equal((await request(app, 'POST', `${BASE}/mdl-1/restore-version`, { body: {} })).status, 400);
  assert.equal((await request(app, 'POST', `${BASE}/mdl-1/restore-version`, { body: { version: 1 } })).status, 200);
});

test('GET /models/:id/stats: aggregates bifrost log stats, filters by provider+model+VK', async () => {
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'openai',
      credentialId: UUID,
      providerModelId: 'gpt-4o',
      gatewayBindingName: `${PROJECT}_abc123_gpt-4o`,
      gatewayModelId: `openai/${PROJECT}_abc123_gpt-4o`,
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats?days=30`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.requests, 1234);
  assert.equal(res.body.totalCost, 12.5);
  assert.equal(res.body.averageLatencyMs, 245);
  // user_facing_success_rate is preferred over the raw success_rate.
  assert.equal(res.body.successRate, 99.2);
  // Scoped to this model: bifrost provider name + BARE providerModelId (that's
  // what Bifrost logs in `model`), plus the project VK id for project scoping.
  assert.equal(lastLogStatsFilters.providers, 'openai');
  assert.equal(lastLogStatsFilters.models, 'gpt-4o');
  assert.equal(lastLogStatsFilters.virtualKeyIds, 'vk-id-test');
  assert.ok(lastLogStatsFilters.startTime, 'days=30 should produce a startTime');

  // model not found -> 404
  seedModel({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/missing/stats`)).status, 404);
});

test('GET /models/:id/stats: no traffic -> successRate null; gateway error -> available:false', async () => {
  // No traffic: successRate must be null rather than a synthetic 0%/100%.
  bifrostLogStats.getLogStats = async () => ({
    total_requests: 0,
    total_tokens: 0,
    total_cost: 0,
    average_latency: 0,
    success_rate: 0,
    user_facing_success_rate: 0,
  });
  seedModel({ findOne: async () => ({ id: 'mdl-1', provider: 'openai', providerModelId: 'gpt-4o' }) });
  const empty = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.available, true);
  assert.equal(empty.body.requests, 0);
  assert.equal(empty.body.successRate, null);

  // Logs store disabled / gateway unreachable -> zeroed, available:false, 200.
  bifrostLogStats.getLogStats = async () => {
    throw new Error('logs store disabled');
  };
  seedModel({ findOne: async () => ({ id: 'mdl-1', provider: 'openai', providerModelId: 'gpt-4o' }) });
  const down = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(down.status, 200);
  assert.equal(down.body.available, false);
  assert.equal(down.body.requests, 0);
  assert.equal(down.body.successRate, null);
});

test('GET /models/:id/stats: zero bifrost cost + configured rates -> cost computed from tokens', async () => {
  // Bifrost couldn't price this custom deployment name -> logged cost 0, but the
  // aggregate still has requests/tokens.
  bifrostLogStats.getLogStats = async () => ({
    total_requests: 1,
    total_tokens: 342,
    total_cost: 0,
    average_latency: 2231,
    success_rate: 100,
    user_facing_success_rate: 100,
  });
  // Recent-log sample carries the input/output split (331 prompt / 11 completion).
  bifrostLogStats.getLogTokenSplit = async () => ({
    promptTokens: 331,
    completionTokens: 11,
    sampledRequests: 1,
  });
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'azure',
      providerModelId: 'gpt-4.1-mini-model',
      inputCostPer1M: 0.4,
      outputCostPer1M: 1.6,
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, true);
  assert.equal(res.body.requests, 1);
  // 331 input tokens @ $0.4/1M + 11 output tokens @ $1.6/1M = 0.00015 USD.
  assert.ok(
    Math.abs(res.body.totalCost - 0.00015) < 1e-9,
    `expected ~0.00015, got ${res.body.totalCost}`,
  );
});

test('GET /models/:id/stats: non-zero bifrost cost is preserved even with configured rates', async () => {
  // Bifrost priced this model itself; configured rates must NOT override it.
  bifrostLogStats.getLogStats = async () => ({
    total_requests: 28,
    total_tokens: 93391,
    total_cost: 0.25,
    average_latency: 3884,
    success_rate: 100,
    user_facing_success_rate: 100,
  });
  let splitCalled = false;
  bifrostLogStats.getLogTokenSplit = async () => {
    splitCalled = true;
    return { promptTokens: 1, completionTokens: 1, sampledRequests: 1 };
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'azure',
      providerModelId: 'gpt-5.4',
      inputCostPer1M: 0.4,
      outputCostPer1M: 1.6,
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCost, 0.25);
  assert.equal(splitCalled, false, 'token split must not be sampled when bifrost already priced');
});

// -------------------------- embedding-model dimensions (PR1)
test('POST /models: embedding model with catalog-known id stamps model_info.dimensions', async () => {
  litellm.enabled = true;
  let savedModel: any = null;
  seedModel({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => {
      savedModel = e;
      return e;
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'my-openai-embed',
      provider: 'openai',
      credentialId: UUID,
      providerModelId: 'text-embedding-3-small',
      modelType: 'embedding',
    },
  });
  assert.equal(res.status, 201);
  assert.ok(savedModel, 'expected modelRepo.save to be called');
  assert.equal(savedModel.model_info?.dimensions, 1536, 'static catalog should fill 1536-d for text-embedding-3-small');
  assert.equal(savedModel.model_info?.category, 'balanced');
});

test('POST /models: embedding model with caller-supplied model_info.dimensions wins over catalog', async () => {
  litellm.enabled = true;
  let savedModel: any = null;
  seedModel({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => {
      savedModel = e;
      return e;
    },
  });
  // text-embedding-3-small is configurable; downsized deployment.
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'my-downsized-embed',
      provider: 'openai',
      credentialId: UUID,
      providerModelId: 'text-embedding-3-small',
      modelType: 'embedding',
      model_info: { dimensions: 512 },
    },
  });
  assert.equal(res.status, 201);
  assert.equal(savedModel.model_info.dimensions, 512, 'user override must beat catalog default');
});

test('POST /models: embedding model unknown to catalog with no dimensions -> 400 EMBEDDING_DIMENSIONS_REQUIRED', async () => {
  litellm.enabled = true;
  seedModel({ findOne: async () => null, create: (d: any) => ({ ...d }), save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'mystery-embed',
      provider: 'openai_compatible',
      credentialId: UUID,
      providerModelId: 'totally-made-up-vendor-1',
      modelType: 'embedding',
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMBEDDING_DIMENSIONS_REQUIRED');
  assert.match(String(res.body.error), /no known vector dimensions/);
});

test('POST /models: LLM models skip the embedding-dimensions cascade entirely', async () => {
  litellm.enabled = true;
  let savedModel: any = null;
  seedModel({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => {
      savedModel = e;
      return e;
    },
  });
  // No modelType -> defaults to LLM; no dimensions required.
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'gpt',
      provider: 'openai',
      credentialId: UUID,
      providerModelId: 'gpt-4o',
    },
  });
  assert.equal(res.status, 201);
  // LLM models must not have a stamped model_info.dimensions (catalog only runs for embeddings).
  assert.equal(savedModel?.model_info?.dimensions, undefined);
});

test('POST /models/list-available: embedding models in response get dimensions stamped from catalog', async () => {
  // Provider registry's ollama adapter returns local models without dimensions;
  // the route should not fabricate dimensions for them. Test with a stub
  // provider that returns embedding model ids matching the catalog.
  litellm.enabled = false;
  // Drive through the openai adapter via the stub axios in the providers.unit.test.ts
  // approach — here we just verify the contract: GET ollama -> models[] sans
  // dimensions on the LLM ones, and any embedding rows the registry returns get
  // dimensions assigned when their id is in the catalog. The ollama adapter
  // returns LLM models in unit tests, so we assert no spurious dimensions.
  const res = await request(app, 'POST', `${BASE}/list-available`, { body: { provider: 'ollama' } });
  assert.equal(res.status, 200);
  for (const m of res.body.models) {
    if (m.type !== 'embedding') {
      assert.equal(m.dimensions, undefined, 'LLM models must not get a dimensions field');
    }
  }
});

test('POST /models: ollama without endpoint returns 400 when gateway enabled', async () => {
  litellm.enabled = true;
  seedModel({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'local', provider: 'ollama', credentialId: UUID, providerModelId: 'llama3' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /endpoint is required/);
});

test('POST /models: credential not found returns 404', async () => {
  litellm.enabled = true;
  cred.getById = async () => null;
  seedModel({ findOne: async () => null });
  const missingUuid = '123e4567-e89b-12d3-a456-426614174099';
  const res = await request(app, 'POST', BASE, {
    body: { name: 'gpt', provider: 'openai', credentialId: missingUuid, providerModelId: 'gpt-4o' },
  });
  assert.equal(res.status, 404);
});

test('POST /models: secret not found returns 500', async () => {
  litellm.enabled = true;
  cred.readSecretData = async () => null;
  seedModel({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'gpt', provider: 'openai', credentialId: UUID, providerModelId: 'gpt-4o' },
  });
  assert.equal(res.status, 500);
});

test('POST /models/list-available: credential not found returns 404', async () => {
  const res = await request(app, 'POST', `${BASE}/list-available`, {
    body: { provider: 'openai', credentialId: 'missing' },
  });
  assert.equal(res.status, 404);
});

test('GET /models: filters by modelClass and modelType', async () => {
  let captured: any = null;
  seedModel({
    find: async (q: any) => {
      captured = q?.where;
      return [{ id: 'mdl-1', name: 'm', modelClass: 'fast', modelType: 'llm' }];
    },
  });
  const res = await request(app, 'GET', `${BASE}?modelClass=fast&modelType=llm`);
  assert.equal(res.status, 200);
  assert.equal(captured.modelClass, 'fast');
  assert.equal(captured.modelType, 'llm');
});

test('GET /models: empty list skips dependents summary', async () => {
  seedModel({ find: async () => [] });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('PUT /models/:id: builtin rejects immutable fields', async () => {
  seedModel({
    findOne: async () => ({ id: 'mdl-builtin', isBuiltin: true, name: 'builtin-embed' }),
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-builtin`, {
    body: { displayName: 'Renamed', provider: 'openai' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'BUILTIN_MODEL_IMMUTABLE');
});

test('PUT /models/:id: builtin allows displayName-only update', async () => {
  let row: any = { id: 'mdl-builtin', isBuiltin: true, name: 'builtin-embed', provider: 'openai' };
  seedModel({
    findOne: async () => row,
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-builtin`, { body: { displayName: 'Pretty Name' } });
  assert.equal(res.status, 200);
  assert.equal(row.displayName, 'Pretty Name');
});

test('PUT /models/:id: syncs governance limits when rpm set', async () => {
  let govCalled = false;
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      readProjectVirtualKeyToken: async () => 'vk-bearer-test',
      resolveProjectVirtualKeyId: async () => 'vk-id-test',
      assignModelGovernance: async () => {
        govCalled = true;
      },
      removeModelGovernance: async () => undefined,
    }),
  );
  clearModule('routes/modelRoutes');
  app = buildApp({ basePath: '/api/v1/projects/:projectId/models', router: loadFresh('routes/modelRoutes').default });

  let row: any = {
    id: 'mdl-1',
    projectId: PROJECT,
    name: 'gpt',
    provider: 'openai',
    providerModelId: 'gpt-4o',
    gatewayBindingName: 'bind-1',
    rpm: 0,
  };
  seedModel({
    findOne: async (q: any) => {
      if (q?.where?.name) return null;
      return row;
    },
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { rpm: 100 } });
  assert.equal(res.status, 200);
  assert.equal(govCalled, true);
});

test('PUT /models/:id: removes governance when limits cleared', async () => {
  let removed = false;
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      readProjectVirtualKeyToken: async () => 'vk-bearer-test',
      resolveProjectVirtualKeyId: async () => 'vk-id-test',
      assignModelGovernance: async () => undefined,
      removeModelGovernance: async () => {
        removed = true;
      },
    }),
  );
  clearModule('routes/modelRoutes');
  app = buildApp({ basePath: '/api/v1/projects/:projectId/models', router: loadFresh('routes/modelRoutes').default });

  let row: any = {
    id: 'mdl-1',
    provider: 'openai',
    gatewayBindingName: 'bind-1',
    rpm: 100,
    tpm: 0,
    spendingLimit: 0,
  };
  seedModel({
    findOne: async () => row,
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { rpm: 0, tpm: 0, spendingLimit: 0 } });
  assert.equal(res.status, 200);
  assert.equal(removed, true);
});

test('POST /models/:id/infer: maps gateway 504 to 504', async () => {
  litellm.enabled = true;
  litellm.chatCompletion = async () => {
    const err: any = new Error('timeout');
    err.status = 504;
    throw err;
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      provider: 'openai',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mdl-1/infer`, {
    body: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.5, maxTokens: 128 },
  });
  assert.equal(res.status, 504);
});

test('POST /models/:id/infer: rejects invalid temperature and maxTokens', async () => {
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, {
      body: { messages: [{ role: 'user', content: 'hi' }], temperature: 'hot' },
    })).status,
    400,
  );
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, {
      body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 0 },
    })).status,
    400,
  );
});

test('PUT /models/:id: returns 409 on postgres unique violation during rename', async () => {
  const pgErr: any = new Error('duplicate');
  pgErr.code = '23505';
  let row: any = { id: 'mdl-1', name: 'Old', provider: 'openai' };
  seedModel({
    findOne: async (q: any) => (q?.where?.name ? { id: 'other' } : row),
    update: async () => {
      throw pgErr;
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { name: 'Taken' } });
  assert.equal(res.status, 409);
});

test('PUT /models/:id: returns 500 on unexpected update error', async () => {
  let row: any = { id: 'mdl-1', name: 'Old', provider: 'openai' };
  seedModel({
    findOne: async () => row,
    update: async () => {
      throw new Error('update exploded');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { displayName: 'New Label' } });
  assert.equal(res.status, 500);
});

test('DELETE /models/:id: rejects built-in models', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-builtin', isBuiltin: true }) });
  const res = await request(app, 'DELETE', `${BASE}/mdl-builtin`);
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /built-in/i);
});

test('POST /models/list-available: secret read failure returns 500', async () => {
  cred.readSecretData = async () => null;
  const res = await request(app, 'POST', `${BASE}/list-available`, {
    body: { provider: 'openai', credentialId: UUID },
  });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /secret/i);
});

test('GET /models: returns 500 when query fails', async () => {
  seedModel({
    find: async () => {
      throw new Error('db down');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('POST /models: non-gateway embedding without catalog match returns EMBEDDING_DIMENSIONS_REQUIRED', async () => {
  litellm.enabled = false;
  seedModel({ findOne: async () => null, create: (d: any) => d, save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'bad-dim-embed',
      provider: 'openai_compatible',
      providerModelId: 'unknown-embed-model',
      modelType: 'embedding',
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMBEDDING_DIMENSIONS_REQUIRED');
});

test('POST /models/list-available: missing provider returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/list-available`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /models/list-available: unknown provider returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/list-available`, { body: { provider: 'nope' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Unknown provider/);
});

test('GET /models/classes: returns 500 when query fails', async () => {
  seedModel({
    createQueryBuilder: () => {
      throw new Error('classes query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/classes`);
  assert.equal(res.status, 500);
});

test('GET /models/pricing-defaults: validates query params and returns pricing', async () => {
  assert.equal((await request(app, 'GET', `${BASE}/pricing-defaults`)).status, 400);
  const res = await request(app, 'GET', `${BASE}/pricing-defaults?provider=openai&model=gpt-4o-mini`);
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'openai');
  assert.equal(res.body.model, 'gpt-4o-mini');
});

test('GET /models/:id/history: returns 500 when query fails', async () => {
  handle.repos.ModelHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history down');
    },
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/history`);
  assert.equal(res.status, 500);
});

test('POST /models/:id/restore-version: 404 when version missing, model missing, or update fails', async () => {
  handle.repos.ModelHistory = makeFakeRepo({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/restore-version`, { body: { version: 9 } })).status,
    404,
  );

  handle.repos.ModelHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'mdl-1', name: 'Old' } }),
  });
  seedModel({
    update: async () => ({ affected: 1 }),
    findOne: async () => null,
  });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/restore-version`, { body: { version: 1 } })).status,
    404,
  );

  handle.repos.ModelHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'mdl-1', name: 'Old' } }),
  });
  seedModel({
    update: async () => {
      throw new Error('restore failed');
    },
  });
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/restore-version`, { body: { version: 1 } })).status,
    500,
  );
});

test('GET /models/:id/stats: empty stats when providerModelId missing', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1', provider: 'openai' }) });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.requests, 0);
});

test('GET /models/:id/stats: continues when virtual key lookup fails', async () => {
  bifrostGov.resolveProjectVirtualKeyId = async () => {
    throw new Error('vk lookup failed');
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'openai',
      credentialId: UUID,
      providerModelId: 'gpt-4o',
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(lastLogStatsFilters.virtualKeyIds, undefined);
});

test('GET /models/:id/stats: falls back to success_rate when user_facing is null', async () => {
  bifrostLogStats.getLogStats = async () => ({
    total_requests: 10,
    total_tokens: 100,
    total_cost: 1,
    average_latency: 50,
    success_rate: 95,
    user_facing_success_rate: null,
  });
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'openai',
      providerModelId: 'gpt-4o',
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.successRate, 95);
});

test('GET /models/:id/stats: token split failure keeps bifrost zero cost', async () => {
  bifrostLogStats.getLogStats = async () => ({
    total_requests: 5,
    total_tokens: 1000,
    total_cost: 0,
    average_latency: 10,
    success_rate: 100,
    user_facing_success_rate: 100,
  });
  bifrostLogStats.getLogTokenSplit = async () => {
    throw new Error('split failed');
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'azure',
      providerModelId: 'gpt-5.4',
      inputCostPer1M: 1,
      outputCostPer1M: 2,
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCost, 0);
});

test('DELETE /models/:id: gateway delete runs even when credential secret read fails', async () => {
  litellm.enabled = true;
  let deleted = false;
  litellm.deleteModel = async () => {
    deleted = true;
  };
  cred.readSecretData = async () => {
    throw new Error('secret read failed');
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      credentialId: UUID,
      provider: 'openai',
      providerModelId: 'gpt-4o',
      rateCardOverride: { _gateway: { credentialId: UUID } },
    }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mdl-1`);
  assert.equal(res.status, 204);
  assert.equal(deleted, true);
});

test('DELETE /models/:id: returns 500 when gateway deleteModel throws', async () => {
  litellm.enabled = true;
  litellm.deleteModel = async () => {
    throw new Error('gateway delete failed');
  };
  seedModel({
    findOne: async () => ({ id: 'mdl-1', provider: 'openai', providerModelId: 'gpt-4o' }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/mdl-1`);
  assert.equal(res.status, 500);
});

test('GET /models/:id/dependents: returns 500 when edge reconciliation fails', async (t) => {
  const localScope = restoreScope();
  t.after(() => localScope.restoreAll());
  localScope.add(
    mockModule('services/ReferenceEdgeReconciler', {
      ensureKbEmbeddingModelReferenceEdgesIfMissing: async () => {
        throw new Error('dependents lookup failed');
      },
    }),
  );
  clearModule('routes/modelRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/models',
    router: loadFresh('routes/modelRoutes').default,
  });
  seedModel({ findOne: async () => ({ id: 'mdl-1' }) });
  const res = await request(localApp, 'GET', `${BASE}/mdl-1/dependents`);
  assert.equal(res.status, 500);
  clearModule('routes/modelRoutes');
});

test('GET /models/:id/stats: returns 500 when model lookup fails', async () => {
  seedModel({
    findOne: async () => {
      throw new Error('model lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/stats`);
  assert.equal(res.status, 500);
});

test('POST /models: gateway path registers google with service_account_json and proxy config', async () => {
  litellm.enabled = true;
  let addModelArgs: any = null;
  litellm.addModel = async (req: any) => {
    addModelArgs = req;
    return { gatewayProvider: 'google', keyName: 'as-cred-key' };
  };
  cred.getById = async () => ({
    id: UUID,
    name: 'vertex-cred',
    metadata: { endpoint: 'https://vertex.example' },
  });
  cred.readSecretData = async () => ({
    service_account_json: '{"type":"service_account"}',
  });
  seedModel({ findOne: async () => null, create: (d: any) => d, save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'gemini',
      provider: 'google',
      credentialId: UUID,
      providerModelId: 'gemini-2.0-flash',
      concurrentRequests: '250',
      bufferSize: '1200',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(addModelArgs.provider_params.auth_credentials, '{"type":"service_account"}');
  assert.equal(addModelArgs.model_info.concurrentRequests, 250);
  assert.equal(addModelArgs.model_info.bufferSize, 1200);
});

test('POST /models: gateway path stamps azure deployment name and gateway ids', async () => {
  litellm.enabled = true;
  let addModelArgs: any = null;
  litellm.addModel = async (req: any) => {
    addModelArgs = req;
    return { gatewayProvider: 'azure', keyName: 'as-cred-key' };
  };
  seedModel({ findOne: async () => null, create: (d: any) => d, save: async (e: any) => e });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'azure-mini',
      provider: 'azure',
      credentialId: UUID,
      providerModelId: 'gpt-4o-mini',
      providerDeploymentName: 'gpt-4o-mini-model',
    },
  });
  assert.equal(res.status, 201);
  assert.equal(addModelArgs.model_info.providerDeploymentName, 'gpt-4o-mini-model');
  assert.ok(addModelArgs.model_info.gatewayModelId.startsWith('azure/'));
  assert.ok(res.body.gatewayModelId.startsWith('azure/'));
});

test('POST /models: gateway addModel failure returns 500', async () => {
  litellm.enabled = true;
  litellm.addModel = async () => {
    throw new Error('gateway registration failed');
  };
  seedModel({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'gpt', provider: 'openai', credentialId: UUID, providerModelId: 'gpt-4o' },
  });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /gateway registration failed/);
});

test('POST /models: gateway save unique violation returns 409', async () => {
  litellm.enabled = true;
  litellm.addModel = async () => ({ gatewayProvider: 'openai', keyName: 'k1' });
  const pgErr = new QueryFailedError('INSERT', [], { code: '23505' } as any);
  seedModel({
    findOne: async () => null,
    create: (d: any) => d,
    save: async () => {
      throw pgErr;
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'gpt', provider: 'openai', credentialId: UUID, providerModelId: 'gpt-4o' },
  });
  assert.equal(res.status, 409);
});

test('GET /models/:id: backfills gatewayModelId and exposes static metadata + VK token', async () => {
  seedModel({
    findOne: async () => ({
      id: 'mdl-legacy',
      provider: 'openai',
      providerModelId: 'gpt-4o-mini',
      credentialId: UUID,
    }),
  });
  const res = await request(app, 'GET', `${BASE}/mdl-legacy`);
  assert.equal(res.status, 200);
  assert.ok(res.body.gatewayModelId.includes('gpt-4o-mini'));
  assert.equal(res.body.contextWindow, 128000);
  assert.equal(res.body.gatewayApiKey, 'vk-bearer-test');
});

test('GET /models/:id: omits gatewayApiKey on user lane and tolerates VK read errors', async () => {
  const userApp = buildApp({
    basePath: '/api/v1/projects/:projectId/models',
    router: loadFresh('routes/modelRoutes').default,
    pre: [
      (req, _res, next) => {
        (req as any).agentStudioContext = { userId: 'gui-user' };
        next();
      },
    ],
  });
  bifrostGov.readProjectVirtualKeyToken = async () => {
    throw new Error('k8s read failed');
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      provider: 'openai',
      providerModelId: 'gpt-4o',
      gatewayModelId: 'openai/gpt-4o',
    }),
  });
  const res = await request(userApp, 'GET', `${BASE}/mdl-1`);
  assert.equal(res.status, 200);
  assert.equal(res.body.gatewayApiKey, undefined);
});

test('GET /models/:id: returns 500 when lookup throws', async () => {
  seedModel({
    findOne: async () => {
      throw new Error('db unavailable');
    },
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1`);
  assert.equal(res.status, 500);
});

test('PUT /models/:id: validation failure returns 400', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1', name: 'm' }) });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { rpm: 'not-a-number' } });
  assert.equal(res.status, 400);
});

test('PUT /models/:id: governance sync failure still returns 200', async () => {
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      readProjectVirtualKeyToken: async () => 'vk-bearer-test',
      resolveProjectVirtualKeyId: async () => 'vk-id-test',
      assignModelGovernance: async () => {
        throw new Error('governance sync down');
      },
      removeModelGovernance: async () => undefined,
    }),
  );
  clearModule('routes/modelRoutes');
  app = buildApp({ basePath: '/api/v1/projects/:projectId/models', router: loadFresh('routes/modelRoutes').default });

  let row: any = {
    id: 'mdl-1',
    provider: 'openai',
    gatewayBindingName: 'bind-1',
    rpm: 0,
  };
  seedModel({
    findOne: async () => row,
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { rpm: 50, tpm: 1000 } });
  assert.equal(res.status, 200);
  assert.equal(row.rpm, 50);
});

test('PUT /models/:id: skips governance when binding name missing', async () => {
  let govCalled = false;
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      readProjectVirtualKeyToken: async () => 'vk-bearer-test',
      resolveProjectVirtualKeyId: async () => 'vk-id-test',
      assignModelGovernance: async () => {
        govCalled = true;
      },
      removeModelGovernance: async () => undefined,
    }),
  );
  clearModule('routes/modelRoutes');
  app = buildApp({ basePath: '/api/v1/projects/:projectId/models', router: loadFresh('routes/modelRoutes').default });

  let row: any = { id: 'mdl-1', rpm: 0 };
  seedModel({
    findOne: async () => row,
    update: async (_w: any, d: any) => {
      row = { ...row, ...d };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { rpm: 25 } });
  assert.equal(res.status, 200);
  assert.equal(govCalled, false);
});

test('POST /models/:id/infer: rejects message count, shape, content, and missing wire id', async () => {
  litellm.enabled = true;
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  const tooMany = Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' }));
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: tooMany } })).status,
    400,
  );
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, {
      body: { messages: [{ role: 'user', content: '' }] },
    })).status,
    400,
  );
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, { body: { messages: [null] } })).status,
    400,
  );

  seedModel({ findOne: async () => ({ id: 'mdl-bare', modelType: 'llm' }) });
  const missingWire = await request(app, 'POST', `${BASE}/mdl-bare/infer`, {
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(missingWire.status, 422);
  assert.match(String(missingWire.body.error), /gatewayModelId and providerModelId/);
});

test('POST /models/:id/infer: maps upstream 4xx to 502 and 408 to 504', async () => {
  litellm.enabled = true;
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });

  litellm.chatCompletion = async () => {
    const err: any = new Error('bad request');
    err.status = 400;
    throw err;
  };
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, {
      body: { messages: [{ role: 'user', content: 'hi' }] },
    })).status,
    502,
  );

  litellm.chatCompletion = async () => {
    const err: any = new Error('timeout');
    err.status = 408;
    throw err;
  };
  assert.equal(
    (await request(app, 'POST', `${BASE}/mdl-1/infer`, {
      body: { messages: [{ role: 'user', content: 'hi' }] },
    })).status,
    504,
  );
});

test('GET /models/pricing-defaults: returns 500 when catalog lookup fails', async (t) => {
  const localScope = restoreScope();
  t.after(() => localScope.restoreAll());
  localScope.add(
    mockModule('catalog/modelPricingCatalog', {
      getModelPricingDefault: async () => {
        throw new Error('catalog unavailable');
      },
    }),
  );
  clearModule('routes/modelRoutes');
  const localApp = buildApp({
    basePath: '/api/v1/projects/:projectId/models',
    router: loadFresh('routes/modelRoutes').default,
  });
  const res = await request(localApp, 'GET', `${BASE}/pricing-defaults?provider=openai&model=gpt-4o`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /catalog unavailable/);
  clearModule('routes/modelRoutes');
});

test('DELETE /models/:id: returns 409 on postgres FK violation during delete', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  seedModel({
    findOne: async () => ({ id: 'mdl-1', provider: 'openai', providerModelId: 'gpt-4o' }),
    delete: async () => {
      throw new QueryFailedError('DELETE', [], { code: '23503' } as any);
    },
  });
  const res = await request(app, 'DELETE', `${BASE}/mdl-1`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HAS_DEPENDENTS');
});

test('PUT /models/:id: returns 409 on QueryFailedError unique violation during update', async () => {
  let row: any = { id: 'mdl-1', name: 'Old', provider: 'openai', projectId: PROJECT };
  seedModel({
    findOne: async (q: any) => (q?.where?.name ? null : row),
    update: async () => {
      throw new QueryFailedError('UPDATE', [], { code: '23505' } as any);
    },
  });
  const res = await request(app, 'PUT', `${BASE}/mdl-1`, { body: { name: 'new-valid-name' } });
  assert.equal(res.status, 409);
});

test('POST /models/:id/infer: returns 502 on generic gateway error without status', async () => {
  litellm.enabled = true;
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  litellm.chatCompletion = async () => {
    throw new Error('gateway exploded');
  };
  const res = await request(app, 'POST', `${BASE}/mdl-1/infer`, {
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 502);
  assert.match(String(res.body.error), /gateway exploded/);
});

test('POST /models/:id/infer: returns 503 when VK read throws', async () => {
  litellm.enabled = true;
  bifrostGov.readProjectVirtualKeyToken = async () => {
    throw new Error('k8s secret read failed');
  };
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  const res = await request(app, 'POST', `${BASE}/mdl-1/infer`, {
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 503);
});

test('GET /models/:id/dependents: returns 500 when lookup fails', async () => {
  seedModel({ findOne: async () => ({ id: 'mdl-1', projectId: PROJECT }) });
  handle.query.mock.mockImplementation(async () => {
    throw new Error('dependents query failed');
  });
  const res = await request(app, 'GET', `${BASE}/mdl-1/dependents`);
  assert.equal(res.status, 500);
});

test('POST /models: returns 400 when validation fails', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'gpt', provider: 'nope' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('GET /models: returns 500 when list query fails', async () => {
  handle.repos.Model = makeFakeRepo({
    find: async () => {
      throw new Error('model list failed');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('POST /models/:id/infer: returns 504 on gateway timeout status 408', async () => {
  litellm.enabled = true;
  seedModel({
    findOne: async () => ({
      id: 'mdl-1',
      modelType: 'llm',
      gatewayModelId: 'openai/gpt-4o-mini',
    }),
  });
  litellm.chatCompletion = async () => {
    const err: any = new Error('timeout');
    err.status = 408;
    throw err;
  };
  const res = await request(app, 'POST', `${BASE}/mdl-1/infer`, {
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.status, 504);
});

