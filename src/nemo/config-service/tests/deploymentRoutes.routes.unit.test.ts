/**
 * Route-handler tests for routes/deploymentRoutes.ts.
 *
 * The router declares its own absolute paths, so it is mounted at '/'.
 * DeploymentService is module-mocked with a fake that controls every
 * branch; the AppDataSource fake-repo seam is installed for symmetry.
 *
 * Run: node --require ts-node/register --test tests/deploymentRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;
let svc: any;

function notFound(message = 'not found') {
  return Object.assign(new Error(message), { statusCode: 404, name: 'NotFoundError' });
}

beforeEach(() => {
  handle = installFakeRepositories({});
  svc = {
    registerDeployment: async (req: any) => ({ id: req.id, region: req.region }),
    getDeployment: async () => undefined,
    updateDeployment: async (id: string) => ({ id }),
    deleteDeployment: async () => undefined,
    listDeployments: async () => [],
    getDeploymentConfig: async (id: string) => ({ deployment_id: id, buckets: [], config_version: 1 }),
    getBucketRouting: async () => ({ deployments: [] }),
    submitMetrics: async () => undefined,
    submitHealthReport: async () => undefined,
  };
  scope = restoreScope();
  scope.add(mockModule('services/DeploymentService', { DeploymentService: svc }));
  const router = loadFresh('routes/deploymentRoutes').default;
  app = buildApp({ basePath: '/', router });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/deploymentRoutes');
  mock.restoreAll();
  handle.restore();
});

// ── Register deployment ──
test('POST /api/v1/deployments: missing id returns 400', async () => {
  const res = await request(app, 'POST', '/api/v1/deployments', { body: { region: 'r' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /id is required/);
});

test('POST /api/v1/deployments: new deployment returns 201', async () => {
  svc.getDeployment = async () => undefined;
  const res = await request(app, 'POST', '/api/v1/deployments', {
    body: { id: 'd1', region: 'r', endpoint: 'e' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'd1');
});

test('POST /api/v1/deployments: existing deployment returns 200', async () => {
  svc.getDeployment = async () => ({ id: 'd1' });
  const res = await request(app, 'POST', '/api/v1/deployments', {
    body: { id: 'd1', region: 'r', endpoint: 'e' },
  });
  assert.equal(res.status, 200);
});

// ── Get deployment ──
test('GET /api/v1/deployments/:id: found 200, missing 404', async () => {
  svc.getDeployment = async (id: string) => ({ id });
  const ok = await request(app, 'GET', '/api/v1/deployments/d1');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'd1');

  svc.getDeployment = async () => {
    throw notFound('Deployment not found');
  };
  assert.equal((await request(app, 'GET', '/api/v1/deployments/missing')).status, 404);
});

// ── Update deployment ──
test('PUT /api/v1/deployments/:id: 200 and 404', async () => {
  svc.updateDeployment = async (id: string) => ({ id, region: 'r2' });
  const ok = await request(app, 'PUT', '/api/v1/deployments/d1', { body: { region: 'r2' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.region, 'r2');

  svc.updateDeployment = async () => {
    throw notFound();
  };
  assert.equal((await request(app, 'PUT', '/api/v1/deployments/missing', { body: {} })).status, 404);
});

// ── Delete deployment ──
test('DELETE /api/v1/deployments/:id: 204 and 404', async () => {
  svc.deleteDeployment = async () => undefined;
  const ok = await request(app, 'DELETE', '/api/v1/deployments/d1');
  assert.equal(ok.status, 204);

  svc.deleteDeployment = async () => {
    throw notFound();
  };
  assert.equal((await request(app, 'DELETE', '/api/v1/deployments/missing')).status, 404);
});

// ── List deployments ──
test('GET /api/v1/deployments: list returns 200', async () => {
  svc.listDeployments = async () => [{ id: 'd1' }, { id: 'd2' }];
  const res = await request(app, 'GET', '/api/v1/deployments');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// ── Config distribution ──
test('GET /api/v1/deployments/:id/buckets: returns config (200)', async () => {
  svc.getDeploymentConfig = async (id: string) => ({
    deployment_id: id,
    buckets: [{ bucket_name: 'b1' }],
    config_version: 7,
  });
  const res = await request(app, 'GET', '/api/v1/deployments/d1/buckets?since=3');
  assert.equal(res.status, 200);
  assert.equal(res.body.config_version, 7);
  assert.equal(res.body.buckets.length, 1);
});

test('GET /api/v1/deployments/:id/config: returns config (200)', async () => {
  const res = await request(app, 'GET', '/api/v1/deployments/d1/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.config_version, 1);
});

// ── Routing ──
test('GET /api/v1/buckets/:projectId/:bucketName/routing: returns 200', async () => {
  svc.getBucketRouting = async (projectId: string, bucketName: string) => ({
    project_id: projectId,
    bucket_name: bucketName,
    deployments: [],
  });
  const res = await request(app, 'GET', '/api/v1/buckets/proj1/bucketA/routing');
  assert.equal(res.status, 200);
  assert.equal(res.body.bucket_name, 'bucketA');
});

// ── Metrics & health ──
test('POST /api/v1/deployments/:id/metrics: accepted (200)', async () => {
  const res = await request(app, 'POST', '/api/v1/deployments/d1/metrics', { body: { metrics: {} } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');
});

test('POST /api/v1/deployments/:id/health: accepted (200)', async () => {
  const res = await request(app, 'POST', '/api/v1/deployments/d1/health', { body: { healthy: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');
});

test('GET /api/v1/projects/:projectId/buckets/:bucketName/health: returns stub (200)', async () => {
  const res = await request(app, 'GET', '/api/v1/projects/proj1/buckets/bucketA/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bucket_health, []);
});

// ── StorageClasses ──
test('GET /api/v1/storage-classes: aggregates from healthy deployments (200)', async () => {
  svc.listDeployments = async () => [
    { id: 'd1', status: 'healthy', storage_classes: ['ebs-gp3', 'local-path'] },
    { id: 'd2', status: 'unhealthy', storage_classes: ['should-not-appear'] },
    { id: 'd3', status: 'unknown', storage_classes: ['local-path'] },
  ];
  const res = await request(app, 'GET', '/api/v1/storage-classes');
  assert.equal(res.status, 200);
  const names = res.body.storage_classes.map((s: any) => s.name);
  assert.deepEqual(names, ['ebs-gp3', 'local-path']);
  const gp3 = res.body.storage_classes.find((s: any) => s.name === 'ebs-gp3');
  assert.equal(gp3.provisioner, 'ebs.csi.aws.com');
});

test('GET /api/v1/deployments/:id/buckets: since=0 uses full sync path', async () => {
  const res = await request(app, 'GET', '/api/v1/deployments/d1/buckets?since=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.config_version, 1);
});

test('GET /api/v1/storage-classes: unknown provisioner maps to unknown', async () => {
  svc.listDeployments = async () => [
    { id: 'd1', status: 'healthy', storage_classes: ['custom-sc'] },
  ];
  const res = await request(app, 'GET', '/api/v1/storage-classes');
  assert.equal(res.status, 200);
  const custom = res.body.storage_classes.find((s: any) => s.name === 'custom-sc');
  assert.equal(custom.provisioner, 'unknown');
});
