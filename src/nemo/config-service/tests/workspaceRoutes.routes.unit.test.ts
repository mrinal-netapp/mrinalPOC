/**
 * Route-handler tests for routes/workspaceRoutes.ts.
 *
 * WorkspaceService (which reaches Kubernetes via the orchestrator client + S3)
 * is fully stubbed via the require-cache module mock; the route is loaded fresh
 * so it binds the fake. Domain errors thrown by the service surface through the
 * buildApp error handler via `err.statusCode`.
 *
 * Run: node --require ts-node/register --test tests/workspaceRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, type Restore } from './helpers/moduleMock';
import { NotFoundError, ConflictError, ValidationError, BusinessLogicError } from '../utils/errors';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/workspaces`;

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let fakeSvc: Record<string, any>;

function notFound(id: string): never {
  throw new NotFoundError('Workspace', id);
}

beforeEach(() => {
  handle = installFakeRepositories({});
  fakeSvc = {
    listWorkspaces: async (projectId: string, status?: string) => [
      { id: 'ws000001', projectId, name: 'w1', status: status ?? 'new' },
    ],
    getWorkspaceOrThrow: async (id: string, projectId: string) =>
      id === 'missing' ? notFound(id) : { id, projectId, name: 'w1', status: 'running' },
    createWorkspace: async (projectId: string, body: any) => {
      if (!body?.templateId || !body?.name) throw new ValidationError('templateId and name are required');
      if (body.name === 'dup') throw new ConflictError('Workspace with this name already exists in this project');
      return { id: 'ws-new001', projectId, name: body.name, templateId: body.templateId, status: 'new' };
    },
    updateWorkspace: async (id: string, projectId: string, body: any) =>
      id === 'missing' ? notFound(id) : { id, projectId, ...body },
    deleteWorkspace: async (id: string) => {
      if (id === 'missing') notFound(id);
    },
    launchWorkspace: async (id: string) => {
      if (id === 'missing') notFound(id);
      if (id === 'runningws') throw new BusinessLogicError('Workspace is already running');
      return { id, status: 'creating' };
    },
    stopWorkspace: async (id: string) => {
      if (id === 'missing') notFound(id);
      return { id, status: 'stopping' };
    },
    updateWorkspaceToken: async (id: string, projectId: string, token: string) =>
      id === 'missing' ? notFound(id) : { id, projectId, tokenSet: Boolean(token) },
  };
  restoreMock = mockModule('services/WorkspaceService', { WorkspaceService: fakeSvc });
  const router = loadFresh('routes/workspaceRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/workspaces', router });
});

afterEach(() => {
  restoreMock();
  clearModule('routes/workspaceRoutes');
  handle.restore();
});

test('GET /workspaces: lists workspaces (200)', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ws000001');
  assert.equal(res.body[0].projectId, PROJECT);
});

test('GET /workspaces?status: passes status filter through (200)', async () => {
  const res = await request(app, 'GET', `${BASE}?status=stopped`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].status, 'stopped');
});

test('GET /workspaces/:id: found 200, missing 404', async () => {
  const ok = await request(app, 'GET', `${BASE}/ws000001`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'ws000001');

  const missing = await request(app, 'GET', `${BASE}/missing`);
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /not found/i);
});

test('POST /workspaces: creates workspace (201)', async () => {
  const res = await request(app, 'POST', BASE, { body: { templateId: 'tpl-1', name: 'w-new' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'ws-new001');
  assert.equal(res.body.status, 'new');
});

test('POST /workspaces: missing required fields -> 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'incomplete' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /required/i);
});

test('POST /workspaces: duplicate name -> 409', async () => {
  const res = await request(app, 'POST', BASE, { body: { templateId: 'tpl-1', name: 'dup' } });
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /already exists/i);
});

test('PUT /workspaces/:id: updates 200, missing 404', async () => {
  const ok = await request(app, 'PUT', `${BASE}/ws000001`, { body: { description: 'updated' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.description, 'updated');

  const missing = await request(app, 'PUT', `${BASE}/missing`, { body: { description: 'x' } });
  assert.equal(missing.status, 404);
});

test('DELETE /workspaces/:id: deletes 200, missing 404', async () => {
  const ok = await request(app, 'DELETE', `${BASE}/ws000001`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { deleted: true });

  const missing = await request(app, 'DELETE', `${BASE}/missing`);
  assert.equal(missing.status, 404);
});

test('POST /workspaces/:id/launch: launches 200, already running 400, missing 404', async () => {
  const ok = await request(app, 'POST', `${BASE}/ws000001/launch`, { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'creating');

  const running = await request(app, 'POST', `${BASE}/runningws/launch`, { body: {} });
  assert.equal(running.status, 400);
  assert.match(String(running.body.error), /already running/i);

  const missing = await request(app, 'POST', `${BASE}/missing/launch`, { body: {} });
  assert.equal(missing.status, 404);
});

test('POST /workspaces/:id/stop: stops 200, missing 404', async () => {
  const ok = await request(app, 'POST', `${BASE}/ws000001/stop`, { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'stopping');

  const missing = await request(app, 'POST', `${BASE}/missing/stop`, { body: {} });
  assert.equal(missing.status, 404);
});

test('PUT /workspaces/:id/token: token required 400, sets token 200, missing 404', async () => {
  const noToken = await request(app, 'PUT', `${BASE}/ws000001/token`, { body: {} });
  assert.equal(noToken.status, 400);
  assert.match(String(noToken.body.error), /required/i);

  const ok = await request(app, 'PUT', `${BASE}/ws000001/token`, { body: { token: 'jt-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tokenSet, true);

  const missing = await request(app, 'PUT', `${BASE}/missing/token`, { body: { token: 'jt-1' } });
  assert.equal(missing.status, 404);
});

test('workspaceRoutes: missing projectId -> 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  assert.equal((await request(noProjectApp, 'GET', '/workspaces')).status, 400);
});

test('POST /workspaces: missing projectId returns 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  const res = await request(noProjectApp, 'POST', '/workspaces', {
    body: { templateId: 'tpl-1', name: 'w' },
  });
  assert.equal(res.status, 400);
});

test('GET /workspaces: returns 500 when service throws', async () => {
  fakeSvc.listWorkspaces = async () => {
    throw new Error('list failed');
  };
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('PUT /workspaces/:id: missing projectId returns 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  const res = await request(noProjectApp, 'PUT', '/workspaces/ws000001', { body: { description: 'x' } });
  assert.equal(res.status, 400);
});

test('DELETE /workspaces/:id: missing projectId returns 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  const res = await request(noProjectApp, 'DELETE', '/workspaces/ws000001');
  assert.equal(res.status, 400);
});

test('POST /workspaces/:id/launch: missing projectId returns 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  const res = await request(noProjectApp, 'POST', '/workspaces/ws000001/launch', { body: {} });
  assert.equal(res.status, 400);
});

test('POST /workspaces/:id/stop: missing projectId returns 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspaces',
    router: loadFresh('routes/workspaceRoutes').default,
  });
  const res = await request(noProjectApp, 'POST', '/workspaces/ws000001/stop', { body: {} });
  assert.equal(res.status, 400);
});
