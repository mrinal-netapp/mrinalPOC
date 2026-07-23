/**
 * Unit tests for services/DeploymentService.ts. The service talks to the
 * database only through repositories/RepositoryFactory, which we module-mock
 * with in-memory fakes (no DB/network). evaluateDeploymentHealthStatus is pure.
 *
 * Run: node --require ts-node/register --test tests/DeploymentService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

let scope: ReturnType<typeof restoreScope>;
let factory: any;
let DeploymentService: any;

function makeFactory() {
  return {
    deploymentRepo: {
      exists: async (_id: string) => false,
      getById: async (_id: string) => null,
      list: async () => [],
      create: async (r: any) => ({ ...r }),
      update: async (id: string, r: any) => ({ id, ...r }),
      delete: async (_id: string) => undefined,
      updateStatus: async (_id: string, _s: string, _ts?: string) => undefined,
    },
    assignmentRepo: {
      listByBucket: async (_p: string, _b: string, _s?: string) => [] as any[],
      listByDeployment: async (_d: string, _s?: string) => [] as any[],
      create: async (_a: any) => undefined,
      deleteByDeployment: async (_d: string) => undefined,
    },
    metricsRepo: {
      create: async (_m: any) => undefined,
      deleteByDeployment: async (_d: string) => undefined,
    },
    healthReportRepo: {
      getByDeploymentId: async (_d: string) => null as any,
      createOrUpdate: async (_h: any) => undefined,
      deleteByDeployment: async (_d: string) => undefined,
    },
    configVersionRepo: {
      getVersion: async () => 1,
      incrementVersion: async () => undefined,
    },
    dataSourceRepo: {
      getByName: async (_p: string, _n: string) => null as any,
      list: async (_p: string, _f?: any) => [] as any[],
    },
    projectRepo: {
      list: async () => [] as any[],
    },
    bucketHealthRepo: {
      createOrUpdate: async (_b: any) => undefined,
    },
  };
}

beforeEach(() => {
  factory = makeFactory();
  scope = restoreScope();
  scope.add(mockModule('repositories/RepositoryFactory', { getRepositoryFactory: () => factory }));
  DeploymentService = loadFresh('services/DeploymentService').DeploymentService;
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/DeploymentService');
  mock.restoreAll();
});

const NOW = () => new Date().toISOString();
const OLD = () => new Date(Date.now() - 200_000).toISOString();

// ---- evaluateDeploymentHealthStatus (pure) ----

test('evaluateDeploymentHealthStatus: recent healthy report -> healthy', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus({ healthy: true, timestamp: NOW() }, { status: 'x' });
  assert.equal(r, 'healthy');
});

test('evaluateDeploymentHealthStatus: recent unhealthy report -> unhealthy', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus({ healthy: false, timestamp: NOW() }, null);
  assert.equal(r, 'unhealthy');
});

test('evaluateDeploymentHealthStatus: stale report -> unhealthy', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus({ healthy: true, timestamp: OLD() }, null);
  assert.equal(r, 'unhealthy');
});

test('evaluateDeploymentHealthStatus: no report, recent last_health_check + healthy status', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus(null, { status: 'healthy', last_health_check: NOW() });
  assert.equal(r, 'healthy');
});

test('evaluateDeploymentHealthStatus: no report, recent last_health_check + unhealthy status', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus(null, { status: 'unhealthy', last_health_check: new Date() });
  assert.equal(r, 'unhealthy');
});

test('evaluateDeploymentHealthStatus: no report, stale last_health_check -> unhealthy', () => {
  const r = DeploymentService.evaluateDeploymentHealthStatus(null, { status: 'healthy', last_health_check: OLD() });
  assert.equal(r, 'unhealthy');
});

test('evaluateDeploymentHealthStatus: no info -> deployment status or unknown', () => {
  assert.equal(DeploymentService.evaluateDeploymentHealthStatus(null, { status: 'healthy' }), 'healthy');
  assert.equal(DeploymentService.evaluateDeploymentHealthStatus(null, null), 'unknown');
});

// ---- registerDeployment ----

test('registerDeployment validates required fields', async () => {
  await assert.rejects(DeploymentService.registerDeployment({}), /Deployment ID is required/);
  await assert.rejects(DeploymentService.registerDeployment({ id: 'd1' }), /Region is required/);
  await assert.rejects(DeploymentService.registerDeployment({ id: 'd1', region: 'us' }), /Endpoint is required/);
});

test('registerDeployment creates a new deployment', async () => {
  mock.method(DeploymentService, 'reassignBucketsForDeployment', async () => undefined);
  factory.deploymentRepo.exists = async () => false;
  factory.deploymentRepo.create = async (r: any) => ({ ...r });
  const d = await DeploymentService.registerDeployment({ id: 'd1', region: 'us', endpoint: 'http://e' });
  assert.equal(d.id, 'd1');
});

test('registerDeployment updates on re-registration', async () => {
  mock.method(DeploymentService, 'reassignBucketsForDeployment', async () => undefined);
  factory.deploymentRepo.exists = async () => true;
  factory.deploymentRepo.update = async (id: string, r: any) => ({ id, region: r.region });
  const d = await DeploymentService.registerDeployment({ id: 'd1', region: 'eu', endpoint: 'http://e' });
  assert.equal(d.region, 'eu');
});

// ---- getDeployment / update / delete / list ----

test('getDeployment returns or throws NotFoundError', async () => {
  factory.deploymentRepo.getById = async () => ({ id: 'd1' });
  assert.equal((await DeploymentService.getDeployment('d1')).id, 'd1');
  factory.deploymentRepo.getById = async () => null;
  await assert.rejects(DeploymentService.getDeployment('missing'), /not found/);
});

test('updateDeployment throws NotFoundError when missing', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.updateDeployment('d1', {}), /not found/);
});

test('updateDeployment updates an existing deployment', async () => {
  mock.method(DeploymentService, 'reassignBucketsForDeployment', async () => undefined);
  factory.deploymentRepo.exists = async () => true;
  factory.deploymentRepo.update = async (id: string) => ({ id, region: 'us' });
  const d = await DeploymentService.updateDeployment('d1', { endpoint: 'http://x' });
  assert.equal(d.id, 'd1');
});

test('deleteDeployment throws NotFoundError when missing', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.deleteDeployment('d1'), /not found/);
});

test('deleteDeployment removes associated data', async () => {
  factory.deploymentRepo.exists = async () => true;
  const delDeploy = mock.fn(async () => undefined);
  factory.deploymentRepo.delete = delDeploy;
  await DeploymentService.deleteDeployment('d1');
  assert.equal(delDeploy.mock.callCount(), 1);
});

test('listDeployments returns the repository list', async () => {
  factory.deploymentRepo.list = async () => [{ id: 'd1' }, { id: 'd2' }];
  assert.equal((await DeploymentService.listDeployments()).length, 2);
});

// ---- getBucketRouting ----

test('getBucketRouting validates inputs', async () => {
  await assert.rejects(DeploymentService.getBucketRouting('', 'b'), /Project ID is required/);
  await assert.rejects(DeploymentService.getBucketRouting('p', ''), /Bucket Name is required/);
});

test('getBucketRouting throws NotFoundError when no assignments', async () => {
  factory.assignmentRepo.listByBucket = async () => [];
  await assert.rejects(DeploymentService.getBucketRouting('p', 'b'), /not found/);
});

test('getBucketRouting builds routing info and skips missing deployments', async () => {
  factory.assignmentRepo.listByBucket = async () => [
    { deployment_id: 'd1', role: 'primary', priority: 100 },
    { deployment_id: 'gone', role: 'secondary', priority: 50 },
  ];
  factory.deploymentRepo.getById = async (id: string) =>
    id === 'd1' ? { id: 'd1', endpoint: 'http://d1', status: 'healthy' } : null;
  factory.healthReportRepo.getByDeploymentId = async () => ({ healthy: true, timestamp: NOW() });
  const res = await DeploymentService.getBucketRouting('p', 'b');
  assert.equal(res.deployments.length, 1);
  assert.equal(res.deployments[0].deployment_id, 'd1');
  assert.equal(res.routing_strategy, 'load_balance');
});

// ---- getDeploymentConfig ----

test('getDeploymentConfig assembles volume bucket configs and skips non-volumes', async () => {
  factory.assignmentRepo.listByDeployment = async () => [
    { project_id: 'p', bucket_name: 'vol', role: 'primary' },
    { project_id: 'p', bucket_name: 'nope', role: 'primary' },
  ];
  factory.dataSourceRepo.getByName = async (_p: string, name: string) =>
    name === 'vol'
      ? { name: 'vol', type: 'volume', volume_config: { region: 'us', volume_info: {}, auth_info: {}, protocol: 'nfs' } }
      : null;
  factory.assignmentRepo.listByBucket = async () => [{ deployment_id: 'd1', role: 'primary' }];
  const res = await DeploymentService.getDeploymentConfig('d1');
  assert.equal(res.buckets.length, 1);
  assert.equal(res.buckets[0].bucket_name, 'vol');
  assert.equal(res.config_version, 1);
});

// ---- reassignBucketsForDeployment ----

test('reassignBucketsForDeployment throws NotFoundError when deployment missing', async () => {
  factory.deploymentRepo.getById = async () => null;
  await assert.rejects(DeploymentService.reassignBucketsForDeployment('d1', 'us'), /not found/);
});

test('reassignBucketsForDeployment skips when at capacity', async () => {
  factory.deploymentRepo.getById = async () => ({ id: 'd1', capacity: { max_buckets: 1 } });
  factory.assignmentRepo.listByDeployment = async () => [{ deployment_id: 'd1' }];
  await assert.doesNotReject(DeploymentService.reassignBucketsForDeployment('d1', 'us'));
});

test('reassignBucketsForDeployment assigns matching unassigned buckets', async () => {
  const assign = mock.method(DeploymentService, 'assignBucketToDeployments', async () => undefined);
  factory.deploymentRepo.getById = async () => ({ id: 'd1', capacity: undefined });
  factory.assignmentRepo.listByDeployment = async () => [];
  factory.projectRepo.list = async () => [{ id: 'p1' }];
  factory.dataSourceRepo.list = async () => [{ project_id: 'p1', name: 'b', volume_config: { region: 'us' } }];
  factory.assignmentRepo.listByBucket = async () => [];
  await DeploymentService.reassignBucketsForDeployment('d1', 'us');
  assert.equal(assign.mock.callCount(), 1);
});

// ---- assignBucketToDeployment ----

test('assignBucketToDeployment validates inputs', async () => {
  await assert.rejects(DeploymentService.assignBucketToDeployment('', 'b', 'd'), /Project ID is required/);
  await assert.rejects(DeploymentService.assignBucketToDeployment('p', '', 'd'), /Bucket Name is required/);
  await assert.rejects(DeploymentService.assignBucketToDeployment('p', 'b', ''), /Deployment ID is required/);
});

test('assignBucketToDeployment throws NotFoundError for unknown deployment', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.assignBucketToDeployment('p', 'b', 'd'), /not found/);
});

test('assignBucketToDeployment throws NotFoundError when volume is missing', async () => {
  factory.deploymentRepo.exists = async () => true;
  factory.dataSourceRepo.getByName = async () => null;
  await assert.rejects(DeploymentService.assignBucketToDeployment('p', 'b', 'd'), /DataSource \(volume\)/);
});

test('assignBucketToDeployment is a no-op when assignment exists', async () => {
  factory.deploymentRepo.exists = async () => true;
  factory.dataSourceRepo.getByName = async () => ({ type: 'volume', name: 'b' });
  factory.assignmentRepo.listByBucket = async () => [{ deployment_id: 'd' }];
  const create = mock.fn(async () => undefined);
  factory.assignmentRepo.create = create;
  await DeploymentService.assignBucketToDeployment('p', 'b', 'd');
  assert.equal(create.mock.callCount(), 0);
});

test('assignBucketToDeployment creates a new assignment', async () => {
  factory.deploymentRepo.exists = async () => true;
  factory.dataSourceRepo.getByName = async () => ({ type: 'volume', name: 'b' });
  factory.assignmentRepo.listByBucket = async () => [];
  const create = mock.fn(async () => undefined);
  factory.assignmentRepo.create = create;
  const inc = mock.fn(async () => undefined);
  factory.configVersionRepo.incrementVersion = inc;
  await DeploymentService.assignBucketToDeployment('p', 'b', 'd');
  assert.equal(create.mock.callCount(), 1);
  assert.equal(inc.mock.callCount(), 1);
});

// ---- assignBucketToDeployments ----

test('assignBucketToDeployments validates inputs', async () => {
  await assert.rejects(DeploymentService.assignBucketToDeployments('', 'b', 'us'), /Project ID is required/);
  await assert.rejects(DeploymentService.assignBucketToDeployments('p', '', 'us'), /Bucket Name is required/);
  await assert.rejects(DeploymentService.assignBucketToDeployments('p', 'b', ''), /Bucket Region is required/);
});

test('assignBucketToDeployments skips when bucket already assigned', async () => {
  factory.assignmentRepo.listByBucket = async () => [{ deployment_id: 'd1' }];
  const assignOne = mock.method(DeploymentService, 'assignBucketToDeployment', async () => undefined);
  await DeploymentService.assignBucketToDeployments('p', 'b', 'us');
  assert.equal(assignOne.mock.callCount(), 0);
});

test('assignBucketToDeployments returns when no deployments exist', async () => {
  factory.assignmentRepo.listByBucket = async () => [];
  factory.deploymentRepo.list = async () => [];
  await assert.doesNotReject(DeploymentService.assignBucketToDeployments('p', 'b', 'us'));
});

test('assignBucketToDeployments assigns primary and secondary by score', async () => {
  factory.assignmentRepo.listByBucket = async () => [];
  factory.deploymentRepo.list = async () => [
    { id: 'd1', region: 'us', capacity: { max_buckets: 10 } },
    { id: 'd2', region: 'eu', capacity: undefined },
  ];
  factory.assignmentRepo.listByDeployment = async () => [];
  const assignOne = mock.method(DeploymentService, 'assignBucketToDeployment', async () => undefined);
  await DeploymentService.assignBucketToDeployments('p', 'b', 'us');
  assert.equal(assignOne.mock.callCount(), 2);
  // Best score (same region + capacity) should be assigned primary first.
  assert.equal(assignOne.mock.calls[0].arguments[2], 'd1');
  assert.equal(assignOne.mock.calls[0].arguments[3], 'primary');
});

// ---- submitMetrics / submitHealthReport / getDeploymentHealth ----

test('submitMetrics throws NotFoundError when deployment missing', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.submitMetrics('d1', { metrics: {} }), /not found/);
});

test('submitMetrics records metrics', async () => {
  factory.deploymentRepo.exists = async () => true;
  const create = mock.fn(async () => undefined);
  factory.metricsRepo.create = create;
  await DeploymentService.submitMetrics('d1', { metrics: { cpu: 1 }, bucket_metrics: [] });
  assert.equal(create.mock.callCount(), 1);
});

test('submitHealthReport throws NotFoundError when deployment missing', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.submitHealthReport('d1', { healthy: true }), /not found/);
});

test('submitHealthReport updates status and processes bucket health', async () => {
  factory.deploymentRepo.exists = async () => true;
  const updateStatus = mock.fn(async () => undefined);
  factory.deploymentRepo.updateStatus = updateStatus;
  const bucketUpdate = mock.fn(async () => undefined);
  factory.bucketHealthRepo.createOrUpdate = bucketUpdate;
  factory.dataSourceRepo.getByName = async () => ({ type: 'volume', name: 'b' });
  await DeploymentService.submitHealthReport('d1', {
    healthy: true,
    timestamp: NOW(),
    bucket_health: [{ project_id: 'p', bucket_name: 'b', healthy: true }],
  });
  assert.equal(updateStatus.mock.callCount(), 1);
  assert.equal(bucketUpdate.mock.callCount(), 1);
});

test('submitHealthReport skips unknown buckets', async () => {
  factory.deploymentRepo.exists = async () => true;
  const bucketUpdate = mock.fn(async () => undefined);
  factory.bucketHealthRepo.createOrUpdate = bucketUpdate;
  factory.dataSourceRepo.getByName = async () => null;
  await DeploymentService.submitHealthReport('d1', {
    healthy: false,
    bucket_health: [{ project_id: 'p', bucket_name: 'missing' }],
  });
  assert.equal(bucketUpdate.mock.callCount(), 0);
});

test('getDeploymentHealth throws NotFoundError when deployment missing', async () => {
  factory.deploymentRepo.exists = async () => false;
  await assert.rejects(DeploymentService.getDeploymentHealth('d1'), /not found/);
});

test('getDeploymentHealth reports the evaluated status', async () => {
  factory.deploymentRepo.exists = async () => true;
  factory.healthReportRepo.getByDeploymentId = async () => ({ healthy: true, timestamp: NOW(), status_message: 'ok' });
  factory.deploymentRepo.getById = async () => ({ id: 'd1', status: 'healthy' });
  const res = await DeploymentService.getDeploymentHealth('d1');
  assert.equal(res.healthy, true);
  assert.equal(res.status, 'healthy');
});
