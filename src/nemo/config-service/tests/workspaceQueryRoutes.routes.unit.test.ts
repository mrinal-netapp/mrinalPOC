/**
 * Route-handler tests for routes/workspaceQueryRoutes.ts (orchestrator polling).
 *
 * WorkspaceService.queryWorkspacesForManagement is stubbed via the require-cache
 * module mock; the route is loaded fresh so it binds the fake. Asserts the
 * orchestrator transform shape (deploymentType, template, s3Config).
 *
 * Run: node --require ts-node/register --test tests/workspaceQueryRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, type Restore } from './helpers/moduleMock';
import type { Express } from 'express';

const BASE = '/api/v1/workspaces';

let handle: FakeDataSourceHandle;
let app: Express;
let restoreMock: Restore;
let lastParams: any;

beforeEach(() => {
  handle = installFakeRepositories({});
  lastParams = undefined;
  const fakeSvc = {
    queryWorkspacesForManagement: async (params: any) => {
      lastParams = params;
      return [
        {
          id: 'ws000001',
          projectId: 'p1',
          templateId: 't1',
          name: 'w1',
          status: 'new',
          bucketName: 'bucket-1',
          podName: 'pod-1',
          pvcName: 'pvc-1',
          deploymentId: 'nemo',
          template: {
            id: 't1',
            projectId: 'p1',
            name: 'tpl',
            type: 'jupyterlab',
            environment: { FOO: 'bar' },
            resources: { cpu: '2' },
          },
        },
        {
          id: 'ws000002',
          projectId: 'p1',
          name: 'w2',
          status: 'creating',
        },
      ];
    },
  };
  restoreMock = mockModule('services/WorkspaceService', { WorkspaceService: fakeSvc });
  const router = loadFresh('routes/workspaceQueryRoutes').default;
  app = buildApp({ basePath: BASE, router });
});

afterEach(() => {
  restoreMock();
  clearModule('routes/workspaceQueryRoutes');
  handle.restore();
});

test('GET /workspaces: transforms workspaces with template + s3Config (200)', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);

  const ws1 = res.body[0];
  assert.equal(ws1.id, 'ws000001');
  assert.equal(ws1.deploymentType, 'nemo');
  assert.equal(ws1.template.id, 't1');
  assert.deepEqual(ws1.template.environment, { FOO: 'bar' });
  assert.equal(ws1.s3Config.bucketName, 'bucket-1');

  const ws2 = res.body[1];
  assert.equal(ws2.template, undefined);
  assert.equal(ws2.s3Config, undefined);
  assert.equal(ws2.deploymentType, 'nemo');
});

test('GET /workspaces?status=new,creating&deploymentId=nemo: parses status csv + filters', async () => {
  const res = await request(app, 'GET', `${BASE}?status=new,%20creating&deploymentId=nemo&deploymentType=nemo`);
  assert.equal(res.status, 200);
  assert.deepEqual(lastParams.status, ['new', 'creating']);
  assert.equal(lastParams.deploymentId, 'nemo');
  assert.equal(lastParams.deploymentType, 'nemo');
});

test('GET /workspaces: no status -> undefined status filter', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(lastParams.status, undefined);
  assert.equal(lastParams.deploymentId, undefined);
});

test('GET /workspaces?deploymentType=invalid -> 400', async () => {
  const res = await request(app, 'GET', `${BASE}?deploymentType=aws`);
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Invalid deploymentType/i);
});
