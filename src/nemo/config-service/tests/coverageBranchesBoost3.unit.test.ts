/**
 * Third wave of branch-coverage tests targeting remaining gaps in
 * LakekeeperCatalogService, ManifestService, bifrostProviderOps, and
 * historySubscriber edge paths.
 *
 * Run: node --require ts-node/register --test tests/coverageBranchesBoost3.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios, { type AxiosInstance } from 'axios';

import { LakekeeperCatalogService } from '../services/LakekeeperCatalogService';
import {
  appendProviderKey,
  buildKeyPayload,
  ensureProviderConfigured,
  listGatewayModels,
  mapLlmProviderToBifrost,
  providerKeyName,
  removeProviderKeyByName,
  removeProviderModelFromKey,
  normalizeBifrostKeyValue,
  updateProviderProxyOnGateway,
  listGatewayProviders,
} from '../services/bifrost/bifrostProviderOps';
import { DataSourceHistorySubscriber } from '../db/historySubscriber';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import { buildApp, request, withUser } from './helpers/httpApp';

const WH_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROJECT = 'proj67bqptlb';
const DATASET = 'ds-abc12345';
const HOME_DIR = 's3://test-bucket/projects/p1';

class TestLakekeeper extends LakekeeperCatalogService {
  constructor(private readonly fake: AxiosInstance, baseUrl?: string) {
    super(baseUrl);
    (this as any).client = fake;
    (this as any).serviceAccountClient = null;
  }
}

function lakeFake(
  handlers: Partial<
    Record<'get' | 'post' | 'put' | 'delete', (url: string, body?: unknown, config?: any) => Promise<any>>
  >,
): AxiosInstance {
  return {
    get: async (url: string, config?: any) => handlers.get?.(url, undefined, config) ?? { status: 200, data: {} },
    post: async (url: string, body?: unknown, config?: any) =>
      handlers.post?.(url, body, config) ?? { status: 200, data: {} },
    put: async (url: string, body?: unknown, config?: any) =>
      handlers.put?.(url, body, config) ?? { status: 200, data: {} },
    delete: async (url: string, config?: any) => handlers.delete?.(url, undefined, config) ?? { status: 204, data: {} },
  } as AxiosInstance;
}

// ─── LakekeeperCatalogService ─────────────────────────────────────────────────

test('LakekeeperCatalogService.createWarehouse: uses warehouse name when uri is absent', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { warehouseId: WH_ID } };
      },
    }),
  );
  await svc.createWarehouse({ name: 'bucket-by-name' });
  assert.equal(posted['storage-profile'].bucket, 'bucket-by-name');
  assert.equal((svc as any).warehouseId, WH_ID);
});

test('LakekeeperCatalogService.createWarehouse: caches warehouseId from warehouseId response field', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => ({ data: { warehouseId: WH_ID, name: 'nemo' } }),
    }),
  );
  await svc.createWarehouse({ name: 'nemo', uri: 's3://bucket' });
  assert.equal((svc as any).warehouseId, WH_ID);
});

test('LakekeeperCatalogService.createWarehouse: wraps errors without HTTP status', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => {
        throw new Error('connection reset');
      },
    }),
  );
  await assert.rejects(
    () => svc.createWarehouse({ name: 'nemo', uri: 's3://bucket' }),
    /connection reset/,
  );
});

test('LakekeeperCatalogService.listWarehouses: accepts bare array response', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: [{ name: 'wh-a', 'warehouse-id': 'id-a' }, { 'warehouse-name': 'wh-b', id: 'id-b' }],
      }),
    }),
  );
  const rows = await svc.listWarehouses();
  assert.equal(rows.length, 2);
});

test('LakekeeperCatalogService.getWarehouse: resolves warehouseId and id alternate fields', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          warehouses: [
            {
              'warehouse-name': 'alt-wh',
              warehouseId: WH_ID,
              uri: 's3://explicit/prefix',
              'storage-profile': { bucket: 'explicit' },
            },
          ],
        },
      }),
    }),
  );
  const wh = await svc.getWarehouse('alt-wh');
  assert.equal(wh.name, 'alt-wh');
  assert.equal((wh as any).warehouseId, WH_ID);
  assert.equal(wh.uri, 's3://explicit');
});

test('LakekeeperCatalogService.getWarehouse: maps id field when other ids absent', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          warehouses: [{ name: 'by-id', id: WH_ID }],
        },
      }),
    }),
  );
  const wh = await svc.getWarehouse('by-id');
  assert.equal((wh as any).warehouseId, WH_ID);
});

test('LakekeeperCatalogService.resolveWarehousePrefix: throws when warehouse has no prefix', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'nemo', 'storage-profile': { bucket: 'b' } }] },
      }),
    }),
  );
  await assert.rejects(
    () => (svc as any).resolveWarehousePrefix('nemo'),
    /Could not resolve warehouse prefix/,
  );
});

test('LakekeeperCatalogService.resolveWarehousePrefix: falls back to cached warehouseId', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'nemo', 'storage-profile': { bucket: 'b' } }] },
      }),
    }),
  );
  (svc as any).warehouseId = WH_ID;
  const prefix = await (svc as any).resolveWarehousePrefix('nemo');
  assert.equal(prefix, WH_ID);
});

test('LakekeeperCatalogService.healthCheck: continues past ECONNREFUSED endpoints', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        calls.push(url);
        if (url === '/api/v1/health') return { status: 200, data: { ok: true } };
        const err: any = new Error('refused');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
  assert.ok(calls.includes('/api/v1/health'));
});

test('LakekeeperCatalogService.updateTableMetadata: wraps getTable failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 503, data: { message: 'catalog overloaded' } };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.updateTableMetadata(['ns'], 'events', {}, 'nemo'),
    /Failed to update table metadata.*catalog overloaded/,
  );
});

test('LakekeeperCatalogService.expireSnapshot: rejects when no rollback target exists', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 9,
                snapshots: [
                  { 'snapshot-id': 9, 'timestamp-ms': 9000 },
                  { 'snapshot-id': 9, 'timestamp-ms': 8000 },
                ],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.expireSnapshot(['proj1', 'datasets'], 'events', 9),
    /no parent or sibling snapshot available/,
  );
});

test('LakekeeperCatalogService.ensureNamespace: creates namespace when lookup reports not found', async () => {
  let created = false;
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        if (url.includes('/namespaces/new.ns')) {
          const err: any = new Error('missing');
          err.response = { data: { message: 'namespace not found' } };
          throw err;
        }
        throw new Error(url);
      },
      post: async (url, body) => {
        created = true;
        return { data: body };
      },
    }),
  );
  const ns = await svc.ensureNamespace(['new', 'ns'], undefined, WH_ID);
  assert.equal(created, true);
  assert.deepEqual(ns.namespace, ['new', 'ns']);
});

test('LakekeeperCatalogService.listTables: uses identifier value when name is absent', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { identifiers: [{ namespace: ['a'], table: 'events' }, { name: 'metrics' }] },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const tables = await svc.listTables(['proj1', 'datasets']);
  assert.deepEqual(tables, [{ namespace: ['a'], table: 'events' }, 'metrics']);
});

test('LakekeeperCatalogService.getTable: wraps non-404 upstream errors', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('upstream');
        err.response = { status: 500, data: { message: 'internal error' } };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.getTable(['proj1', 'datasets'], 'events'),
    /Failed to get table.*internal error/,
  );
});

test('LakekeeperCatalogService.deleteTable: wraps non-404 delete failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      delete: async () => {
        const err: any = new Error('forbidden');
        err.response = { status: 403, data: { message: 'denied' } };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.deleteTable(['proj1', 'datasets'], 'events'),
    /Failed to delete table.*denied/,
  );
});

test('LakekeeperCatalogService.createNamespace: rejects invalid UUID after trim', async () => {
  const svc = new TestLakekeeper(lakeFake({}));
  await assert.rejects(
    () => svc.createNamespace({ namespace: ['a'] }, 'not-a-uuid'),
    /UUID format/,
  );
});

test('LakekeeperCatalogService.tryCatalogPaths: throws immediately on 400 bad request', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => {
        const err: any = new Error('bad request');
        err.response = { status: 400, data: { message: 'invalid namespace body' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.createNamespace({ namespace: ['bad'] }, WH_ID),
    /bad request/,
  );
});

// ─── bifrostProviderOps ───────────────────────────────────────────────────────

const ORIGINAL_URL = process.env.LLM_GATEWAY_URL;
const ORIGINAL_KEY = process.env.LLM_GATEWAY_API_KEY;

beforeEach(() => {
  process.env.LLM_GATEWAY_URL = 'http://gateway.example';
  process.env.LLM_GATEWAY_API_KEY = 'test-key';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.LLM_GATEWAY_API_KEY;
  else process.env.LLM_GATEWAY_API_KEY = ORIGINAL_KEY;
});

test('providerKeyName: delegates to resolveProviderKeyName', () => {
  assert.equal(providerKeyName('model-1'), 'as-model-1');
});

test('buildKeyPayload: rejects unsafe gateway binding names', () => {
  assert.throws(
    () =>
      buildKeyPayload({
        llmProvider: 'openai',
        modelId: 'model-1',
        providerModelId: 'gpt-4o',
        gatewayBindingName: '__proto__',
        providerDeploymentName: 'gpt-4o',
        apiKey: 'sk',
      }),
    /Invalid gateway binding name/,
  );
});

test('mapLlmProviderToBifrost: maps additional native providers', () => {
  assert.equal(mapLlmProviderToBifrost('cohere'), 'cohere');
  assert.equal(mapLlmProviderToBifrost('anthropic'), 'anthropic');
  assert.equal(mapLlmProviderToBifrost('perplexity'), 'perplexity');
  assert.equal(mapLlmProviderToBifrost('huggingface'), 'huggingface');
  assert.equal(mapLlmProviderToBifrost('fireworks'), 'fireworks');
});

test('appendProviderKey: creates new key when duplicate row lacks id', async () => {
  let postCount = 0;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url.endsWith('/keys')) {
        return { data: { keys: [{ name: 'as-cred-cred-1', models: ['existing'] }] } };
      }
      throw new Error(url);
    },
    post: async (url: string) => {
      if (url.endsWith('/keys')) {
        postCount += 1;
        return { data: { id: 'fresh-key' } };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  } as unknown as AxiosInstance;

  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o-mini',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(postCount, 1);
  assert.equal(result.keyId, 'fresh-key');
});

test('removeProviderKeyByName: returns false when key is missing', async () => {
  const fake = {
    get: async (url: string) => {
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  assert.equal(await removeProviderKeyByName('openai', 'missing-key', fake), false);
});

test('listGatewayProviders: accepts providers embedded on bare response', async () => {
  const fake = {
    get: async () => ({ data: { providers: [{ name: 'openai' }], total: 1 } }),
  } as unknown as AxiosInstance;
  const out = await listGatewayProviders(fake);
  assert.equal(out.providers.length, 1);
  assert.equal(out.total, 1);
});

// ─── ManifestService ──────────────────────────────────────────────────────────

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let ManifestService: any;
let dep: any;
let s3Send: ReturnType<typeof mock.fn>;
let savedManualUploadMax: string | undefined;

beforeEach(() => {
  savedManualUploadMax = process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET;
  delete process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET;
  handle = installFakeRepositories({});
  dep = { getPrimaryDeploymentEndpoint: async () => 'http://app.example.com' };
  s3Send = mock.fn(async () => ({}));

  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      generatePresignedUrl: async () => 'http://presigned.example.com/upload',
      createS3ClientForDeployment: () => ({ send: async () => ({}) }),
      deploymentEndpointToS3GatewayUrl: (e: string) => e,
      s3Client: { send: s3Send },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DeploymentEndpointService', {
      DeploymentEndpointService: {
        getPrimaryDeploymentEndpoint: (...a: any[]) => dep.getPrimaryDeploymentEndpoint(...a),
      },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        async deleteTable() {
          return undefined;
        }
      },
    }),
  );

  ManifestService = loadFresh('services/ManifestService').ManifestService;
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/ManifestService');
  handle.restore();
  mock.restoreAll();
  if (savedManualUploadMax === undefined) delete process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET;
  else process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = savedManualUploadMax;
});

function seedDataSet(overrides: Record<string, any>) {
  handle.repos.DataSet = makeFakeRepo(overrides);
}
function seedManifest(overrides: Record<string, any>) {
  handle.repos.DataSetManifest = makeFakeRepo(overrides);
}
function seedFile(overrides: Record<string, any>) {
  handle.repos.DataSetManifestFile = makeFakeRepo(overrides);
}

test('ManifestService.replaceManifestFiles: MANUAL_UPLOAD_MAX_FILES_PER_DATASET=0 disables cap', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '99999' } }),
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });

  const uris = Array.from({ length: 3 }, (_, i) => `s3://b/data_files/f${i}.txt`);
  const m = await ManifestService.replaceManifestFiles('m1', uris);
  assert.equal(m.id, 'm1');
});

test('ManifestService.replaceManifestFiles: rejects when custom file cap exceeded', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '2';
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({ findOne: async () => ({ id: 'm1', dataSetId: 'ds1', status: 'draft' }) });
  seedFile({ createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '2' } }) });

  await assert.rejects(
    ManifestService.replaceManifestFiles('m1', ['s3://b/data_files/a.txt']),
    /Dataset file count cap exceeded/,
  );
});

test('ManifestService.replaceManifestFiles: extracts nested relative paths under data_files', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  const saved: any[] = [];
  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: async (rows: any) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    },
  });

  await ManifestService.replaceManifestFiles('m1', [
    's3://bucket/projects/p1/datasets/ds1/data_files/dir1/a.txt',
    's3://bucket/projects/p1/datasets/ds1/data_files/dir2/a.txt',
    's3://bucket/other/path/standalone.txt',
  ]);
  assert.deepEqual(saved.map((f) => f.fileName), ['dir1/a.txt', 'dir2/a.txt', 'standalone.txt']);
});

test('ManifestService.createManifestFromManifest: derives fileName from uri and unknown fallback', async () => {
  const saved: any[] = [];
  let call = 0;
  seedManifest({
    findOne: async (q: any) => {
      if (q?.where?.status === 'draft') return null;
      call += 1;
      if (call === 1) {
        return {
          id: 'src',
          dataSetId: 'ds1',
          files: [
            { uri: 's3://b/data_files/nested/x.txt' },
            { uri: '', fileName: 'kept-name' },
            {},
          ],
          metadata: {},
        };
      }
      return { id: 'new1', dataSetId: 'ds1', files: [] };
    },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'new1' }),
  });
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedFile({
    create: (d: any) => ({ ...d }),
    save: async (rows: any) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    },
  });

  await ManifestService.createManifestFromManifest('src');
  assert.deepEqual(saved.map((f) => f.fileName), ['nested/x.txt', 'kept-name', 'unknown']);
});

test('ManifestService.updateManifestStatus: swallows import workflow trigger failures', async () => {
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.reject(new Error('workflow unavailable'));
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      status: 'in_progress',
      bucketName: 'default-nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  const m = await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(m.status, 'committed');
});

test('ManifestService.deleteS3Objects: skips non-s3 uris and swallows delete errors', async () => {
  s3Send = mock.fn(async () => {
    throw new Error('delete failed');
  });
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      generatePresignedUrl: async () => 'http://presigned.example.com/upload',
      s3Client: { send: s3Send },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  await ManifestService.deleteS3Objects(['not-a-uri', 's3://bucket/key.txt']);
  assert.equal(s3Send.mock.callCount(), 1);
});

test('ManifestService.prepareDatasetReimport: manual errored drops catalog table on success', async () => {
  let deleteTableCalls = 0;
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        async deleteTable() {
          deleteTableCalls += 1;
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedDataSet({ save: async (row: any) => row });
  const deletePrefix = mock.method(ManifestService, 'deleteS3Prefix', async () => undefined);
  const timer = mock.method(global, 'setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);

  await ManifestService.prepareDatasetReimport(
    {
      id: 'ds1',
      projectId: PROJECT,
      status: 'errored',
      catalogTableName: 'events',
      namespace: PROJECT,
      warehouseName: 'nemo',
      type: 'manual',
    } as any,
    'bucket',
    'projects/p1',
  );

  assert.equal(deleteTableCalls, 1);
  deletePrefix.mock.restore();
  timer.mock.restore();
});

test('LakekeeperCatalogService.getTableSchema: falls back to first schema when current id missing', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            'current-schema-id': 99,
            schemas: [{ 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true, doc: 'pk' }] }],
          },
        },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const schema = await svc.getTableSchema(['proj1', 'datasets'], 'events');
  assert.equal(schema?.fields?.[0]?.doc, 'pk');
});

test('LakekeeperCatalogService.getTableSchema: wraps upstream failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        throw new Error('catalog offline');
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.getTableSchema(['proj1', 'datasets'], 'events'),
    /Failed to get table schema.*catalog offline/,
  );
});

test('LakekeeperCatalogService.getTable: returns not-found after 404 retry fails', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.getTable(['proj1', 'datasets'], 'ghost'),
    /not found/,
  );
});

test('LakekeeperCatalogService.expireSnapshot: removes non-current snapshot without rollback', async () => {
  let posts = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            'current-snapshot-id': 1,
            snapshots: [
              { 'snapshot-id': 1, 'timestamp-ms': 1000 },
              { 'snapshot-id': 2, 'timestamp-ms': 2000 },
            ],
          },
        },
      }),
      post: async () => {
        posts += 1;
        return { data: { metadata: { 'current-snapshot-id': 1 } } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const result = await svc.expireSnapshot(['proj1', 'datasets'], 'events', 2);
  assert.equal(result.newCurrentSnapshotId, 1);
  assert.equal(posts, 1);
});

test('LakekeeperCatalogService.createTable: uses cached warehouseId when request omits it', async () => {
  let postedUrl = '';
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (url) => {
        postedUrl = url;
        return { data: { metadata: {} } };
      },
    }),
  );
  (svc as any).warehouseId = WH_ID;
  await svc.createTable({
    name: 'events',
    namespace: ['proj1', 'datasets'],
    schema: { type: 'struct', fields: [{ id: 1, name: 'id', type: 'long', required: true }] },
  });
  assert.match(postedUrl, new RegExp(`/catalog/v1/${WH_ID}/`));
});

test('LakekeeperCatalogService.resolveWarehousePrefix: returns cached prefix without list call', async () => {
  const svc = new TestLakekeeper(lakeFake({ get: async () => { throw new Error('should not list'); } }));
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const prefix = await (svc as any).resolveWarehousePrefix('nemo');
  assert.equal(prefix, WH_ID);
});

test('LakekeeperCatalogService.listNamespaces: includes parent query parameter', async () => {
  let requested = '';
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        requested = url;
        return { data: { namespaces: [] } };
      },
    }),
  );
  await svc.listNamespaces(['parent', 'ns']);
  assert.match(requested, /parent=parent\.ns/);
});

test('LakekeeperCatalogService.deleteNamespace: wraps non-404 delete failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      delete: async () => {
        const err: any = new Error('forbidden');
        err.response = { status: 403, data: { message: 'denied' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.deleteNamespace(['proj1', 'datasets']), /Failed to delete namespace.*denied/);
});

test('LakekeeperCatalogService.getWarehouse: finds row by plain name field', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'plain-name', id: WH_ID, 'storage-profile': { bucket: 'b1' } }] },
      }),
    }),
  );
  const wh = await svc.getWarehouse('plain-name');
  assert.equal(wh.name, 'plain-name');
});

test('LakekeeperCatalogService.healthCheck: returns false when every endpoint is 404', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  assert.equal(await svc.healthCheck(), false);
});

test('LakekeeperCatalogService.createWarehouse: uses region from properties for s3 uri', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { id: WH_ID } };
      },
    }),
  );
  await svc.createWarehouse({
    name: 'wh',
    uri: 's3://bucket/prefix',
    properties: { region: 'ap-south-1' },
  });
  assert.equal(posted['storage-profile'].region, 'ap-south-1');
  assert.equal((svc as any).warehouseId, WH_ID);
});

test('buildKeyPayload: azure prefers apiBase over metadata endpoint', () => {
  const payload = buildKeyPayload({
    llmProvider: 'azure',
    modelId: 'm1',
    providerModelId: 'gpt-4o',
    gatewayBindingName: 'bind-1',
    providerDeploymentName: 'deploy-1',
    apiKey: 'sk',
    apiBase: 'https://from-api-base.openai.azure.com',
    credentialMetadata: { endpoint: 'https://from-meta.openai.azure.com' },
  });
  const azureCfg = payload.azure_key_config as Record<string, { value: string }>;
  assert.equal(azureCfg.endpoint.value, 'https://from-api-base.openai.azure.com');
});

test('appendProviderKey: PUT omits aliases when binding equals upstream id', async () => {
  let putBody: Record<string, unknown> | undefined;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url.endsWith('/keys')) {
        return { data: { keys: [{ id: 'key-1', name: 'as-cred-cred-1', models: ['gpt-4o'] }] } };
      }
      throw new Error(url);
    },
    put: async (_url: string, body: unknown) => {
      putBody = body as Record<string, unknown>;
      return { data: {} };
    },
    post: async () => ({ data: {} }),
  } as unknown as AxiosInstance;

  await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(putBody?.aliases, undefined);
});

test('ManifestService.addFilesToManifest: wraps presigned URL generation failures', async () => {
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      generatePresignedUrl: async () => {
        throw new Error('s3 down');
      },
      s3Client: { send: async () => ({}) },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DeploymentEndpointService', {
      DeploymentEndpointService: {
        getPrimaryDeploymentEndpoint: async () => 'http://app.example.com',
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft', dataSetId: 'ds1' }) });
  seedFile({
    find: async () => [],
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d, id: 'f1' }),
    save: async (e: any) => e,
  });
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }) });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  await assert.rejects(
    ManifestService.addFilesToManifest('m1', ['dir/file.txt'], 'my-bucket'),
    /Failed to generate pre-signed URL.*s3 down/,
  );
});

test('ManifestService.updateManifestStatus: sets dataset warning when S3 write times out', async () => {
  s3Send = mock.fn(async () => {
    const err: any = new Error('timeout');
    err.code = 'ETIMEDOUT';
    throw err;
  });
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      generatePresignedUrl: async () => 'http://presigned.example.com/upload',
      s3Client: { send: s3Send },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DeploymentEndpointService', {
      DeploymentEndpointService: {
        getPrimaryDeploymentEndpoint: async () => 'http://app.example.com',
      },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  const dsRow: any = {
    id: 'ds1',
    projectId: PROJECT,
    status: 'in_progress',
    bucketName: 'default-nemo',
  };
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => dsRow,
    save: async (row: any) => {
      Object.assign(dsRow, row);
      return row;
    },
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  await ManifestService.updateManifestStatus('m1', 'committed');
  assert.match(String(dsRow.errorMessage), /Storage gateway temporarily unreachable/);
});

test('ManifestService.appendDraftManifestSourceUris: allows same basename in different directories', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
  });
  let savedFiles: any[] = [];
  seedFile({
    find: async () => [],
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: async (e: any) => {
      savedFiles = Array.isArray(e) ? e : [e];
      return e;
    },
  });

  await ManifestService.appendDraftManifestSourceUris('m1', 'ds1', [
    's3://b/data_files/dir1/a.txt',
    's3://b/data_files/dir2/a.txt',
  ]);

  // Both same-basename URIs (a.txt) must be persisted; a regression that
  // dedupes on basename would silently drop one.
  assert.equal(savedFiles.length, 2);
  assert.equal(new Set(savedFiles.map((f) => f.fileName)).size, 2);
  assert.deepEqual(
    savedFiles.map((f) => f.uri).sort(),
    ['s3://b/data_files/dir1/a.txt', 's3://b/data_files/dir2/a.txt'],
  );
});

test('ManifestService.replaceManifestFiles: uses basename when data_files marker has empty tail', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  const saved: any[] = [];
  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: async (rows: any) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    },
  });

  await ManifestService.replaceManifestFiles('m1', ['s3://bucket/prefix/data_files/']);
  assert.equal(saved[0].fileName, 's3://bucket/prefix/data_files/');
});

// ─── bifrostOps extra branches ────────────────────────────────────────────────

test('getLogStats: passes virtualKeyIds and endTime filters', async () => {
  const { getLogStats } = await import('../services/bifrost/bifrostOps');
  let url = '';
  const fake = {
    get: async (u: string) => {
      url = u;
      return {
        data: {
          total_requests: '10',
          total_tokens: '100',
          user_facing_success_rate: null,
          user_facing_total_requests: null,
        },
      };
    },
  } as unknown as AxiosInstance;
  const stats = await getLogStats(
    { providers: 'openai', virtualKeyIds: 'vk-1', endTime: '2024-12-31' },
    fake,
  );
  assert.match(url, /virtual_key_ids=vk-1/);
  assert.match(url, /end_time=2024-12-31/);
  assert.equal(stats.total_requests, 10);
  assert.equal(stats.user_facing_success_rate, undefined);
});

test('getLogTokenSplit: sums string token counts from log entries', async () => {
  const { getLogTokenSplit } = await import('../services/bifrost/bifrostOps');
  let url = '';
  const fake = {
    get: async (u: string) => {
      url = u;
      return {
        data: {
          logs: [
            { token_usage: { prompt_tokens: '3', completion_tokens: '7' } },
            { token_usage: { prompt_tokens: 2, completion_tokens: 1 } },
          ],
        },
      };
    },
  } as unknown as AxiosInstance;
  const split = await getLogTokenSplit(
    { providers: 'openai', models: 'gpt-4', startTime: '2024-01-01', limit: 50 },
    fake,
  );
  assert.match(url, /limit=50/);
  assert.equal(split.promptTokens, 5);
  assert.equal(split.completionTokens, 8);
  assert.equal(split.sampledRequests, 2);
});

// ─── more Lakekeeper + Manifest branches ───────────────────────────────────────

test('LakekeeperCatalogService.listTables: wraps non-404 list failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('upstream');
        err.response = { status: 500, data: { message: 'catalog error' } };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.listTables(['proj1', 'datasets']),
    /Failed to list tables.*catalog error/,
  );
});

test('LakekeeperCatalogService.setCurrentSnapshot: sends assert-ref when expected current provided', async () => {
  let posted: Record<string, unknown> | undefined;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body as Record<string, unknown>;
        return { data: { metadata: { 'current-snapshot-id': 2 } } };
      },
    }),
  );
  await svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 2, 1);
  const requirements = posted?.requirements as Array<Record<string, unknown>>;
  assert.equal(requirements?.[0]?.type, 'assert-ref-snapshot-id');
  assert.equal(requirements?.[0]?.['snapshot-id'], 1);
});

test('ManifestService.updateManifestStatus: skips import for deprecated datasets', async () => {
  let importStarted = false;
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      generatePresignedUrl: async () => 'http://presigned.example.com/upload',
      s3Client: { send: async () => ({}) },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          importStarted = true;
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  let findCount = 0;
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => {
      findCount += 1;
      return {
        id: 'ds1',
        projectId: PROJECT,
        status: findCount > 1 ? 'deprecated' : 'in_progress',
        bucketName: null,
      };
    },
  });

  await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(importStarted, false);
});

test('ManifestService.updateManifestStatus: no-ops import when dataset row disappears', async () => {
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: { send: async () => ({}) },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  let findCount = 0;
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => {
      findCount += 1;
      return findCount === 1 ? { id: 'ds1', projectId: PROJECT, status: 'in_progress', bucketName: null } : null;
    },
  });

  const m = await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(m.status, 'committed');
});

test('ManifestService.updateManifestStatus: continues when dataset warning save fails', async () => {
  s3Send = mock.fn(async () => {
    const err: any = new Error('timeout');
    err.code = 'ETIMEDOUT';
    throw err;
  });
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: { send: s3Send },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => ({
      id: 'ds1',
      projectId: PROJECT,
      status: 'in_progress',
      bucketName: 'default-nemo',
      errorMessage: 'existing',
    }),
    save: async () => {
      throw new Error('db save failed');
    },
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  const m = await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(m.status, 'committed');
});

test('buildKeyPayload: bedrock uses metadata access_key when apiKey absent', () => {
  const payload = buildKeyPayload({
    llmProvider: 'aws_bedrock',
    modelId: 'm1',
    providerModelId: 'anthropic.claude-v2',
    credentialMetadata: { access_key: 'AKIA-META', secret_key: 'sec', region: 'eu-west-1' },
  });
  const cfg = payload.bedrock_key_config as Record<string, { value: string }>;
  assert.equal(cfg.access_key.value, 'AKIA-META');
});

test('removeProviderKeyByName: deletes matching key by name', async () => {
  let deleted = false;
  const fake = {
    get: async (url: string) => {
      if (url.endsWith('/keys')) {
        return { data: { keys: [{ id: 'kid-1', name: 'as-cred-c1' }] } };
      }
      throw new Error(url);
    },
    delete: async () => {
      deleted = true;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  assert.equal(await removeProviderKeyByName('openai', 'as-cred-c1', fake), true);
  assert.equal(deleted, true);
});

test('EvaluationIdGenerator.validateTemplate: rejects invalid template ids', async () => {
  const { EvaluationIdGenerator } = await import('../services/EvaluationIdGenerator');
  assert.equal(EvaluationIdGenerator.validateTemplate(''), false);
  assert.equal(EvaluationIdGenerator.validateTemplate('evt-short'), false);
  assert.equal(EvaluationIdGenerator.validateTemplate('evt-ABCDEFGH'), false);
  assert.equal(EvaluationIdGenerator.validateTemplate('bad-abc12345'), false);
  assert.equal(EvaluationIdGenerator.validateTemplate('evt-abc12345'), true);
});

test('EvaluationIdGenerator.template: generates evt- prefixed ids', async () => {
  const { EvaluationIdGenerator } = await import('../services/EvaluationIdGenerator');
  const id = EvaluationIdGenerator.template();
  assert.match(id, /^evt-[0-9a-z]{8}$/);
});

test('BifrostGatewayClient.callMCPTool: throws when MCP client entry is missing', async () => {
  const { BifrostGatewayClient } = loadFresh<typeof import('../services/BifrostGatewayClient')>(
    'services/BifrostGatewayClient',
  );
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = true;
  (gw as any).getMcpClientEntry = async () => null;
  await assert.rejects(() => gw.callMCPTool('missing-server', 'tool_a', {}), /Bifrost MCP client not found/);
  clearModule('services/BifrostGatewayClient');
});

test('LakekeeperCatalogService.createTable: rejects when warehouse id is missing', async () => {
  const svc = new TestLakekeeper(lakeFake({}));
  await assert.rejects(
    () =>
      svc.createTable({
        name: 'events',
        namespace: ['default'],
        schema: { type: 'struct', fields: [] },
      }),
    /Warehouse ID is required/,
  );
});

test('LakekeeperCatalogService.getTable: succeeds on unit-separator retry after dot-namespace 404', async () => {
  let calls = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        calls += 1;
        if (url.includes('proj1.datasets')) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { data: { metadata: { properties: { k: 'v' } } } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const table = await svc.getTable(['proj1', 'datasets'], 'events');
  assert.equal((table.metadata as any).properties.k, 'v');
  assert.equal(calls, 2);
});

test('LakekeeperCatalogService.ensureNamespace: wraps getWarehouse failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('boom');
        err.response = { status: 503, data: { message: 'warehouse unavailable' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureNamespace(['a', 'b'], 'missing-wh'),
    /Failed to get warehouse ID.*warehouse unavailable/,
  );
});

test('listProviderKeys: returns empty array when keys field missing', async () => {
  const { listProviderKeys } = await import('../services/bifrost/bifrostProviderOps');
  const fake = {
    get: async () => ({ data: {} }),
  } as unknown as AxiosInstance;
  assert.deepEqual(await listProviderKeys('openai', fake), []);
});

test('referenceCatalog: agent_team manager agent_id and team member edges', async () => {
  const { referenceCatalog } = await import('../services/referenceCatalog');
  const edges = referenceCatalog.extractEdges('agent_team', 'team-1', {
    manager: { agent_id: '  agt-mgr  ', modelId: 'mdl-1' },
    members: [{ memberId: 'sub-team', memberType: 'team' }],
    sharedKnowledgeBaseIds: ['kb-1'],
    sharedDatasetIds: ['ds-1'],
  } as any);
  assert.ok(edges.some((e) => e.relation === 'uses_manager_agent' && e.targetId === 'agt-mgr'));
  assert.ok(edges.some((e) => e.relation === 'has_member' && e.targetType === 'agent_team'));
  assert.ok(edges.some((e) => e.relation === 'shares_kb'));
});

test('referenceCatalog: pipeline workflow block and dataset origin volume edges', async () => {
  const { referenceCatalog } = await import('../services/referenceCatalog');
  const pipelineEdges = referenceCatalog.extractEdges('pipeline', 'pl-1', {
    graph: {
      nodes: [{ type: 'workflow', config: { params: { workflowId: ' inner-wf ' } } }],
    },
  } as any);
  assert.ok(pipelineEdges.some((e) => e.targetType === 'pipeline' && e.targetId === 'inner-wf'));

  const dsEdges = referenceCatalog.extractEdges('dataset', 'ds-1', {
    originConnector: 'conn-1',
    originVolume: 'vol-1',
  } as any);
  assert.equal(dsEdges.length, 2);
});

test('manifestRoutes: PUT status/metadata/schema return 500 on service errors', async (t) => {
  const fakeSvc: Record<string, any> = {
    updateManifestStatus: async () => {
      throw new Error('status exploded');
    },
    updateManifestMetadata: async () => {
      throw new Error('metadata exploded');
    },
    updateManifestSchema: async () => {
      throw new Error('schema exploded');
    },
  };
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(mockModule('services/ManifestService', { ManifestService: fakeSvc }));
  const router = loadFresh('routes/manifestRoutes').default;
  const routeApp = buildApp({
    basePath: '/api/v1/projects/:projectId/datasets/:dataSetId/manifests',
    router,
  });
  const base = `/api/v1/projects/${PROJECT}/datasets/${DATASET}/manifests`;

  assert.equal(
    (await request(routeApp, 'PUT', `${base}/mf-1/status`, { body: { status: 'committed' } })).status,
    500,
  );
  assert.equal(
    (await request(routeApp, 'PUT', `${base}/mf-1/metadata`, { body: { metadata: { a: 1 } } })).status,
    500,
  );
  assert.equal(
    (await request(routeApp, 'PUT', `${base}/mf-1/schema`, { body: { schema: { fields: [] } } })).status,
    500,
  );
  clearModule('routes/manifestRoutes');
});

test('referenceCatalog: pipeline graph covers agent, kb, mcp, dataset_reader, cross-project skip', async () => {
  const { referenceCatalog } = await import('../services/referenceCatalog');
  const edges = referenceCatalog.extractEdges('pipeline', 'pl-1', {
    projectId: 'proj-a',
    graph: {
      nodes: [
        { type: 'agent', config: { params: { agentId: 'agt-1', projectId: 'proj-a' } } },
        { type: 'knowledge', config: { params: { knowledgeBaseId: 'kb-1' } } },
        { type: 'mcp', config: { params: { server: 'mcp-1' } } },
        { type: 'dataset_reader', config: { params: { dataset_id: 'ds-1' } } },
        { type: 'agent', config: { params: { agentId: 'agt-other', projectId: 'proj-b' } } },
        { type: 'unknown_block', config: { params: {} } },
      ],
    },
  } as any);
  const relations = edges.map((e) => e.relation);
  assert.ok(relations.includes('graph_ref'));
  assert.equal(edges.filter((e) => e.targetId === 'agt-other').length, 0);
});

test('assertTerminationStrategyShape and assertAgentRequirementsShape validate configs', async () => {
  const { assertTerminationStrategyShape, assertAgentRequirementsShape } = await import(
    '../validators/agentValidator'
  );
  assert.doesNotThrow(() =>
    assertTerminationStrategyShape({ type: 'timeout', timeout_seconds: 30 }),
  );
  assert.throws(
    () => assertTerminationStrategyShape({ type: 'timeout', timeout_seconds: 0 }),
    /timeout_seconds must be an integer >= 1/,
  );
  assert.doesNotThrow(() =>
    assertAgentRequirementsShape({
      mcpServers: [
        {
          id: WH_ID,
          label: '  mcp  ',
          description: 'tool server',
          required: false,
        },
      ],
    }),
  );
  assert.throws(
    () => assertAgentRequirementsShape({ unknownList: [] }),
    /not a recognised key/,
  );
});

test('LakekeeperCatalogService.createNamespace: succeeds on second catalog path after 404', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (url) => {
        attempts += 1;
        if (attempts === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { data: { namespace: ['a', 'b'], properties: {} } };
      },
    }),
  );
  const ns = await svc.createNamespace({ namespace: ['a', 'b'] }, WH_ID);
  assert.deepEqual(ns.namespace, ['a', 'b']);
  assert.ok(attempts >= 2);
});

test('LakekeeperCatalogService.commitTable: wraps non-404 commit failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => {
        const err: any = new Error('forbidden');
        err.response = { status: 403, data: { message: 'denied' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () =>
      svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 2),
    /Failed to commit table.*denied/,
  );
});

test('EvaluationService.generateRunName: includes agent version when present', async () => {
  const { EvaluationService } = await import('../services/EvaluationService');
  const name = EvaluationService.generateRunName({
    evalName: 'Smoke Test',
    agent: { agentVersion: 'v3' },
  } as any);
  assert.match(name, /^Smoke-Test-v3-/);
});

test('EvaluationService.estimateImpact: treats negative counts as zero', async () => {
  const { EvaluationService } = await import('../services/EvaluationService');
  const out = EvaluationService.estimateImpact({
    testCaseCount: -5,
    judgeDimensionCount: -2,
    usesAiJudge: true,
  });
  assert.equal(out.estimatedCostUsd, 0);
});

test('gatewayRoutes: models upstream detail fallback', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => true }),
    }),
  );
  scope2.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayModels: async () => {
        const err: any = new Error('');
        err.response = { data: { detail: 'models unavailable' } };
        throw err;
      },
      listGatewayProviders: async () => ({ providers: [], total: 0 }),
      mapLlmProviderToBifrost: (p: string) => p,
    }),
  );
  const app = buildApp({
    basePath: '/api/v1/gateway',
    router: loadFresh('routes/gatewayRoutes').default,
  });
  const res = await request(app, 'GET', '/api/v1/gateway/models');
  assert.equal(res.status, 502);
  assert.equal(res.body.message, 'models unavailable');
  clearModule('routes/gatewayRoutes');
});

test('bifrostProjectGovernance helpers: VK naming and MCP filtering', async () => {
  const gov = await import('../services/bifrost/bifrostProjectGovernance');
  assert.equal(gov.projectIdFromVkName('as-proj-projabc123-vk'), 'projabc123');
  assert.equal(gov.projectIdFromVkName('as-proj-projabc123-vk-r2'), 'projabc123');
  assert.equal(gov.projectIdFromVkName('other-vk'), undefined);
  assert.equal(gov.projectVkNameMatches('as-proj-projabc123-vk-r1', 'projabc123'), true);
  assert.equal(gov.projectMcpClientPrefix('projabc123'), 'projabc123_');

  const filtered = gov.filterMcpConfigsToProject(
    [
      { mcp_client_name: 'projabc123_server_a' },
      { mcp_client_name: 'projother1_server_b' },
      { mcp_client_name: 'platform_shared' },
    ],
    'projabc123',
  );
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((c) => c.mcp_client_name === 'platform_shared'));
});

test('computePlatformMcpConfigAdditions: adds synced attachable platform MCP clients', async () => {
  const { computePlatformMcpConfigAdditions } = await import('../services/bifrost/bifrostProjectGovernance');
  const { configs, added } = computePlatformMcpConfigAdditions(
    [{ mcp_client_name: 'existing_srv', tools_to_execute: ['*'] }],
    [
      {
        catalogId: 'analytics_datasets_mcp',
        status: 'ready',
        syncStatus: 'synced',
        llmproxyGatewayServerName: 'analytics_datasets_mcp',
        name: 'analytics-datasets',
      } as any,
      {
        catalogId: 'broken_mcp',
        status: 'error',
        syncStatus: 'synced',
        name: 'broken',
      } as any,
    ],
    { webSearch: false, analytics: true },
  );
  assert.ok(added.includes('analytics_datasets_mcp'));
  assert.ok(configs.some((c) => c.mcp_client_name === 'existing_srv'));
});

test('applyBuiltinBindingsToProviderConfigs: merges bindings and reports changes', async () => {
  const { applyBuiltinBindingsToProviderConfigs } = await import('../services/bifrost/bifrostProjectGovernance');
  const first = applyBuiltinBindingsToProviderConfigs([], [
    { provider: 'as-tei-minilm', modelId: 'm1', providerKeyId: 'kid-1' },
  ]);
  assert.equal(first.changed, true);
  const second = applyBuiltinBindingsToProviderConfigs(first.configs, [
    { provider: 'as-tei-minilm', modelId: 'm1', providerKeyId: 'kid-1' },
  ]);
  assert.equal(second.changed, false);
});

// ─── historySubscriber ────────────────────────────────────────────────────────

test('DataSourceHistorySubscriber: beforeRemove uses databaseEntity-only payload', async () => {
  const saved: Array<{ entityId: string; op: string; data: Record<string, unknown> }> = [];
  const historyRepo = {
    findOne: async () => null,
    save: async (row: any) => {
      saved.push(row);
      return row;
    },
  };
  const entityRepo = { findOne: async () => null };
  const manager = {
    getRepository: (cls: { name?: string }) =>
      cls?.name?.endsWith('History') ? historyRepo : entityRepo,
  };

  const sub = new DataSourceHistorySubscriber();
  await sub.beforeRemove({
    manager,
    entity: undefined,
    databaseEntity: { id: 'ds-db-only', name: 'legacy' },
  } as any);

  assert.equal(saved.length, 1);
  assert.equal(saved[0].entityId, 'ds-db-only');
  assert.equal(saved[0].op, 'delete');
  assert.equal(saved[0].data.name, 'legacy');
});

// ─── additional branch coverage (wave 3b) ─────────────────────────────────────

test('LakekeeperCatalogService.deleteTable: purge flag and 404 retry success', async () => {
  const deleted: string[] = [];
  const svc = new TestLakekeeper(
    lakeFake({
      delete: async (url) => {
        deleted.push(url);
        if (url.includes('proj1.datasets')) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { status: 204, data: {} };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await svc.deleteTable(['proj1', 'datasets'], 'events', undefined, { purge: true });
  assert.ok(deleted.some((u) => u.includes('purgeRequested=true')));
  assert.ok(deleted.some((u) => u.includes('\x1F')));
});

test('LakekeeperCatalogService.deleteTable: wraps 404 retry failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      delete: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.deleteTable(['proj1', 'datasets'], 'events'),
    /Failed to delete table.*missing/,
  );
});

test('LakekeeperCatalogService.listTables: 404 retry success returns table names', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        attempts += 1;
        if (attempts === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { data: { identifiers: [{ name: 'events' }] } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const tables = await svc.listTables(['proj1', 'datasets']);
  assert.deepEqual(tables, ['events']);
  assert.ok(attempts >= 2);
});

test('LakekeeperCatalogService.listTables: wraps 404 retry failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.listTables(['proj1', 'datasets']),
    /Failed to list tables.*missing/,
  );
});

test('LakekeeperCatalogService.ensureNamespace: rethrows non-not-found lookup errors', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('upstream');
        err.response = { data: { message: 'catalog unavailable' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureNamespace(['a', 'b'], undefined, WH_ID),
    /catalog unavailable/,
  );
});

test('getLogStats: default client path and user-facing metrics', async () => {
  let url = '';
  const fakeClient = {
    get: async (u: string) => {
      url = u;
      return {
        data: {
          total_requests: '2',
          total_tokens: 4,
          total_cost: 0,
          average_latency: 1,
          success_rate: 1,
          user_facing_success_rate: 0.88,
          user_facing_total_requests: '9',
        },
      };
    },
  };
  const restoreAxios = mock.method(axios, 'create', () => fakeClient as any);
  clearModule('services/bifrost/bifrostOps');
  const { getLogStats } = await import('../services/bifrost/bifrostOps');
  const stats = await getLogStats({ models: 'gpt-4', startTime: '2024-01-01' });
  assert.equal(url, '/api/logs/stats?models=gpt-4&start_time=2024-01-01');
  assert.equal(stats.user_facing_success_rate, 0.88);
  assert.equal(stats.user_facing_total_requests, 9);
  restoreAxios.mock.restore();
  clearModule('services/bifrost/bifrostOps');
});

test('getLogTokenSplit: default client, empty logs, and zero limit fallback', async () => {
  let url = '';
  const fakeClient = {
    get: async (u: string) => {
      url = u;
      return { data: { logs: [{ token_usage: {} }, { token_usage: { prompt_tokens: 1 } }] } };
    },
  };
  const restoreAxios = mock.method(axios, 'create', () => fakeClient as any);
  clearModule('services/bifrost/bifrostOps');
  const { getLogTokenSplit } = await import('../services/bifrost/bifrostOps');
  const split = await getLogTokenSplit({
    virtualKeyIds: 'vk-1',
    endTime: '2024-12-31',
    limit: 0,
  });
  assert.match(url, /virtual_key_ids=vk-1/);
  assert.match(url, /limit=100/);
  assert.equal(split.promptTokens, 1);
  assert.equal(split.completionTokens, 0);
  restoreAxios.mock.restore();
  clearModule('services/bifrost/bifrostOps');
});

test('ensureProviderConfigured: treats 409 conflict as already-created', async () => {
  let postCalls = 0;
  const fake = {
    get: async () => ({
      data: {
        providers: postCalls > 0 ? [{ name: 'cohere' }] : [],
      },
    }),
    post: async () => {
      postCalls += 1;
      const err: any = new Error('exists');
      err.response = { status: 409 };
      throw err;
    },
  } as unknown as AxiosInstance;
  const state = await ensureProviderConfigured('cohere', fake);
  assert.equal((state as { name?: string }).name, 'cohere');
});

test('listGatewayModels: skips providers with empty names', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return { data: { providers: [{ name: '' }, { name: 'openai' }], total: 2 } };
      }
      if (url.endsWith('/keys')) {
        return { data: { keys: [{ id: 'k1', name: 'as-key', models: ['m1'] }] } };
      }
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  const out = await listGatewayModels(fake);
  assert.equal(out.providers.length, 1);
  assert.equal(out.models.length, 1);
});

test('appendProviderKey: swallows provider proxy-config update failures', async () => {
  let proxyPut = 0;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(url);
    },
    post: async (url: string) => {
      if (url.endsWith('/keys')) return { data: { id: 'new-key' } };
      throw new Error(url);
    },
    put: async (url: string) => {
      if (url.includes('/api/providers/openai') && !url.includes('/keys/')) {
        proxyPut += 1;
        throw new Error('proxy write failed');
      }
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o-mini',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
      concurrency: 4,
      bufferSize: 8,
    },
    fake,
  );
  assert.equal(result.keyId, 'new-key');
  assert.equal(proxyPut, 1);
});

test('buildKeyPayload: google vertex includes optional project_number and auth', () => {
  const payload = buildKeyPayload({
    llmProvider: 'google',
    modelId: 'model-1',
    providerModelId: 'gemini-pro',
    apiKey: 'unused',
    credentialMetadata: {
      project_id: 'proj-123',
      project_number: '999',
      service_account_json: '{"type":"service_account"}',
    },
  });
  const cfg = payload.vertex_key_config as Record<string, { value: string }>;
  assert.equal(cfg.project_number.value, '999');
  assert.ok(cfg.auth_credentials.value.includes('service_account'));
  assert.equal(payload.value, undefined);
});

test('BifrostGatewayClient.callMCPTool: tool-not-found retry surfaces nested failure', async () => {
  const { BifrostGatewayClient } = loadFresh<typeof import('../services/BifrostGatewayClient')>(
    'services/BifrostGatewayClient',
  );
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = true;
  (gw as any).getMcpClientEntry = async () => ({ raw: { config: { name: 'srv_a' } } });
  (gw as any).client = {
    post: async (_url: string, body: any) => {
      const name = body?.function?.name;
      const err: any = new Error('tool missing');
      err.response = {
        data: { detail: name.includes('srv_a') ? 'Tool not found' : 'still missing' },
      };
      throw err;
    },
  };
  await assert.rejects(() => gw.callMCPTool('srv_a', 'tool_a', {}), /still missing/);
  clearModule('services/BifrostGatewayClient');
});

test('BifrostGatewayClient.editMCPServer: syncs allowed_extra_headers on edit', async () => {
  const { BifrostGatewayClient } = loadFresh<typeof import('../services/BifrostGatewayClient')>(
    'services/BifrostGatewayClient',
  );
  let putBody: Record<string, unknown> | undefined;
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = true;
  (gw as any).client = {
    put: async (_url: string, body: Record<string, unknown>) => {
      putBody = body;
      return { data: {} };
    },
    post: async () => ({ data: {} }),
  };
  (gw as any).disableMcpClientAutoExecute = async () => undefined;
  await gw.editMCPServer({
    server_id: 'mc-1',
    server_name: 'srv',
    extra_headers: ['x-tenant', 'x-trace'],
  });
  assert.deepEqual(putBody?.allowed_extra_headers, ['x-tenant', 'x-trace']);
  clearModule('services/BifrostGatewayClient');
});

test('dataSourceRoutes: volume create auto-assigns deployment with region match', async () => {
  const dsProject = 'projds00001';
  const dsBase = `/api/v1/projects/${dsProject}/datasources`;
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
    Deployment: makeFakeRepo({
      find: async () => [
        {
          id: 'dep-east',
          region: 'us-east-1',
          capacity: { max_buckets: 5 },
          registered_at: new Date('2024-01-01T00:00:00.000Z'),
          status: 'healthy',
        },
      ],
    }),
    DeploymentAssignment: makeFakeRepo({
      find: async () => [],
      create: (d: any) => ({ ...d }),
      save: async (e: any) => e,
    }),
    ConfigVersion: makeFakeRepo({
      findOne: async () => ({ id: 1, version: 3 }),
      save: async (e: any) => e,
    }),
    ReferenceEdge: makeFakeRepo({
      createQueryBuilder: () => makeQueryBuilder({ execute: undefined }),
    }),
  });
  const wf = { post: async () => ({ data: {} }), get: async () => ({ data: {} }), delete: async () => ({ data: {} }), put: async () => ({ data: {} }), interceptors: { request: { use: () => undefined } } };
  const restoreAxios = mock.method(axios, 'create', () => wf as any);
  dsHandle.repos.DataSource = makeFakeRepo({
    count: async () => 0,
    save: async (e: any) => ({
      id: 'vol000000001',
      projectId: dsProject,
      name: e.name,
      type: 'volume',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    findOne: async () => ({
      id: 'vol000000001',
      projectId: dsProject,
      name: 'my-volume',
      type: 'volume',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  });
  const router = loadFresh('routes/dataSourceRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasources', router });
  const res = await request(dsApp, 'POST', dsBase, {
    body: {
      name: 'my-volume',
      type: 'volume',
      volume_config: {
        region: 'us-east-1',
        volume_info: { type: 'nfs' },
        auth_info: { type: 'none' },
        protocol: 'NFS',
      },
    },
  });
  assert.equal(res.status, 201);
  restoreAxios.mock.restore();
  clearModule('routes/dataSourceRoutes');
  dsHandle.restore();
});

test('dataSourceRoutes: volume create continues when deployment assignment throws', async () => {
  const dsProject = 'projds00002';
  const dsBase = `/api/v1/projects/${dsProject}/datasources`;
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
    Deployment: makeFakeRepo({
      find: async () => [
        {
          id: 'dep-west',
          region: 'us-west-2',
          capacity: { max_buckets: 10 },
          registered_at: new Date('2024-01-01T00:00:00.000Z'),
          status: 'healthy',
        },
      ],
    }),
    DeploymentAssignment: makeFakeRepo({
      find: async () => [],
      create: () => {
        throw new Error('assignment failed');
      },
    }),
    ReferenceEdge: makeFakeRepo({
      createQueryBuilder: () => makeQueryBuilder({ execute: undefined }),
    }),
  });
  const wf = { post: async () => ({ data: {} }), get: async () => ({ data: {} }), delete: async () => ({ data: {} }), put: async () => ({ data: {} }), interceptors: { request: { use: () => undefined } } };
  const restoreAxios = mock.method(axios, 'create', () => wf as any);
  const savedRow = {
    id: 'vol000000002',
    projectId: dsProject,
    name: 'my-volume',
    type: 'volume',
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  dsHandle.repos.DataSource = makeFakeRepo({
    count: async () => 0,
    save: async (e: any) => {
      Object.assign(savedRow, e);
      return { ...savedRow };
    },
    findOne: async () => ({ ...savedRow }),
  });
  const router = loadFresh('routes/dataSourceRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasources', router });
  const res = await request(dsApp, 'POST', dsBase, {
    body: {
      name: 'my-volume',
      type: 'volume',
      volume_config: {
        region: 'us-west-2',
        volume_info: { type: 'nfs' },
        auth_info: { type: 'none' },
        protocol: 'NFS',
      },
    },
  });
  assert.equal(res.status, 201);
  restoreAxios.mock.restore();
  clearModule('routes/dataSourceRoutes');
  dsHandle.restore();
});

test('dataSourceRoutes: bulk-preflight catches per-item workflow throws', async () => {
  const dsProject = 'projds00003';
  const dsBase = `/api/v1/projects/${dsProject}/datasources`;
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
  });
  const wf = {
    post: async () => {
      throw new Error('workflow exploded');
    },
    get: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    interceptors: { request: { use: () => undefined } },
  };
  const restoreAxios = mock.method(axios, 'create', () => wf as any);
  dsHandle.repos.DataSource = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            id: 'vol000000003',
            projectId: dsProject,
            name: 'ontap-vol',
            type: 'volume',
            metadata: { source: 'ontap', connector_id: 'cn-000000001' },
            volumeConfig: { volume_info: { type: 'nfs', endpoint: 'nfs://old' } },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
  });
  const router = loadFresh('routes/dataSourceRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasources', router });
  const res = await request(dsApp, 'POST', `${dsBase}/bulk-preflight`, {
    body: { filter: { source: 'ontap' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.results[0].error, 'workflow exploded');
  restoreAxios.mock.restore();
  clearModule('routes/dataSourceRoutes');
  dsHandle.restore();
});

test('dataSourceRoutes: POST scan returns 500 when trigger fails', async () => {
  const dsProject = 'projds00004';
  const dsBase = `/api/v1/projects/${dsProject}/datasources`;
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
  });
  const wf = {
    post: async () => {
      throw new Error('scan trigger failed');
    },
    get: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    interceptors: { request: { use: () => undefined } },
  };
  const restoreAxios = mock.method(axios, 'create', () => wf as any);
  let getCalls = 0;
  dsHandle.repos.DataSource = makeFakeRepo({
    findOne: async () => {
      getCalls += 1;
      if (getCalls >= 2) {
        throw new Error('scan trigger failed');
      }
      return {
        id: 'vol000000004',
        projectId: dsProject,
        name: 'scan-vol',
        type: 'volume',
        scanConfig: { scan_depth: 'all_levels' },
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    save: async (e: any) => e,
    update: async () => ({ affected: 1 }),
  });
  const router = loadFresh('routes/dataSourceRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasources', router });
  const res = await request(dsApp, 'POST', `${dsBase}/vol000000004/scan`, { body: {} });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /scan trigger failed/);
  restoreAxios.mock.restore();
  clearModule('routes/dataSourceRoutes');
  dsHandle.restore();
});

test('projectRoutes: DELETE continues when delete workflow service fails to construct', async (t) => {
  const prProject = 'projpr00001';
  const prHandle = installFakeRepositories({});
  const prScope = restoreScope();
  t.after(() => prScope.restoreAll());
  prScope.add(
    mockModule('services/ProjectInitService', {
      ProjectInitService: class {
        initializeProject() {
          return Promise.resolve();
        }
      },
    }),
  );
  prScope.add(
    mockModule('services/ProjectDeleteService', {
      ProjectDeleteService: class {
        constructor() {
          throw new Error('delete service init failed');
        }
      },
    }),
  );
  prScope.add(
    mockModule('services/ProjectServiceAccountService', {
      ProjectServiceAccountService: { create: async () => ({}), getByProjectId: async () => ({}) },
    }),
  );
  prScope.add(
    mockModule('services/WorkspaceTemplateService', {
      WorkspaceTemplateService: { seedDefaultTemplates: async () => undefined },
    }),
  );
  prScope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => false }) }));
  prScope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      teardownProjectGateway: async () => ({ modelsRemoved: 0, modelsFound: 0, mcpServersRemoved: 0, mcpServersFound: 0, virtualKeyDeleted: false, teamDeleted: false }),
    }),
  );
  prScope.add(mockModule('services/ReferenceEdgeService', { removeForProject: async () => 0 }));
  prScope.add(
    mockModule('services/FacetService', {
      FacetService: { deleteForProject: async () => 0, getFacet: async () => null },
    }),
  );
  prHandle.repos.Project = makeFakeRepo({
    findOne: async () => ({
      id: prProject,
      name: 'Delete Me',
      home_dir: `s3://default-nemo/projects/${prProject}`,
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    }),
    delete: async () => ({ affected: 1 }),
  });
  const prRouter = loadFresh('routes/projectRoutes').default;
  const prApp = buildApp({ basePath: '/', router: prRouter, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(prApp, 'DELETE', `/api/v1/projects/${prProject}`);
  assert.equal(res.status, 204);
  clearModule('routes/projectRoutes');
  prHandle.restore();
});

test('projectRoutes: DELETE continues when reference-edge cleanup throws', async (t) => {
  const prProject = 'projpr00002';
  const prHandle = installFakeRepositories({});
  const prScope = restoreScope();
  t.after(() => prScope.restoreAll());
  prScope.add(
    mockModule('services/ProjectDeleteService', {
      ProjectDeleteService: class {
        deleteProject() {
          return Promise.resolve();
        }
      },
    }),
  );
  prScope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => false }) }));
  prScope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      teardownProjectGateway: async () => ({ modelsRemoved: 0, modelsFound: 0, mcpServersRemoved: 0, mcpServersFound: 0, virtualKeyDeleted: false, teamDeleted: false }),
    }),
  );
  prScope.add(
    mockModule('services/ReferenceEdgeService', {
      removeForProject: async () => {
        throw new Error('edge cleanup failed');
      },
    }),
  );
  prScope.add(
    mockModule('services/FacetService', {
      FacetService: { deleteForProject: async () => 0, getFacet: async () => null },
    }),
  );
  prHandle.repos.Project = makeFakeRepo({
    findOne: async () => ({
      id: prProject,
      name: 'Delete Me',
      home_dir: `s3://default-nemo/projects/${prProject}`,
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    }),
    delete: async () => ({ affected: 1 }),
  });
  const prRouter = loadFresh('routes/projectRoutes').default;
  const prApp = buildApp({ basePath: '/', router: prRouter, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(prApp, 'DELETE', `/api/v1/projects/${prProject}`);
  assert.equal(res.status, 204);
  clearModule('routes/projectRoutes');
  prHandle.restore();
});

test('projectRoutes: GET service-account returns 404 when project row missing', async (t) => {
  const prProject = 'projpr00003';
  const prHandle = installFakeRepositories({});
  const prScope = restoreScope();
  t.after(() => prScope.restoreAll());
  prScope.add(
    mockModule('services/ProjectServiceAccountService', {
      ProjectServiceAccountService: {
        getByProjectId: async () => {
          throw new Error('should not be called');
        },
      },
    }),
  );
  prHandle.repos.Project = makeFakeRepo({
    exists: async () => false,
    count: async () => 0,
  });
  const prRouter = loadFresh('routes/projectRoutes').default;
  const prApp = buildApp({ basePath: '/', router: prRouter, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(prApp, 'GET', `/api/v1/projects/${prProject}/service-account`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
  clearModule('routes/projectRoutes');
  prHandle.restore();
});

test('internalProjectRoutes: init-status failed stores error message', async (t) => {
  const ipProject = 'projip00001';
  const ipHandle = installFakeRepositories({});
  const ipScope = restoreScope();
  t.after(() => ipScope.restoreAll());
  let savedError: string | null | undefined;
  ipHandle.repos.Project = makeFakeRepo({
    update: async (id: string, data: any) => {
      if (id === ipProject) {
        savedError = data.init_error;
        return { affected: 1 };
      }
      return { affected: 0 };
    },
  });
  const ipRouter = loadFresh('routes/internalProjectRoutes').default;
  const ipApp = buildApp({ basePath: '/api/v1/internal/projects', router: ipRouter });
  const res = await request(ipApp, 'POST', `/api/v1/internal/projects/${ipProject}/init-status`, {
    body: { status: 'failed', error: 'lakekeeper timeout' },
  });
  assert.equal(res.status, 200);
  assert.equal(savedError, 'lakekeeper timeout');
  clearModule('routes/internalProjectRoutes');
  ipHandle.restore();
});

// ─── wave 3c: remaining high-yield branch gaps ────────────────────────────────

test('LakekeeperCatalogService.listWarehouses: unwraps warehouses wrapper object', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'wrapped-wh', 'warehouse-id': WH_ID }] },
      }),
    }),
  );
  const rows = await svc.listWarehouses();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'wrapped-wh');
});

test('LakekeeperCatalogService.getWarehouse: warns when warehouse row lacks id fields', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'no-id-wh', 'storage-profile': { bucket: 'b-only' } }] },
      }),
    }),
  );
  const wh = await svc.getWarehouse('no-id-wh');
  assert.equal(wh.name, 'no-id-wh');
  assert.equal((wh as any).warehouseId, undefined);
});

test('LakekeeperCatalogService.getWarehouse: wraps upstream errors with HTTP status', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('busy');
        err.response = { status: 502, data: { message: 'gateway timeout' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.getWarehouse('nemo'), /Failed to get warehouse.*gateway timeout/);
});

test('LakekeeperCatalogService.createTable: includes optional table metadata fields', async () => {
  let posted: Record<string, unknown> | undefined;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body as Record<string, unknown>;
        return { data: { metadata: {} } };
      },
    }),
  );
  await svc.createTable({
    name: 'events',
    namespace: ['proj1', 'datasets'],
    warehouseId: WH_ID,
    schema: { type: 'struct', fields: [{ id: 1, name: 'id', type: 'long', required: true }] },
    partitionSpec: [{ 'field-id': 1, name: 'day', transform: 'day' }],
    sortOrder: [{ 'field-id': 1, direction: 'asc', 'null-order': 'nulls-first' }],
    location: 's3://bucket/table/path',
  });
  assert.ok(posted?.['partition-spec']);
  assert.ok(posted?.['sort-order']);
  assert.equal(posted?.location, 's3://bucket/table/path');
});

test('LakekeeperCatalogService.createTable: wraps upstream create failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => {
        const err: any = new Error('create failed');
        err.response = { status: 422, data: { message: 'invalid schema' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () =>
      svc.createTable({
        name: 'events',
        namespace: ['default'],
        warehouseId: WH_ID,
        schema: { type: 'struct', fields: [] },
      }),
    /Failed to create table.*invalid schema/,
  );
});

test('LakekeeperCatalogService.listNamespaces: 404 retry returns namespaces array', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        attempts += 1;
        if (attempts === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { data: [{ namespace: ['a', 'b'] }] };
      },
    }),
  );
  const rows = await svc.listNamespaces(['parent']);
  assert.equal(rows.length, 1);
  assert.ok(attempts >= 2);
});

test('LakekeeperCatalogService.updateTableSchema: serializes complex field types', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            'current-schema-id': 1,
            schemas: [{ 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true }] }],
          },
        },
      }),
      post: async () => ({ data: { metadata: { 'current-schema-id': 2 } } }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const table = await svc.updateTableSchema(
    ['proj1', 'datasets'],
    'events',
    {
      type: 'struct',
      fields: [
        {
          id: 2,
          name: 'tags',
          type: { type: 'list', elementType: 'string' },
          required: false,
          doc: 'tag list',
        },
      ],
    },
  );
  assert.ok(table.metadata);
});

test('LakekeeperCatalogService.createWarehouse: caches warehouse-id hyphenated field', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => ({ data: { 'warehouse-id': WH_ID, name: 'hyphen-id' } }),
    }),
  );
  await svc.createWarehouse({ name: 'hyphen-id', uri: 's3://bucket' });
  assert.equal((svc as any).warehouseId, WH_ID);
});

test('ManifestService.replaceManifestFiles: rejects duplicate relative paths', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedManifest({ findOne: async () => ({ id: 'm1', dataSetId: 'ds1', status: 'draft' }) });
  await assert.rejects(
    ManifestService.replaceManifestFiles('m1', [
      's3://b/data_files/dir/a.txt',
      's3://b/data_files/dir/a.txt',
    ]),
    /Duplicate file paths/,
  );
});

test('ManifestService.addFilesToManifest: rejects conflicts with existing manifest files', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = '0';
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft', dataSetId: 'ds1' }) });
  seedFile({
    find: async () => [{ id: 'f1', manifestId: 'm1', fileName: 'dir/a.txt' }],
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '1' } }),
  });
  await assert.rejects(
    ManifestService.addFilesToManifest('m1', ['dir/a.txt'], 'my-bucket'),
    /File path conflicts detected/,
  );
});

test('ManifestService.replaceManifestFiles: invalid env cap falls back to default limit', async () => {
  process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET = 'not-a-number';
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '49999' } }),
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  const uris = ['s3://b/data_files/only-one.txt'];
  const m = await ManifestService.replaceManifestFiles('m1', uris);
  assert.equal(m.id, 'm1');
});

test('ManifestService.updateManifestStatus: sets dataset warning on ECONNREFUSED', async () => {
  s3Send = mock.fn(async () => {
    const err: any = new Error('refused');
    err.code = 'ECONNREFUSED';
    throw err;
  });
  scope.restoreAll();
  scope = restoreScope();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: { send: s3Send },
      S3_CONFIG: { S3_ENDPOINT: 'http://s3gateway:7070', DEFAULT_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' },
    }),
  );
  scope.add(
    mockModule('services/DatasetImportService', {
      DatasetImportService: class {
        startDatasetImport() {
          return Promise.resolve('wf-import');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;

  const dsRow: any = {
    id: 'ds1',
    projectId: PROJECT,
    status: 'in_progress',
    bucketName: 'default-nemo',
  };
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm1',
            dataSetId: 'ds1',
            manifestId: 1,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => dsRow,
    save: async (row: any) => {
      Object.assign(dsRow, row);
      return row;
    },
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  await ManifestService.updateManifestStatus('m1', 'committed');
  assert.match(String(dsRow.errorMessage), /Storage gateway temporarily unreachable/);
});

test('buildKeyPayload: azure includes AAD client credential fields', () => {
  const payload = buildKeyPayload({
    llmProvider: 'azure',
    modelId: 'm1',
    providerModelId: 'gpt-4o',
    gatewayBindingName: 'bind-1',
    providerDeploymentName: 'deploy-1',
    apiKey: 'sk',
    credentialMetadata: {
      endpoint: 'https://azure.openai.azure.com',
      client_id: 'cid',
      client_secret: 'csec',
      tenant_id: 'tid',
    },
  });
  const azureCfg = payload.azure_key_config as Record<string, unknown>;
  assert.equal((azureCfg.client_id as { value: string }).value, 'cid');
  assert.deepEqual(azureCfg.scopes, ['https://cognitiveservices.azure.com/.default']);
});

test('buildKeyPayload: includes credential description with project hint', () => {
  const payload = buildKeyPayload({
    llmProvider: 'openai',
    modelId: 'm1',
    providerModelId: 'gpt-4o',
    credentialName: 'Corp Key',
    projectId: PROJECT,
    apiKey: 'sk',
  });
  assert.match(String(payload.description), /Corp Key/);
  assert.match(String(payload.description), new RegExp(PROJECT));
});

test('buildKeyPayload: bedrock includes session_token when provided', () => {
  const payload = buildKeyPayload({
    llmProvider: 'aws_bedrock',
    modelId: 'm1',
    providerModelId: 'anthropic.claude-v2',
    apiKey: 'AKIA',
    credentialMetadata: { secret_key: 'sec', session_token: 'sess', region: 'eu-west-1' },
  });
  const cfg = payload.bedrock_key_config as Record<string, { value: string }>;
  assert.equal(cfg.session_token.value, 'sess');
});

test('appendProviderKey: merges prior and new aliases when extending an existing key', async () => {
  let putBody: Record<string, unknown> | undefined;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url.endsWith('/keys')) {
        return {
          data: {
            keys: [{
              id: 'key-1',
              name: 'as-cred-c1',
              models: ['old-binding'],
              aliases: { 'safe-bind': 'gpt-4o' },
            }],
          },
        };
      }
      throw new Error(url);
    },
    put: async (_url: string, body: unknown) => {
      putBody = body as Record<string, unknown>;
      return { data: {} };
    },
    post: async () => ({ data: {} }),
  } as unknown as AxiosInstance;

  await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o-mini',
      gatewayBindingName: 'new-binding',
      credentialId: 'c1',
      apiKey: 'sk-test',
    },
    fake,
  );
  const aliases = putBody?.aliases as Record<string, string>;
  assert.equal(aliases['safe-bind'], 'gpt-4o');
  assert.equal(aliases['new-binding'], 'gpt-4o-mini');
});

test('ensureProviderConfigured: throws when provider remains missing after create', async () => {
  const fake = {
    get: async () => ({ data: { providers: [] } }),
    post: async () => ({ data: {} }),
  } as unknown as AxiosInstance;
  await assert.rejects(
    () => ensureProviderConfigured('ghost-provider', fake),
    /Failed to auto-create Bifrost provider 'ghost-provider'/,
  );
});

test('removeProviderModelFromKey: preserves provider configs when trimming models', async () => {
  let putBody: Record<string, unknown> | undefined;
  const fake = {
    get: async () => ({
      data: {
        keys: [{
          id: 'kid-1',
          name: 'as-cred-c1',
          models: ['bind-a', 'bind-b'],
          aliases: { 'bind-a': 'gpt-4o', 'bind-b': 'gpt-4o-mini' },
          azure_key_config: { endpoint: { value: 'https://azure.example' } },
          bedrock_key_config: { region: { value: 'us-east-1' } },
          vertex_key_config: { region: { value: 'us-central1' } },
          description: 'cred',
        }],
      },
    }),
    put: async (_url: string, body: unknown) => {
      putBody = body as Record<string, unknown>;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  const removed = await removeProviderModelFromKey('openai', 'as-cred-c1', 'bind-a', fake, 'sk-live');
  assert.equal(removed, true);
  assert.ok(putBody?.azure_key_config);
  assert.ok(putBody?.bedrock_key_config);
  assert.ok(putBody?.vertex_key_config);
  assert.equal(putBody?.description, 'cred');
});

test('normalizeBifrostKeyValue: passes through null and plain values', () => {
  assert.deepEqual(normalizeBifrostKeyValue({ id: 'k', value: null }), { id: 'k', value: null });
  assert.deepEqual(normalizeBifrostKeyValue({ id: 'k', value: 'plain' }), { id: 'k', value: 'plain' });
});

test('updateProviderProxyOnGateway: sends concurrency and buffer size', async () => {
  let putBody: Record<string, unknown> | undefined;
  const fake = {
    put: async (_url: string, body: unknown) => {
      putBody = body as Record<string, unknown>;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  await updateProviderProxyOnGateway('openai', 8, 16, fake);
  const tuning = putBody?.concurrency_and_buffer_size as Record<string, number>;
  assert.equal(tuning.concurrency, 8);
  assert.equal(tuning.buffer_size, 16);
});

test('dataSetRoutes: GET enriches in-progress datasets with live workflow progress', async (t) => {
  const dsProject = 'projds00005';
  const dsBase = `/api/v1/projects/${dsProject}/datasets?include=dependentsSummary=false`;
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
    DataSource: makeFakeRepo({
      createQueryBuilder: () => makeQueryBuilder({ many: [] }),
    }),
  });
  const dsScope = restoreScope();
  t.after(() => dsScope.restoreAll());
  dsScope.add(
    mockModule('services/DataSetService', {
      DataSetService: {
        listDataSets: async () => [{
          id: 'ds-progress',
          projectId: dsProject,
          name: 'events',
          status: 'in_progress',
          jobId: 'wf-import-1',
          progress: { phase: 'old', percentage: 1 },
          facets: [{ id: 'facet-1', state: 'in_progress', jobId: 'wf-facet-1', type: 'pii' }],
        }],
      },
    }),
  );
  dsScope.add(
    mockModule('services/ManifestService', {
      ManifestService: {
        countFiles: async () => 0,
      },
    }),
  );
  dsScope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        getTableSnapshots() {
          return Promise.resolve([]);
        }
      },
    }),
  );
  const progressPayload = {
    phase: 'importing',
    percentage: 42,
    message: 'processing',
    extra: { totalFiles: 10, processedFiles: 4, sourceFileCount: 10, rowCount: 100, columnCount: 5 },
    totalUnits: 10,
    units: 4,
  };
  const restoreAxios = mock.method(axios, 'get', async (url: string) => {
    if (String(url).includes('/progress')) {
      return { status: 200, data: progressPayload };
    }
    return { status: 200, data: {} };
  });
  const router = loadFresh('routes/dataSetRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasets', router });
  const res = await request(dsApp, 'GET', dsBase);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].progress.percentage, 42);
  assert.equal(res.body[0].stats.rowCount, 100);
  assert.equal(res.body[0].facets[0].progress.phase, 'importing');
  restoreAxios.mock.restore();
  clearModule('routes/dataSetRoutes');
  dsHandle.restore();
});

test('dataSetRoutes: GET dependents returns 404 when dataset missing', async (t) => {
  const dsProject = 'projds00006';
  const dsHandle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: dsProject, name: 'P', home_dir: 's3://b/p' }) }),
  });
  const dsScope = restoreScope();
  t.after(() => dsScope.restoreAll());
  dsScope.add(
    mockModule('services/DataSetService', {
      DataSetService: {
        getDataSet: async () => null,
      },
    }),
  );
  const router = loadFresh('routes/dataSetRoutes').default;
  const dsApp = buildApp({ basePath: '/api/v1/projects/:projectId/datasets', router });
  const res = await request(dsApp, 'GET', `/api/v1/projects/${dsProject}/datasets/missing-ds/dependents`);
  assert.equal(res.status, 404);
  clearModule('routes/dataSetRoutes');
  dsHandle.restore();
});

test('selectPlatformMcpClientNames: includes web search when flag enabled', async () => {
  const { selectPlatformMcpClientNames } = await import('../services/bifrost/bifrostProjectGovernance');
  const names = selectPlatformMcpClientNames(
    [
      {
        catalogId: 'web_search_mcp',
        status: 'ready',
        syncStatus: 'synced',
        llmproxyGatewayServerName: 'web_search_mcp',
        name: 'web-search',
      } as any,
    ],
    { webSearch: true, analytics: false },
  );
  assert.ok(names.includes('web_search_mcp'));
});

test('removeProviderModelFromKey: deletes key when last model is removed', async () => {
  let deleted = false;
  const fake = {
    get: async () => ({
      data: { keys: [{ id: 'kid-1', name: 'as-cred-c1', models: ['only-model'] }] },
    }),
    delete: async () => {
      deleted = true;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  const removed = await removeProviderModelFromKey('openai', 'as-cred-c1', 'only-model', fake);
  assert.equal(removed, true);
  assert.equal(deleted, true);
});

test('LakekeeperCatalogService.getTableSnapshots: returns snapshots from table metadata', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            snapshots: [{ 'snapshot-id': 1, 'timestamp-ms': 1000 }],
          },
        },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const snaps = await svc.getTableSnapshots(['proj1', 'datasets'], 'events');
  assert.equal(snaps.length, 1);
});

test('LakekeeperCatalogService.getTableSnapshots: wraps upstream failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.getTableSnapshots(['proj1', 'datasets'], 'ghost'),
    /Failed to get table snapshots/,
  );
});

test('LakekeeperCatalogService.getCurrentSnapshotId: returns null when absent', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({ data: { metadata: {} } }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  assert.equal(await svc.getCurrentSnapshotId(['proj1', 'datasets'], 'events'), null);
});

test('LakekeeperCatalogService.getTableSchema: uses schema matching current-schema-id', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            'current-schema-id': 2,
            schemas: [
              { 'schema-id': 1, fields: [{ id: 1, name: 'old', type: 'long', required: true }] },
              { 'schema-id': 2, fields: [{ id: 2, name: 'current', type: 'string', required: false, doc: 'active' }] },
            ],
          },
        },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const schema = await svc.getTableSchema(['proj1', 'datasets'], 'events');
  assert.equal(schema?.fields?.[0]?.name, 'current');
});

test('ManifestService.countFiles: returns zero when count row is missing', async () => {
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: undefined }),
  });
  assert.equal(await ManifestService.countFiles('ds1'), 0);
});

test('ManifestService.createManifest: rejects duplicate upload paths', async () => {
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedManifest({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'm-new' }),
  });
  await assert.rejects(
    ManifestService.createManifest('ds1', [
      's3://b/data_files/a.txt',
      's3://b/data_files/a.txt',
    ]),
    /Duplicate file paths/,
  );
});

test('buildKeyPayload: credential description omits project hint when absent', () => {
  const payload = buildKeyPayload({
    llmProvider: 'openai',
    modelId: 'm1',
    providerModelId: 'gpt-4o',
    credentialName: 'Shared Key',
    apiKey: 'sk',
  });
  assert.equal(payload.description, 'AgentStudio credential: Shared Key');
});

test('buildKeyPayload: google vertex uses projectId and location metadata fallbacks', () => {
  const payload = buildKeyPayload({
    llmProvider: 'google',
    modelId: 'm1',
    providerModelId: 'gemini-pro',
    credentialMetadata: { projectId: 'proj-from-meta', location: 'europe-west1' },
  });
  const cfg = payload.vertex_key_config as Record<string, { value: string }>;
  assert.equal(cfg.project_id.value, 'proj-from-meta');
  assert.equal(cfg.region.value, 'europe-west1');
});

test('buildKeyPayload: bedrock drops top-level value when only access key is provided', () => {
  const payload = buildKeyPayload({
    llmProvider: 'aws_bedrock',
    modelId: 'm1',
    providerModelId: 'anthropic.claude-v2',
    apiKey: 'AKIA',
    credentialMetadata: { region: 'us-west-2' },
  });
  assert.equal(payload.value, undefined);
  assert.ok(payload.bedrock_key_config);
});

test('listGatewayProviders: uses default axios client when none supplied', async () => {
  const fakeClient = {
    get: async () => ({ data: { providers: [{ name: 'openai' }], total: 1 } }),
  };
  const restoreAxios = mock.method(axios, 'create', () => fakeClient as any);
  clearModule('services/bifrost/bifrostProviderOps');
  const { listGatewayProviders } = await import('../services/bifrost/bifrostProviderOps');
  const out = await listGatewayProviders();
  assert.equal(out.providers.length, 1);
  restoreAxios.mock.restore();
  clearModule('services/bifrost/bifrostProviderOps');
});

test('LakekeeperCatalogService.setCurrentSnapshot: omits assert-ref without expected current', async () => {
  let posted: Record<string, unknown> | undefined;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body as Record<string, unknown>;
        return { data: { metadata: { 'current-snapshot-id': 3 } } };
      },
    }),
  );
  await svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 3);
  assert.equal((posted?.requirements as unknown[])?.length ?? 0, 0);
});

test('LakekeeperCatalogService.setCurrentSnapshot: retries commit on 404 namespace encoding', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (url) => {
        attempts += 1;
        if (attempts === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { data: { metadata: { 'current-snapshot-id': 4 } } };
      },
    }),
  );
  await svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 4);
  assert.ok(attempts >= 2);
});

test('LakekeeperCatalogService.listNamespaces: returns bare array without parent filter', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({ data: [{ namespace: ['root'] }] }),
    }),
  );
  const rows = await svc.listNamespaces();
  assert.equal(rows.length, 1);
});

test('buildKeyPayload: omits aliases when binding equals upstream id', () => {
  const payload = buildKeyPayload({
    llmProvider: 'openai',
    modelId: 'm1',
    providerModelId: 'gpt-4o',
    apiKey: 'sk',
  });
  assert.equal(payload.aliases, undefined);
});

test('ManifestService.createManifestFromManifest: uses basename for non-s3 uri', async () => {
  const saved: any[] = [];
  seedManifest({
    findOne: async (q: any) => {
      if (q?.where?.status === 'draft') return null;
      return {
        id: 'src',
        dataSetId: 'ds1',
        files: [{ uri: 'https://example.com/path/report.csv' }],
        metadata: {},
      };
    },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'new1' }),
  });
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedFile({
    create: (d: any) => ({ ...d }),
    save: async (rows: any) => {
      saved.push(...(Array.isArray(rows) ? rows : [rows]));
      return rows;
    },
  });
  await ManifestService.createManifestFromManifest('src');
  assert.equal(saved[0].fileName, 'report.csv');
});

test('toVkProviderConfigsWriteShape: merges key_ids from keys objects', async () => {
  const { toVkProviderConfigsWriteShape } = await import('../services/bifrost/bifrostProjectGovernance');
  const out = toVkProviderConfigsWriteShape([
    {
      provider: 'openai',
      keys: [{ key_id: 'kid-1' }, 'kid-2'],
    },
  ]);
  assert.deepEqual(out[0].key_ids, ['kid-1', 'kid-2']);
});

test('projectVkNameMatches: accepts rotated virtual key suffixes', async () => {
  const { projectVkNameMatches } = await import('../services/bifrost/bifrostProjectGovernance');
  assert.equal(projectVkNameMatches('as-proj-projabc123-vk-r9', 'projabc123'), true);
  assert.equal(projectVkNameMatches('other-vk', 'projabc123'), false);
});

test('LakekeeperCatalogService.healthCheck: returns true on first healthy endpoint', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        if (url === '/api/v1/health') return { status: 200, data: { ok: true } };
        throw new Error('should not probe further');
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
});

test('appendProviderKey: creates brand-new key via POST when no duplicate exists', async () => {
  let postUrl = '';
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(url);
    },
    post: async (url: string) => {
      postUrl = url;
      return { data: { id: 'new-kid' } };
    },
  } as unknown as AxiosInstance;
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-new',
      providerModelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.match(postUrl, /\/keys$/);
  assert.equal(result.keyId, 'new-kid');
});

test('NotFoundError: message without id omits id clause', async () => {
  const { NotFoundError, getErrorStatusCode } = await import('../utils/errors');
  const err = new NotFoundError('Manifest');
  assert.equal(err.message, 'Manifest not found');
  assert.equal(getErrorStatusCode(err), 404);
});

test('NotFoundError: message includes id when provided', async () => {
  const { NotFoundError } = await import('../utils/errors');
  assert.equal(new NotFoundError('Manifest', 'm1').message, 'Manifest with id m1 not found');
});

test('resolveHttpStatusCode: rejects out-of-range explicit status codes', async () => {
  const { resolveHttpStatusCode } = await import('../utils/errors');
  const err = Object.assign(new Error('fallback not found'), { statusCode: 600 });
  assert.equal(resolveHttpStatusCode(err), 404);
  const low = Object.assign(new Error('duplicate row'), { statusCode: 399 });
  assert.equal(resolveHttpStatusCode(low), 400);
});

test('AgentIdGenerator.validate: rejects malformed ids', async () => {
  const { AgentIdGenerator } = await import('../services/AgentIdGenerator');
  assert.equal(AgentIdGenerator.validate(''), false);
  assert.equal(AgentIdGenerator.validate('bad-prefix-abc'), false);
  assert.equal(AgentIdGenerator.validate('ag-short'), false);
  assert.equal(AgentIdGenerator.validate('ag-ABCDEFGH'), false);
});

test('ProjectIdGenerator.validate: rejects malformed project ids', async () => {
  const { ProjectIdGenerator } = await import('../utils/ProjectIdGenerator');
  assert.equal(ProjectIdGenerator.validate(''), false);
  assert.equal(ProjectIdGenerator.validate('proj-short'), false);
  assert.equal(ProjectIdGenerator.validate('proj-abc1234!'), false);
});

test('DataSetIdGenerator.validate: rejects malformed dataset ids', async () => {
  const { DataSetIdGenerator } = await import('../services/DataSetIdGenerator');
  assert.equal(DataSetIdGenerator.validate(''), false);
  assert.equal(DataSetIdGenerator.validate('dset-bad'), false);
});

test('PipelineIdGenerator.validate: rejects malformed pipeline ids', async () => {
  const { PipelineIdGenerator } = await import('../services/PipelineIdGenerator');
  assert.equal(PipelineIdGenerator.validate(''), false);
  assert.equal(PipelineIdGenerator.validate('pl-bad'), false);
});

test('KnowledgeBaseIdGenerator.validate: rejects malformed knowledge base ids', async () => {
  const { KnowledgeBaseIdGenerator } = await import('../services/KnowledgeBaseIdGenerator');
  assert.equal(KnowledgeBaseIdGenerator.validate(''), false);
  assert.equal(KnowledgeBaseIdGenerator.validate('kb-bad'), false);
});

test('VolumeIdGenerator.validate: rejects malformed volume ids', async () => {
  const { VolumeIdGenerator } = await import('../services/VolumeIdGenerator');
  assert.equal(VolumeIdGenerator.validate(''), false);
  assert.equal(VolumeIdGenerator.validate('vol-bad'), false);
});

test('AgentTeamIdGenerator.validate: rejects malformed team ids', async () => {
  const { AgentTeamIdGenerator } = await import('../services/AgentTeamIdGenerator');
  assert.equal(AgentTeamIdGenerator.validate(''), false);
  assert.equal(AgentTeamIdGenerator.validate('agr-bad'), false);
});

test('ConnectorIdGenerator.validate: rejects malformed connector ids', async () => {
  const { ConnectorIdGenerator } = await import('../services/ConnectorIdGenerator');
  assert.equal(ConnectorIdGenerator.validate(''), false);
  assert.equal(ConnectorIdGenerator.validate('cn-bad'), false);
});

test('ArtifactStoreIdGenerator.validate: rejects malformed artifact store ids', async () => {
  const { ArtifactStoreIdGenerator } = await import('../services/ArtifactStoreIdGenerator');
  assert.equal(ArtifactStoreIdGenerator.validate(''), false);
  assert.equal(ArtifactStoreIdGenerator.validate('as-bad'), false);
});

test('WorkspaceIdGenerator.validate: rejects malformed workspace ids', async () => {
  const { WorkspaceIdGenerator } = await import('../services/WorkspaceIdGenerator');
  assert.equal(WorkspaceIdGenerator.validate(''), false);
  assert.equal(WorkspaceIdGenerator.validate('UPPERCASE'), false);
});

test('validateConfigSchemaShape: returns errors for invalid schema shape', async () => {
  const { validateConfigSchemaShape } = await import('../validators/guardrailConfigSchemaMeta');
  const errors = validateConfigSchemaShape({ type: 'string' });
  assert.ok(errors.length > 0);
});

test('mapLlmProviderToBifrost: defaults and passthrough branches', () => {
  assert.equal(mapLlmProviderToBifrost(undefined), 'openai');
  assert.equal(mapLlmProviderToBifrost('custom-vendor'), 'custom-vendor');
  assert.equal(mapLlmProviderToBifrost('openai_compatible'), 'openai');
});

test('AWSBedrockAdapter: validate returns false when listModels throws', async () => {
  const { AWSBedrockAdapter } = await import('../providers/aws_bedrock');
  const a = new AWSBedrockAdapter();
  (a as any).listModels = async () => {
    throw new Error('bedrock down');
  };
  assert.equal(await a.validate({ aws_access_key_id: 'x', aws_secret_access_key: 'y' }), false);
});

test('OpenAIAdapter: validate propagates models request failures', async () => {
  const { OpenAIAdapter } = await import('../providers/openai');
  const a = new OpenAIAdapter();
  const restoreAxios = mock.method(axios, 'get', async () => {
    throw new Error('network down');
  });
  await assert.rejects(() => a.validate({ api_key: 'sk' }), /network down/);
  restoreAxios.mock.restore();
});

test('buildGatewayBindingName: empty providerModelId returns empty string', async () => {
  const { buildGatewayBindingName } = await import('../services/bifrost/bifrostProviderOps');
  assert.equal(buildGatewayBindingName('proj1', 'cred', ''), '');
});

test('buildBuiltinGatewayBindingName: replaces slashes with double underscores', async () => {
  const { buildBuiltinGatewayBindingName } = await import('../services/bifrost/bifrostProviderOps');
  assert.equal(
    buildBuiltinGatewayBindingName('sentence-transformers/all-MiniLM-L6-v2'),
    'sentence-transformers__all-MiniLM-L6-v2',
  );
});
