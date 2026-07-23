/**
 * Route-handler tests for routes/workspaceTemplateRoutes.ts.
 *
 * WorkspaceTemplateService (DB-backed) is fully stubbed via the require-cache
 * module mock; the route is loaded fresh so it binds the fake. Domain errors
 * surface through the buildApp error handler via `err.statusCode`.
 *
 * Run: node --require ts-node/register --test tests/workspaceTemplateRoutes.routes.unit.test.ts
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
const BASE = `/api/v1/projects/${PROJECT}/workspace-templates`;

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let fakeSvc: Record<string, any>;

function notFound(id: string): never {
  throw new NotFoundError('WorkspaceTemplate', id);
}

beforeEach(() => {
  handle = installFakeRepositories({});
  fakeSvc = {
    listTemplates: async (projectId: string, activeOnly: boolean) => [
      { id: 'tpl-1', projectId, name: 't1', type: 'jupyterlab', isActive: true, activeOnly },
    ],
    getTemplate: async (id: string) =>
      id === 'missing' ? null : { id, projectId: PROJECT, name: 't1', type: 'jupyterlab' },
    createTemplate: async (projectId: string, body: any) => {
      if (!body?.name || !body?.type) throw new ValidationError('name and type are required');
      if (body.name === 'dup') throw new ConflictError('Template with this name already exists');
      return { id: 'tpl-new', projectId, name: body.name, type: body.type, isActive: true };
    },
    updateTemplate: async (id: string, projectId: string, body: any) =>
      id === 'missing' ? notFound(id) : { id, projectId, ...body },
    deleteTemplate: async (id: string) => {
      if (id === 'missing') notFound(id);
      if (id === 'inuse') throw new BusinessLogicError('Template is in use by existing workspaces');
    },
  };
  restoreMock = mockModule('services/WorkspaceTemplateService', { WorkspaceTemplateService: fakeSvc });
  const router = loadFresh('routes/workspaceTemplateRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/workspace-templates', router });
});

afterEach(() => {
  restoreMock();
  clearModule('routes/workspaceTemplateRoutes');
  handle.restore();
});

test('GET /workspace-templates: lists templates (200), default activeOnly=true', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'tpl-1');
  assert.equal(res.body[0].activeOnly, true);
});

test('GET /workspace-templates?activeOnly=false: passes flag through', async () => {
  const res = await request(app, 'GET', `${BASE}?activeOnly=false`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].activeOnly, false);
});

test('GET /workspace-templates/:id: found 200, missing 404', async () => {
  const ok = await request(app, 'GET', `${BASE}/tpl-1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'tpl-1');

  const missing = await request(app, 'GET', `${BASE}/missing`);
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /not found/i);
});

test('POST /workspace-templates: creates 201', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 't-new', type: 'vscode' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'tpl-new');
  assert.equal(res.body.type, 'vscode');
});

test('POST /workspace-templates: missing fields -> 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'incomplete' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /required/i);
});

test('POST /workspace-templates: duplicate name -> 409', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'dup', type: 'custom' } });
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /already exists/i);
});

test('PUT /workspace-templates/:id: updates 200, missing 404', async () => {
  const ok = await request(app, 'PUT', `${BASE}/tpl-1`, { body: { name: 'renamed', isActive: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'renamed');
  assert.equal(ok.body.isActive, false);

  const missing = await request(app, 'PUT', `${BASE}/missing`, { body: { name: 'x' } });
  assert.equal(missing.status, 404);
});

test('DELETE /workspace-templates/:id: deletes 200, in-use 400, missing 404', async () => {
  const ok = await request(app, 'DELETE', `${BASE}/tpl-1`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { deleted: true });

  const inUse = await request(app, 'DELETE', `${BASE}/inuse`);
  assert.equal(inUse.status, 400);
  assert.match(String(inUse.body.error), /in use/i);

  const missing = await request(app, 'DELETE', `${BASE}/missing`);
  assert.equal(missing.status, 404);
});

test('workspaceTemplateRoutes: missing projectId -> 400', async () => {
  const noProjectApp = buildApp({
    basePath: '/workspace-templates',
    router: loadFresh('routes/workspaceTemplateRoutes').default,
  });
  assert.equal((await request(noProjectApp, 'GET', '/workspace-templates')).status, 400);
  assert.equal(
    (await request(noProjectApp, 'POST', '/workspace-templates', { body: { name: 'x', type: 'custom' } })).status,
    400,
  );
});
