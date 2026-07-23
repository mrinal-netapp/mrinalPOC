/**
 * Unit tests for services/ProjectDeleteService.ts. The workflow-engine axios
 * client is replaced with a fake (no network). getProjectStorageRoot runs real.
 *
 * Run: node --require ts-node/register --test tests/ProjectDeleteService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ProjectDeleteService } from '../services/ProjectDeleteService';

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => mock.restoreAll());

test('deleteProject sends bucket + prefix derived from home_dir', async () => {
  const del = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-1' } }));
  const svc = new ProjectDeleteService();
  (svc as any).client = { delete: del };
  await svc.deleteProject('proj1', 's3://default-nemo/projects/proj1');
  const [url, opts] = del.mock.calls[0].arguments as any[];
  assert.match(url, /\/projects\/proj1\/delete$/);
  assert.equal(opts.data.bucketName, 'default-nemo');
  assert.equal(opts.data.pathPrefix, 'projects/proj1');
});

test('deleteProject resolves even without a workflow id', async () => {
  const svc = new ProjectDeleteService();
  (svc as any).client = { delete: mock.fn(async () => ({ status: 200, data: {} })) };
  await assert.doesNotReject(svc.deleteProject('proj1', 's3://default-nemo/projects/proj1'));
});

test('deleteProject swallows errors from an invalid home_dir', async () => {
  const svc = new ProjectDeleteService();
  (svc as any).client = { delete: mock.fn(async () => ({ status: 200, data: {} })) };
  // Invalid home_dir makes getProjectStorageRoot throw; the service must not reject.
  await assert.doesNotReject(svc.deleteProject('proj1', 'not-an-s3-uri'));
});

test('deleteProject swallows workflow-engine errors', async () => {
  const svc = new ProjectDeleteService();
  (svc as any).client = {
    delete: mock.fn(async () => {
      throw new Error('engine down');
    }),
  };
  await assert.doesNotReject(svc.deleteProject('proj1', 's3://default-nemo/projects/proj1'));
});

test('deleteProject includes gateway metadata when teamId or virtualKeyId present', async () => {
  const del = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-gw' } }));
  const svc = new ProjectDeleteService();
  (svc as any).client = { delete: del };
  await svc.deleteProject('proj1', 's3://default-nemo/projects/proj1', {
    teamId: 'team-1',
    virtualKeyId: 'vk-1',
  });
  const [, opts] = del.mock.calls[0].arguments as any[];
  assert.deepEqual(opts.data.gateway, { teamId: 'team-1', virtualKeyId: 'vk-1' });
});

test('deleteProject omits gateway when metadata has no team or vk ids', async () => {
  const del = mock.fn(async () => ({ status: 200, data: {} }));
  const svc = new ProjectDeleteService();
  (svc as any).client = { delete: del };
  await svc.deleteProject('proj1', 's3://default-nemo/projects/proj1', { teamName: 'only-name' });
  const [, opts] = del.mock.calls[0].arguments as any[];
  assert.equal(opts.data.gateway, undefined);
});
