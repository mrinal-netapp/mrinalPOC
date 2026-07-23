/**
 * Unit tests for services/TableProcessingService.ts. The service POSTs to the
 * workflow-engine over an axios instance; we replace the instance's `client`
 * with a fake so no network is touched.
 *
 * Run: node --require ts-node/register --test tests/TableProcessingService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { TableProcessingService } from '../services/TableProcessingService';

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => mock.restoreAll());

function buildService(post: (...args: any[]) => Promise<any>) {
  const svc = new TableProcessingService();
  (svc as any).client = { post: mock.fn(post) };
  return svc;
}

test('startTableProcessing returns the workflowId on success', async () => {
  const svc = buildService(async () => ({ status: 200, data: { workflowId: 'wf-123' } }));
  const id = await svc.startTableProcessing('p', 'ds1', 'tbl', 'ns', 'wh');
  assert.equal(id, 'wf-123');
});

test('startTableProcessing returns null when the response omits a workflowId', async () => {
  const svc = buildService(async () => ({ status: 200, data: {} }));
  const id = await svc.startTableProcessing('p', 'ds1', 'tbl', 'ns');
  assert.equal(id, null);
});

test('startTableProcessing swallows errors and returns null', async () => {
  const svc = buildService(async () => {
    throw Object.assign(new Error('boom'), { response: { status: 500, data: { error: 'nope' } } });
  });
  const id = await svc.startTableProcessing('p', 'ds1', 'tbl', 'ns');
  assert.equal(id, null);
});

test('startTableProcessing posts the expected request body', async () => {
  const post = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf' } }));
  const svc = new TableProcessingService();
  (svc as any).client = { post };
  await svc.startTableProcessing('proj', 'ds1', 'mytable', 'myns', 'wh-1');
  const [url, body] = post.mock.calls[0].arguments as any[];
  assert.match(url, /\/projects\/proj\/datasets\/ds1\/process$/);
  assert.deepEqual(body, { dataSetId: 'ds1', tableName: 'mytable', namespace: 'myns', warehouseId: 'wh-1' });
});

test('startTableProcessing logs error without response body', async () => {
  const svc = buildService(async () => {
    throw new Error('network fail');
  });
  const id = await svc.startTableProcessing('p', 'ds1', 'tbl', 'ns');
  assert.equal(id, null);
});
