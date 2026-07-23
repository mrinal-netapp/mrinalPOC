/**
 * Route-handler tests for routes/pipelineRoutes.ts.
 *
 * The workflow-engine HTTP client is created at module load via
 * `createServiceAccountClientFromEnv()` (returns null with no KEYCLOAK_* env)
 * falling back to `axios.create(...)`. We stub `axios.create` BEFORE loading
 * the route so `workflowEngineClient` becomes an in-memory fake whose `.post`
 * we control. DB access flows through the AppDataSource fake-repo seam and the
 * real pipelineValidator + ReferenceEdgeService run against the same fakes.
 *
 * Run: node --require ts-node/register --test tests/pipelineRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { loadFresh, clearModule } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/pipelines`;
const PROJECT_ROW = { id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` };

const VALID_GRAPH = { nodes: [{ id: 'n1', type: 'dataset' }], edges: [] };

let handle: FakeDataSourceHandle;
let app: Express;
let wfClient: any;

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => PROJECT_ROW }),
  });
  // Fake workflow-engine HTTP client returned by the stubbed axios.create.
  wfClient = {
    post: mock.fn(async () => ({ data: {} })),
    get: mock.fn(async () => ({ data: {} })),
    put: mock.fn(async () => ({ data: {} })),
    delete: mock.fn(async () => ({ data: {} })),
    // Defensive: if a ServiceAccountClient path is ever taken, createAuthenticatedClient
    // installs interceptors on the axios instance returned by axios.create.
    interceptors: { request: { use: () => undefined }, response: { use: () => undefined } },
  };
  mock.method(axios, 'create', () => wfClient);
  const router = loadFresh('routes/pipelineRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/pipelines', router });
});

afterEach(() => {
  mock.restoreAll();
  clearModule('routes/pipelineRoutes');
  handle.restore();
});

function seedPipeline(overrides: Record<string, any>) {
  handle.repos.Pipeline = makeFakeRepo(overrides);
}

// ─── POST / (create) ────────────────────────────────────────────────────────

test('POST /pipelines: valid body creates pipeline (201)', async () => {
  seedPipeline({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'pl-new0001' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'My Pipeline', graph: VALID_GRAPH },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'pl-new0001');
});

test('POST /pipelines: invalid graph returns 400 errors array', async () => {
  const res = await request(app, 'POST', BASE, {
    // edge references a node that does not exist -> validateGraph false
    body: { name: 'p', graph: { nodes: [{ id: 'a', type: 'dataset' }], edges: [{ from: 'a', to: 'z' }] } },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /pipelines: missing name + graph returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: {} });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /pipelines: duplicate name returns 409', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-existing', name: 'My Pipeline' }) });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'My Pipeline', graph: VALID_GRAPH },
  });
  assert.equal(res.status, 409);
});

test('POST /pipelines: project not found returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'My Pipeline', graph: VALID_GRAPH },
  });
  assert.equal(res.status, 404);
});

// ─── GET / (list) ─────────────────────────────────────────────────────────────

test('GET /pipelines: list returns items with dependentsSummary', async () => {
  seedPipeline({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'pl-1', name: 'P' }] }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'pl-1');
  assert.ok(res.body[0].dependentsSummary);
});

test('GET /pipelines: empty list returns [] without summary', async () => {
  seedPipeline({ createQueryBuilder: () => makeQueryBuilder({ many: [] }) });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /pipelines: project not found returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 404);
});

// ─── GET /:id and /:id/dependents ─────────────────────────────────────────────

test('GET /pipelines/:id: found / not found', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1', name: 'P' }) });
  assert.equal((await request(app, 'GET', `${BASE}/pl-1`)).status, 200);
  seedPipeline({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/pl-x`)).status, 404);
});

test('GET /pipelines/:id/dependents: returns a page; 404 when missing', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  const ok = await request(app, 'GET', `${BASE}/pl-1/dependents?limit=10`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.items));
  assert.equal(ok.body.nextCursor, null);

  seedPipeline({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/pl-x/dependents`)).status, 404);
});

// ─── PUT /:id ─────────────────────────────────────────────────────────────────

test('PUT /pipelines/:id: updates an existing pipeline (200)', async () => {
  seedPipeline({
    findOne: async () => ({ id: 'pl-1', name: 'P', projectId: PROJECT, graph: { nodes: [], edges: [] } }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1`, { body: { description: 'updated' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'pl-1');
});

test('PUT /pipelines/:id: invalid graph returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/pl-1`, {
    body: { graph: { nodes: [], edges: [{ from: 'a', to: 'b' }] } },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('PUT /pipelines/:id: not found returns 404', async () => {
  seedPipeline({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/pl-x`, { body: { description: 'x' } });
  assert.equal(res.status, 404);
});

test('PUT /pipelines/:id: duplicate name returns 409', async () => {
  handle.repos.Pipeline = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      // dup-check query keys by name + id: Not(...) (a FindOperator object)
      if (w.name !== undefined && w.id && typeof w.id === 'object') {
        return { id: 'pl-2', name: 'New' };
      }
      return { id: 'pl-1', name: 'Old', projectId: PROJECT };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1`, { body: { name: 'New' } });
  assert.equal(res.status, 409);
});

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

test('DELETE /pipelines/:id: deletes pipeline (200)', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }), delete: async () => ({ affected: 1 }) });
  const res = await request(app, 'DELETE', `${BASE}/pl-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
});

test('DELETE /pipelines/:id: terminate failure is swallowed; still 200', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }), delete: async () => ({ affected: 1 }) });
  wfClient.post = mock.fn(async () => {
    throw new Error('workflow-engine unreachable');
  });
  const res = await request(app, 'DELETE', `${BASE}/pl-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
});

test('DELETE /pipelines/:id: not found returns 404', async () => {
  seedPipeline({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/pl-x`);
  assert.equal(res.status, 404);
});

// ─── history + restore-version ────────────────────────────────────────────────

test('GET /pipelines/:id/history: returns history or 404', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  handle.repos.PipelineHistory = makeFakeRepo({ find: async () => [{ version: 2 }, { version: 1 }] });
  const ok = await request(app, 'GET', `${BASE}/pl-1/history`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 2);

  handle.repos.PipelineHistory = makeFakeRepo({ find: async () => [] });
  assert.equal((await request(app, 'GET', `${BASE}/pl-1/history`)).status, 404);

  seedPipeline({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/pl-x/history`)).status, 404);
});

test('POST /pipelines/:id/restore-version: validates + restores', async () => {
  // missing version -> 400
  assert.equal(
    (await request(app, 'POST', `${BASE}/pl-1/restore-version`, { body: {} })).status,
    400,
  );

  // pipeline not found -> 404
  seedPipeline({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/pl-1/restore-version`, { body: { version: 1 } })).status,
    404,
  );

  // version not in history -> 404
  seedPipeline({ findOne: async () => ({ id: 'pl-1', projectId: PROJECT }), update: async () => ({ affected: 1 }) });
  handle.repos.PipelineHistory = makeFakeRepo({ findOne: async () => null });
  assert.equal(
    (await request(app, 'POST', `${BASE}/pl-1/restore-version`, { body: { version: 9 } })).status,
    404,
  );

  // happy path
  seedPipeline({
    findOne: async () => ({ id: 'pl-1', name: 'P', projectId: PROJECT, graph: { nodes: [], edges: [] } }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.PipelineHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'pl-1', name: 'Old', graph: { nodes: [], edges: [] } } }),
  });
  const ok = await request(app, 'POST', `${BASE}/pl-1/restore-version`, { body: { version: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restored, true);
});

// ─── execute (proxies workflow-engine) ─────────────────────────────────────────

test('POST /pipelines/:id/execute: starts execution (201)', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  wfClient.post = mock.fn(async () => ({ data: { executionId: 'e1', status: 'running' } }));
  const res = await request(app, 'POST', `${BASE}/pl-1/execute`, { body: { parameters: { x: 1 } } });
  assert.equal(res.status, 201);
  assert.equal(res.body.executionId, 'e1');
});

test('POST /pipelines/:id/execute: pipeline not found returns 404', async () => {
  seedPipeline({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/pl-x/execute`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /pipelines/:id/execute: upstream error maps to its status', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  wfClient.post = mock.fn(async () => {
    const err: any = new Error('bad gateway');
    err.response = { status: 502, data: { error: 'upstream down' } };
    throw err;
  });
  const res = await request(app, 'POST', `${BASE}/pl-1/execute`, { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'upstream down');
});

// ─── executions list / get ──────────────────────────────────────────────────

test('GET /pipelines/:id/executions: list (200) / pipeline 404', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  handle.repos.PipelineExecution = makeFakeRepo({ find: async () => [{ executionId: 'e1' }] });
  const ok = await request(app, 'GET', `${BASE}/pl-1/executions`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body[0].executionId, 'e1');

  seedPipeline({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/pl-x/executions`)).status, 404);
});

test('GET /pipelines/:id/executions/:executionId: found / not found', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({ findOne: async () => ({ executionId: 'e1', status: 'running' }) });
  assert.equal((await request(app, 'GET', `${BASE}/pl-1/executions/e1`)).status, 200);

  handle.repos.PipelineExecution = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/pl-1/executions/missing`)).status, 404);
});

// ─── executions update (workflow-engine persistence) ──────────────────────────

test('PUT /pipelines/:id/executions/:executionId: updates fields (200)', async () => {
  const exec: any = { executionId: 'e1', status: 'running', stepResults: [] };
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => exec,
    save: async (e: any) => e,
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1`, {
    body: { status: 'completed', finalOutput: { ok: true }, endedAt: new Date().toISOString() },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
});

test('PUT /pipelines/:id/executions/:executionId: not found returns 404', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/missing`, { body: { status: 'failed' } });
  assert.equal(res.status, 404);
});

test('PUT /pipelines/:id/executions/:executionId/steps: validation + upsert', async () => {
  const exec: any = { executionId: 'e1', stepResults: [] };
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => exec,
    save: async (e: any) => e,
  });
  // missing nodeId/stepResult -> 400
  assert.equal(
    (await request(app, 'PUT', `${BASE}/pl-1/executions/e1/steps`, { body: {} })).status,
    400,
  );
  // valid -> 200
  const ok = await request(app, 'PUT', `${BASE}/pl-1/executions/e1/steps`, {
    body: { nodeId: 'n1', stepResult: { nodeId: 'n1', output: 'done' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stepResults.length, 1);
});

test('PUT /pipelines/:id/executions/:executionId/steps: not found returns 404', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/missing/steps`, {
    body: { nodeId: 'n1', stepResult: {} },
  });
  assert.equal(res.status, 404);
});

// ─── resume / cancel (proxy workflow-engine) ───────────────────────────────────

test('POST /pipelines/:id/executions/:executionId/resume: proxies (200)', async () => {
  wfClient.post = mock.fn(async () => ({ data: { resumed: true } }));
  const res = await request(app, 'POST', `${BASE}/pl-1/executions/e1/resume`, { body: { input: {} } });
  assert.equal(res.status, 200);
  assert.equal(res.body.resumed, true);
});

test('POST /pipelines/:id/executions/:executionId/resume: upstream error maps status', async () => {
  wfClient.post = mock.fn(async () => {
    const err: any = new Error('boom');
    err.response = { status: 409, data: { error: 'not paused' } };
    throw err;
  });
  const res = await request(app, 'POST', `${BASE}/pl-1/executions/e1/resume`, { body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'not paused');
});

test('POST /pipelines/:id/executions/:executionId/cancel: proxies (200)', async () => {
  wfClient.post = mock.fn(async () => ({ data: { cancelled: true } }));
  const res = await request(app, 'POST', `${BASE}/pl-1/executions/e1/cancel`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.cancelled, true);
});

test('POST /pipelines/:id/executions/:executionId/cancel: upstream error maps status', async () => {
  wfClient.post = mock.fn(async () => {
    const err: any = new Error('cancel failed');
    err.response = { status: 409, data: { error: 'already finished' } };
    throw err;
  });
  const res = await request(app, 'POST', `${BASE}/pl-1/executions/e1/cancel`, { body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'already finished');
});

test('POST /pipelines/:id/executions/:executionId/resume: upstream 404 maps through', async () => {
  wfClient.post = mock.fn(async () => {
    const err: any = new Error('missing');
    err.response = { status: 404, data: { error: 'execution not found' } };
    throw err;
  });
  const res = await request(app, 'POST', `${BASE}/missing/executions/e1/resume`, { body: {} });
  assert.equal(res.status, 404);
});

test('PUT /pipelines/:id/executions/:executionId/steps: validation error returns 400', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => ({ pipelineId: 'pl-1', projectId: PROJECT, executionId: 'e1', stepResults: [] }),
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1/steps`, { body: {} });
  assert.equal(res.status, 400);
});

test('GET /pipelines: returns 500 when list query fails', async () => {
  handle.repos.Pipeline = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          skip: () => ({
            take: () => ({
              getMany: async () => {
                throw new Error('db down');
              },
            }),
          }),
        }),
        skip: () => ({
          take: () => ({
            getMany: async () => {
              throw new Error('db down');
            },
          }),
        }),
        take: () => ({
          getMany: async () => {
            throw new Error('db down');
          },
        }),
        getMany: async () => {
          throw new Error('db down');
        },
      }),
    }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('GET /pipelines: filters by type and skips dependentsSummary', async () => {
  seedPipeline({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'pl-1', name: 'P', type: 'API' }] }),
  });
  const res = await request(app, 'GET', `${BASE}?type=API&include=dependentsSummary=false`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].type, 'API');
  assert.ok(!('dependentsSummary' in res.body[0]));
});

test('GET /pipelines/:id: returns 500 when lookup fails', async () => {
  seedPipeline({
    findOne: async () => {
      throw new Error('pipeline read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/pl-1`);
  assert.equal(res.status, 500);
});

test('PUT /pipelines/:id: same name does not trigger duplicate check', async () => {
  seedPipeline({
    findOne: async () => ({ id: 'pl-1', name: 'Same', projectId: PROJECT, graph: VALID_GRAPH }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1`, { body: { name: 'Same', description: 'ok' } });
  assert.equal(res.status, 200);
});

test('PUT /pipelines/:id: returns 400 on transaction failure', async () => {
  seedPipeline({
    findOne: async () => ({ id: 'pl-1', name: 'P', projectId: PROJECT, graph: VALID_GRAPH }),
    update: async () => {
      throw new Error('tx update failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1`, { body: { description: 'x' } });
  assert.equal(res.status, 400);
});

test('DELETE /pipelines/:id: returns 404 when delete affects zero rows', async () => {
  seedPipeline({
    findOne: async () => ({ id: 'pl-1' }),
    delete: async () => ({ affected: 0 }),
  });
  const res = await request(app, 'DELETE', `${BASE}/pl-1`);
  assert.equal(res.status, 404);
});

test('GET /pipelines/:id/history: returns 500 on unexpected errors', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  handle.repos.PipelineHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/pl-1/history`);
  assert.equal(res.status, 500);
});

test('POST /pipelines/:id/restore-version: returns 500 on unexpected errors', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1', projectId: PROJECT }) });
  handle.repos.PipelineHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'pl-1', name: 'Old', graph: VALID_GRAPH } }),
  });
  handle.repos.Pipeline = makeFakeRepo({
    findOne: async () => ({ id: 'pl-1', projectId: PROJECT }),
    update: async () => {
      throw new Error('restore failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/pl-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
});

test('GET /pipelines/:id/executions: returns 500 when list fails', async () => {
  seedPipeline({ findOne: async () => ({ id: 'pl-1' }) });
  handle.repos.PipelineExecution = makeFakeRepo({
    find: async () => {
      throw new Error('executions list failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/pl-1/executions`);
  assert.equal(res.status, 500);
});

test('GET /pipelines/:id/executions/:executionId: returns 500 on unexpected errors', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => {
      throw new Error('execution read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/pl-1/executions/e1`);
  assert.equal(res.status, 500);
});

test('PUT /pipelines/:id/executions/:executionId: sets endedAt when status completes', async () => {
  const exec: any = { executionId: 'e1', status: 'running', stepResults: [] };
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => exec,
    save: async (e: any) => e,
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1`, {
    body: { status: 'completed', finalOutput: { ok: true } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'completed');
  assert.ok(res.body.endedAt);
});

test('PUT /pipelines/:id/executions/:executionId: returns 500 on save failure', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => ({ executionId: 'e1', status: 'running', stepResults: [] }),
    save: async () => {
      throw new Error('save failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1`, { body: { status: 'failed' } });
  assert.equal(res.status, 500);
});

test('PUT /pipelines/:id/executions/:executionId/steps: updates existing step result', async () => {
  const exec: any = {
    executionId: 'e1',
    stepResults: [{ nodeId: 'n1', output: 'old' }],
  };
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => exec,
    save: async (e: any) => e,
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1/steps`, {
    body: { nodeId: 'n1', stepResult: { nodeId: 'n1', output: 'new' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.stepResults[0].output, 'new');
  assert.equal(res.body.stepResults.length, 1);
});

test('PUT /pipelines/:id/executions/:executionId/steps: returns 500 on save failure', async () => {
  handle.repos.PipelineExecution = makeFakeRepo({
    findOne: async () => ({ executionId: 'e1', stepResults: [] }),
    save: async () => {
      throw new Error('steps save failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/pl-1/executions/e1/steps`, {
    body: { nodeId: 'n1', stepResult: { nodeId: 'n1', output: 'x' } },
  });
  assert.equal(res.status, 500);
});

test('POST /pipelines/:id/execute: returns 500 on outer handler failure', async () => {
  seedPipeline({
    findOne: async () => {
      throw new Error('pipeline lookup failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/pl-1/execute`, { body: {} });
  assert.equal(res.status, 500);
});

test('GET /pipelines/:id/dependents: returns 500 when lookup fails', async () => {
  seedPipeline({
    findOne: async () => {
      throw new Error('dependents failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/pl-1/dependents`);
  assert.equal(res.status, 500);
});

test('POST /pipelines: returns 400 when save fails', async () => {
  seedPipeline({
    findOne: async () => null,
    save: async () => {
      throw new Error('create tx failed');
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'Fail Pipeline', graph: VALID_GRAPH },
  });
  assert.equal(res.status, 400);
});
