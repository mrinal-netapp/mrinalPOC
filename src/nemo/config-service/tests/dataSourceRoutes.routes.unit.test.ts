/**
 * Route-handler tests for routes/dataSourceRoutes.ts.
 *
 * DB access flows through DataSourceRepository over the AppDataSource fake-repo
 * seam. The workflow-engine client is built at module load from either a
 * ServiceAccountClient (Keycloak env) or a plain axios instance; both paths end
 * in `axios.create(...)`, so we stub `axios.create` to return a controllable
 * fake HTTP client and `loadFresh` the route so it binds the stub. Validators
 * and ReferenceEdgeService run real against the fakes (no DB, no network).
 *
 * Run: node --require ts-node/register --test tests/dataSourceRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { loadFresh, clearModule } from './helpers/moduleMock';
import { baseS3ConnectorCreate } from './helpers/s3Fixtures';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/datasources`;
const PROJECT_ROW = { id: PROJECT, name: 'Test Project', home_dir: `s3://default-nemo/projects/${PROJECT}` };

let handle: FakeDataSourceHandle;
let app: Express;
let wfClient: any;

/** Build an entity-shaped row that survives DataSourceRepository.mapEntityToModel. */
function dsEntity(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'vol000000001',
    projectId: PROJECT,
    name: 'my-volume',
    type: 'volume',
    metadata: {},
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function seedDataSourceRepo(overrides: Record<string, any>) {
  handle.repos.DataSource = makeFakeRepo(overrides);
}

const validVolumeBody = (over: Record<string, any> = {}) => ({
  name: 'my-volume',
  type: 'volume',
  volume_config: {
    region: 'us-east-1',
    volume_info: { type: 'nfs' },
    auth_info: { type: 'none' },
    protocol: 'NFS',
  },
  ...over,
});

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => PROJECT_ROW }),
  });
  wfClient = {
    post: async () => ({ data: {} }),
    get: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    interceptors: { request: { use: () => undefined } },
  };
  // Both the ServiceAccountClient path and the plain-axios fallback build the
  // workflow client via axios.create(...); stub it before the route loads.
  mock.method(axios, 'create', () => wfClient);
  const router = loadFresh('routes/dataSourceRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/datasources', router });
});

afterEach(() => {
  mock.restoreAll();
  clearModule('routes/dataSourceRoutes');
  handle.restore();
});

// ---------------------------------------------------------------------------
// GET / (list)
// ---------------------------------------------------------------------------
test('GET /datasources: lists data sources (200)', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({ many: [dsEntity({ id: 'vol000000001', name: 'a' })] }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'vol000000001');
  assert.equal(res.body[0].name, 'a');
});

test('GET /datasources: project not found returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 404);
});

test('GET /datasources: limit above 100 returns 400', async () => {
  const res = await request(app, 'GET', `${BASE}?limit=101`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  // Error states the accepted range so API consumers can self-correct.
  assert.match(res.body.error, /limit must be an integer between 1 and 100/);
});

// ---------------------------------------------------------------------------
// POST / (create)
// ---------------------------------------------------------------------------
test('POST /datasources: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: '' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /datasources: invalid volume bucket name returns 400 INVALID_NAME', async () => {
  // Passes express-validator (non-empty string) but fails S3 bucket rules.
  const res = await request(app, 'POST', BASE, { body: validVolumeBody({ name: 'AB' }) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_NAME');
});

test('POST /datasources: duplicate name returns 409', async () => {
  seedDataSourceRepo({ count: async () => 1 });
  const res = await request(app, 'POST', BASE, { body: validVolumeBody() });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('POST /datasources: creates a volume data source (201)', async () => {
  seedDataSourceRepo({
    count: async () => 0,
    save: async (e: any) => dsEntity({ ...e, id: 'vol000000001', type: 'volume' }),
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume' }),
  });
  const res = await request(app, 'POST', BASE, { body: validVolumeBody() });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'vol000000001');
  assert.equal(res.body.type, 'volume');
});

test('POST /datasources: creates a connector and records uses_credential reference edge (201)', async () => {
  const credId = 'cred-11111111-1111-1111-1111-111111111111';
  let insertedEdges: Record<string, unknown>[] = [];
  const edgeQb = makeQueryBuilder();
  edgeQb.values = mock.fn((vals: Record<string, unknown> | Record<string, unknown>[]) => {
    insertedEdges = Array.isArray(vals) ? vals : [vals];
    return edgeQb;
  });

  seedDataSourceRepo({
    count: async () => 0,
    save: async (e: Record<string, unknown>) =>
      dsEntity({
        ...e,
        id: 'cn-000000001',
        type: 'connector',
        credentialId: e.credentialId ?? credId,
      }),
    findOne: async () =>
      dsEntity({
        id: 'cn-000000001',
        type: 'connector',
        credentialId: credId,
      }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({
    delete: async () => ({ affected: 0 }),
    createQueryBuilder: () => edgeQb,
  });

  const res = await request(app, 'POST', BASE, { body: baseS3ConnectorCreate() });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'cn-000000001');
  assert.ok(
    insertedEdges.some(
      (e) =>
        e.targetType === 'credential' &&
        e.targetId === credId &&
        e.relation === 'uses_credential' &&
        e.sourceType === 'data_source',
    ),
    `expected uses_credential edge, got ${JSON.stringify(insertedEdges)}`,
  );
});

// ---------------------------------------------------------------------------
// POST /bulk-preflight
// ---------------------------------------------------------------------------
test('POST /datasources/bulk-preflight: empty candidate set returns 200', async () => {
  seedDataSourceRepo({ createQueryBuilder: () => makeQueryBuilder({ many: [] }) });
  const res = await request(app, 'POST', `${BASE}/bulk-preflight`, { body: { filter: { source: 'ontap' } } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, []);
});

test('POST /datasources/bulk-preflight: resolves a candidate via workflow-engine', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          dsEntity({
            id: 'vol000000001',
            type: 'volume',
            metadata: { source: 'ontap', connector_id: 'cn-000000001' },
            volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old/path' } },
          }),
        ],
      }),
  });
  wfClient.post = async () => ({
    data: {
      nodes: [
        {
          resource: { endpoint: 'nfs://new/path', mount_options: ['vers=4.1'] },
          metadata: { mount_preflight: { can_mount: true, blocking: [] } },
        },
      ],
    },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-preflight`, { body: { filter: { source: 'ontap' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].id, 'vol000000001');
  assert.equal(res.body.results[0].proposed_endpoint, 'nfs://new/path');
  assert.equal(res.body.results[0].would_change, true);
});

// ---------------------------------------------------------------------------
// POST /bulk-apply
// ---------------------------------------------------------------------------
test('POST /datasources/bulk-apply: missing ids returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: [] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /datasources/bulk-apply: dry-run reports proposed endpoint (200)', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
        volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old' } },
      }),
  });
  wfClient.post = async () => ({
    data: { nodes: [{ resource: { endpoint: 'nfs://new' }, metadata: { mount_preflight: { blocking: [] } } }] },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, {
    body: { ids: ['vol000000001'], dry_run: true },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].ok, true);
  assert.equal(res.body.outcomes[0].dry_run, true);
  assert.equal(res.body.outcomes[0].proposed_endpoint, 'nfs://new');
});

test('POST /datasources/bulk-apply: unknown id reported as not_found (200)', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol-missing'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].ok, false);
  assert.equal(res.body.outcomes[0].error, 'not_found');
});

// ---------------------------------------------------------------------------
// POST /:id/preflight
// ---------------------------------------------------------------------------
test('POST /datasources/:id/preflight: not a volume returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasources/:id/preflight: no ONTAP connector returns 400', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', metadata: {} }),
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'NO_CONNECTOR');
});

test('POST /datasources/:id/preflight: healthy mount (200)', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({ id: 'vol000000001', type: 'volume', metadata: { connector_id: 'cn-000000001' } }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  wfClient.post = async () => ({
    data: { nodes: [{ metadata: { mount_preflight: { can_mount: true, blocking: [] } } }] },
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.mount_health.status, 'healthy');
});

test('POST /datasources/:id/preflight: upstream failure returns 502', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({ id: 'vol000000001', type: 'volume', metadata: { connector_id: 'cn-000000001' } }),
  });
  wfClient.post = async () => {
    throw new Error('connection refused');
  };
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'UPSTREAM_ERROR');
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
test('GET /datasources/:id: found (200) / not found (404)', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001' }) });
  assert.equal((await request(app, 'GET', `${BASE}/vol000000001`)).status, 200);

  seedDataSourceRepo({ findOne: async () => null });
  const missing = await request(app, 'GET', `${BASE}/vol-missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

test('GET /datasources/:id: includes scanned_data_count, modified_by and associated datasets', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        modifiedBy: 'user-123',
        scanResult: {
          completed_at: '2024-01-01T00:00:00.000Z',
          total_files: 4200,
          total_folders: 3,
          total_size_bytes: 10,
          file_type_stats: [],
        },
      }),
  });
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({ many: [{ id: 'ds-1', name: 'd1', originVolume: 'vol000000001' }] }),
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.scanned_data_count, 4200);
  assert.equal(res.body.modified_by, 'user-123');
  assert.equal(res.body.associated_datasets_count, 1);
  assert.equal(res.body.associated_datasets[0].dset_id, 'ds-1');
  assert.equal(res.body.associated_datasets[0].name, 'd1');
});

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------
test('PUT /datasources/:id: updates description (200)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', description: 'old' }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { description: 'updated' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'updated');
});

test('PUT /datasources/:id: empty description clears persisted value (200)', async () => {
  let savedEntity: Record<string, unknown> | undefined;
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', description: 'old' }),
    save: async (e: any) => {
      savedEntity = e;
      return dsEntity({ ...e });
    },
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { description: '' } });
  assert.equal(res.status, 200);
  assert.equal(savedEntity?.description, null);
  assert.equal(res.body.description, undefined);
});

test('PUT /datasources/:id: empty labels array clears persisted value (200)', async () => {
  let savedEntity: Record<string, unknown> | undefined;
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', labels: ['gold'] }),
    save: async (e: any) => {
      savedEntity = e;
      return dsEntity({ ...e });
    },
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { labels: [] } });
  assert.equal(res.status, 200);
  assert.equal(savedEntity?.labels, null);
  assert.equal(res.body.labels, undefined);
});

test('PUT /datasources/:id: labels null leaves existing labels unchanged (200)', async () => {
  let savedEntity: Record<string, unknown> | undefined;
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', labels: ['gold'] }),
    save: async (e: any) => {
      savedEntity = e;
      return dsEntity({ ...e });
    },
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { labels: null } });
  assert.equal(res.status, 200);
  assert.deepEqual(savedEntity?.labels, ['gold']);
});

test('PUT /datasources/:id: not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/vol-missing`, { body: { description: 'x' } });
  assert.equal(res.status, 404);
});

test('PUT /datasources/:id: duplicate name returns 409', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', name: 'old' }),
    count: async () => 1,
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { name: 'taken' } });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('PUT /datasources/:id: scan_config on a connector returns 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  const res = await request(app, 'PUT', `${BASE}/cn-000000001`, {
    body: { scan_config: { scan_depth: 'none' } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('PUT /datasources/:id: invalid volume_config returns 400', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({ id: 'vol000000001', type: 'volume', volumeConfig: { volume_info: { type: 'nfs' } } }),
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, {
    body: { volume_config: { volume_info: { provisioning_mode: 'dynamic' } } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// POST /:id/scan
// ---------------------------------------------------------------------------
test('POST /datasources/:id/scan: not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/vol-missing/scan`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasources/:id/scan: not a volume returns 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  const res = await request(app, 'POST', `${BASE}/cn-000000001/scan`, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('POST /datasources/:id/scan: no scan_config available returns 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', scanConfig: undefined }) });
  const res = await request(app, 'POST', `${BASE}/vol000000001/scan`, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('POST /datasources/:id/scan: triggers workflow with body config (202)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume' }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  let posted = false;
  wfClient.post = async () => {
    posted = true;
    return { data: { workflowId: 'wf-scan-1', status: 'running' } };
  };
  const res = await request(app, 'POST', `${BASE}/vol000000001/scan`, {
    body: { scan_config: { scan_depth: 'all_levels' } },
  });
  assert.equal(res.status, 202);
  assert.equal(posted, true);
});

// ---------------------------------------------------------------------------
// PATCH /:id/connection-test-result
// ---------------------------------------------------------------------------
test('PATCH /datasources/:id/connection-test-result: not found 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'PATCH', `${BASE}/cn-000000001/connection-test-result`, {
    body: { success: true },
  });
  assert.equal(res.status, 404);
});

test('PATCH /datasources/:id/connection-test-result: not a connector 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume' }) });
  const res = await request(app, 'PATCH', `${BASE}/vol000000001/connection-test-result`, {
    body: { success: true },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('PATCH /datasources/:id/connection-test-result: missing success 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  const res = await request(app, 'PATCH', `${BASE}/cn-000000001/connection-test-result`, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('PATCH /datasources/:id/connection-test-result: records result (200)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  const res = await request(app, 'PATCH', `${BASE}/cn-000000001/connection-test-result`, {
    body: { success: true, message: 'ok' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.last_connection_test_status, 'success');
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
test('DELETE /datasources/:id: not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/vol-missing`);
  assert.equal(res.status, 404);
});

test('DELETE /datasources/:id: deletes a volume (204)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume' }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ delete: async () => ({ affected: 0 }) });
  const res = await request(app, 'DELETE', `${BASE}/vol000000001`);
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
});

test('DELETE /datasources/:id: connector terminates workflows then deletes (204)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ delete: async () => ({ affected: 0 }) });
  let terminated = false;
  wfClient.post = async () => {
    terminated = true;
    return { data: {} };
  };
  const res = await request(app, 'DELETE', `${BASE}/cn-000000001`);
  assert.equal(res.status, 204);
  assert.equal(terminated, true);
});

// ---------------------------------------------------------------------------
// GET /:id/datasets
// ---------------------------------------------------------------------------
test('GET /datasources/:id/datasets: not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets`);
  assert.equal(res.status, 404);
});

test('GET /datasources/:id/datasets: lists associated datasets (200)', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: 'ds-000000001',
            name: 'imported',
            type: 'imported',
            kind: 'structured',
            originConnector: 'cn-000000001',
            status: 'ready',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds-000000001');
});

test('GET /datasources/:id/datasets: includes file_scope and synchronization_schedule', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: 'ds-000000001',
            name: 'imported',
            type: 'acquired',
            kind: 'structured',
            originConnector: 'cn-000000001',
            status: 'ready',
            stats: { sourceFileCount: 12 },
            scheduleConfig: { cronExpression: '0 * * * *' },
            labels: ['gold'],
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].file_scope, 12);
  assert.equal(res.body[0].synchronization_schedule, '0 * * * *');
  assert.deepEqual(res.body[0].labels, ['gold']);
});

// ---------------------------------------------------------------------------
// GET /:id/history
// ---------------------------------------------------------------------------
test('GET /datasources/:id/history: data source not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/vol-missing/history`);
  assert.equal(res.status, 404);
});

test('GET /datasources/:id/history: no history returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001' }) });
  handle.repos.DataSourceHistory = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/vol000000001/history`);
  assert.equal(res.status, 404);
});

test('GET /datasources/:id/history: returns history (200)', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001' }) });
  handle.repos.DataSourceHistory = makeFakeRepo({
    find: async () => [{ version: 2 }, { version: 1 }],
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// ---------------------------------------------------------------------------
// POST /:id/restore-version
// ---------------------------------------------------------------------------
test('POST /datasources/:id/restore-version: missing version returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/vol000000001/restore-version`, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /datasources/:id/restore-version: data source not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/vol-missing/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 404);
});

test('POST /datasources/:id/restore-version: version not found returns 404', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001' }) });
  handle.repos.DataSourceHistory = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/vol000000001/restore-version`, { body: { version: 9 } });
  assert.equal(res.status, 404);
});

test('POST /datasources/:id/restore-version: restores (200)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', name: 'restored' }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.DataSourceHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'vol000000001', name: 'restored', type: 'volume' } }),
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.restored, true);
});

test('DELETE /datasources/:id: returns 500 when delete fails', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001' }),
    delete: async () => {
      throw new Error('datasource delete failed');
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/vol000000001`);
  assert.equal(res.status, 500);
});

test('GET /datasources: returns 500 when list fails', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () => ({
      where: () => ({
        orderBy: () => ({
          andWhere: () => ({
            limit: () => ({
              offset: () => ({
                getMany: async () => {
                  throw new Error('list failed');
                },
              }),
            }),
          }),
          limit: () => ({
            offset: () => ({
              getMany: async () => {
                throw new Error('list failed');
              },
            }),
          }),
          offset: () => ({
            getMany: async () => {
              throw new Error('list failed');
            },
          }),
          getMany: async () => {
            throw new Error('list failed');
          },
        }),
      }),
    }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('POST /datasources/bulk-apply: returns 500 when repository lookup throws', async () => {
  seedDataSourceRepo({
    findOne: async () => {
      throw new Error('bulk apply failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 500);
});

test('GET /datasources/:id/history: returns 500 on unexpected errors', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001' }),
  });
  handle.repos.DataSourceHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001/history`);
  assert.equal(res.status, 500);
});

test('POST /datasources/bulk-preflight: reports no_ontap_connector for candidate', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          dsEntity({
            id: 'vol000000001',
            type: 'volume',
            metadata: { source: 'ontap' },
            volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old' } },
          }),
        ],
      }),
  });
  const res = await request(app, 'POST', `${BASE}/bulk-preflight`, { body: { filter: { source: 'ontap' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].error, 'no_ontap_connector');
});

test('POST /datasources/bulk-preflight: surfaces explorer error in result', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          dsEntity({
            id: 'vol000000001',
            type: 'volume',
            metadata: { source: 'ontap', connector_id: 'cn-000000001' },
          }),
        ],
      }),
  });
  wfClient.post = async () => ({
    data: { error: { code: 'EXPLORE_FAIL', message: 'mount resolution failed' } },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-preflight`, { body: { filter: { source: 'ontap' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].error.code, 'EXPLORE_FAIL');
});

test('POST /datasources/bulk-apply: reports no_ontap_connector', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { source: 'ontap' },
      }),
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].error, 'no_ontap_connector');
});

test('POST /datasources/bulk-apply: skips when mount preflight has blocking issues', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { source: 'ontap', connector_id: 'cn-000000001' },
        volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old' } },
      }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  wfClient.post = async () => ({
    data: {
      nodes: [
        {
          resource: { endpoint: 'nfs://blocked' },
          metadata: { mount_preflight: { blocking: ['permission denied'] } },
        },
      ],
    },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].skipped, true);
  assert.ok(res.body.outcomes[0].blocking.length > 0);
});

test('POST /datasources/bulk-apply: reports no_proposed_endpoint when explorer returns empty', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
      }),
  });
  wfClient.post = async () => ({
    data: { nodes: [{ resource: {}, metadata: { mount_preflight: { blocking: [] } } }] },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].error, 'no_proposed_endpoint');
});

test('POST /datasources/bulk-apply: applies endpoint update when not dry-run', async () => {
  let saved: any = null;
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
        volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old' } },
      }),
    save: async (e: any) => {
      saved = e;
      return dsEntity({ ...e });
    },
  });
  wfClient.post = async () => ({
    data: {
      nodes: [
        {
          resource: { endpoint: 'nfs://applied', mount_options: ['vers=4.1'] },
          metadata: { mount_preflight: { can_mount: true, blocking: [] } },
        },
      ],
    },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].ok, true);
  assert.equal(saved?.volumeConfig?.volume_info?.endpoint, 'nfs://applied');
});

test('POST /datasources/:id/preflight: explorer error marks mount unhealthy', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
      }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  wfClient.post = async () => ({
    data: { error: { message: 'explorer mount test failed' } },
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.mount_health.status, 'unhealthy');
});

test('PUT /datasources/:id: re-triggers scan when scan_config changes', async () => {
  let scanTriggered = false;
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        scanConfig: { scan_depth: 'none' },
      }),
    save: async (e: any) => {
      if (e.scanConfig?.scan_depth === 'all_levels') scanTriggered = true;
      return dsEntity({ ...e });
    },
  });
  wfClient.post = async () => ({ data: { workflowId: 'wf-scan-2', status: 'running' } });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, {
    body: { scan_config: { scan_depth: 'all_levels' } },
  });
  assert.equal(res.status, 200);
  assert.equal(scanTriggered, true);
});

test('POST /datasources: volume with scan_depth none marks scan skipped', async () => {
  seedDataSourceRepo({
    count: async () => 0,
    save: async (e: any) => dsEntity({ ...e, id: 'vol000000002', type: 'volume' }),
    findOne: async () =>
      dsEntity({
        id: 'vol000000002',
        type: 'volume',
        scanConfig: { scan_depth: 'none' },
        scanStatus: { state: 'skipped' },
      }),
  });
  const res = await request(app, 'POST', BASE, {
    body: validVolumeBody({ scan_config: { scan_depth: 'none' } }),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.scan_status?.state, 'skipped');
});

test('GET /datasources/:id: returns 500 when lookup fails', async () => {
  seedDataSourceRepo({
    findOne: async () => {
      throw new Error('get failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001`);
  assert.equal(res.status, 500);
});

test('PUT /datasources/:id: returns 500 on unexpected update error', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume' }),
    save: async () => {
      throw new Error('update failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { description: 'boom' } });
  assert.equal(res.status, 500);
});

test('POST /datasources/:id/scan: validation error returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/vol000000001/scan`, {
    body: { scan_config: { scan_depth: 'not-valid' } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('PATCH /datasources/:id/connection-test-result: records failure (200)', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }),
    save: async (e: any) => dsEntity({ ...e }),
  });
  const res = await request(app, 'PATCH', `${BASE}/cn-000000001/connection-test-result`, {
    body: { success: false, message: 'auth failed' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.last_connection_test_status, 'failed');
});

test('GET /datasources/:id/datasets: includeManual adds manual datasets on volume', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', name: 'my-volume' }),
  });
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: 'ds-manual01',
            name: 'manual-ds',
            type: 'manual',
            kind: 'unstructured',
            bucketName: 'my-volume',
            status: 'ready',
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
            updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001/datasets?includeManual=true`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds-manual01');
});

test('GET /datasources/:id/datasets: invalid limit returns 400', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets?limit=5000`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /datasources/:id/restore-version: returns 500 on unexpected errors', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'vol000000001' }) });
  handle.repos.DataSourceHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'vol000000001', name: 'old', type: 'volume' } }),
  });
  handle.repos.DataSource = makeFakeRepo({
    findOne: async () => dsEntity({ id: 'vol000000001' }),
    update: async () => {
      throw new Error('restore write failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
});

test('POST /datasources: returns 500 when create fails', async () => {
  seedDataSourceRepo({
    count: async () => 0,
    save: async () => {
      throw new Error('create failed');
    },
  });
  const res = await request(app, 'POST', BASE, { body: validVolumeBody() });
  assert.equal(res.status, 500);
});

test('GET /datasources/:id/datasets: returns 500 when query fails', async () => {
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          orderBy: () => ({
            take: () => ({
              skip: () => ({
                getMany: async () => {
                  throw new Error('datasets query failed');
                },
              }),
            }),
          }),
        }),
      }),
    }),
  });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets`);
  assert.equal(res.status, 500);
});

test('GET /datasources/:id/datasets: filters by nameRegex', async () => {
  let capturedRegex: string | undefined;
  const qb = makeQueryBuilder({
    many: [
      {
        id: 'ds-filtered',
        name: 'golden-set',
        type: 'imported',
        kind: 'structured',
        originConnector: 'cn-000000001',
        status: 'ready',
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ],
  });
  qb.andWhere = mock.fn((clause: string, params?: Record<string, unknown>) => {
    if (clause.includes('ILIKE')) capturedRegex = String(params?.nameRegex);
    return qb;
  });
  seedDataSourceRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  handle.repos.DataSet = makeFakeRepo({ createQueryBuilder: () => qb });
  const res = await request(app, 'GET', `${BASE}/cn-000000001/datasets?nameRegex=gold`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds-filtered');
  assert.equal(capturedRegex, '%gold%');
});

test('GET /datasources/:id/datasets: volume without includeManual uses originVolume only', async () => {
  let capturedClause = '';
  const qb = makeQueryBuilder({ many: [] });
  qb.andWhere = mock.fn((clause: string) => {
    capturedClause = clause;
    return qb;
  });
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', name: 'my-volume' }),
  });
  handle.repos.DataSet = makeFakeRepo({ createQueryBuilder: () => qb });
  const res = await request(app, 'GET', `${BASE}/vol000000001/datasets`);
  assert.equal(res.status, 200);
  assert.match(capturedClause, /originVolume/);
  assert.ok(!/manualType/.test(capturedClause));
});

test('PATCH /datasources/:id/connection-test-result: returns 500 when update fails', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }),
    save: async () => {
      throw new Error('connection test write failed');
    },
  });
  const res = await request(app, 'PATCH', `${BASE}/cn-000000001/connection-test-result`, {
    body: { success: true },
  });
  assert.equal(res.status, 500);
});

test('DELETE /datasources/:id: connector tolerates workflow terminate failure', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ delete: async () => ({ affected: 0 }) });
  wfClient.post = async () => {
    throw new Error('terminate refused');
  };
  const res = await request(app, 'DELETE', `${BASE}/cn-000000001`);
  assert.equal(res.status, 204);
});

test('GET /datasources: invalid limit zero returns 400', async () => {
  const res = await request(app, 'GET', `${BASE}?limit=0`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('POST /datasources/bulk-apply: surfaces per-id explorer error object in outcome', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
      }),
  });
  wfClient.post = async () => ({
    data: { error: { code: 'RESOLVE_FAIL', message: 'mount resolution failed' } },
  });
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].error.code, 'RESOLVE_FAIL');
});

test('POST /datasources/bulk-apply: catches per-id workflow exceptions in outcomes', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
      }),
  });
  wfClient.post = async () => {
    throw new Error('explorer timeout');
  };
  const res = await request(app, 'POST', `${BASE}/bulk-apply`, { body: { ids: ['vol000000001'] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.outcomes[0].ok, false);
  assert.match(String(res.body.outcomes[0].error), /explorer timeout/);
});

test('POST /datasources/:id/preflight: returns 500 when initial lookup throws', async () => {
  seedDataSourceRepo({
    findOne: async () => {
      throw new Error('preflight lookup failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
});

test('POST /datasources/:id/scan: returns 202 but marks scan failed when workflow start fails', async () => {
  let row = dsEntity({
    id: 'vol000000001',
    type: 'volume',
    scanConfig: { scan_depth: 'all_levels' },
  });
  seedDataSourceRepo({
    findOne: async () => row,
    save: async (e: any) => {
      row = dsEntity({ ...e });
      return row;
    },
  });
  wfClient.post = async () => {
    throw new Error('scan workflow failed');
  };
  const res = await request(app, 'POST', `${BASE}/vol000000001/scan`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.scan_status?.state, 'failed');
  assert.match(String(res.body.scan_status?.last_error), /scan workflow failed/);
});

test('PUT /datasources/:id: returns 500 when repo.save throws during update', async () => {
  seedDataSourceRepo({
    findOne: async () => dsEntity({ id: 'vol000000001', type: 'volume', description: 'old' }),
    save: async () => {
      throw new Error('save failed during update');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/vol000000001`, { body: { description: 'updated' } });
  assert.equal(res.status, 500);
});

test('POST /datasources/bulk-preflight: returns 500 when candidate query throws', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          getMany: async () => {
            throw new Error('bulk preflight failed');
          },
        }),
      }),
    }),
  });
  const res = await request(app, 'POST', `${BASE}/bulk-preflight`, { body: { filter: { source: 'ontap' } } });
  assert.equal(res.status, 500);
});

test('POST /datasources/:id/preflight: forwards axios response error message', async () => {
  seedDataSourceRepo({
    findOne: async () =>
      dsEntity({
        id: 'vol000000001',
        type: 'volume',
        metadata: { connector_id: 'cn-000000001' },
      }),
  });
  wfClient.post = async () => {
    const err: any = new Error('upstream refused');
    err.response = { data: { error: 'workflow-engine down' } };
    throw err;
  };
  const res = await request(app, 'POST', `${BASE}/vol000000001/preflight`, { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'workflow-engine down');
});

test('GET /datasources: returns 500 when list fails', async () => {
  seedDataSourceRepo({
    createQueryBuilder: () => {
      const qb = makeQueryBuilder({ many: [] });
      qb.getMany = async () => {
        throw new Error('datasource list failed');
      };
      return qb;
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});

test('GET /datasources/:id: returns 500 when lookup throws', async () => {
  seedDataSourceRepo({
    findOne: async () => {
      throw new Error('datasource read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/vol000000001`);
  assert.equal(res.status, 500);
});

test('POST /datasources: returns 400 on validation error', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

