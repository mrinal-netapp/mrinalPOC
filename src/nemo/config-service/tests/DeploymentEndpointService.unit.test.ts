/**
 * Unit tests for services/DeploymentEndpointService.ts. RepositoryFactory and
 * utils/s3Utils are module-mocked; utils/defaultBucket runs real (driven by
 * env). DeploymentService.evaluateDeploymentHealthStatus runs real.
 *
 * Run: node --require ts-node/register --test tests/DeploymentEndpointService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const DEFAULT_BUCKET = 'default-nemo';
let scope: ReturnType<typeof restoreScope>;
let factory: any;
let DeploymentEndpointService: any;
let savedEnv: Record<string, string | undefined>;

function makeFactory() {
  return {
    assignmentRepo: { listByBucket: async (_p: string, _b: string, _s?: string) => [] as any[] },
    deploymentRepo: {
      getById: async (_id: string) => null as any,
      list: async () => [] as any[],
      updateStatus: async () => undefined,
    },
    healthReportRepo: { getByDeploymentId: async (_d: string) => null as any },
  };
}

beforeEach(() => {
  savedEnv = {
    DEFAULT_BUCKET_NAME: process.env.DEFAULT_BUCKET_NAME,
    DEFAULT_BUCKET_DEPLOYMENT_ID: process.env.DEFAULT_BUCKET_DEPLOYMENT_ID,
  };
  process.env.DEFAULT_BUCKET_NAME = DEFAULT_BUCKET;
  delete process.env.DEFAULT_BUCKET_DEPLOYMENT_ID;

  factory = makeFactory();
  scope = restoreScope();
  scope.add(mockModule('repositories/RepositoryFactory', { getRepositoryFactory: () => factory }));
  scope.add(
    mockModule('utils/s3Utils', {
      deploymentEndpointToS3GatewayUrl: (e: string) => e.replace('app.', 's3.'),
    }),
  );
  DeploymentEndpointService = loadFresh('services/DeploymentEndpointService', [
    'services/DeploymentService',
  ]).DeploymentEndpointService;
  mock.method(console, 'warn', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/DeploymentEndpointService', 'services/DeploymentService');
  mock.restoreAll();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('default bucket resolves via DEFAULT_BUCKET_DEPLOYMENT_ID env', async () => {
  process.env.DEFAULT_BUCKET_DEPLOYMENT_ID = 'd-env';
  factory.deploymentRepo.getById = async (id: string) =>
    id === 'd-env' ? { id, endpoint: 'https://app.example.com', http_endpoint: 'http://app.example.com' } : null;
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', DEFAULT_BUCKET, 'https');
  assert.equal(ep, 'https://app.example.com');
});

test('default bucket picks http_endpoint when protocol is http', async () => {
  process.env.DEFAULT_BUCKET_DEPLOYMENT_ID = 'd-env';
  factory.deploymentRepo.getById = async () => ({
    id: 'd-env',
    endpoint: 'https://app.example.com',
    http_endpoint: 'http://app.example.com',
  });
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', DEFAULT_BUCKET, 'http');
  assert.equal(ep, 'http://app.example.com');
});

test('default bucket falls back to the first healthy deployment', async () => {
  factory.deploymentRepo.list = async () => [
    { id: 'd-bad', endpoint: 'https://bad', status: 'unhealthy' },
    { id: 'd-good', endpoint: 'https://good', status: 'healthy' },
  ];
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', DEFAULT_BUCKET, 'https');
  assert.equal(ep, 'https://good');
});

test('default bucket returns null when no deployments exist', async () => {
  factory.deploymentRepo.list = async () => [];
  factory.assignmentRepo.listByBucket = async () => [];
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', DEFAULT_BUCKET, 'https');
  assert.equal(ep, null);
});

test('project-scoped bucket with no assignments returns null', async () => {
  factory.assignmentRepo.listByBucket = async () => [];
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', 'project-bucket', 'https');
  assert.equal(ep, null);
});

test('project-scoped bucket selects the healthy primary endpoint', async () => {
  factory.assignmentRepo.listByBucket = async () => [
    { deployment_id: 'd1', role: 'primary', priority: 100, load_balance_weight: 100 },
  ];
  factory.deploymentRepo.getById = async () => ({ id: 'd1', endpoint: 'https://d1', status: 'healthy' });
  factory.healthReportRepo.getByDeploymentId = async () => ({ healthy: true, timestamp: new Date().toISOString() });
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', 'project-bucket', 'https');
  assert.equal(ep, 'https://d1');
});

test('project-scoped bucket skips deployments that no longer exist', async () => {
  factory.assignmentRepo.listByBucket = async () => [
    { deployment_id: 'gone', role: 'primary', priority: 100 },
  ];
  factory.deploymentRepo.getById = async () => null;
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', 'project-bucket', 'https');
  assert.equal(ep, null);
});

test('formatS3Endpoint delegates to the s3 gateway helper', () => {
  assert.equal(DeploymentEndpointService.formatS3Endpoint('https://app.example.com'), 'https://s3.example.com');
});

test('default bucket warns and falls back when configured deployment id is missing', async () => {
  process.env.DEFAULT_BUCKET_DEPLOYMENT_ID = 'missing-id';
  factory.deploymentRepo.getById = async (id: string) => (id === 'missing-id' ? null : null);
  factory.deploymentRepo.list = async () => [{ id: 'd-fallback', endpoint: 'https://fallback', status: 'healthy' }];
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', DEFAULT_BUCKET, 'https');
  assert.equal(ep, 'https://fallback');
});

test('project-scoped bucket marks stale health and picks any primary endpoint', async () => {
  let statusUpdated = false;
  factory.assignmentRepo.listByBucket = async () => [
    { deployment_id: 'd1', role: 'primary', priority: 50, load_balance_weight: 100 },
    { deployment_id: 'd2', role: 'primary', priority: 10, load_balance_weight: 100 },
  ];
  factory.deploymentRepo.getById = async (id: string) =>
    id === 'd1'
      ? { id, endpoint: 'https://d1', status: 'healthy' }
      : { id, endpoint: 'https://d2', http_endpoint: 'http://d2', status: 'healthy' };
  factory.healthReportRepo.getByDeploymentId = async (id: string) =>
    id === 'd1'
      ? { healthy: false, timestamp: new Date().toISOString() }
      : { healthy: true, timestamp: new Date().toISOString() };
  factory.deploymentRepo.updateStatus = async () => {
    statusUpdated = true;
  };
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', 'project-bucket', 'http');
  assert.equal(ep, 'http://d2');
  assert.equal(statusUpdated, true);
});

test('project-scoped bucket uses first deployment when no healthy primary exists', async () => {
  factory.assignmentRepo.listByBucket = async () => [
    { deployment_id: 'd1', role: 'replica', priority: 1, load_balance_weight: 100 },
  ];
  factory.deploymentRepo.getById = async () => ({ id: 'd1', endpoint: 'https://replica', status: 'degraded' });
  factory.healthReportRepo.getByDeploymentId = async () => null;
  const ep = await DeploymentEndpointService.getPrimaryDeploymentEndpoint('p', 'project-bucket', 'https');
  assert.equal(ep, 'https://replica');
});
