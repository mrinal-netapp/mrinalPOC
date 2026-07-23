/**
 * Unit tests for services/DatasetImportService.ts. The workflow-engine axios
 * client is replaced with a fake (no network).
 *
 * Run: node --require ts-node/register --test tests/DatasetImportService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { DatasetImportService } from '../services/DatasetImportService';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => mock.restoreAll());

test('startDatasetImport returns the workflowId on success', async () => {
  const svc = new DatasetImportService();
  (svc as any).client = { post: mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-1' } })) };
  const id = await svc.startDatasetImport('p', 'ds1', 'name', 'structured', 'bucket');
  assert.equal(id, 'wf-1');
});

test('startDatasetImport returns null when no workflowId present', async () => {
  const svc = new DatasetImportService();
  (svc as any).client = { post: mock.fn(async () => ({ status: 202, data: {} })) };
  const id = await svc.startDatasetImport('p', 'ds1', 'name', 'unstructured', 'bucket');
  assert.equal(id, null);
});

test('startDatasetImport swallows errors and returns null', async () => {
  const svc = new DatasetImportService();
  (svc as any).client = {
    post: mock.fn(async () => {
      throw Object.assign(new Error('down'), { response: { status: 503, data: {} } });
    }),
  };
  const id = await svc.startDatasetImport('p', 'ds1', 'name', 'structured', 'bucket');
  assert.equal(id, null);
});

test('startDatasetImport includes optional flags in the request body', async () => {
  const post = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf' } }));
  const svc = new DatasetImportService();
  (svc as any).client = { post };
  await svc.startDatasetImport(
    'proj',
    'ds1',
    'name',
    'structured',
    'bucket',
    'ns',
    'wh',
    'prefix/path',
    true,
    true,
    true,
  );
  const [url, body] = post.mock.calls[0].arguments as any[];
  assert.match(url, /\/projects\/proj\/datasets\/ds1\/import$/);
  assert.equal(body.pathPrefix, 'prefix/path');
  assert.equal(body.enablePiiAnalysis, true);
  assert.equal(body.piiAnalysisImageOnly, true);
  assert.equal(body.reprocessPiiOnly, true);
  assert.equal(body.warehouseId, 'wh');
});

test('startDatasetImport defaults the warehouse name to "nemo"', async () => {
  const post = mock.fn(async () => ({ status: 200, data: {} }));
  const svc = new DatasetImportService();
  (svc as any).client = { post };
  await svc.startDatasetImport('proj', 'ds1', 'name', 'structured', 'bucket');
  const body = (post.mock.calls[0].arguments as any[])[1];
  assert.equal(body.warehouseId, 'nemo');
  assert.equal(body.namespace, 'default');
});

test('constructor: uses authenticated workflow-engine client when service account is configured', async () => {
  const scope = restoreScope();
  const post = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-auth' } }));
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => ({
        createAuthenticatedClient: () => ({ post }),
      }),
    }),
  );
  try {
    const { DatasetImportService: FreshSvc } = loadFresh<{ DatasetImportService: typeof DatasetImportService }>(
      'services/DatasetImportService',
    );
    const svc = new FreshSvc();
    assert.equal(await svc.startDatasetImport('p', 'ds1', 'name', 'structured', 'bucket'), 'wf-auth');
  } finally {
    scope.restoreAll();
    clearModule('services/DatasetImportService');
  }
});
