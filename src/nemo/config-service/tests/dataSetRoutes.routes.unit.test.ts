/**
 * Route-handler tests for routes/dataSetRoutes.ts.
 *
 * DataSetService, ManifestService, LakekeeperCatalogService and (dynamically
 * imported) DatasetImportService are module-mocked so the route never reaches
 * Lakekeeper / workflow-engine / S3. FacetService and ReferenceEdgeService run
 * real against the AppDataSource fake-repo seam. axios.get (live-progress
 * polling) is stubbed. No DB, no network.
 *
 * Run: node --require ts-node/register --test tests/dataSetRoutes.routes.unit.test.ts
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
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/datasets`;
const PROJECT_ROW = { id: PROJECT, name: 'Test Project', home_dir: `s3://default-nemo/projects/${PROJECT}` };

let handle: FakeDataSourceHandle;
let app: Express;
let scope: ReturnType<typeof restoreScope>;

// Mutable doubles reset in every beforeEach so tests can override per-case.
let dss: any; // DataSetService static surface
let lake: any; // LakekeeperCatalogService instance surface
let importWorkflowId: string | null;
// workflow-engine `post` used by the acquire proxy route; tests override to
// simulate success or an upstream error.
let acquireProxy: (...args: any[]) => Promise<any>;

// LakekeeperCatalogService is constructed once at route module load; delegate
// its methods to the per-test `lake` object so overrides take effect.
class FakeLakekeeper {
  getTableSnapshots(...a: any[]) {
    return lake.getTableSnapshots(...a);
  }
  getCurrentSnapshotId(...a: any[]) {
    return lake.getCurrentSnapshotId(...a);
  }
  expireSnapshot(...a: any[]) {
    return lake.expireSnapshot(...a);
  }
  setCurrentSnapshot(...a: any[]) {
    return lake.setCurrentSnapshot(...a);
  }
}

class FakeImportService {
  startDatasetImport(..._a: any[]) {
    return Promise.resolve(importWorkflowId);
  }
}

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => PROJECT_ROW }),
  });

  dss = {
    createDataSet: async (_p: string, body: any) => ({ id: 'ds00000001', projectId: PROJECT, status: 'ready', ...body }),
    listDataSets: async () => [{ id: 'ds00000001', projectId: PROJECT, name: 'd1', status: 'ready' }],
    getDataSet: async (id: string) => ({ id, projectId: PROJECT, name: 'd1', status: 'ready', kind: 'unstructured' }),
    updateDataSet: async (id: string, _p: string, body: any) => ({ id, projectId: PROJECT, ...body }),
    deleteDataSet: async () => ({ workflowId: 'wf-del-1' }),
    restoreDataSetVersion: async (id: string) => ({ id, projectId: PROJECT, name: 'restored' }),
    updateDatasetStatus: async (_p: string, id: string, status: string) => ({ id, projectId: PROJECT, status }),
    updateDatasetJobId: async () => undefined,
  };
  lake = {
    getTableSnapshots: async () => [],
    getCurrentSnapshotId: async () => null,
    expireSnapshot: async () => ({ newCurrentSnapshotId: null }),
    setCurrentSnapshot: async () => undefined,
  };
  importWorkflowId = 'wf-import-1';
  acquireProxy = async () => ({
    data: { workflowId: 'wf-acq-1', status: 'started', datasetId: 'ds00000001' },
  });

  scope = restoreScope();
  scope.add(mockModule('services/DataSetService', { DataSetService: dss }));
  scope.add(
    mockModule('services/ManifestService', {
      ManifestService: { prepareDatasetReimport: async () => undefined },
    }),
  );
  scope.add(mockModule('services/LakekeeperCatalogService', { LakekeeperCatalogService: FakeLakekeeper }));
  scope.add(mockModule('services/DatasetImportService', { DatasetImportService: FakeImportService }));
  // Stub the workflow-engine client so acquire/import routes never make real
  // network calls. POST /:id/import dynamically imports DatasetImportService,
  // which uses this client — route import URLs to a synthetic workflowId.
  scope.add(
    mockModule('@agentstudio/common', {
      ServiceAccountClient: class ServiceAccountClient {},
      createServiceAccountClientFromEnv: () => ({
        createAuthenticatedClient: () => ({
          post: async (url: string, ...args: any[]) => {
            if (typeof url === 'string' && url.includes('/import')) {
              return { status: 202, data: { workflowId: importWorkflowId ?? 'wf-import-1' } };
            }
            return acquireProxy(url, ...args);
          },
        }),
      }),
    }),
  );

  const router = loadFresh('routes/dataSetRoutes').default;
  app = buildApp({ basePath: '/api/v1/projects/:projectId/datasets', router });

  mock.method(axios, 'get', async () => ({ status: 200, data: {} }));
});

afterEach(() => {
  mock.restoreAll();
  scope.restoreAll();
  clearModule('routes/dataSetRoutes');
  handle.restore();
});

// ---------------------------------------------------------------------------
// POST / (create)
// ---------------------------------------------------------------------------
test('POST /datasets: creates a dataset (201)', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'my-dataset', type: 'manual', kind: 'unstructured' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'ds00000001');
});

test('POST /datasets: service conflict propagates as 409', async () => {
  const { ConflictError } = require('../utils/errors');
  dss.createDataSet = async () => {
    throw new ConflictError('A dataset with this name already exists');
  };
  const res = await request(app, 'POST', BASE, {
    body: { name: 'dup', type: 'manual', kind: 'unstructured' },
  });
  assert.equal(res.status, 409);
});

// ---------------------------------------------------------------------------
// GET / (list)
// ---------------------------------------------------------------------------
test('GET /datasets: lists with dependentsSummary (200)', async () => {
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds00000001');
  assert.ok(res.body[0].dependentsSummary);
  assert.equal(res.body[0].dependentsSummary.total, 0);
});

test('GET /datasets: include=dependentsSummary=false skips summary', async () => {
  const res = await request(app, 'GET', `${BASE}?include=${encodeURIComponent('dependentsSummary=false')}`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds00000001');
  assert.equal('dependentsSummary' in res.body[0], false);
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
test('GET /datasets/:id: returns dataset (200)', async () => {
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'ds00000001');
});

test('GET /datasets/:id: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other-project', status: 'ready' });
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 404);
});

test('GET /datasets/:id: enriches with data source name/type, sync status and latest_snapshot', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'd1',
    status: 'ready',
    kind: 'unstructured',
    originConnector: 'cn-1',
    scheduleConfig: { cronExpression: '0 0 * * *', timezone: 'UTC', enabled: true },
    latestSnapshot: { snapshotId: 5, version: 2, timestampMs: 1700000000000, totalFiles: 9, filesAdded: 9, filesRemoved: 0 },
  });
  handle.repos.DataSource = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'cn-1', name: 'My Connector' }] }),
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dataSourceName, 'My Connector');
  assert.equal(res.body.data_source_type, 'connector');
  assert.equal(res.body.synchronization_status, 'Completed');
  assert.equal(res.body.synchronization_summary.schedule, '0 0 * * *');
  assert.equal(res.body.latest_snapshot.id, '5');
  assert.equal(res.body.latest_snapshot.version, 2);
  assert.equal(res.body.latest_snapshot.total_files, 9);
});

test('GET /datasets/:id: manual (upload) datasets report synchronization_status by import lifecycle', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'manual-ds',
    type: 'manual',
    status: 'ready',
    kind: 'unstructured',
  });
  const readyRes = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(readyRes.status, 200);
  assert.equal(readyRes.body.synchronization_status, 'Never');
  assert.equal(readyRes.body.synchronization_summary.status, 'Never');

  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'manual-ds',
    type: 'manual',
    status: 'in_progress',
    kind: 'unstructured',
  });
  const importingRes = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(importingRes.body.synchronization_status, 'Synchronizing');

  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'manual-ds',
    type: 'manual',
    status: 'errored',
    kind: 'unstructured',
  });
  const failedRes = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(failedRes.body.synchronization_status, 'Failed');
});

test('GET /datasets/:id: manual (upload) datasets report null schedule/last-completed/next-scheduled sync fields', async () => {
  // Even if a manual dataset has residual scheduleConfig/refreshConfig/latestSnapshot
  // data (e.g. leftover from before a type change, or an import completing), the
  // Sync tab fields must stay null — sync doesn't apply to manual uploads.
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'manual-ds',
    type: 'manual',
    status: 'ready',
    kind: 'unstructured',
    scheduleConfig: { cronExpression: '0 0 * * *', timezone: 'UTC', enabled: true },
    refreshConfig: { schedule_type: 'daily', time_of_day: '03:00' },
    latestSnapshot: { snapshotId: 5, version: 2, timestampMs: 1700000000000, totalFiles: 9, filesAdded: 9, filesRemoved: 0 },
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.synchronization_summary.schedule, null);
  assert.equal(res.body.synchronization_summary.last_completed_synchronization, null);
  assert.equal(res.body.synchronization_summary.next_scheduled_synchronization, null);
  // latest_snapshot (the data-version projection) is unaffected — it's still useful.
  assert.equal(res.body.latest_snapshot.version, 2);
});

test('GET /datasets/:id: computes next_scheduled_synchronization from refresh_config', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'd1',
    status: 'ready',
    kind: 'unstructured',
    originConnector: 'cn-1',
    scheduleConfig: { cronExpression: '0 3 * * *', timezone: 'UTC', enabled: true },
    refreshConfig: {
      auto_refresh_enabled: true,
      paused: false,
      schedule_type: 'daily',
      time_of_day: '03:00',
      timezone: 'UTC',
    },
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  const next = res.body.synchronization_summary.next_scheduled_synchronization;
  assert.ok(typeof next === 'string' && next.length > 0, 'expected an ISO next-run string');
  // Daily 03:00 UTC → the ISO timestamp always lands on the top of the hour.
  assert.match(next, /T03:00:00\.000Z$/);
  assert.ok(new Date(next).getTime() > Date.now(), 'next run must be in the future');
});

test('GET /datasets/:id: next_scheduled_synchronization null when auto-refresh disabled', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'd1',
    status: 'ready',
    kind: 'unstructured',
    originConnector: 'cn-1',
    refreshConfig: {
      auto_refresh_enabled: false,
      paused: false,
      schedule_type: 'daily',
      time_of_day: '03:00',
      timezone: 'UTC',
    },
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.synchronization_summary.next_scheduled_synchronization, null);
});

// ---------------------------------------------------------------------------
// PUT /:id
// ---------------------------------------------------------------------------
test('PUT /datasets/:id: updates dataset (200)', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001`, { body: { description: 'updated' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'updated');
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
test('DELETE /datasets/:id: deletes when no dependents (200)', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.workflowId, 'wf-del-1');
});

test('DELETE /datasets/:id: blocked by dependents returns 409', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  const res = await request(app, 'DELETE', `${BASE}/ds00000001`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HAS_DEPENDENTS');
  assert.ok(res.body.dependents);
});

// ---------------------------------------------------------------------------
// GET /:id/dependents
// ---------------------------------------------------------------------------
test('GET /datasets/:id/dependents: returns a page (200)', async () => {
  const res = await request(app, 'GET', `${BASE}/ds00000001/dependents?limit=10`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /datasets/:id/dependents: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other-project' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/dependents`);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// GET /:id/knowledge-bases
// ---------------------------------------------------------------------------
test('GET /datasets/:id/knowledge-bases: lists consuming knowledge bases (200)', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: 'kb-1',
            name: 'kb one',
            status: 'ready',
            labels: [],
            scheduleConfig: { cronExpression: '0 0 * * *' },
            stats: { fileCount: 3 },
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001/knowledge-bases`);
  assert.equal(res.status, 200);
  assert.equal(res.body.dataset_id, 'ds00000001');
  assert.equal(res.body.knowledge_bases[0].id, 'kb-1');
  assert.equal(res.body.knowledge_bases[0].name, 'kb one');
});

test('GET /datasets/:id/knowledge-bases: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other-project', name: 'd1' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/knowledge-bases`);
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// GET /:id/snapshots
// ---------------------------------------------------------------------------
function readyCatalogDataset(id = 'ds00000001') {
  return { id, projectId: PROJECT, status: 'ready', namespace: 'nemo.projtest', catalogTableName: 'my_table' };
}

test('GET /datasets/:id/snapshots: lists snapshots (200)', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.getTableSnapshots = async () => [
    { 'snapshot-id': 11, 'parent-snapshot-id': null, 'timestamp-ms': 1700000000000, summary: { operation: 'append' } },
  ];
  lake.getCurrentSnapshotId = async () => 11;
  const res = await request(app, 'GET', `${BASE}/ds00000001/snapshots`);
  assert.equal(res.status, 200);
  assert.equal(res.body.currentSnapshotId, 11);
  assert.equal(res.body.snapshots[0].snapshotId, 11);
});

test('GET /datasets/:id/snapshots: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other', status: 'ready', namespace: 'a.b', catalogTableName: 't' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/snapshots`);
  assert.equal(res.status, 404);
});

test('GET /datasets/:id/snapshots: no catalog table returns 409', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'ready' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/snapshots`);
  assert.equal(res.status, 409);
});

test('GET /datasets/:id/snapshots: import in progress returns 409', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'in_progress', namespace: 'a.b', catalogTableName: 't' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/snapshots`);
  assert.equal(res.status, 409);
});

// ---------------------------------------------------------------------------
// POST /:id/snapshots/:snapshotId/expire
// ---------------------------------------------------------------------------
test('POST /datasets/:id/snapshots/:snapshotId/expire: invalid id returns 400', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/not-a-number/expire`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /datasets/:id/snapshots/:snapshotId/expire: expires (200)', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.expireSnapshot = async () => ({ newCurrentSnapshotId: 9 });
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/11/expire`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.expired, 11);
  assert.equal(res.body.newCurrentSnapshotId, 9);
});

test('POST /datasets/:id/snapshots/:snapshotId/expire: not found maps to 404', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.expireSnapshot = async () => {
    throw new Error('snapshot 11 not found');
  };
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/11/expire`, { body: {} });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// POST /:id/snapshots/:snapshotId/set-current
// ---------------------------------------------------------------------------
test('POST /datasets/:id/snapshots/:snapshotId/set-current: unknown snapshot 404', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.getTableSnapshots = async () => [{ 'snapshot-id': 11 }];
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/999/set-current`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasets/:id/snapshots/:snapshotId/set-current: sets current (200)', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.getTableSnapshots = async () => [{ 'snapshot-id': 11 }, { 'snapshot-id': 12 }];
  lake.getCurrentSnapshotId = async () => 12;
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/11/set-current`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.currentSnapshotId, 11);
  assert.equal(res.body.previousSnapshotId, 12);
});

// ---------------------------------------------------------------------------
// GET /:id/history
// ---------------------------------------------------------------------------
test('GET /datasets/:id/history: no history returns 404', async () => {
  handle.repos.DataSetHistory = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/ds00000001/history`);
  assert.equal(res.status, 404);
});

test('GET /datasets/:id/history: returns history (200)', async () => {
  handle.repos.DataSetHistory = makeFakeRepo({ find: async () => [{ version: 2 }, { version: 1 }] });
  const res = await request(app, 'GET', `${BASE}/ds00000001/history`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// ---------------------------------------------------------------------------
// POST /:id/restore-version
// ---------------------------------------------------------------------------
test('POST /datasets/:id/restore-version: missing version returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/ds00000001/restore-version`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /datasets/:id/restore-version: restores (200)', async () => {
  const res = await request(app, 'POST', `${BASE}/ds00000001/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 200);
  assert.equal(res.body.restored, true);
});

// ---------------------------------------------------------------------------
// PATCH /:id
// ---------------------------------------------------------------------------
test('PATCH /datasets/:id: not found returns 404', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'PATCH', `${BASE}/ds00000001`, { body: { acquisitionConfig: { watermark: 1 } } });
  assert.equal(res.status, 404);
});

test('PATCH /datasets/:id: merges acquisitionConfig (200)', async () => {
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({ id: 'ds00000001', projectId: PROJECT, acquisitionConfig: { watermark: 1 } }),
    save: async (e: any) => e,
  });
  const res = await request(app, 'PATCH', `${BASE}/ds00000001`, { body: { acquisitionConfig: { watermark: 2 } } });
  assert.equal(res.status, 200);
  assert.equal(res.body.acquisitionConfig.watermark, 2);
});

// ---------------------------------------------------------------------------
// PUT /:id/status
// ---------------------------------------------------------------------------
test('PUT /datasets/:id/status: invalid status returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001/status`, { body: { status: 'bogus' } });
  assert.equal(res.status, 400);
});

test('PUT /datasets/:id/status: updates status (200)', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001/status`, { body: { status: 'ready' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ready');
});

// ---------------------------------------------------------------------------
// POST /:id/import
// ---------------------------------------------------------------------------
test('POST /datasets/:id/import: triggers import workflow (202)', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'd1',
    kind: 'unstructured',
    namespace: 'nemo.projtest',
    warehouseName: 'nemo',
  });
  const res = await request(app, 'POST', `${BASE}/ds00000001/import`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.workflowId, 'wf-import-1');
  assert.equal(res.body.status, 'running');
});

test('POST /datasets/:id/import: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other', name: 'd1', kind: 'unstructured' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/import`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasets/:id/import: PII facet in progress returns 400', async () => {
  handle.repos.Facet = makeFakeRepo({ findOne: async () => ({ state: 'in_progress' }) });
  const res = await request(app, 'POST', `${BASE}/ds00000001/import`, { body: {} });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// POST /:id/acquire (proxy to workflow-engine)
// ---------------------------------------------------------------------------
test('POST /datasets/:id/acquire: forwards workflow-engine response verbatim (202)', async () => {
  const res = await request(app, 'POST', `${BASE}/ds00000001/acquire`, { body: {} });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, {
    workflowId: 'wf-acq-1',
    status: 'started',
    datasetId: 'ds00000001',
  });
});

test('POST /datasets/:id/acquire: maps workflow-engine error to its status/message', async () => {
  acquireProxy = async () => {
    throw { response: { status: 502, data: { error: 'workflow-engine unavailable' } } };
  };
  const res = await request(app, 'POST', `${BASE}/ds00000001/acquire`, { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'workflow-engine unavailable');
});

test('POST /datasets/:id/acquire: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other-project', status: 'ready' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/acquire`, { body: {} });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Facet routes
// ---------------------------------------------------------------------------
test('GET /datasets/:id/facets: lists facets (200)', async () => {
  handle.repos.Facet = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/ds00000001/facets`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.facets, []);
});

test('GET /datasets/:id/facets: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other', status: 'ready' });
  const res = await request(app, 'GET', `${BASE}/ds00000001/facets`);
  assert.equal(res.status, 404);
});

test('GET /datasets/:id/facets/:facetType: not found returns 404', async () => {
  handle.repos.Facet = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/ds00000001/facets/pii`);
  assert.equal(res.status, 404);
});

test('GET /datasets/:id/facets/:facetType: returns facet (200)', async () => {
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({ projectId: PROJECT, entityType: 'dataset', entityId: 'ds00000001', facetType: 'pii', state: 'ready' }),
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001/facets/pii`);
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
});

test('PUT /datasets/:id/facets/:facetType: invalid state returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001/facets/pii`, { body: { state: 'nope' } });
  assert.equal(res.status, 400);
});

test('PUT /datasets/:id/facets/:facetType: upserts facet state (200)', async () => {
  handle.repos.Facet = makeFakeRepo({ findOne: async () => null, save: async (e: any) => e, create: (d: any) => ({ ...d }) });
  const res = await request(app, 'PUT', `${BASE}/ds00000001/facets/pii`, { body: { state: 'ready' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
});

test('PUT /datasets/:id/facets/:facetType: jobId mismatch returns 409', async () => {
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({ projectId: PROJECT, entityType: 'dataset', entityId: 'ds00000001', facetType: 'pii', state: 'in_progress', jobId: 'job-A' }),
  });
  const res = await request(app, 'PUT', `${BASE}/ds00000001/facets/pii`, {
    body: { state: 'in_progress', jobId: 'job-B' },
  });
  assert.equal(res.status, 409);
});

test('POST /datasets/:id/facets/:facetType/run: project mismatch returns 404', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: 'other', status: 'ready' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasets/:id/facets/:facetType/run: dataset in progress returns 400', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'in_progress' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /datasets/:id/facets/:facetType/run: unknown facet returns 400', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'ready' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/unknown/run`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /datasets/:id/facets/pii/run: starts PII reprocess (202)', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    status: 'ready',
    name: 'd1',
    kind: 'unstructured',
    namespace: 'nemo.projtest',
    warehouseName: 'nemo',
  });
  handle.repos.Facet = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ execute: { affected: 0 } }),
    findOne: async () => null,
    save: async (e: any) => e,
    create: (d: any) => ({ ...d }),
  });
  handle.repos.DataSet = makeFakeRepo({ save: async (e: any) => e });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.workflowId, 'wf-import-1');
  assert.equal(res.body.status, 'started');
});

test('GET /datasets/:id/dependents: returns 500 when lookup fails', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'ready' });
  handle.query.mock.mockImplementation(async () => {
    throw new Error('dataset dependents failed');
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001/dependents`);
  assert.equal(res.status, 500);
});

test('POST /datasets/:id/import: returns 500 when workflow dispatch returns null', async () => {
  importWorkflowId = null;
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    name: 'd1',
    kind: 'unstructured',
    namespace: 'nemo.projtest',
    warehouseName: 'nemo',
  });
  const res = await request(app, 'POST', `${BASE}/ds00000001/import`, { body: {} });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /Failed to start import workflow/);
});

test('POST /datasets/:id/import: dataset not found returns 404', async () => {
  dss.getDataSet = async () => null as any;
  const res = await request(app, 'POST', `${BASE}/ds00000001/import`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /datasets/:id/facets/:facetType/run: rejects pending dataset status', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, status: 'pending' });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /ready.*errored/);
});

test('POST /datasets/:id/facets/pii/run: returns 500 when workflow id is null', async () => {
  importWorkflowId = null;
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    status: 'ready',
    name: 'd1',
    kind: 'unstructured',
    namespace: 'nemo.projtest',
    warehouseName: 'nemo',
  });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => null,
    save: async (e: any) => e,
    create: (d: any) => ({ ...d }),
  });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /Failed to start PII reprocessing workflow/);
});

test('PUT /datasets/:id/facets/:facetType: returns 500 on unexpected facet update error', async () => {
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => {
      throw new Error('facet update exploded');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ds00000001/facets/pii`, { body: { state: 'ready' } });
  assert.equal(res.status, 500);
});

test('PUT /datasets/:id/facets/:facetType: invalid state returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001/facets/pii`, { body: { state: 'bogus' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Invalid state/);
});

test('POST /datasets/:id/snapshots/:snapshotId/expire: returns 409 for only snapshot', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.expireSnapshot = async () => {
    throw new Error('cannot expire the only snapshot');
  };
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/11/expire`, { body: {} });
  assert.equal(res.status, 409);
});

test('POST /datasets/:id/snapshots/:snapshotId/expire: returns 500 on unexpected catalog errors', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  lake.expireSnapshot = async () => {
    throw new Error('catalog unavailable');
  };
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/11/expire`, { body: {} });
  assert.equal(res.status, 500);
});

test('POST /datasets/:id/snapshots/:snapshotId/set-current: invalid snapshot id returns 400', async () => {
  dss.getDataSet = async () => readyCatalogDataset();
  const res = await request(app, 'POST', `${BASE}/ds00000001/snapshots/not-a-number/set-current`, { body: {} });
  assert.equal(res.status, 400);
});

test('GET /datasets/:id/history: returns 500 when history query fails', async () => {
  handle.repos.DataSetHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001/history`);
  assert.equal(res.status, 500);
});

test('POST /datasets/:id/restore-version: returns 500 when service throws', async () => {
  dss.restoreDataSetVersion = async () => {
    throw new Error('DataSet not found');
  };
  const res = await request(app, 'POST', `${BASE}/dsmissing1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
});

test('DELETE /datasets/:id: returns 500 when delete fails', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  dss.deleteDataSet = async () => {
    throw new Error('delete exploded');
  };
  const res = await request(app, 'DELETE', `${BASE}/ds00000001`);
  assert.equal(res.status, 500);
});

test('POST /datasets: returns 500 when service throws', async () => {
  dss.createDataSet = async () => {
    throw new Error('create exploded');
  };
  const res = await request(app, 'POST', BASE, {
    body: { name: 'my-dataset', type: 'manual', kind: 'unstructured' },
  });
  assert.equal(res.status, 500);
});

test('GET /datasets: enriches in-progress datasets with live workflow progress', async () => {
  dss.listDataSets = async () => [{
    id: 'ds00000001',
    projectId: PROJECT,
    name: 'd1',
    status: 'in_progress',
    jobId: 'wf-live-1',
    progress: { phase: 'old', percentage: 1 },
  }];
  mock.restoreAll();
  mock.method(axios, 'get', async (url: string) => {
    if (String(url).includes('/progress')) {
      return {
        status: 200,
        data: { phase: 'import', percentage: 55, extra: { filesProcessed: 2 } },
      };
    }
    return { status: 200, data: {} };
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].progress.phase, 'import');
  assert.equal(res.body[0].progress.percentage, 55);
});

test('POST /datasets/:id/facets/pii/run: returns already_running when facet is in progress', async () => {
  dss.getDataSet = async (id: string) => ({
    id,
    projectId: PROJECT,
    status: 'ready',
    name: 'd1',
    kind: 'unstructured',
    namespace: 'nemo.projtest',
    warehouseName: 'nemo',
  });
  handle.repos.Facet = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ execute: { affected: 0 } }),
    findOne: async () => ({
      projectId: PROJECT,
      entityType: 'dataset',
      entityId: 'ds00000001',
      facetType: 'pii',
      state: 'in_progress',
      jobId: 'wf-existing',
    }),
    save: async (e: any) => e,
    create: (d: any) => ({ ...d }),
  });
  handle.repos.DataSet = makeFakeRepo({ save: async (e: any) => e });
  const res = await request(app, 'POST', `${BASE}/ds00000001/facets/pii/run`, { body: {} });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'already_running');
});

test('POST /datasets/:id/acquire: returns 502 on generic network error', async () => {
  acquireProxy = async () => {
    throw new Error('connection reset');
  };
  const res = await request(app, 'POST', `${BASE}/ds00000001/acquire`, { body: {} });
  assert.equal(res.status, 502);
});

test('GET /datasets/:id/knowledge-bases: returns 500 when query fails', async () => {
  dss.getDataSet = async (id: string) => ({ id, projectId: PROJECT, name: 'd1', status: 'ready' });
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          orderBy: () => ({
            getMany: async () => {
              throw new Error('kb query failed');
            },
          }),
        }),
      }),
    }),
  });
  const res = await request(app, 'GET', `${BASE}/ds00000001/knowledge-bases`);
  assert.equal(res.status, 500);
});

test('PUT /datasets/:id/status: missing status returns 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/ds00000001/status`, { body: {} });
  assert.equal(res.status, 400);
});

test('DELETE /datasets/:id: omits workflow message when cleanup workflow id missing', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  dss.deleteDataSet = async () => ({ workflowId: undefined });
  const res = await request(app, 'DELETE', `${BASE}/ds00000001`);
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Dataset deleted.');
});
