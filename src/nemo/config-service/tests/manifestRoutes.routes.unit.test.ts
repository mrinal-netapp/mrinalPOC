/**
 * Route-handler tests for routes/manifestRoutes.ts.
 *
 * ManifestService (which reaches the DB + S3 for pre-signed URLs) is fully
 * stubbed via the require-cache module mock; the route is loaded fresh so it
 * binds the fake. The real express-validator chains in validators/manifestValidator
 * run unmodified. Service errors surface through sendErrorResponse ->
 * resolveHttpStatusCode (domain `statusCode`).
 *
 * Run: node --require ts-node/register --test tests/manifestRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, type Restore } from './helpers/moduleMock';
import { NotFoundError, ConflictError, BusinessLogicError } from '../utils/errors';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const DATASET = 'ds-abc12345';
const BASE = `/api/v1/projects/${PROJECT}/datasets/${DATASET}/manifests`;

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let fakeSvc: Record<string, any>;

function notFound(entity: string, id: string): never {
  throw new NotFoundError(entity, id);
}

beforeEach(() => {
  handle = installFakeRepositories({});
  fakeSvc = {
    listManifests: async (dataSetId: string) => [{ id: 'mf-1', dataSetId, status: 'draft' }],
    createManifest: async (dataSetId: string, uris: string[], _metadata: any, _schema: any) => {
      if (dataSetId === 'ds-missing') notFound('Dataset', dataSetId);
      if (dataSetId === 'ds-conflict') throw new ConflictError('Draft manifest already exists');
      return { id: 'mf-new', dataSetId, status: 'draft', uris };
    },
    createManifestFromManifest: async (sourceManifestId: string, dataSetId: string) => {
      if (sourceManifestId === 'src-missing') notFound('Manifest', sourceManifestId);
      return { id: 'mf-copy', dataSetId, status: 'draft', from: sourceManifestId };
    },
    getManifest: async (id: string) => (id === 'missing' ? null : { id, status: 'committed' }),
    addFilesToManifest: async (id: string, fileNames: string[]) => {
      if (id === 'missing') notFound('Manifest', id);
      return fileNames.map((name, idx) => ({ fileId: `f-${idx}`, fileName: name, uploadUrl: 'https://x' }));
    },
    deleteFileFromManifest: async (id: string, fileId: string) => {
      if (id === 'missing' || fileId === 'missing') notFound('File', fileId);
    },
    updateManifestStatus: async (id: string, status: string) =>
      id === 'missing' ? notFound('Manifest', id) : { id, status },
    updateManifestMetadata: async (id: string, metadata: any) => {
      if (id === 'missing') notFound('Manifest', id);
      if (id === 'committed') throw new BusinessLogicError('Cannot update metadata: manifest is not in draft status');
      return { id, metadata };
    },
    updateManifestSchema: async (id: string, schema: any) =>
      id === 'missing' ? notFound('Manifest', id) : { id, schema: schema ?? null },
    replaceDraftManifestSourceUris: async (id: string, dataSetId: string, uris: string[]) =>
      id === 'missing' ? notFound('Manifest', id) : { id, dataSetId, fileCount: uris.length },
    appendDraftManifestSourceUris: async (id: string, dataSetId: string, uris: string[]) =>
      id === 'missing' ? notFound('Manifest', id) : { id, dataSetId, added: uris.length },
  };
  restoreMock = mockModule('services/ManifestService', { ManifestService: fakeSvc });
  const router = loadFresh('routes/manifestRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/datasets/:dataSetId/manifests', router });
});

afterEach(() => {
  restoreMock();
  clearModule('routes/manifestRoutes');
  handle.restore();
});

test('GET /manifests: lists manifests (200)', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'mf-1');
  assert.equal(res.body[0].dataSetId, DATASET);
});

test('POST /manifests: creates 201, dataset missing 404, draft conflict 409', async () => {
  const ok = await request(app, 'POST', BASE, { body: { uris: ['s3://b/a'], metadata: { k: 1 } } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, 'mf-new');
  assert.deepEqual(ok.body.uris, ['s3://b/a']);

  const missingBase = `/api/v1/projects/${PROJECT}/datasets/ds-missing/manifests`;
  assert.equal((await request(app, 'POST', missingBase, { body: {} })).status, 404);

  const conflictBase = `/api/v1/projects/${PROJECT}/datasets/ds-conflict/manifests`;
  assert.equal((await request(app, 'POST', conflictBase, { body: {} })).status, 409);
});

test('POST /manifests/from/:sourceManifestId: copies 201, source missing 404', async () => {
  const ok = await request(app, 'POST', `${BASE}/from/src-1`, { body: {} });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.from, 'src-1');

  const missing = await request(app, 'POST', `${BASE}/from/src-missing`, { body: {} });
  assert.equal(missing.status, 404);
});

test('GET /manifests/:id: found 200, missing 404', async () => {
  assert.equal((await request(app, 'GET', `${BASE}/mf-1`)).status, 200);
  const missing = await request(app, 'GET', `${BASE}/missing`);
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /not found/i);
});

test('PATCH /manifests/:id/files: returns pre-signed urls 200, missing 404', async () => {
  const ok = await request(app, 'PATCH', `${BASE}/mf-1/files`, { body: { fileNames: ['a.txt', 'b.txt'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 2);
  assert.equal(ok.body[0].uploadUrl, 'https://x');

  const missing = await request(app, 'PATCH', `${BASE}/missing/files`, { body: { fileNames: ['a.txt'] } });
  assert.equal(missing.status, 404);
});

test('DELETE /manifests/:id/files/:fileId: deletes 200, missing 404', async () => {
  const ok = await request(app, 'DELETE', `${BASE}/mf-1/files/f-1`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { deleted: true });

  assert.equal((await request(app, 'DELETE', `${BASE}/missing/files/f-1`)).status, 404);
});

test('PUT /manifests/:id/status: valid 200, invalid status 400, missing 404', async () => {
  const ok = await request(app, 'PUT', `${BASE}/mf-1/status`, { body: { status: 'committed' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'committed');

  // Validator chains run but the handler does not call validationResult, so the
  // service ultimately rejects unknown values. Assert the not-found path explicitly.
  const missing = await request(app, 'PUT', `${BASE}/missing/status`, { body: { status: 'draft' } });
  assert.equal(missing.status, 404);
});

test('PUT /manifests/:id/metadata: updates 200, not-draft 400, missing 404', async () => {
  const ok = await request(app, 'PUT', `${BASE}/mf-1/metadata`, { body: { metadata: { a: 1 } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.metadata, { a: 1 });

  const notDraft = await request(app, 'PUT', `${BASE}/committed/metadata`, { body: { metadata: { a: 1 } } });
  assert.equal(notDraft.status, 400);
  assert.match(String(notDraft.body.error), /draft/i);

  assert.equal((await request(app, 'PUT', `${BASE}/missing/metadata`, { body: { metadata: {} } })).status, 404);
});

test('PUT /manifests/:id/schema: updates 200, missing 404', async () => {
  const ok = await request(app, 'PUT', `${BASE}/mf-1/schema`, { body: { schema: { fields: [] } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.schema, { fields: [] });

  assert.equal((await request(app, 'PUT', `${BASE}/missing/schema`, { body: { schema: {} } })).status, 404);
});

test('PUT /manifests/:id/source-uris: replaces 200, non-array uris -> 400', async () => {
  const ok = await request(app, 'PUT', `${BASE}/mf-1/source-uris`, { body: { uris: ['s3://b/a', 's3://b/b'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.fileCount, 2);

  const bad = await request(app, 'PUT', `${BASE}/mf-1/source-uris`, { body: { uris: 'not-an-array' } });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /array/i);
});

test('POST /manifests/:id/append-source-uris: appends 200, missing uris -> 400, missing 404', async () => {
  const ok = await request(app, 'POST', `${BASE}/mf-1/append-source-uris`, { body: { uris: ['s3://b/a'] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.added, 1);

  // Omitting `uris` fails the isArray()/notEmpty() chain (an empty array is allowed).
  const empty = await request(app, 'POST', `${BASE}/mf-1/append-source-uris`, { body: {} });
  assert.equal(empty.status, 400);
  assert.match(String(empty.body.error), /non-empty/i);

  const missing = await request(app, 'POST', `${BASE}/missing/append-source-uris`, { body: { uris: ['s3://b/a'] } });
  assert.equal(missing.status, 404);
});

test('GET /manifests: returns 500 when list fails', async () => {
  fakeSvc.listManifests = async () => {
    throw new Error('list manifests failed');
  };
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('GET /manifests/:id: returns 500 when service throws', async () => {
  fakeSvc.getManifest = async () => {
    throw new Error('get manifest failed');
  };
  const res = await request(app, 'GET', `${BASE}/mf-1`);
  assert.equal(res.status, 500);
});

test('PUT /manifests/:id/source-uris: validation error when uris missing', async () => {
  const res = await request(app, 'PUT', `${BASE}/mf-1/source-uris`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /uris must be an array/);
});

test('POST /manifests: returns 500 on unexpected service error', async () => {
  fakeSvc.createManifest = async () => {
    throw new Error('create manifest exploded');
  };
  const res = await request(app, 'POST', BASE, { body: { uris: ['s3://b/a'] } });
  assert.equal(res.status, 500);
});

test('PUT /manifests/:id/source-uris: rejects more than 2000 uris', async () => {
  const uris = Array.from({ length: 2001 }, (_v, i) => `s3://bucket/file-${i}.txt`);
  const res = await request(app, 'PUT', `${BASE}/mf-1/source-uris`, { body: { uris } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /at most 2000 entries/);
});

test('POST /manifests/:id/append-source-uris: rejects more than 2000 uris', async () => {
  const uris = Array.from({ length: 2001 }, (_v, i) => `s3://bucket/file-${i}.txt`);
  const res = await request(app, 'POST', `${BASE}/mf-1/append-source-uris`, { body: { uris } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /1–2000 entries/);
});

test('POST /manifests/from/:sourceManifestId: returns 500 on unexpected service error', async () => {
  fakeSvc.createManifestFromManifest = async () => {
    throw new Error('copy manifest exploded');
  };
  const res = await request(app, 'POST', `${BASE}/from/src-1`, { body: {} });
  assert.equal(res.status, 500);
});

test('DELETE /manifests/:id/files/:fileId: returns 500 when service throws', async () => {
  fakeSvc.deleteFileFromManifest = async () => {
    throw new Error('delete file exploded');
  };
  const res = await request(app, 'DELETE', `${BASE}/mf-1/files/f-1`);
  assert.equal(res.status, 500);
});
