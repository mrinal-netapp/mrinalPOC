/**
 * Route-handler tests for routes/knowledgeBaseRoutes.ts.
 *
 * axios (workflow-engine calls) is stubbed via mock.method. The workflow-engine
 * HTTP client in KnowledgeBaseWorkflowService is created at module load via
 * axios.create, so axios.create must be stubbed before loadFresh(). The Temporal
 * schedule client wrapper is module-mocked. FacetService + ReferenceEdgeService
 * run real against the fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/knowledgeBaseRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { QueryFailedError } from 'typeorm';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request, withUser } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, type Restore } from './helpers/moduleMock';
import { baseKnowledgeBaseCreate } from './helpers/knowledgeBaseFixtures';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/knowledgebases`;
const PROJECT_ROW = { id: PROJECT, home_dir: 's3://default-nemo/projects/projtest0001' };

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let wfClient: {
  post: (...args: any[]) => Promise<any>;
  delete: (...args: any[]) => Promise<any>;
  get: (...args: any[]) => Promise<any>;
  interceptors: { request: { use: () => undefined }; response: { use: () => undefined } };
};

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => PROJECT_ROW }),
    DataSet: makeFakeRepo({ findOne: async () => ({ id: 'ds-abc12345', status: 'ready', kind: 'unstructured' }) }),
    Model: makeFakeRepo({
      findOne: async () => ({
        id: 'mdl-default',
        name: 'sentence-transformers/all-MiniLM-L6-v2',
        provider: 'huggingface',
        providerModelId: 'sentence-transformers/all-MiniLM-L6-v2',
        modelType: 'embedding',
        model_info: { dimensions: 384 },
      }),
    }),
    Facet: makeFakeRepo({ find: async () => [] }),
  });

  // KnowledgeBaseWorkflowService binds workflowEngineClient at module load.
  wfClient = {
    post: async () => ({ data: { workflowId: 'wf-put' } }),
    delete: async () => ({ data: {} }),
    get: async () => ({ data: {} }),
    interceptors: { request: { use: () => undefined }, response: { use: () => undefined } },
  };
  mock.method(axios, 'create', () => wfClient);
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'post', async () => ({ status: 200, data: { workflowId: 'wf-1' } }));
  mock.method(axios, 'delete', async () => ({ status: 200, data: { workflowId: 'wf-del' } }));

  restoreMock = mockModule('services/KnowledgeBaseScheduleService', {
    KnowledgeBaseScheduleService: {
      applySynchronizationConfig: async () => undefined,
      tearDownSchedule: async () => undefined,
    },
  });
  clearModule('services/KnowledgeBaseWorkflowService');
  const router = loadFresh('routes/knowledgeBaseRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router });
});

afterEach(() => {
  mock.restoreAll();
  restoreMock();
  clearModule('routes/knowledgeBaseRoutes');
  clearModule('services/KnowledgeBaseWorkflowService');
  handle.restore();
});

function seedKb(overrides: Record<string, any>) {
  handle.repos.KnowledgeBase = makeFakeRepo(overrides);
}

test('POST /knowledgebases: creates KB and triggers workflow (201)', async () => {
  const created = { id: 'kb0000001', name: 'product-docs-kb', sourceDataset: 'ds-abc12345' };
  seedKb({
    // dup-check queries by name -> null; later reads (by id) -> the created KB
    findOne: async (q: any) => (q?.where?.name ? null : { ...created, status: 'in_progress' }),
    create: (d: any) => ({ ...created, ...d }),
    save: async (e: any) => ({ ...created, ...e }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
});

test('POST /knowledgebases: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'x' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /knowledgebases: duplicate name is surfaced as an error', async () => {
  // The POST handler wraps the ConflictError in its outer catch -> 500.
  seedKb({ findOne: async () => ({ id: 'kb0000001', name: 'product-docs-kb' }) });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /already exists/);
});

test('POST /knowledgebases: dataset not ready returns 201 with warning', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => ({ id: 'ds-abc12345', status: 'pending' }) });
  seedKb({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'kb0000002' }),
    save: async (e: any) => ({ ...e, id: 'kb0000002' }),
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  assert.match(String(res.body.warning), /not started/);
});

test('POST /knowledgebases: structured dataset without textColumns returns 201 with warning, no workflow call', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => ({ id: 'ds-abc12345', status: 'ready', kind: 'structured' }) });
  seedKb({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'kb0000003' }),
    save: async (e: any) => ({ ...e, id: 'kb0000003' }),
  });
  const postSpy = mock.method(axios, 'post', async () => ({ status: 200, data: { workflowId: 'wf-1' } }));
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  assert.match(String(res.body.warning), /textColumns is required/);
  assert.equal(postSpy.mock.callCount(), 0);
});

test('POST /knowledgebases: structured dataset with textColumns creates KB and triggers workflow', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => ({ id: 'ds-abc12345', status: 'ready', kind: 'structured' }) });
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000004', textColumns: 'title, content', status: 'in_progress' }),
    create: (d: any) => ({ id: 'kb0000004', ...d }),
    save: async (e: any) => ({ id: 'kb0000004', ...e }),
  });
  let posted: any = null;
  const postSpy = mock.method(axios, 'post', async (_url: string, body: any) => {
    posted = body;
    return { status: 200, data: { workflowId: 'wf-1' } };
  });
  const res = await request(app, 'POST', BASE, {
    body: baseKnowledgeBaseCreate({ textColumns: 'title, content' }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.warning, undefined);
  assert.equal(postSpy.mock.callCount(), 1);
  assert.equal(posted?.textColumns, 'title, content');
  assert.equal(posted?.datasetKind, 'structured');
});

test('GET /knowledgebases: list with facets + summary', async () => {
  seedKb({ find: async () => [{ id: 'kb0000001', name: 'k', status: 'ready' }] });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'kb0000001');
  assert.ok('facets' in res.body[0]);
});

test('GET /knowledgebases/:id: found / not found', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'ready' }) });
  assert.equal((await request(app, 'GET', `${BASE}/kb0000001`)).status, 200);
  seedKb({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/kbmissing0`)).status, 404);
});

test('PUT /knowledgebases/:id: update 200, conflict 409, not found 404', async () => {
  let row: any = { id: 'kb0000001', name: 'Old', projectId: PROJECT };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null; // Not(id) name check
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  assert.equal((await request(app, 'PUT', `${BASE}/kb0000001`, { body: { description: 'd' } })).status, 200);

  handle.repos.KnowledgeBase = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'PUT', `${BASE}/kbmissing0`, { body: { description: 'd' } })).status, 404);
});

test('PUT /knowledgebases/:id: changed processing settings trigger reprocess workflow', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.workflowId, 'wf-put');
  assert.equal(res.body.workflowStatus, 'running');
  assert.equal(row.chunkSize, 300);
});

test('PUT /knowledgebases/:id: embeddingModelId-only override sends resolved model name to workflow', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    embeddingModelId: '22222222-2222-4222-8222-222222222222',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  handle.repos.Model = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.id === '11111111-1111-4111-8111-111111111111') {
        return {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'text-embedding-3-small',
          provider: 'openai',
          providerModelId: 'text-embedding-3-small',
          gatewayModelId: 'openai/text-embedding-3-small',
          modelType: 'embedding',
          model_info: { dimensions: 1536 },
        };
      }
      return null;
    },
  });

  let posted: any = null;
  const originalPost = wfClient.post;
  wfClient.post = async (_url: string, body: any) => {
    posted = body;
    return { data: { workflowId: 'wf-put' } };
  };
  try {
    const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
      body: { embeddingModelId: '11111111-1111-4111-8111-111111111111' },
    });
    assert.equal(res.status, 200);
    assert.equal(posted?.embeddingModelId, '11111111-1111-4111-8111-111111111111');
    assert.equal(posted?.embeddingModel, 'text-embedding-3-small');
    assert.notEqual(posted?.embeddingModel, row.embeddingModel);
  } finally {
    wfClient.post = originalPost;
  }
});

test('PUT /knowledgebases/:id: invalid embedding override returns 400 without starting workflow', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    description: 'old-desc',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  let posted = false;
  let metadataUpdates = 0;
  const originalPost = wfClient.post;
  wfClient.post = async () => {
    posted = true;
    return { data: { workflowId: 'wf-should-not-run' } };
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      if (data.description !== undefined) metadataUpdates += 1;
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  handle.repos.Model = makeFakeRepo({
    findOne: async () => null,
  });
  try {
    const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
      body: {
        description: 'new-desc',
        embeddingModelId: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'EMBEDDING_MODEL_NOT_FOUND');
    assert.equal(posted, false);
    assert.equal(row.description, 'old-desc');
    assert.equal(metadataUpdates, 0);
  } finally {
    wfClient.post = originalPost;
  }
});

test('PUT /knowledgebases/:id: processing change while in_progress returns 409', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'in_progress',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'KB_IN_PROGRESS');
  assert.equal(row.chunkSize, 300);
  assert.equal(row.status, 'in_progress');
});

test('PUT /knowledgebases/:id: stale ready KB blocked when DB is in_progress at workflow trigger', async () => {
  let reads = 0;
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      reads += 1;
      // Route reads see ready; service re-read from DB sees in_progress.
      if (reads >= 3) return { ...row, status: 'in_progress' };
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });

  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'KB_IN_PROGRESS');
  assert.equal(row.status, 'ready');
});

test('PUT /knowledgebases/:id: reprocess 409 does not persist metadata', async () => {
  let reads = 0;
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    description: 'old-desc',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  let metadataUpdates = 0;
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      reads += 1;
      if (reads >= 3) return { ...row, status: 'in_progress' };
      return row;
    },
    update: async (_w: any, data: any) => {
      if (data.description !== undefined) metadataUpdates += 1;
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });

  const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
    body: { description: 'new-desc', chunkSize: 400 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'KB_IN_PROGRESS');
  assert.equal(row.description, 'old-desc');
  assert.equal(metadataUpdates, 0);
});

test('PUT /knowledgebases/:id: concurrent claim failure returns 409 without starting workflow', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  let posted = false;
  const originalPost = wfClient.post;
  wfClient.post = async () => {
    posted = true;
    return { data: { workflowId: 'wf-should-not-run' } };
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (where: any, data: any) => {
      if (where.status?._type === 'not') {
        return { affected: 0 };
      }
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  try {
    const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'KB_IN_PROGRESS');
    assert.equal(posted, false);
    assert.equal(row.status, 'ready');
  } finally {
    wfClient.post = originalPost;
  }
});

test('PUT /knowledgebases/:id: workflow trigger failure persists metadata and returns warning', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    description: 'old-desc',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  const originalPost = wfClient.post;
  wfClient.post = async () => {
    throw new Error('workflow engine unavailable');
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  try {
    const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
      body: { description: 'new-desc', chunkSize: 400 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.warning, 'Knowledge base updated but reprocessing workflow failed to start');
    assert.equal(res.body.workflowError, 'workflow engine unavailable');
    assert.equal(row.description, 'new-desc');
    assert.equal(row.chunkSize, 300);
  } finally {
    wfClient.post = originalPost;
  }
});

test('PUT /knowledgebases/:id: metadata persistence failure after workflow start is not masked as workflow error', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    description: 'old-desc',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  let metadataUpdates = 0;
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      if (data.description !== undefined) {
        metadataUpdates += 1;
        throw new Error('metadata persistence failed');
      }
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });

  const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
    body: { description: 'new-desc', chunkSize: 400 },
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'metadata persistence failed');
  assert.equal(res.body.warning, undefined);
  assert.equal(res.body.workflowError, undefined);
  assert.equal(metadataUpdates, 1);
  assert.equal(row.description, 'old-desc');
});

test('PUT /knowledgebases/:id: processing change with dataset not ready returns warning', async () => {
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({ id: 'ds-abc12345', status: 'in_progress', kind: 'unstructured' }),
  });
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.workflowSkippedReason, 'dataset_not_ready');
  assert.match(String(res.body.warning), /not started/);
  assert.equal(res.body.workflowId, undefined);
  assert.equal(row.chunkSize, 300);
});

test('PUT /knowledgebases/:id: processing change with missing dataset returns warning', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-missing',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.workflowSkippedReason, 'dataset_not_found');
  assert.match(String(res.body.warning), /not found/);
  assert.equal(res.body.workflowId, undefined);
});

test('PUT /knowledgebases/:id: workflow status update persists ready', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'in_progress',
    jobId: 'facet-knowledge_base-kb0000001-embedding',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });

  const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
    body: {
      status: 'ready',
      lanceTablePath: '/mnt/pvcs/default-nemo/projects/p/knowledgebases/kb0000001/lancedb-run-abc',
      stats: { documentCount: 1, chunkCount: 1, vectorCount: 1 },
      lastSyncedAt: '2026-07-13T13:01:35Z',
      chunkSize: 512,
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready');
  assert.equal(row.status, 'ready');
  assert.equal(row.lanceTablePath, '/mnt/pvcs/default-nemo/projects/p/knowledgebases/kb0000001/lancedb-run-abc');
  assert.equal(row.chunkSize, 512);
  assert.equal(res.body.workflowId, undefined);
});

test('PUT /knowledgebases/:id: user JWT cannot set workflow status fields', async () => {
  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'in_progress',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });

  const userApp = buildApp({
    basePath: '/api/v1/projects/:projectId/knowledgebases',
    router: loadFresh('routes/knowledgeBaseRoutes').default,
    pre: [withUser({ sub: 'user-1', email: 'alice@example.com' })],
  });

  const res = await request(userApp, 'PUT', `${BASE}/kb0000001`, {
    body: {
      status: 'ready',
      stats: { documentCount: 99, chunkCount: 99, vectorCount: 99 },
      chunkSize: 512,
    },
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'WORKFLOW_FIELDS_FORBIDDEN');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.chunkSize, 300);
});

test('PUT /knowledgebases/:id: missing workflowId does not mark KB in_progress', async () => {
  const originalPost = wfClient.post;
  wfClient.post = async () => ({ data: {} });

  let row: any = {
    id: 'kb0000001',
    name: 'k',
    projectId: PROJECT,
    status: 'ready',
    sourceDataset: 'ds-abc12345',
    chunkSize: 300,
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
  };
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return row;
    },
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  try {
    const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 400 } });
    assert.equal(res.status, 200);
    assert.match(String(res.body.warning), /failed to start/);
    assert.equal(res.body.workflowId, undefined);
    assert.equal(row.status, 'ready');
    assert.equal(row.jobId, undefined);
  } finally {
    wfClient.post = originalPost;
  }
});

test('DELETE /knowledgebases/:id: 200, not found 404, dependents 409', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', scheduleConfig: undefined }), delete: async () => ({ affected: 1 }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const ok = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(ok.status, 200);

  seedKb({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/kbmissing0`)).status, 404);

  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  assert.equal((await request(app, 'DELETE', `${BASE}/kb0000001`)).status, 409);
});

test('GET /knowledgebases/:id/history + restore-version', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }), update: async () => ({ affected: 1 }) });
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({ find: async () => [{ version: 1 }] });
  assert.equal((await request(app, 'GET', `${BASE}/kb0000001/history`)).status, 200);

  assert.equal((await request(app, 'POST', `${BASE}/kb0000001/restore-version`, { body: {} })).status, 400);
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({ findOne: async () => ({ version: 1, data: { id: 'kb0000001', name: 'X' } }) });
  assert.equal((await request(app, 'POST', `${BASE}/kb0000001/restore-version`, { body: { version: 1 } })).status, 200);
});

test('POST /knowledgebases/:id/create: triggers workflow (202)', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', name: 'k', sourceDataset: 'ds-abc12345' }), update: async () => ({ affected: 1 }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'running');
});

test('POST /knowledgebases/:id/create: non-string embeddingModel override does not 500', async () => {
  // A malformed override must not reach the TypeORM name lookup; the handler
  // falls back to the persisted KB value and still dispatches (202).
  seedKb({
    findOne: async () => ({ id: 'kb0000001', name: 'k', sourceDataset: 'ds-abc12345', embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: { embeddingModel: { bad: true } } });
  assert.equal(res.status, 202);
});

test('POST /knowledgebases/:id/create: empty embeddingModel override falls back to KB value', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      name: 'k',
      sourceDataset: 'ds-abc12345',
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    }),
    update: async () => ({ affected: 1 }),
  });
  let posted: any = null;
  mock.restoreAll();
  mock.method(axios, 'create', () => ({
    post: async (_url: string, body: any) => {
      posted = body;
      return { data: { workflowId: 'wf-1' } };
    },
    delete: async () => ({ data: {} }),
    get: async () => ({ data: {} }),
    interceptors: { request: { use: () => undefined }, response: { use: () => undefined } },
  }));
  mock.method(axios, 'post', async (_url: string, body: any) => {
    posted = body;
    return { status: 200, data: { workflowId: 'wf-1' } };
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: { embeddingModel: '   ' } });
  assert.equal(res.status, 202);
  assert.equal(posted?.embeddingModel, 'sentence-transformers/all-MiniLM-L6-v2');
});

// Regression for "EmbeddingGenerator: api_key is required": the reprocess route
// must forward the project virtual-key token + embedding gateway id so the
// kb-processor activity can authenticate to the gateway.
test('POST /knowledgebases/:id/create: forwards virtual-key token + embedding gateway id', async () => {
  const restoreVk = mockModule('services/bifrost/bifrostProjectGovernance', {
    readProjectVirtualKeyToken: async () => 'vk-test-token',
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  try {
    seedKb({
      findOne: async () => ({
        id: 'kb0000001',
        name: 'k',
        sourceDataset: 'ds-abc12345',
        embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      }),
      update: async () => ({ affected: 1 }),
    });
    handle.repos.Model = makeFakeRepo({
      findOne: async () => ({
        id: 'mdl-remote',
        name: 'sentence-transformers/all-MiniLM-L6-v2',
        provider: 'openai',
        providerModelId: 'text-embedding-3-small',
        gatewayModelId: 'openai/projxxx_text-embedding-3-small',
        modelType: 'embedding',
        model_info: { dimensions: 1536 },
      }),
    });
    let posted: any = null;
    mock.restoreAll();
    mock.method(axios, 'post', async (_url: string, body: any) => {
      posted = body;
      return { status: 200, data: { workflowId: 'wf-1' } };
    });
    const res = await request(freshApp, 'POST', `${BASE}/kb0000001/create`, { body: {} });
    assert.equal(res.status, 202);
    assert.equal(posted?.projectVirtualKeyToken, 'vk-test-token');
    assert.equal(posted?.embeddingGatewayModelId, 'openai/projxxx_text-embedding-3-small');
  } finally {
    restoreVk();
  }
});

test('GET /knowledgebases/:id/versions: proxies workflow-engine', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  mock.restoreAll();
  mock.method(axios, 'get', async () => ({ status: 200, data: { versions: ['v1'] } }));
  const res = await request(app, 'GET', `${BASE}/kb0000001/versions`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.versions, ['v1']);
});

test('GET /knowledgebases/:id/facets + PUT facet state', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({ find: async () => [], findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/kb0000001/facets`)).status, 200);

  const bad = await request(app, 'PUT', `${BASE}/kb0000001/facets/embedding`, { body: { state: 'nope' } });
  assert.equal(bad.status, 400);
});

// ------------------------------- embedding-dimensions resolver (PR1)
test('POST /knowledgebases: model_info.dimensions is preferred over static catalog', async () => {
  const created = { id: 'kb0000001', name: 'product-docs-kb', sourceDataset: 'ds-abc12345' };
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { ...created, status: 'in_progress' }),
    create: (d: any) => ({ ...created, ...d }),
    save: async (e: any) => ({ ...created, ...e }),
    update: async () => ({ affected: 1 }),
  });
  // Persisted Model row with explicit dimensions = 1536 (OpenAI 3-small).
  handle.repos.Model = makeFakeRepo({
    findOne: async () => ({
      id: 'mdl-abc',
      name: 'sentence-transformers/all-MiniLM-L6-v2',
      provider: 'openai',
      providerModelId: 'text-embedding-3-small',
      modelType: 'embedding',
      model_info: { dimensions: 1536 },
    }),
  });
  let postedWorkflow: any = null;
  mock.restoreAll();
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'post', async (_url: string, body: any) => {
    postedWorkflow = body;
    return { status: 200, data: { workflowId: 'wf-1' } };
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  // The workflow input should carry embeddingDimensions=1536 (the persisted
  // value), NOT the static catalog default, NOT the legacy 384.
  assert.equal(postedWorkflow?.embeddingDimensions, 1536);
});

test('POST /knowledgebases: static catalog fills dimensions when model_info is missing', async () => {
  const created = { id: 'kb0000001', name: 'product-docs-kb', sourceDataset: 'ds-abc12345' };
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { ...created, status: 'in_progress' }),
    create: (d: any) => ({ ...created, ...d }),
    save: async (e: any) => ({ ...created, ...e }),
    update: async () => ({ affected: 1 }),
  });
  // Persisted Model row WITHOUT dimensions — pre-backfill state. Catalog
  // must rescue with 3072 for text-embedding-3-large.
  handle.repos.Model = makeFakeRepo({
    findOne: async () => ({
      id: 'mdl-abc',
      name: 'sentence-transformers/all-MiniLM-L6-v2',
      provider: 'openai',
      providerModelId: 'text-embedding-3-large',
      modelType: 'embedding',
      model_info: null,
    }),
  });
  let postedWorkflow: any = null;
  mock.restoreAll();
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'post', async (_url: string, body: any) => {
    postedWorkflow = body;
    return { status: 200, data: { workflowId: 'wf-1' } };
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  assert.equal(postedWorkflow?.embeddingDimensions, 3072, 'static catalog must supply 3072 for text-embedding-3-large');
});

test('POST /knowledgebases: 400 when neither persisted nor static dimensions available', async () => {
  const created = { id: 'kb0000001', name: 'product-docs-kb', sourceDataset: 'ds-abc12345' };
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { ...created }),
    create: (d: any) => ({ ...created, ...d }),
    save: async (e: any) => ({ ...created, ...e }),
  });
  // Persisted Model with no dimensions AND a providerModelId the catalog
  // doesn't know — KB creation must refuse with 400, not silently default
  // to 384 and corrupt the index.
  handle.repos.Model = makeFakeRepo({
    findOne: async () => ({
      id: 'mdl-abc',
      name: 'sentence-transformers/all-MiniLM-L6-v2',
      provider: 'openai_compatible',
      providerModelId: 'totally-made-up-vendor-embed-1',
      modelType: 'embedding',
      model_info: {},
    }),
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 400);
  // The caller turns resolveEmbeddingFields()==null into EMBEDDING_MODEL_NOT_FOUND.
  assert.equal(res.body.code, 'EMBEDDING_MODEL_NOT_FOUND');
});

test('POST /knowledgebases/:id/versions/:versionId/rollback: success updates lance path', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001', status: 'ready' }),
    update: async () => ({ affected: 1 }),
  });
  mock.restoreAll();
  mock.method(axios, 'post', async () => ({
    status: 200,
    data: { rolledBackTo: { lanceTablePath: 's3://bucket/kb/v1' } },
  }));
  const res = await request(app, 'POST', `${BASE}/kb0000001/versions/v1/rollback`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.rolledBackTo.lanceTablePath, 's3://bucket/kb/v1');
});

test('POST /knowledgebases/:id/versions/:versionId/rollback: 409 when KB in progress', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'in_progress' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/versions/v1/rollback`, { body: {} });
  assert.equal(res.status, 409);
});

test('GET /knowledgebases/:id/facets/:facetType: returns facet or 404', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({ facetType: 'embedding', state: 'ready' }),
  });
  const ok = await request(app, 'GET', `${BASE}/kb0000001/facets/embedding`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.facetType, 'embedding');

  handle.repos.Facet = makeFakeRepo({ findOne: async () => null });
  const missing = await request(app, 'GET', `${BASE}/kb0000001/facets/missing`);
  assert.equal(missing.status, 404);
});

test('PUT /knowledgebases/:id/facets/:facetType: updates facet state', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (e: any) => ({ ...e, id: 'facet-1' }),
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001/facets/embedding`, {
    body: { state: 'ready', summary: { chunks: 10 } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
});

test('POST /knowledgebases/:id/facets/:facetType/run: starts embedding workflow', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      name: 'kb',
      status: 'ready',
      sourceDataset: 'ds-abc12345',
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      chunkSize: 512,
      vectorSize: 384,
      dataType: 'text',
    }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => null,
    findOneOrFail: async () => ({
      projectId: PROJECT,
      entityType: 'knowledge_base',
      entityId: 'kb0000001',
      facetType: 'embedding',
      state: 'in_progress',
      jobId: 'wf-embed-1',
    }),
    create: (d: any) => d,
    save: async (e: any) => ({ ...e, id: 'facet-1' }),
    createQueryBuilder: () => ({
      update: () => ({
        set: () => ({
          where: () => ({
            execute: async () => ({ affected: 0 }),
          }),
        }),
      }),
    }),
  });
  mock.restoreAll();
  mock.method(axios, 'post', async () => ({ status: 200, data: { workflowId: 'wf-embed-1' } }));
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.workflowId, 'wf-embed-1');
});

test('POST /knowledgebases/:id/facets/:facetType/run: rejects unknown facet type', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'ready' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/search/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Unknown facet type/);
});

test('POST /knowledgebases/:id/facets/:facetType/run: rejects KB in_progress', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'in_progress' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /currently being processed/);
});

test('POST /knowledgebases/:id/facets/:facetType/run: rejects non-ready KB status', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'pending' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /must be in 'ready' or 'errored'/);
});

test('POST /knowledgebases/:id/facets/:facetType/run: rejects dataset not ready', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      status: 'ready',
      sourceDataset: 'ds-abc12345',
    }),
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({ id: 'ds-abc12345', status: 'processing', kind: 'unstructured' }),
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Source dataset must be in 'ready'/);
});

test('POST /knowledgebases/:id/facets/:facetType/run: returns 500 when workflow dispatch fails', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      name: 'kb',
      status: 'ready',
      sourceDataset: 'ds-abc12345',
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      chunkSize: 512,
      vectorSize: 384,
      dataType: 'text',
    }),
  });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (e: any) => e,
  });
  mock.restoreAll();
  mock.method(axios, 'post', async () => {
    throw new Error('workflow engine unavailable');
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /workflow engine unavailable/);
});

test('PUT /knowledgebases/:id/facets/:facetType: returns 409 on jobId mismatch', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({
      projectId: PROJECT,
      entityType: 'knowledge_base',
      entityId: 'kb0000001',
      facetType: 'embedding',
      state: 'in_progress',
      jobId: 'wf-old',
    }),
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001/facets/embedding`, {
    body: { state: 'ready', jobId: 'wf-new' },
  });
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /jobId mismatch/);
});

test('GET /knowledgebases/:id/dependents: returns page or 404', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  const ok = await request(app, 'GET', `${BASE}/kb0000001/dependents?limit=5`);
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.items));

  seedKb({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/kbmissing0/dependents`)).status, 404);
});

test('POST /knowledgebases/:id/versions/:versionId/rollback: 502 when workflow call fails', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'ready' }) });
  mock.restoreAll();
  mock.method(axios, 'post', async () => {
    throw new Error('workflow unreachable');
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/versions/v1/rollback`, { body: {} });
  assert.equal(res.status, 502);
  assert.match(String(res.body.error), /workflow unreachable/);
});

test('POST /knowledgebases/:id/versions/:versionId/rollback: tolerates DB update failure after success', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001', status: 'ready' }),
    update: async () => {
      throw new Error('db write failed');
    },
  });
  mock.restoreAll();
  mock.method(axios, 'post', async () => ({
    status: 200,
    data: { rolledBackTo: { lanceTablePath: 's3://bucket/kb/v2' } },
  }));
  const res = await request(app, 'POST', `${BASE}/kb0000001/versions/v1/rollback`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.rolledBackTo.lanceTablePath, 's3://bucket/kb/v2');
});

test('GET /knowledgebases/:id/facets: returns 500 when facet listing fails', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    find: async () => {
      throw new Error('facet list failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/facets`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /facet list failed/);
});

test('PUT /knowledgebases/:id/facets/:facetType: returns 500 on unexpected errors', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => {
      throw new Error('facet update failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001/facets/embedding`, {
    body: { state: 'ready' },
  });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /facet update failed/);
});

test('GET /knowledgebases: returns 500 when list fails', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    find: async () => {
      throw new Error('kb list failed');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('PUT /knowledgebases/:id: returns 500 on unexpected update error', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      name: 'kb',
      sourceDataset: 'ds-abc12345',
      embeddingModel: 'mdl-default',
      chunkSize: 512,
      vectorSize: 384,
    }),
    update: async () => {
      throw new Error('update exploded');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, {
    body: { description: 'updated description' },
  });
  assert.equal(res.status, 500);
});

test('GET /knowledgebases/:id/versions: forwards workflow-engine error status', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  mock.method(axios, 'get', async () => {
    const err: any = new Error('we down');
    err.response = { status: 503, data: { error: 'unavailable' } };
    throw err;
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/versions`);
  assert.equal(res.status, 503);
});

test('GET /knowledgebases: skips dependentsSummary when include=false', async () => {
  seedKb({ find: async () => [{ id: 'kb0000001', name: 'k', status: 'ready' }] });
  const res = await request(app, 'GET', `${BASE}?include=dependentsSummary=false`);
  assert.equal(res.status, 200);
  assert.ok(!('dependentsSummary' in res.body[0]));
});

test('GET /knowledgebases/:id: enriches in_progress KB with live progress', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      status: 'in_progress',
      jobId: 'wf-live-1',
      progress: { phase: 'old', percentage: 5 },
    }),
  });
  mock.restoreAll();
  mock.method(axios, 'get', async (url: string) => {
    if (String(url).includes('/progress')) {
      return {
        status: 200,
        data: {
          phase: 'embedding',
          percentage: 42,
          extra: { documentsProcessed: 3, chunksCreated: 10 },
        },
      };
    }
    return { status: 200, data: {} };
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.phase, 'embedding');
  assert.equal(res.body.progress.percentage, 42);
  assert.ok('synchronizationSummary' in res.body);
});

test('GET /knowledgebases/:id: returns 500 when lookup fails', async () => {
  seedKb({
    findOne: async () => {
      throw new Error('kb read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 500);
});

test('PUT /knowledgebases/:id: validation error returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { chunkSize: 'not-a-number' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('PUT /knowledgebases/:id: duplicate name returns 409', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      if (w.name !== undefined && w.id && typeof w.id === 'object') {
        return { id: 'kb-other01', name: 'Taken' };
      }
      return { id: 'kb0000001', name: 'Old', projectId: PROJECT };
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { name: 'Taken' } });
  assert.equal(res.status, 409);
});

test('POST /knowledgebases: dataset missing returns 201 with warning', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000001', status: 'in_progress' }),
    create: (d: any) => ({ ...d, id: 'kb0000003' }),
    save: async (e: any) => ({ ...e, id: 'kb0000003' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  assert.match(String(res.body.warning), /source dataset not found/);
});

test('POST /knowledgebases: workflow failure still returns 201 with warning', async () => {
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000001', status: 'in_progress' }),
    create: (d: any) => ({ ...d, id: 'kb0000004' }),
    save: async (e: any) => ({ ...e, id: 'kb0000004' }),
    update: async () => ({ affected: 1 }),
  });
  mock.restoreAll();
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'post', async () => {
    throw new Error('workflow engine down');
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 201);
  assert.match(String(res.body.warning), /workflow failed to start/);
});

test('POST /knowledgebases: rejects non-embedding model type', async () => {
  handle.repos.Model = makeFakeRepo({
    findOne: async () => ({
      id: 'mdl-llm',
      name: 'sentence-transformers/all-MiniLM-L6-v2',
      provider: 'openai',
      providerModelId: 'gpt-4',
      modelType: 'llm',
      model_info: { dimensions: 1536 },
    }),
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMBEDDING_MODEL_NOT_FOUND');
});

test('POST /knowledgebases: resolves embeddingModelId FK when provided', async () => {
  const modelId = '550e8400-e29b-41d4-a716-446655440000';
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000005', status: 'in_progress' }),
    create: (d: any) => ({ ...d, id: 'kb0000005' }),
    save: async (e: any) => ({ ...e, id: 'kb0000005' }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.Model = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      if (w.id === modelId && w.projectId === PROJECT) {
        return {
          id: modelId,
          name: 'custom-embed',
          provider: 'openai',
          providerModelId: 'text-embedding-3-small',
          modelType: 'embedding',
          model_info: { dimensions: 1536 },
        };
      }
      return null;
    },
  });
  let postedWorkflow: any = null;
  mock.restoreAll();
  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'post', async (_url: string, body: any) => {
    postedWorkflow = body;
    return { status: 200, data: { workflowId: 'wf-fk-1' } };
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      ...baseKnowledgeBaseCreate(),
      embeddingModelId: modelId,
      embeddingModel: undefined,
    },
  });
  assert.equal(res.status, 201);
  assert.equal(postedWorkflow?.embeddingModelId, modelId);
});

test('GET /knowledgebases/:id/history: no history returns 404', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/kb0000001/history`);
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/restore-version: KB not found returns 404', async () => {
  seedKb({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kbmissing0/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/restore-version: version not found returns 404', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kb0000001/restore-version`, { body: { version: 99 } });
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/restore-version: returns 500 on unexpected errors', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001' }),
    update: async () => {
      throw new Error('restore failed');
    },
  });
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'kb0000001', name: 'X' } }),
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
});

test('POST /knowledgebases/:id/create: KB not found returns 404', async () => {
  seedKb({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kbmissing0/create`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/create: source dataset not found returns 404', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', sourceDataset: 'ds-missing' }) });
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/create: dataset not ready returns 400', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', sourceDataset: 'ds-abc12345' }) });
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => ({ id: 'ds-abc12345', status: 'processing' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /must be in 'ready' status/);
});

test('POST /knowledgebases/:id/create: returns 500 when workflow dispatch fails', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      name: 'k',
      sourceDataset: 'ds-abc12345',
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    }),
    update: async () => ({ affected: 1 }),
  });
  mock.restoreAll();
  mock.method(axios, 'post', async () => {
    throw new Error('create workflow failed');
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/create`, { body: {} });
  assert.equal(res.status, 500);
});

test('DELETE /knowledgebases/:id: starts S3 cleanup workflow on success', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001', scheduleConfig: undefined }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  mock.restoreAll();
  mock.method(axios, 'post', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'delete', async () => ({ status: 200, data: { workflowId: 'wf-cleanup' } }));
  const res = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.s3CleanupStarted, true);
});

test('GET /knowledgebases/:id/versions: returns 502 when workflow-engine is unreachable', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  mock.restoreAll();
  mock.method(axios, 'get', async () => {
    throw new Error('connection reset');
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/versions`);
  assert.equal(res.status, 502);
});

test('POST /knowledgebases/:id/facets/:facetType/run: KB not found returns 404', async () => {
  seedKb({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kbmissing0/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /knowledgebases/:id/facets/:facetType/run: source dataset not found returns 404', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      status: 'ready',
      sourceDataset: 'ds-missing',
    }),
  });
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 404);
});

test('GET /knowledgebases/:id/facets/:facetType: returns 500 on unexpected errors', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => {
      throw new Error('facet read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/facets/embedding`);
  assert.equal(res.status, 500);
});

test('GET /knowledgebases/:id/dependents: returns 500 when lookup fails', async () => {
  seedKb({
    findOne: async () => {
      throw new Error('dependents lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/dependents`);
  assert.equal(res.status, 500);
});

test('GET /knowledgebases/:id/history: returns 500 when history query fails', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001' }) });
  handle.repos.KnowledgeBaseHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001/history`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /history read failed/);
});

test('POST /knowledgebases: tolerates readProjectVirtualKeyToken failure', async () => {
  const restoreVk = mockModule('services/bifrost/bifrostProjectGovernance', {
    readProjectVirtualKeyToken: async () => {
      throw new Error('vk secret unreadable');
    },
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  try {
    seedKb({
      findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000001', status: 'in_progress' }),
      create: (d: any) => ({ ...d, id: 'kb0000006' }),
      save: async (e: any) => ({ ...e, id: 'kb0000006' }),
      update: async () => ({ affected: 1 }),
    });
    const res = await request(freshApp, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
    assert.equal(res.status, 201);
  } finally {
    restoreVk();
  }
});

test('POST /knowledgebases/:id/create: tolerates readProjectVirtualKeyToken failure', async () => {
  const restoreVk = mockModule('services/bifrost/bifrostProjectGovernance', {
    readProjectVirtualKeyToken: async () => {
      throw new Error('vk read failed on reprocess');
    },
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  try {
    seedKb({
      findOne: async () => ({
        id: 'kb0000001',
        name: 'k',
        sourceDataset: 'ds-abc12345',
        embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      }),
      update: async () => ({ affected: 1 }),
    });
    const res = await request(freshApp, 'POST', `${BASE}/kb0000001/create`, { body: {} });
    assert.equal(res.status, 202);
  } finally {
    restoreVk();
  }
});

test('POST /knowledgebases: tolerates schedule apply failure on create', async () => {
  restoreMock();
  restoreMock = mockModule('services/KnowledgeBaseScheduleService', {
    KnowledgeBaseScheduleService: {
      applySynchronizationConfig: async () => {
        throw new Error('schedule apply failed');
      },
      tearDownSchedule: async () => undefined,
    },
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  seedKb({
    findOne: async (q: any) => (q?.where?.name ? null : { id: 'kb0000007', status: 'in_progress' }),
    create: (d: any) => ({ ...d, id: 'kb0000007' }),
    save: async (e: any) => ({ ...e, id: 'kb0000007', synchronizationConfig: { sync_mode: 'cron' } }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(freshApp, 'POST', BASE, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '0 0 * * *',
      },
    }),
  });
  assert.equal(res.status, 201);
});

test('POST /knowledgebases: maps postgres unique violation on save to 500', async () => {
  seedKb({
    findOne: async () => null,
    create: (d: any) => d,
    save: async () => {
      throw Object.assign(new Error('duplicate key'), { code: '23505' });
    },
  });
  const res = await request(app, 'POST', BASE, { body: baseKnowledgeBaseCreate() });
  assert.equal(res.status, 500);
});

test('PUT /knowledgebases/:id: maps postgres unique violation to 409', async () => {
  seedKb({
    findOne: async (q: any) => {
      if (q?.where?.name && q?.where?.id?._type) return null;
      return { id: 'kb0000001', name: 'Old', projectId: PROJECT };
    },
    update: async () => {
      throw new QueryFailedError('update', [], { code: '23505' } as any);
    },
  });
  const res = await request(app, 'PUT', `${BASE}/kb0000001`, { body: { name: 'new-valid-name' } });
  assert.equal(res.status, 409);
});

test('PUT /knowledgebases/:id: tolerates schedule reconcile failure', async () => {
  restoreMock();
  restoreMock = mockModule('services/KnowledgeBaseScheduleService', {
    KnowledgeBaseScheduleService: {
      applySynchronizationConfig: async () => {
        throw new Error('schedule reconcile failed');
      },
      tearDownSchedule: async () => undefined,
    },
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  let row: any = {
    id: 'kb0000001',
    name: 'kb',
    projectId: PROJECT,
    synchronizationConfig: {
      sync_mode: 'scheduled',
      schedule_type: 'cron',
      cron_expression: '0 0 * * *',
    },
  };
  seedKb({
    findOne: async () => row,
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(freshApp, 'PUT', `${BASE}/kb0000001`, {
    body: {
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '0 1 * * *',
      },
    },
  });
  assert.equal(res.status, 200);
});

test('DELETE /knowledgebases/:id: tolerates workflow terminate failure', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001', scheduleConfig: undefined }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  mock.restoreAll();
  mock.method(axios, 'post', async (url: string) => {
    if (String(url).includes('/terminate')) {
      throw new Error('terminate unreachable');
    }
    return { status: 200, data: {} };
  });
  mock.method(axios, 'delete', async () => ({ status: 200, data: {} }));
  const res = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
});

test('POST /knowledgebases/:id/versions/:versionId/rollback: forwards workflow-engine error status', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'ready' }) });
  mock.restoreAll();
  mock.method(axios, 'post', async () => {
    const err: any = new Error('rollback rejected');
    err.response = { status: 422, data: { error: 'version stale' } };
    throw err;
  });
  const res = await request(app, 'POST', `${BASE}/kb0000001/versions/v1/rollback`, { body: {} });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, 'version stale');
});

test('PUT /knowledgebases/:id: persists scheduleConfig when reconcile returns new config', async () => {
  restoreMock();
  restoreMock = mockModule('services/KnowledgeBaseScheduleService', {
    KnowledgeBaseScheduleService: {
      applySynchronizationConfig: async () => ({
        temporalScheduleId: 'sched-new-1',
        cronExpression: '0 2 * * *',
      }),
      tearDownSchedule: async () => undefined,
    },
  });
  const freshRouter = loadFresh('routes/knowledgeBaseRoutes').default;
  const freshApp = buildApp({ basePath: '/api/v1/projects/:projectId/knowledgebases', router: freshRouter });
  let savedSchedule: any = null;
  let row: any = {
    id: 'kb0000001',
    name: 'kb',
    projectId: PROJECT,
    synchronizationConfig: {
      sync_mode: 'scheduled',
      schedule_type: 'cron',
      cron_expression: '0 0 * * *',
    },
  };
  seedKb({
    findOne: async () => row,
    update: async (_w: any, data: any) => {
      row = { ...row, ...data };
      return { affected: 1 };
    },
    save: async (entity: any) => {
      savedSchedule = entity.scheduleConfig;
      row = entity;
      return entity;
    },
  });
  const res = await request(freshApp, 'PUT', `${BASE}/kb0000001`, {
    body: {
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '0 2 * * *',
      },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(savedSchedule?.temporalScheduleId, 'sched-new-1');
});

test('DELETE /knowledgebases/:id: returns warning when S3 cleanup trigger fails', async () => {
  let projectLookups = 0;
  handle.repos.Project = makeFakeRepo({
    findOne: async () => {
      projectLookups += 1;
      if (projectLookups === 1) return PROJECT_ROW;
      throw new Error('project lookup failed during cleanup');
    },
  });
  seedKb({
    findOne: async () => ({ id: 'kb0000001', scheduleConfig: undefined }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.s3CleanupStarted, false);
  assert.match(String(res.body.warning), /S3 cleanup workflow failed to start/);
});

test('DELETE /knowledgebases/:id: returns 500 when delete throws', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001' }),
    delete: async () => {
      throw new Error('delete exploded');
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(res.status, 500);
});

test('GET /knowledgebases/:id: keeps stale progress when workflow progress fetch fails', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      status: 'in_progress',
      jobId: 'wf-live-1',
      progress: { phase: 'old', percentage: 3 },
    }),
  });
  mock.restoreAll();
  mock.method(axios, 'get', async (url: string) => {
    if (String(url).includes('/progress')) {
      throw new Error('progress endpoint down');
    }
    return { status: 200, data: {} };
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.phase, 'old');
});

test('POST /knowledgebases: returns 400 when embeddingModelId FK not found', async () => {
  handle.repos.Model = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      ...baseKnowledgeBaseCreate(),
      embeddingModelId: '550e8400-e29b-41d4-a716-446655440000',
      embeddingModel: undefined,
    },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'EMBEDDING_MODEL_NOT_FOUND');
});

test('DELETE /knowledgebases/:id: tolerates S3 cleanup axios rejection', async () => {
  seedKb({
    findOne: async () => ({ id: 'kb0000001', scheduleConfig: undefined }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  mock.restoreAll();
  mock.method(axios, 'post', async () => ({ status: 200, data: {} }));
  mock.method(axios, 'delete', async () => {
    throw new Error('cleanup workflow unreachable');
  });
  const res = await request(app, 'DELETE', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.s3CleanupStarted, true);
});

test('POST /knowledgebases/:id/facets/embedding/run: rejects KB failed status', async () => {
  seedKb({ findOne: async () => ({ id: 'kb0000001', status: 'failed' }) });
  const res = await request(app, 'POST', `${BASE}/kb0000001/facets/embedding/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /ready.*errored/);
});

test('GET /knowledgebases/:id: computes next_scheduled_synchronization for hourly UTC schedule', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'hourly',
        interval_minutes: 30,
        timezone: 'UTC',
      },
      scheduleConfig: { enabled: true, cronExpression: '*/30 * * * *' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.ok(res.body.synchronizationSummary.next_scheduled_synchronization);
});

test('GET /knowledgebases/:id: computes next_scheduled_synchronization for daily UTC schedule', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'daily',
        time_of_day: '14:30',
        timezone: 'UTC',
      },
      scheduleConfig: { enabled: true, cronExpression: '30 14 * * *' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.ok(res.body.synchronizationSummary.next_scheduled_synchronization);
});

test('GET /knowledgebases/:id: computes next_scheduled_synchronization for weekly UTC schedule', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'weekly',
        day_of_week: [1, 3, 5],
        time_of_day: '09:00',
        timezone: 'UTC',
      },
      scheduleConfig: { enabled: true, cronExpression: '0 9 * * 1,3,5' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.ok(res.body.synchronizationSummary.next_scheduled_synchronization);
});

test('GET /knowledgebases/:id: computes next_scheduled_synchronization for monthly UTC schedule', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'monthly',
        day_of_month: 15,
        time_of_day: '06:00',
        timezone: 'UTC',
      },
      scheduleConfig: { enabled: true, cronExpression: '0 6 15 * *' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.ok(res.body.synchronizationSummary.next_scheduled_synchronization);
});

test('GET /knowledgebases/:id: returns null next run for non-UTC timezone', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'daily',
        time_of_day: '09:00',
        timezone: 'America/Los_Angeles',
      },
      scheduleConfig: { enabled: true, cronExpression: '0 9 * * *' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.synchronizationSummary.next_scheduled_synchronization, null);
});

test('GET /knowledgebases/:id: returns null next run for cron schedule type', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'ready',
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '0 0 * * *',
        timezone: 'UTC',
      },
      scheduleConfig: { enabled: true, cronExpression: '0 0 * * *' },
    }),
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.synchronizationSummary.next_scheduled_synchronization, null);
});

test('GET /knowledgebases/:id: enriches in_progress KB with live progress stats', async () => {
  seedKb({
    findOne: async () => ({
      id: 'kb0000001',
      projectId: PROJECT,
      status: 'in_progress',
      jobId: 'wf-live-stats',
      progress: { phase: 'old', percentage: 1 },
    }),
  });
  mock.restoreAll();
  mock.method(axios, 'get', async (url: string) => {
    if (String(url).includes('/progress')) {
      return {
        status: 200,
        data: {
          phase: 'indexing',
          percentage: 42,
          extra: {
            totalFiles: 10,
            documentsProcessed: 4,
            totalDocuments: 8,
            chunksCreated: 20,
            vectorsCreated: 20,
            currentFile: 'doc.pdf',
            estimatedRemainingFormatted: '2m',
            elapsedFormatted: '1m',
            documentCount: 4,
            chunkCount: 20,
            vectorCount: 20,
            storageMB: 1.5,
          },
          totalUnits: 10,
          units: 4,
        },
      };
    }
    return { status: 200, data: {} };
  });
  const res = await request(app, 'GET', `${BASE}/kb0000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.phase, 'indexing');
  assert.equal(res.body.progress.totalFiles, 10);
  assert.equal(res.body.stats.documentCount, 4);
  assert.equal(res.body.stats.chunkCount, 20);
});

