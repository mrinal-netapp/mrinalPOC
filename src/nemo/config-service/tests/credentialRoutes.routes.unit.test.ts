/**
 * Route-handler tests for routes/credentialRoutes.ts.
 *
 * The CredentialService (which reaches Kubernetes) is stubbed via the
 * require-cache module mock; the route is loaded fresh so it binds the fake.
 *
 * Run: node --require ts-node/register --test tests/credentialRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, type Restore } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/credentials`;

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let fakeSvc: Record<string, any>;

beforeEach(() => {
  handle = installFakeRepositories({});
  fakeSvc = {
    create: async (i: any) => ({ id: 'cred-1', ...i }),
    list: async () => [{ id: 'cred-1', name: 'c', provider: 'openai' }],
    getById: async (_p: string, id: string) => (id === 'missing' ? null : { id, name: 'c', provider: 'openai' }),
    update: async (_p: string, id: string) => (id === 'missing' ? null : { id, name: 'updated' }),
    delete: async (_p: string, id: string) => id !== 'missing',
    readSecretData: async (_p: string, id: string) => (id === 'missing' ? null : { api_key: 'sk' }),
    validate: async () => ({ valid: true }),
    rotateSecret: async (_p: string, id: string) => (id === 'missing' ? null : { id, rotationVersion: 2 }),
  };
  restoreMock = mockModule('services/CredentialService', { getCredentialService: () => fakeSvc });
  const router = loadFresh('routes/credentialRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/credentials', router });
});

afterEach(() => {
  restoreMock();
  clearModule('routes/credentialRoutes');
  handle.restore();
});

test('POST /credentials: valid create returns 201 without secret', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'cred', provider: 'openai', secretData: { api_key: 'sk' } },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'cred-1');
  assert.equal(res.body.secretData, undefined);
});

test('POST /credentials: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'c' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('GET /credentials: list with dependentsSummary', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.ok(res.body[0].dependentsSummary);
});

test('GET /credentials/:id: found and not found', async () => {
  assert.equal((await request(app, 'GET', `${BASE}/cred-1`)).status, 200);
  assert.equal((await request(app, 'GET', `${BASE}/missing`)).status, 404);
});

test('PATCH /credentials/:id: update + not found', async () => {
  assert.equal((await request(app, 'PATCH', `${BASE}/cred-1`, { body: { name: 'new' } })).status, 200);
  assert.equal((await request(app, 'PATCH', `${BASE}/missing`, { body: { name: 'new' } })).status, 404);
});

test('DELETE /credentials/:id: 204, dependents 409, not found 404', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/cred-1`)).status, 204);

  assert.equal((await request(app, 'DELETE', `${BASE}/missing`)).status, 404);

  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  const blocked = await request(app, 'DELETE', `${BASE}/cred-1`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'HAS_DEPENDENTS');
});

test('GET /credentials/:id/dependents: page + not found', async () => {
  assert.equal((await request(app, 'GET', `${BASE}/cred-1/dependents`)).status, 200);
  assert.equal((await request(app, 'GET', `${BASE}/missing/dependents`)).status, 404);
});

test('GET /credentials/:id/dependents: name lookup casts uuid ids to text (AIAS-1413)', async () => {
  // Drive listDependents so resolveNames issues its entity name-lookup query.
  // A model dependent (models.id is uuid) is the exact case that used to fail
  // with "operator does not exist: uuid = text" during credential delete.
  handle.query.mock.mockImplementation(async (sql: string) => {
    if (/COUNT\(\*\)/.test(sql)) return [{ sourceType: 'model', n: '1' }];
    if (/FROM reference_edges/.test(sql)) {
      return [{ sourceType: 'model', sourceId: 'm1', relation: 'uses_credential' }];
    }
    return [{ id: 'm1', name: 'My Model' }];
  });

  const res = await request(app, 'GET', `${BASE}/cred-1/dependents`);
  assert.equal(res.status, 200);

  const sqls = handle.query.mock.calls.map((c: any) => String(c.arguments[0]));
  const nameLookup = sqls.find((s: string) => /FROM models/.test(s));
  assert.ok(nameLookup, 'expected a name-lookup query against the models table');
  assert.match(nameLookup, /::text = ANY/);
});

test('POST /credentials/:id/secret-data: returns secret or 404', async () => {
  const ok = await request(app, 'POST', `${BASE}/cred-1/secret-data`, { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.api_key, 'sk');
  assert.equal((await request(app, 'POST', `${BASE}/missing/secret-data`, { body: {} })).status, 404);
});

test('POST /credentials/:id/validate: returns provider validation', async () => {
  const res = await request(app, 'POST', `${BASE}/cred-1/validate`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
});

test('POST /credentials/:id/rotate: rotates + validation + not found', async () => {
  assert.equal((await request(app, 'POST', `${BASE}/cred-1/rotate`, { body: { secretData: { api_key: 'x' } } })).status, 200);
  assert.equal((await request(app, 'POST', `${BASE}/cred-1/rotate`, { body: {} })).status, 400);
  assert.equal(
    (await request(app, 'POST', `${BASE}/missing/rotate`, { body: { secretData: { api_key: 'x' } } })).status,
    404,
  );
});

test('POST /credentials/validate: draft validation + validation errors', async () => {
  fakeSvc.validateDraft = async () => ({ valid: false, message: 'bad key' });
  const ok = await request(app, 'POST', `${BASE}/validate`, {
    body: { provider: 'openai', secretData: { api_key: 'x' } },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.valid, false);

  assert.equal((await request(app, 'POST', `${BASE}/validate`, { body: {} })).status, 400);
  assert.equal(
    (await request(app, 'POST', `${BASE}/validate`, { body: { provider: 'openai' } })).status,
    400,
  );
});

test('GET /credentials/:id/dependents: returns 500 when lookup fails', async () => {
  handle.query.mock.mockImplementation(async () => {
    throw new Error('credential dependents failed');
  });
  const res = await request(app, 'GET', `${BASE}/cred-1/dependents`);
  assert.equal(res.status, 500);
});

test('POST /credentials/:id/secret-data: returns 500 when service throws', async () => {
  fakeSvc.readSecretData = async () => {
    throw new Error('secret read failed');
  };
  const res = await request(app, 'POST', `${BASE}/cred-1/secret-data`, { body: {} });
  assert.equal(res.status, 500);
});

test('POST /credentials/:id/validate: returns 500 when service throws', async () => {
  fakeSvc.validate = async () => {
    throw new Error('validate failed');
  };
  const res = await request(app, 'POST', `${BASE}/cred-1/validate`, { body: {} });
  assert.equal(res.status, 500);
});

test('POST /credentials: returns 500 when create throws', async () => {
  fakeSvc.create = async () => {
    throw new Error('create failed');
  };
  const res = await request(app, 'POST', BASE, {
    body: { name: 'cred', provider: 'openai', secretData: { api_key: 'sk' } },
  });
  assert.equal(res.status, 500);
});

test('GET /credentials: returns 500 when list throws', async () => {
  fakeSvc.list = async () => {
    throw new Error('list failed');
  };
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('GET /credentials/:id: returns 500 when lookup throws', async () => {
  fakeSvc.getById = async () => {
    throw new Error('get failed');
  };
  const res = await request(app, 'GET', `${BASE}/cred-1`);
  assert.equal(res.status, 500);
});

test('PATCH /credentials/:id: validation error returns 400', async () => {
  const res = await request(app, 'PATCH', `${BASE}/cred-1`, { body: { expiresAt: 'not-a-date' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('PATCH /credentials/:id: returns 500 when update throws', async () => {
  fakeSvc.update = async () => {
    throw new Error('update failed');
  };
  const res = await request(app, 'PATCH', `${BASE}/cred-1`, { body: { name: 'new-name' } });
  assert.equal(res.status, 500);
});

test('DELETE /credentials/:id: returns 500 when delete throws', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  fakeSvc.delete = async () => {
    throw new Error('delete failed');
  };
  const res = await request(app, 'DELETE', `${BASE}/cred-1`);
  assert.equal(res.status, 500);
});

test('GET /credentials/:id/dependents: 404 when credential missing', async () => {
  const res = await request(app, 'GET', `${BASE}/missing/dependents`);
  assert.equal(res.status, 404);
});

test('POST /credentials/validate: returns 500 when draft validation throws', async () => {
  fakeSvc.validateDraft = async () => {
    throw new Error('draft validate failed');
  };
  const res = await request(app, 'POST', `${BASE}/validate`, {
    body: { provider: 'openai', secretData: { api_key: 'x' } },
  });
  assert.equal(res.status, 500);
});

test('POST /credentials/:id/rotate: returns 400 when rotate throws', async () => {
  fakeSvc.rotateSecret = async () => {
    throw new Error('rotate failed');
  };
  const res = await request(app, 'POST', `${BASE}/cred-1/rotate`, {
    body: { secretData: { api_key: 'new' } },
  });
  assert.equal(res.status, 400);
});

test('GET /credentials: omits dependentsSummary when include=false', async () => {
  const res = await request(app, 'GET', `${BASE}?include=dependentsSummary=false`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].dependentsSummary, undefined);
});

test('GET /credentials: passes provider and labels filters to service', async () => {
  let listed: any = null;
  fakeSvc.list = async (opts: any) => {
    listed = opts;
    return [{ id: 'cred-1', name: 'c', provider: 'openai' }];
  };
  const res = await request(app, 'GET', `${BASE}?provider=openai&labels=prod,gold`);
  assert.equal(res.status, 200);
  assert.equal(listed.provider, 'openai');
  assert.deepEqual(listed.labels, ['prod', 'gold']);
});
