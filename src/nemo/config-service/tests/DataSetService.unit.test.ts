/**
 * Unit tests for services/DataSetService.ts.
 *
 * Module-mocked seams (installed before the SUT is loaded):
 *   - axios (workflow-engine schedule client)
 *   - services/LakekeeperCatalogService (catalog table reads/writes)
 *   - repositories/ProjectRepository (project home_dir lookup)
 *   - services/ManifestService (manual-upload manifest mgmt)
 *   - services/DatasetDeleteService (deletion workflow)
 *   - services/KnowledgeBaseScheduleService (KB fan-out)
 * FacetService and DataSetValidator run real against the fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/DataSetService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';
const HOME_DIR = 's3://test-bucket/projects/p1';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let DataSetService: any;

// Controllable seam state, reset per test.
let we: { post: (...a: any[]) => Promise<any>; delete: (...a: any[]) => Promise<any> };
let lake: any;
let proj: any;
let manifest: any;
let del: any;
let kb: any;

beforeEach(() => {
  handle = installFakeRepositories({
    DataSet: makeFakeRepo({ findOne: async () => null, create: (d: any) => ({ ...d, id: 'ds1' }), save: async (e: any) => e }),
    Facet: makeFakeRepo({ find: async () => [] }),
    DataSetHistory: makeFakeRepo({ find: async () => [] }),
  });

  we = {
    post: async () => ({ data: { temporalScheduleId: 'sch-1' } }),
    delete: async () => ({ data: {} }),
  };
  const weClient = { post: (...a: any[]) => we.post(...a), delete: (...a: any[]) => we.delete(...a) };
  lake = {
    getTable: async () => ({ metadata: { properties: {} }, name: 'tbl' }),
    updateTableMetadata: async () => undefined,
    getTableSnapshots: async () => [],
    getCurrentSnapshotId: async () => null,
  };
  proj = { getById: async () => ({ id: PROJECT, home_dir: HOME_DIR, metadata: {} }), update: async () => undefined };
  manifest = {
    listManifests: async () => [],
    createManifest: async () => ({ id: 'm1', status: 'draft' }),
    replaceManifestFiles: async () => ({ id: 'm1', status: 'draft' }),
    updateManifestStatus: async () => ({ id: 'm1', status: 'committed' }),
    countFiles: async () => 0,
  };
  del = {
    terminateDatasetWorkflows: async () => [],
    startDatasetDeletion: async () => 'wf-del',
  };
  kb = { fanOutAfterDatasetReady: async () => undefined };

  scope = restoreScope();
  scope.add(mockModule('axios', { create: () => weClient }));
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        getTable(...a: any[]) {
          return lake.getTable(...a);
        }
        updateTableMetadata(...a: any[]) {
          return lake.updateTableMetadata(...a);
        }
        getTableSnapshots(...a: any[]) {
          return lake.getTableSnapshots(...a);
        }
        getCurrentSnapshotId(...a: any[]) {
          return lake.getCurrentSnapshotId(...a);
        }
      },
    }),
  );
  scope.add(
    mockModule('repositories/ProjectRepository', {
      ProjectRepository: class {
        getById(...a: any[]) {
          return proj.getById(...a);
        }
        update(...a: any[]) {
          return proj.update(...a);
        }
      },
    }),
  );
  scope.add(
    mockModule('services/ManifestService', {
      ManifestService: {
        listManifests: (...a: any[]) => manifest.listManifests(...a),
        createManifest: (...a: any[]) => manifest.createManifest(...a),
        replaceManifestFiles: (...a: any[]) => manifest.replaceManifestFiles(...a),
        updateManifestStatus: (...a: any[]) => manifest.updateManifestStatus(...a),
        countFiles: (...a: any[]) => manifest.countFiles(...a),
      },
    }),
  );
  scope.add(
    mockModule('services/DatasetDeleteService', {
      DatasetDeleteService: class {
        terminateDatasetWorkflows(...a: any[]) {
          return del.terminateDatasetWorkflows(...a);
        }
        startDatasetDeletion(...a: any[]) {
          return del.startDatasetDeletion(...a);
        }
      },
    }),
  );
  scope.add(
    mockModule('services/KnowledgeBaseScheduleService', {
      KnowledgeBaseScheduleService: {
        fanOutAfterDatasetReady: (...a: any[]) => kb.fanOutAfterDatasetReady(...a),
      },
    }),
  );

  DataSetService = loadFresh('services/DataSetService').DataSetService;
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/DataSetService');
  handle.restore();
  mock.restoreAll();
  delete process.env.MANUAL_UPLOAD_MAX_FILE_BYTES;
});

function seedDataSet(overrides: Record<string, any>) {
  handle.repos.DataSet = makeFakeRepo(overrides);
}

// ---- createDataSet ----

test('createDataSet throws NotFoundError when the project is missing', async () => {
  proj.getById = async () => null;
  await assert.rejects(
    DataSetService.createDataSet(PROJECT, { name: 'good_name', kind: 'unstructured' } as any),
    /Project.*not found/,
  );
});

test('createDataSet rejects an invalid dataset name', async () => {
  await assert.rejects(
    DataSetService.createDataSet(PROJECT, { name: 'Bad Name!', kind: 'unstructured' } as any),
    /Dataset name/,
  );
});

test('createDataSet rejects a duplicate name', async () => {
  seedDataSet({ findOne: async () => ({ id: 'dup', name: 'taken' }) });
  await assert.rejects(
    DataSetService.createDataSet(PROJECT, { name: 'taken', kind: 'unstructured' } as any),
    /already exists/,
  );
});

test('createDataSet defaults an omitted description to empty string (optional, no 500)', async () => {
  const ds = await DataSetService.createDataSet(PROJECT, {
    name: 'no_desc',
    type: 'manual',
    kind: 'unstructured',
  } as any);
  assert.equal(ds.description, '');
});

test('createDataSet persists a dataset derived from the project home_dir', async () => {
  const ds = await DataSetService.createDataSet(PROJECT, {
    name: 'my_dataset',
    description: 'd',
    type: 'manual',
    kind: 'unstructured',
  } as any);
  assert.equal(ds.bucketName, 'test-bucket');
  assert.equal(ds.status, 'in_progress');
  assert.equal(ds.warehouseName, 'nemo');
  assert.equal(ds.namespace, PROJECT);
  assert.equal(ds.catalogTableName, 'my_dataset');
});

test('createDataSet tears down the schedule when refresh is disabled', async () => {
  const ds = await DataSetService.createDataSet(PROJECT, {
    name: 'sched_off',
    description: 'd',
    type: 'manual',
    kind: 'unstructured',
    refreshConfig: { auto_refresh_enabled: false } as any,
  } as any);
  assert.equal(ds.scheduleConfig.enabled, false);
});

test('createDataSet creates a Temporal schedule when refresh is enabled', async () => {
  we.post = async () => ({ data: { temporalScheduleId: 'sch-xyz' } });
  const ds = await DataSetService.createDataSet(PROJECT, {
    name: 'sched_on',
    description: 'd',
    type: 'manual',
    kind: 'unstructured',
    refreshConfig: { auto_refresh_enabled: true, schedule_type: 'daily', time_of_day: '02:30', timezone: 'UTC' } as any,
  } as any);
  assert.equal(ds.scheduleConfig.enabled, true);
  assert.equal(ds.scheduleConfig.temporalScheduleId, 'sch-xyz');
  assert.equal(ds.scheduleConfig.cronExpression, '30 2 * * *');
});

test('createDataSet persists the derived cron even if the schedule API fails', async () => {
  we.post = async () => {
    throw new Error('engine down');
  };
  const ds = await DataSetService.createDataSet(PROJECT, {
    name: 'sched_err',
    description: 'd',
    type: 'manual',
    kind: 'unstructured',
    refreshConfig: { auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 120, timezone: 'UTC' } as any,
  } as any);
  assert.equal(ds.scheduleConfig.enabled, true);
  assert.equal(ds.scheduleConfig.cronExpression, '0 */2 * * *');
});

// ---- getDataSet ----

test('getDataSet without catalog returns the row or throws NotFoundError', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }) });
  assert.equal((await DataSetService.getDataSet('ds1', false)).id, 'ds1');
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.getDataSet('missing', false), /not found/);
});

test('getDataSet with catalog merges catalogTable and facets and strips piiSummary', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      catalogTableRef: 'ns.tbl',
      namespace: PROJECT,
      catalogTableName: 'tbl',
      piiSummary: { totalFiles: 1 },
    }),
  });
  handle.repos.Facet = makeFakeRepo({ find: async () => [{ facetType: 'tags' }] });
  const ds = await DataSetService.getDataSet('ds1');
  assert.ok(ds.catalogTable);
  assert.ok(Array.isArray(ds.facets));
  assert.equal((ds as any).piiSummary, undefined);
});

test('getDataSet swallows catalog lookup failures', async () => {
  lake.getTable = async () => {
    throw new Error('catalog down');
  };
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, catalogTableRef: 'ns.tbl', namespace: PROJECT, catalogTableName: 'tbl' }),
  });
  const ds = await DataSetService.getDataSet('ds1');
  assert.equal(ds.catalogTable, null);
});

// ---- updateDataSet ----

test('updateDataSet throws NotFoundError when missing', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.updateDataSet('ds1', PROJECT, { description: 'x' }), /not found/);
});

test('updateDataSet enforces immutable type via the validator', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT, type: 'manual', kind: 'unstructured' }) });
  await assert.rejects(
    DataSetService.updateDataSet('ds1', PROJECT, { type: 'acquired' }),
    /Cannot change dataset type/,
  );
});

test('updateDataSet rejects oversized manual uploads', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILE_BYTES = '100';
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT, name: 'n', status: 'in_progress' }), save: async (e: any) => e });
  await assert.rejects(
    DataSetService.updateDataSet('ds1', PROJECT, {
      uploadedFiles: [{ key: 'k', url: 'u', size: 1000, originalName: 'big.bin' }],
    }),
    /exceed the per-file limit/,
  );
});

test('updateDataSet applies uploaded files via the manifest service', async () => {
  const createManifest = mock.fn(async () => ({ id: 'm1', status: 'draft' }));
  manifest.createManifest = createManifest;
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, name: 'n', status: 'in_progress' }),
    save: async (e: any) => e,
  });
  const res = await DataSetService.updateDataSet('ds1', PROJECT, {
    uploadedFiles: [{ key: 'k', url: 's3://test-bucket/data_files/a.txt' }],
  });
  assert.equal(createManifest.mock.callCount(), 1);
  assert.equal(res.id, 'ds1');
});

test('updateDataSet updates catalog table properties when a catalog ref exists', async () => {
  const updateMeta = mock.fn(async () => undefined);
  lake.updateTableMetadata = updateMeta;
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      name: 'n',
      catalogTableRef: 'ns.tbl',
      namespace: PROJECT,
      catalogTableName: 'tbl',
    }),
    save: async (e: any) => e,
  });
  await DataSetService.updateDataSet('ds1', PROJECT, { description: 'new desc' });
  assert.equal(updateMeta.mock.callCount(), 1);
});

test('updateDataSet triggers acquisition when acquisition scope changes', async () => {
  const acquirePost = mock.fn(async () => ({ data: { workflowId: 'wf-acq' } }));
  we.post = acquirePost;
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      name: 'n',
      type: 'acquired',
      originVolume: 'vol-1',
      filterSpec: { paths: ['/old'] },
    }),
    save: async (e: any) => e,
  });
  await DataSetService.updateDataSet('ds1', PROJECT, {
    filterSpec: { paths: ['/new'] },
  });
  assert.equal(acquirePost.mock.callCount(), 1);
  const [url] = acquirePost.mock.calls[0].arguments as unknown as [string];
  assert.match(url, /\/datasets\/ds1\/acquire$/);
});

// ---- deleteDataSet ----

test('deleteDataSet throws NotFoundError when missing', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.deleteDataSet('ds1', PROJECT), /not found/);
});

test('deleteDataSet without catalog refs just deletes the record', async () => {
  const del0 = mock.fn(async () => ({ affected: 1 }));
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }), delete: del0 });
  const res = await DataSetService.deleteDataSet('ds1', PROJECT);
  assert.equal(res.workflowId, undefined);
  assert.equal(del0.mock.callCount(), 1);
});

test('deleteDataSet triggers the deletion workflow when a catalog table exists', async () => {
  del.startDatasetDeletion = async () => 'wf-123';
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, catalogTableRef: 'ns.tbl', namespace: PROJECT, catalogTableName: 'tbl' }),
    delete: async () => ({ affected: 1 }),
  });
  const res = await DataSetService.deleteDataSet('ds1', PROJECT);
  assert.equal(res.workflowId, 'wf-123');
});

test('deleteDataSet tears down the Temporal schedule when one exists', async () => {
  const del0 = mock.fn(async () => ({ data: {} }));
  we.delete = del0;
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      scheduleConfig: { cronExpression: '0 */2 * * *', timezone: 'UTC', temporalScheduleId: 'sch-xyz', enabled: true },
    }),
    delete: async () => ({ affected: 1 }),
  });
  await DataSetService.deleteDataSet('ds1', PROJECT);
  assert.equal(del0.mock.callCount(), 1);
  // URL targets the dataset schedule endpoint; temporalScheduleId is sent in the body.
  const [url, opts] = del0.mock.calls[0].arguments as unknown as [string, any];
  assert.match(url, /\/datasets\/ds1\/schedule$/);
  assert.equal(opts.data.temporalScheduleId, 'sch-xyz');
});

test('deleteDataSet skips schedule teardown when no temporalScheduleId is set', async () => {
  const del0 = mock.fn(async () => ({ data: {} }));
  we.delete = del0;
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT }),
    delete: async () => ({ affected: 1 }),
  });
  await DataSetService.deleteDataSet('ds1', PROJECT);
  assert.equal(del0.mock.callCount(), 0);
});

// ---- listDataSets ----

test('listDataSets requires a projectId', async () => {
  await assert.rejects(DataSetService.listDataSets({ projectId: '' }), /projectId is required/);
});

test('listDataSets returns [] when no datasets match', async () => {
  seedDataSet({ createQueryBuilder: () => makeQueryBuilder({ many: [] }) });
  assert.deepEqual(await DataSetService.listDataSets({ projectId: PROJECT }), []);
});

test('listDataSets attaches facets and strips piiSummary', async () => {
  seedDataSet({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ds1', projectId: PROJECT, piiSummary: { totalFiles: 2 } }] }),
  });
  handle.repos.Facet = makeFakeRepo({ find: async () => [{ entityId: 'ds1', facetType: 'tags' }] });
  const rows = await DataSetService.listDataSets({ projectId: PROJECT });
  assert.equal(rows.length, 1);
  assert.ok(Array.isArray(rows[0].facets));
  assert.equal((rows[0] as any).piiSummary, undefined);
});

// ---- restoreDataSetVersion / history ----

test('restoreDataSetVersion throws NotFoundError for a missing dataset', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.restoreDataSetVersion('ds1', PROJECT, 1), /DataSet with id ds1/);
});

test('restoreDataSetVersion throws NotFoundError for a missing version', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }), save: async (e: any) => e });
  handle.repos.DataSetHistory = makeFakeRepo({ findOne: async () => null });
  await assert.rejects(DataSetService.restoreDataSetVersion('ds1', PROJECT, 9), /DataSetHistory/);
});

test('restoreDataSetVersion restores fields from history', async () => {
  // Shared row reference so the post-restore re-fetch observes the mutation.
  const row: any = { id: 'ds1', projectId: PROJECT, description: 'old' };
  seedDataSet({ findOne: async () => row, save: async (e: any) => e });
  handle.repos.DataSetHistory = makeFakeRepo({
    findOne: async () => ({ version: 2, data: { id: 'ds1', description: 'restored', name: 'n' } }),
  });
  const ds = await DataSetService.restoreDataSetVersion('ds1', PROJECT, 2);
  assert.equal(ds.description, 'restored');
});

test('getDataSetHistory returns history ordered by version', async () => {
  handle.repos.DataSetHistory = makeFakeRepo({ find: async () => [{ version: 2 }, { version: 1 }] });
  const hist = await DataSetService.getDataSetHistory('ds1');
  assert.equal(hist.length, 2);
});

// ---- updateDatasetStatus / updateDatasetJobId ----

test('updateDatasetStatus throws NotFoundError when missing', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready'), /not found/);
});

test('updateDatasetStatus fans out KB reprocess when transitioning to ready', async () => {
  const fan = mock.fn(async () => undefined);
  kb.fanOutAfterDatasetReady = fan;
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT, status: 'in_progress' }), save: async (e: any) => e });
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  assert.equal(fan.mock.callCount(), 1);
});

test('updateDatasetStatus records an error message on errored', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT, status: 'in_progress' }), save: async (e: any) => e });
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'errored', 'kaboom');
  assert.equal(ds.status, 'errored');
  assert.equal(ds.errorMessage, 'kaboom');
});

test('updateDatasetStatus captures stats + latestSnapshot from the catalog on ready', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      type: 'acquired',
      status: 'in_progress',
      catalogTableRef: 'nemo.tbl',
      namespace: 'nemo',
      catalogTableName: 'tbl',
    }),
    save: async (e: any) => e,
  });
  lake.getTableSnapshots = async () => [
    {
      'snapshot-id': 11,
      'timestamp-ms': 1700000000000,
      summary: { 'total-data-files': '7', 'added-data-files': '7', 'deleted-data-files': '0', 'total-records': '42' },
    },
  ];
  lake.getCurrentSnapshotId = async () => 11;

  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  assert.equal(ds.stats.sourceFileCount, 7);
  assert.equal(ds.stats.rowCount, 42);
  assert.equal(ds.latestSnapshot.snapshotId, 11);
  assert.equal(ds.latestSnapshot.version, 1);
  assert.equal(ds.latestSnapshot.totalFiles, 7);
});

test('updateDatasetStatus leaves summary untouched when the catalog read fails', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      type: 'acquired',
      status: 'in_progress',
      catalogTableRef: 'nemo.tbl',
      namespace: 'nemo',
      catalogTableName: 'tbl',
    }),
    save: async (e: any) => e,
  });
  lake.getTableSnapshots = async () => {
    throw new Error('catalog down');
  };
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  assert.equal(ds.stats, undefined);
  assert.equal(ds.latestSnapshot, undefined);
});

test('updateDatasetStatus counts manifest files for manual datasets even when the catalog read fails', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      type: 'manual',
      status: 'in_progress',
      catalogTableRef: 'nemo.tbl',
      namespace: 'nemo',
      catalogTableName: 'tbl',
      warehouseName: 'nemo',
    }),
    save: async (e: any) => e,
  });
  // Catalog read fails, but a manual dataset's file count comes from the
  // manifest and must still be captured.
  lake.getTableSnapshots = async () => {
    throw new Error('catalog down');
  };
  manifest.countFiles = async () => 5;
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  assert.equal(ds.stats.sourceFileCount, 5);
  assert.equal(ds.latestSnapshot, undefined);
});

test('updateDatasetStatus forwards the dataset warehouse to the catalog read', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      type: 'acquired',
      status: 'in_progress',
      catalogTableRef: 'nemo.tbl',
      namespace: 'nemo',
      catalogTableName: 'tbl',
      warehouseName: 'nemo',
    }),
    save: async (e: any) => e,
  });
  let snapshotArgs: any[] = [];
  lake.getTableSnapshots = async (...a: any[]) => {
    snapshotArgs = a;
    return [];
  };
  lake.getCurrentSnapshotId = async () => null;
  await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.deepEqual(snapshotArgs, [['nemo'], 'tbl', 'nemo']);
});

test('updateDatasetJobId throws NotFoundError when missing', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(DataSetService.updateDatasetJobId(PROJECT, 'ds1', 'job-1'), /not found/);
});

test('updateDatasetJobId stores the job id', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }), save: async (e: any) => e });
  const ds = await DataSetService.updateDatasetJobId(PROJECT, 'ds1', 'job-42');
  assert.equal(ds.jobId, 'job-42');
});

test('listDataSets includes catalog metadata when requested', async () => {
  seedDataSet({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [{
          id: 'ds1',
          projectId: PROJECT,
          catalogTableRef: 'nemo.tbl',
          namespace: 'projtest0001.datasets',
          catalogTableName: 'events',
          warehouseName: 'nemo',
        }],
      }),
  });
  lake.getTable = async () => ({ metadata: { name: 'events' }, name: 'events' });
  const rows = await DataSetService.listDataSets({ projectId: PROJECT, includeCatalog: true });
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).catalogTable?.name, 'events');
});

test('listDataSets tolerates catalog lookup failures', async () => {
  seedDataSet({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [{
          id: 'ds1',
          projectId: PROJECT,
          catalogTableRef: 'nemo.tbl',
          namespace: 'projtest0001.datasets',
          catalogTableName: 'events',
          warehouseName: 'nemo',
        }],
      }),
  });
  lake.getTable = async () => {
    throw new Error('catalog down');
  };
  const rows = await DataSetService.listDataSets({ projectId: PROJECT, includeCatalog: true });
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).catalogTable, undefined);
});

test('updateDatasetStatus does not fan out when already ready', async () => {
  const fan = mock.fn(async () => undefined);
  kb.fanOutAfterDatasetReady = fan;
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, status: 'ready' }),
    save: async (e: any) => e,
  });
  await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(fan.mock.callCount(), 0);
});

test('updateDatasetStatus tolerates fan-out failures in background', async () => {
  kb.fanOutAfterDatasetReady = async () => {
    throw new Error('fan-out failed');
  };
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, status: 'in_progress' }),
    save: async (e: any) => e,
  });
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('updateDatasetStatus leaves stats empty when manual manifest count fails', async () => {
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      type: 'manual',
      status: 'in_progress',
      catalogTableRef: 'nemo.tbl',
      namespace: 'nemo',
      catalogTableName: 'tbl',
    }),
    save: async (e: any) => e,
  });
  lake.getTableSnapshots = async () => [];
  lake.getCurrentSnapshotId = async () => null;
  manifest.countFiles = async () => {
    throw new Error('manifest unavailable');
  };
  const ds = await DataSetService.updateDatasetStatus(PROJECT, 'ds1', 'ready');
  assert.equal(ds.status, 'ready');
  assert.equal(ds.stats, undefined);
});
