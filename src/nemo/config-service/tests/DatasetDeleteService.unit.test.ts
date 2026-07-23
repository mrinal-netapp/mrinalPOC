/**
 * Unit tests for services/DatasetDeleteService.ts. The workflow-engine axios
 * client is replaced with a fake (no network).
 *
 * Run: node --require ts-node/register --test tests/DatasetDeleteService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { DatasetDeleteService } from '../services/DatasetDeleteService';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => mock.restoreAll());

test('terminateDatasetWorkflows returns the cancelled list', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = { post: mock.fn(async () => ({ data: { cancelled: ['a', 'b'] } })) };
  const cancelled = await svc.terminateDatasetWorkflows('p', 'ds1');
  assert.deepEqual(cancelled, ['a', 'b']);
});

test('terminateDatasetWorkflows returns [] on error', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = {
    post: mock.fn(async () => {
      throw new Error('temporal unreachable');
    }),
  };
  assert.deepEqual(await svc.terminateDatasetWorkflows('p', 'ds1'), []);
});

test('terminateDatasetWorkflows defaults to [] when the response omits cancelled', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = { post: mock.fn(async () => ({ data: {} })) };
  assert.deepEqual(await svc.terminateDatasetWorkflows('p', 'ds1'), []);
});

test('startDatasetDeletion returns the workflowId on success', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = { delete: mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-9' } })) };
  const id = await svc.startDatasetDeletion('p', 'ds1', 'tbl', 'ns');
  assert.equal(id, 'wf-9');
});

test('startDatasetDeletion returns null when no workflowId present', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = { delete: mock.fn(async () => ({ status: 200, data: {} })) };
  const id = await svc.startDatasetDeletion('p', 'ds1', 'tbl', 'ns');
  assert.equal(id, null);
});

test('startDatasetDeletion throws when the workflow-engine call fails', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = {
    delete: mock.fn(async () => {
      throw Object.assign(new Error('boom'), { response: { status: 500, data: { error: 'denied' } } });
    }),
  };
  await assert.rejects(svc.startDatasetDeletion('p', 'ds1', 'tbl', 'ns'), /Failed to start dataset deletion workflow: denied/);
});

test('startDatasetDeletion sends pathPrefix and bucket defaults', async () => {
  const del = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf' } }));
  const svc = new DatasetDeleteService();
  (svc as any).client = { delete: del };
  await svc.startDatasetDeletion('proj', 'ds1', 'tbl', 'ns', undefined, undefined, 'pre/fix');
  const [url, opts] = del.mock.calls[0].arguments as any[];
  assert.match(url, /\/projects\/proj\/datasets\/ds1$/);
  assert.equal(opts.data.pathPrefix, 'pre/fix');
  assert.equal(opts.data.warehouseId, 'proj');
  assert.equal(opts.data.bucketName, 'proj');
});

test('constructor: uses authenticated workflow-engine client when service account is configured', async () => {
  const scope = restoreScope();
  const post = mock.fn(async () => ({ data: { cancelled: ['wf-1'] } }));
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => ({
        createAuthenticatedClient: () => ({ post, delete: post }),
      }),
    }),
  );
  try {
    const { DatasetDeleteService: FreshSvc } = loadFresh<{ DatasetDeleteService: typeof DatasetDeleteService }>(
      'services/DatasetDeleteService',
    );
    const svc = new FreshSvc();
    assert.deepEqual(await svc.terminateDatasetWorkflows('p', 'ds1'), ['wf-1']);
  } finally {
    scope.restoreAll();
    clearModule('services/DatasetDeleteService');
  }
});

test('startDatasetDeletion uses explicit warehouseId and bucketName', async () => {
  const del = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-x' } }));
  const svc = new DatasetDeleteService();
  (svc as any).client = { delete: del };
  const id = await svc.startDatasetDeletion('proj', 'ds1', 'tbl', 'ns', 'wh-1', 'bucket-a', 'pfx');
  assert.equal(id, 'wf-x');
  const [, opts] = del.mock.calls[0].arguments as any[];
  assert.equal(opts.data.warehouseId, 'wh-1');
  assert.equal(opts.data.bucketName, 'bucket-a');
});

test('startDatasetDeletion uses error.message when response body lacks error field', async () => {
  const svc = new DatasetDeleteService();
  (svc as any).client = {
    delete: mock.fn(async () => {
      throw Object.assign(new Error('network down'), { response: { status: 503, data: {} } });
    }),
  };
  await assert.rejects(
    svc.startDatasetDeletion('p', 'ds1', 'tbl', 'ns'),
    /Failed to start dataset deletion workflow: network down/,
  );
});
