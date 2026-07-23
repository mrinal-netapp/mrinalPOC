/**
 * Unit tests for services/KnowledgeBaseScheduleService.ts.
 *
 * Run: node --require ts-node/register --test tests/KnowledgeBaseScheduleService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';
const KB_ID = 'kb-12345678';

function syncCfg(overrides: Record<string, unknown> = {}) {
  return {
    sync_mode: 'manual',
    data_change_threshold_enabled: false,
    ...overrides,
  } as import('../models/KnowledgeBase').KBSynchronizationConfig;
}

function fanOutKbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KB_ID,
    projectId: PROJECT,
    sourceDataset: 'ds-1',
    status: 'ready',
    synchronizationConfig: { sync_mode: 'after_dataset_updates' },
    name: 'kb',
    embeddingModel: 'm-1',
    chunkSize: 512,
    vectorSize: 384,
    dataType: 'text',
    chunkStrategy: 'fixed',
    chunkOverlap: 50,
    indexingMode: 'hybrid',
    ...overrides,
  };
}

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let httpCalls: Array<{ method: string; url: string; body?: unknown; data?: unknown }>;
let KnowledgeBaseScheduleService: typeof import('../services/KnowledgeBaseScheduleService').KnowledgeBaseScheduleService;

function fakeHttpClient() {
  return {
    post: async (url: string, body?: unknown) => {
      httpCalls.push({ method: 'POST', url, body });
      return { data: { temporalScheduleId: 'sched-new-1', workflowId: 'wf-kb-1' } };
    },
    delete: async (url: string, opts?: { data?: unknown }) => {
      httpCalls.push({ method: 'DELETE', url, data: opts?.data });
      return { data: {} };
    },
  };
}

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  httpCalls = [];
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => null,
    }),
  );
  scope.add(
    mockModule('axios', {
      default: { create: () => fakeHttpClient() },
      create: () => fakeHttpClient(),
    }),
  );
  clearModule('services/KnowledgeBaseWorkflowService');
  KnowledgeBaseScheduleService = loadFresh<typeof import('../services/KnowledgeBaseScheduleService')>(
    'services/KnowledgeBaseScheduleService',
  ).KnowledgeBaseScheduleService;
});

afterEach(() => {
  scope.restoreAll();
  clearModule(
    'services/KnowledgeBaseScheduleService',
    'services/KnowledgeBaseWorkflowService',
    'axios',
    '@agentstudio/common',
  );
  handle.restore();
});

test('applySynchronizationConfig: manual mode tears down existing schedule', async () => {
  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({ sync_mode: 'manual' }),
    { cronExpression: '0 0 * * *', timezone: 'UTC', temporalScheduleId: 'sched-old', enabled: true },
  );
  assert.equal(result?.enabled, false);
  assert.equal(result?.temporalScheduleId, undefined);
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'DELETE');
  assert.match(httpCalls[0].url, /\/schedule$/);
});

test('applySynchronizationConfig: scheduled mode creates Temporal schedule', async () => {
  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({
      sync_mode: 'scheduled',
      schedule_type: 'daily',
      time_of_day: '09:30',
      timezone: 'America/Los_Angeles',
    }),
    undefined,
  );
  assert.equal(result?.enabled, true);
  assert.equal(result?.temporalScheduleId, 'sched-new-1');
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'POST');
  const body = httpCalls[0].body as Record<string, unknown>;
  assert.equal(body.enabled, true);
  assert.match(String(body.cronExpression), /30 9/);
});

test('tearDownSchedule: no-op without temporalScheduleId', async () => {
  await KnowledgeBaseScheduleService.tearDownSchedule(PROJECT, KB_ID, { enabled: false, cronExpression: '', timezone: 'UTC' });
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: skips KBs below file-change threshold', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: KB_ID,
            projectId: PROJECT,
            sourceDataset: 'ds-1',
            status: 'ready',
            lastSyncedAt: '2024-01-01T00:00:00Z',
            synchronizationConfig: {
              sync_mode: 'after_dataset_updates',
              data_change_threshold_enabled: true,
              data_change_threshold_value: 5,
            },
            name: 'kb',
            embeddingModel: 'm-1',
            chunkSize: 512,
            vectorSize: 384,
            dataType: 'text',
          },
        ],
      }),
  });
  handle.repos.DataSetManifest = makeFakeRepo({
    find: async () => [{ id: 'mf-1' }],
  });
  handle.repos.DataSetManifestFile = makeFakeRepo({
    count: async () => 2,
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: triggers workflow when threshold met', async () => {
  const kbRow = fanOutKbRow();
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({
      id: PROJECT,
      home_dir: `s3://default-nemo/projects/${PROJECT}`,
    }),
  });
  const kbUpdates: any[] = [];
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [kbRow],
      }),
    findOne: async () => kbRow,
    update: async (_criteria: unknown, patch: any) => {
      kbUpdates.push(patch);
      return { affected: 1 };
    },
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'POST');
  assert.match(httpCalls[0].url, /\/create$/);
  assert.equal(kbUpdates.some((patch) => patch.status === 'in_progress'), true);
  assert.equal(kbUpdates.some((patch) => patch.jobId === 'wf-kb-1'), true);
});

test('applySynchronizationConfig: persists cron when schedule create fails', async () => {
  scope.add(
    mockModule('axios', {
      default: {
        create: () => ({
          post: async () => {
            throw new Error('workflow engine down');
          },
          delete: async () => ({ data: {} }),
        }),
      },
      create: () => ({
        post: async () => {
          throw new Error('workflow engine down');
        },
        delete: async () => ({ data: {} }),
      }),
    }),
  );
  KnowledgeBaseScheduleService = loadFresh<typeof import('../services/KnowledgeBaseScheduleService')>(
    'services/KnowledgeBaseScheduleService',
  ).KnowledgeBaseScheduleService;

  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({
      sync_mode: 'scheduled',
      schedule_type: 'daily',
      time_of_day: '10:00',
      timezone: 'UTC',
    }),
    { cronExpression: '', timezone: 'UTC', temporalScheduleId: 'sched-persist', enabled: false },
  );
  assert.equal(result?.enabled, true);
  assert.equal(result?.temporalScheduleId, 'sched-persist');
  assert.match(result?.cronExpression ?? '', /0 10/);
});

test('tearDownSchedule: deletes schedule when temporalScheduleId is set', async () => {
  await KnowledgeBaseScheduleService.tearDownSchedule(PROJECT, KB_ID, {
    cronExpression: '0 0 * * *',
    timezone: 'UTC',
    temporalScheduleId: 'sched-del',
    enabled: true,
  });
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'DELETE');
  assert.deepEqual(httpCalls[0].data, { temporalScheduleId: 'sched-del' });
});

test('fanOutAfterDatasetReady: skips KBs already in_progress', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: KB_ID,
            projectId: PROJECT,
            sourceDataset: 'ds-1',
            status: 'in_progress',
            synchronizationConfig: { sync_mode: 'after_dataset_updates' },
          },
        ],
      }),
  });
  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: aborts when source dataset is not ready', async () => {
  const kbRow = fanOutKbRow();
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [kbRow],
      }),
    findOne: async () => kbRow,
  });
  // Seed the source dataset in a non-ready state and a present project so the
  // workflow reaches (and is stopped by) the `dataset.status !== 'ready'`
  // guard. Without a DataSet seeded it would short-circuit earlier on the
  // `dataset_not_found` branch, so the not-ready path would never be covered.
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({ id: 'ds-1', projectId: PROJECT, status: 'processing', kind: 'unstructured' }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(httpCalls.length, 0);
  // The reason surfaced by the workflow service must be `dataset_not_ready`
  // (not `dataset_not_found`), proving the status guard is what aborted.
  assert.ok(
    warnings.some((w) => w.includes('dataset_not_ready')),
    'expected the dataset_not_ready reason to be logged',
  );
});

test('applySynchronizationConfig: returns current when cfg is null', async () => {
  const current = { cronExpression: '0 0 * * *', timezone: 'UTC', enabled: false };
  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    null,
    current,
  );
  assert.deepEqual(result, current);
});

test('applySynchronizationConfig: manual mode dispatches DELETE for existing schedule', async () => {
  await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({ sync_mode: 'manual' }),
    { cronExpression: '0 0 * * *', timezone: 'UTC', temporalScheduleId: 'sched-old', enabled: true },
  );
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'DELETE');
});

test('applySynchronizationConfig: tolerates schedule delete failure in manual mode', async () => {
  scope.add(
    mockModule('axios', {
      default: {
        create: () => ({
          post: async () => ({ data: {} }),
          delete: async () => {
            throw new Error('delete failed');
          },
        }),
      },
      create: () => ({
        post: async () => ({ data: {} }),
        delete: async () => {
          throw new Error('delete failed');
        },
      }),
    }),
  );
  KnowledgeBaseScheduleService = loadFresh<typeof import('../services/KnowledgeBaseScheduleService')>(
    'services/KnowledgeBaseScheduleService',
  ).KnowledgeBaseScheduleService;

  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({ sync_mode: 'manual' }),
    { cronExpression: '0 0 * * *', timezone: 'UTC', temporalScheduleId: 'sched-fail', enabled: true },
  );
  assert.equal(result?.enabled, false);
  assert.equal(result?.temporalScheduleId, undefined);
});

test('tearDownSchedule: tolerates delete failure', async () => {
  scope.add(
    mockModule('axios', {
      default: {
        create: () => ({
          post: async () => ({ data: {} }),
          delete: async () => {
            throw new Error('delete failed');
          },
        }),
      },
      create: () => ({
        post: async () => ({ data: {} }),
        delete: async () => {
          throw new Error('delete failed');
        },
      }),
    }),
  );
  KnowledgeBaseScheduleService = loadFresh<typeof import('../services/KnowledgeBaseScheduleService')>(
    'services/KnowledgeBaseScheduleService',
  ).KnowledgeBaseScheduleService;

  await assert.doesNotReject(
    KnowledgeBaseScheduleService.tearDownSchedule(PROJECT, KB_ID, {
      cronExpression: '0 0 * * *',
      timezone: 'UTC',
      temporalScheduleId: 'sched-err',
      enabled: true,
    }),
  );
});

test('fanOutAfterDatasetReady: returns early when KB query fails', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          andWhere: () => ({
            getMany: async () => {
              throw new Error('db down');
            },
          }),
        }),
      }),
    }),
  });
  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: skips when project entity missing', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: KB_ID,
            projectId: PROJECT,
            sourceDataset: 'ds-1',
            status: 'ready',
            synchronizationConfig: { sync_mode: 'after_dataset_updates' },
            name: 'kb',
            embeddingModel: 'm-1',
            chunkSize: 512,
            vectorSize: 384,
            dataType: 'text',
          },
        ],
      }),
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({ id: 'ds-1', projectId: PROJECT, status: 'ready', kind: 'unstructured' }),
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: counts all files when lastSyncedAt is null', async () => {
  const kbRow = fanOutKbRow({
    lastSyncedAt: undefined,
    synchronizationConfig: {
      sync_mode: 'after_dataset_updates',
      data_change_threshold_enabled: true,
      data_change_threshold_value: 1,
    },
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [kbRow] }),
    findOne: async () => kbRow,
    update: async () => ({ affected: 1 }),
  });
  handle.repos.DataSetManifest = makeFakeRepo({
    find: async () => [{ id: 'mf-1' }],
  });
  handle.repos.DataSetManifestFile = makeFakeRepo({
    count: async () => 3,
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].method, 'POST');
  assert.match(httpCalls[0].url, /\/create$/);
});

test('fanOutAfterDatasetReady: logs and continues when one KB trigger fails', async () => {
  // Two eligible KBs so we can prove the loop keeps going after a failure
  // rather than aborting on the first one.
  const kbRows = [fanOutKbRow({ id: 'kb-11111111' }), fanOutKbRow({ id: 'kb-22222222' })];
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: kbRows }),
    findOne: async (q: any) => kbRows.find((r) => r.id === q?.where?.id) ?? null,
    update: async () => ({ affected: 1 }),
  });

  // Every KB's /create dispatch fails; count attempts so we can assert both
  // KBs were actually reached (a silent short-circuit would leave this at 0).
  let createAttempts = 0;
  const post = async (url: string, body?: unknown) => {
    if (typeof url === 'string' && url.includes('/create')) {
      createAttempts += 1;
      throw new Error('workflow dispatch failed');
    }
    httpCalls.push({ method: 'POST', url, body });
    return { data: { temporalScheduleId: 'sched-new-1', workflowId: 'wf-kb-1' } };
  };
  const del = async (url: string, opts?: { data?: unknown }) => {
    httpCalls.push({ method: 'DELETE', url, data: opts?.data });
    return { data: {} };
  };
  scope.add(
    mockModule('axios', {
      default: { create: () => ({ post, delete: del }) },
      create: () => ({ post, delete: del }),
    }),
  );
  clearModule('services/KnowledgeBaseScheduleService', 'services/KnowledgeBaseWorkflowService');
  KnowledgeBaseScheduleService = loadFresh<typeof import('../services/KnowledgeBaseScheduleService')>(
    'services/KnowledgeBaseScheduleService',
  ).KnowledgeBaseScheduleService;

  await assert.doesNotReject(
    KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1'),
  );
  // Both KBs must have attempted the /create dispatch: the first failure is
  // logged and swallowed, and the second KB is still processed.
  assert.equal(createAttempts, 2);
});

test('fanOutAfterDatasetReady: ignores invalid data-change threshold values', async () => {
  const kbRow = fanOutKbRow({
    synchronizationConfig: {
      sync_mode: 'after_dataset_updates',
      data_change_threshold_enabled: true,
      data_change_threshold_value: 0,
    },
  });
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [kbRow] }),
    findOne: async () => kbRow,
    update: async () => ({ affected: 1 }),
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 1);
  assert.match(httpCalls[0].url, /\/create$/);
});

test('fanOutAfterDatasetReady: skips KB when changed file count is below the data-change threshold', async () => {
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: KB_ID,
            projectId: PROJECT,
            sourceDataset: 'ds-1',
            status: 'ready',
            synchronizationConfig: {
              sync_mode: 'after_dataset_updates',
              data_change_threshold_enabled: true,
              data_change_threshold_value: 150,
            },
            name: 'kb',
            embeddingModel: 'm-1',
            chunkSize: 512,
            vectorSize: 384,
            dataType: 'text',
            chunkStrategy: 'fixed',
            chunkOverlap: 50,
            indexingMode: 'hybrid',
          },
        ],
      }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });
  // Committed manifest with 5 changed files, well under the threshold of 150,
  // so the count-vs-threshold comparison (not the empty-manifest short-circuit)
  // is what skips the KB. (There is no "percent > 100" logic in prod; the
  // threshold is an absolute changed-file count.)
  handle.repos.DataSetManifest = makeFakeRepo({
    find: async () => [{ id: 'mf-1' }],
  });
  handle.repos.DataSetManifestFile = makeFakeRepo({
    count: async () => 5,
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('fanOutAfterDatasetReady: skips KB when dataset has no committed manifests', async () => {
  const kbRow = fanOutKbRow({
    synchronizationConfig: {
      sync_mode: 'after_dataset_updates',
      data_change_threshold_enabled: true,
      data_change_threshold_value: 1,
    },
  });
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [kbRow] }),
    findOne: async () => kbRow,
    update: async () => ({ affected: 1 }),
  });
  handle.repos.DataSet = makeFakeRepo({
    findOne: async () => ({
      id: 'ds-1',
      projectId: PROJECT,
      status: 'ready',
      kind: 'unstructured',
      warehouseName: 'nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT, home_dir: `s3://default-nemo/projects/${PROJECT}` }),
  });
  // No committed manifests -> the change count short-circuits to 0, which is
  // below the threshold of 1, so the KB is skipped.
  handle.repos.DataSetManifest = makeFakeRepo({
    find: async () => [],
  });

  await KnowledgeBaseScheduleService.fanOutAfterDatasetReady(PROJECT, 'ds-1');
  assert.equal(httpCalls.length, 0);
});

test('applySynchronizationConfig: after_dataset_updates mode disables schedule metadata', async () => {
  const result = await KnowledgeBaseScheduleService.applySynchronizationConfig(
    PROJECT,
    KB_ID,
    syncCfg({ sync_mode: 'after_dataset_updates' }),
    undefined,
  );
  assert.equal(result?.enabled, false);
  assert.equal(httpCalls.length, 0);
});
