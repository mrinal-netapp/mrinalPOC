/**
 * Unit tests for services/ManifestService.ts.
 *
 * Module-mocked seams (installed before the SUT is loaded):
 *   - utils/s3Utils (presigned URLs + S3 client)
 *   - services/DeploymentEndpointService (endpoint resolution)
 *   - services/DatasetImportService (import workflow trigger)
 * DB access flows through the AppDataSource fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/ManifestService.unit.test.ts
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
let ManifestService: any;
let dep: any;
let s3Send: ReturnType<typeof mock.fn>;

beforeEach(() => {
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
  delete process.env.MANUAL_UPLOAD_MAX_FILES_PER_DATASET;
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

test('getNextManifestId returns 1 then increments', async () => {
  seedManifest({ findOne: async () => null });
  assert.equal(await ManifestService.getNextManifestId('ds1'), 1);
  seedManifest({ findOne: async () => ({ manifestId: 7 }) });
  assert.equal(await ManifestService.getNextManifestId('ds1'), 8);
});

test('createManifest throws NotFoundError when the dataset is missing', async () => {
  seedDataSet({ findOne: async () => null });
  await assert.rejects(ManifestService.createManifest('ds1', []), /DataSet with id ds1/);
});

test('createManifest rejects when a draft already exists', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedManifest({ findOne: async (q: any) => (q?.where?.status === 'draft' ? { id: 'd0' } : null) });
  await assert.rejects(ManifestService.createManifest('ds1', []), /draft manifest already exists/);
});

test('createManifest rejects duplicate file URIs', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedManifest({ findOne: async () => null });
  await assert.rejects(
    ManifestService.createManifest('ds1', [
      's3://b/data_files/a.txt',
      's3://b/data_files/a.txt',
    ]),
    /Duplicate file paths/,
  );
});

test('createManifest persists a draft manifest with files', async () => {
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  const saveFiles = mock.fn(async (e: any) => e);
  seedManifest({
    findOne: async (q: any) => {
      if (q?.where?.status === 'draft') return null;
      if (q?.relations) return { id: 'mid', dataSetId: 'ds1', manifestId: 1, files: [] };
      return null;
    },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'mid' }),
  });
  seedFile({ create: (d: any) => ({ ...d }), save: saveFiles });
  const m = await ManifestService.createManifest('ds1', ['s3://b/data_files/a.txt']);
  assert.equal(m.id, 'mid');
  assert.equal(saveFiles.mock.callCount(), 1);
});

test('countFiles returns the aggregate count', async () => {
  seedFile({ createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '12' } }) });
  assert.equal(await ManifestService.countFiles('ds1'), 12);
});

test('countFiles excludes deprecated manifests from the query', async () => {
  const qb = makeQueryBuilder({ rawOne: { count: '5' } });
  seedFile({ createQueryBuilder: () => qb });
  await ManifestService.countFiles('ds1');
  const excludesDeprecated = qb.andWhere.mock.calls.some((c: any) =>
    String(c.arguments[0]).includes('deprecated') || c.arguments[1]?.deprecated === 'deprecated',
  );
  assert.ok(excludesDeprecated, 'expected countFiles to filter out deprecated manifests');
});

test('addFilesToManifest rejects when the manifest is not a draft', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'committed' }) });
  await assert.rejects(ManifestService.addFilesToManifest('m1', ['a.txt']), /Only draft manifests/);
});

test('addFilesToManifest requires a resolvable bucket', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft', dataSetId: 'ds1' }) });
  seedFile({ find: async () => [], createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }) });
  // No bucketName param and dataset has no bucketName -> error.
  seedDataSet({ findOne: async () => ({ id: 'ds1', bucketName: null }) });
  await assert.rejects(ManifestService.addFilesToManifest('m1', ['a.txt']), /Bucket name is required/);
});

test('addFilesToManifest generates presigned URLs for each file', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft', dataSetId: 'ds1' }) });
  seedFile({
    find: async () => [],
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'f1' }),
  });
  seedDataSet({ findOne: async () => ({ id: 'ds1', projectId: PROJECT }) });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });
  const res = await ManifestService.addFilesToManifest('m1', ['a.txt'], 'my-bucket');
  assert.equal(res.length, 1);
  assert.equal(res[0].preSignedUrl, 'http://presigned.example.com/upload');
});

test('replaceManifestFiles replaces the file list of a draft', async () => {
  const saveFiles = mock.fn(async (e: any) => e);
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => e,
  });
  seedFile({
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: saveFiles,
  });
  const m = await ManifestService.replaceManifestFiles('m1', ['s3://b/data_files/a.txt']);
  assert.equal(m.id, 'm1');
  assert.equal(saveFiles.mock.callCount(), 1);
});

test('replaceDraftManifestSourceUris rejects a dataset mismatch', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', dataSetId: 'other', status: 'draft' }) });
  await assert.rejects(
    ManifestService.replaceDraftManifestSourceUris('m1', 'ds1', []),
    /Manifest with id m1/,
  );
});

test('appendDraftManifestSourceUris returns early for empty input', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] }) });
  const m = await ManifestService.appendDraftManifestSourceUris('m1', 'ds1', []);
  assert.equal(m.id, 'm1');
});

test('appendDraftManifestSourceUris appends new file records', async () => {
  const saveFiles = mock.fn(async (e: any) => e);
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
  });
  seedFile({
    find: async () => [],
    createQueryBuilder: () => makeQueryBuilder({ rawOne: { count: '0' } }),
    create: (d: any) => ({ ...d }),
    save: saveFiles,
  });
  await ManifestService.appendDraftManifestSourceUris('m1', 'ds1', ['s3://b/data_files/x.txt']);
  assert.equal(saveFiles.mock.callCount(), 1);
});

test('deleteFileFromManifest throws when the file is absent', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft' }) });
  seedFile({ findOne: async () => null });
  await assert.rejects(ManifestService.deleteFileFromManifest('m1', 'f-x'), /File with id f-x not found/);
});

test('deleteFileFromManifest removes an existing file', async () => {
  const remove = mock.fn(async (e: any) => e);
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'draft' }) });
  seedFile({ findOne: async () => ({ id: 'f1', manifestId: 'm1' }), remove });
  await ManifestService.deleteFileFromManifest('m1', 'f1');
  assert.equal(remove.mock.callCount(), 1);
});

test('updateManifestMetadata rejects non-draft manifests', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', status: 'committed' }) });
  await assert.rejects(ManifestService.updateManifestMetadata('m1', {}), /Only draft manifests/);
});

test('updateManifestMetadata updates a draft', async () => {
  const row: any = { id: 'm1', status: 'draft' };
  seedManifest({ findOne: async () => row, save: async (e: any) => e });
  const m = await ManifestService.updateManifestMetadata('m1', { a: 1 });
  assert.deepEqual(m.metadata, { a: 1 });
});

test('updateManifestSchema updates a draft', async () => {
  const row: any = { id: 'm1', status: 'draft' };
  seedManifest({ findOne: async () => row, save: async (e: any) => e });
  const m = await ManifestService.updateManifestSchema('m1', { fields: [] });
  assert.deepEqual(m.schema, { fields: [] });
});

test('listManifests returns the manifests for a dataset', async () => {
  seedManifest({ find: async () => [{ id: 'm1' }, { id: 'm2' }] });
  assert.equal((await ManifestService.listManifests('ds1')).length, 2);
});

test('deleteAllManifestsForDataSet deletes files then manifests', async () => {
  const delManifests = mock.fn(async () => ({ affected: 2 }));
  seedManifest({ find: async () => [{ id: 'm1' }, { id: 'm2' }], delete: delManifests });
  seedFile({ createQueryBuilder: () => makeQueryBuilder() });
  await ManifestService.deleteAllManifestsForDataSet('ds1');
  assert.equal(delManifests.mock.callCount(), 1);
});

test('deleteAllManifestsForDataSet handles an empty manifest set', async () => {
  const delManifests = mock.fn(async () => ({ affected: 0 }));
  seedManifest({ find: async () => [], delete: delManifests });
  await ManifestService.deleteAllManifestsForDataSet('ds1');
  assert.equal(delManifests.mock.callCount(), 1);
});

test('getManifest delegates to findOne with files', async () => {
  seedManifest({ findOne: async () => ({ id: 'm1', files: [] }) });
  assert.equal((await ManifestService.getManifest('m1'))?.id, 'm1');
});

test('getLatestManifest prefers a draft over committed', async () => {
  seedManifest({ findOne: async (q: any) => (q?.where?.status === 'draft' ? { id: 'draft1' } : { id: 'committed1' }) });
  assert.equal((await ManifestService.getLatestManifest('ds1'))?.id, 'draft1');
});

test('getLatestManifest falls back to the latest committed', async () => {
  seedManifest({ findOne: async (q: any) => (q?.where?.status === 'draft' ? null : { id: 'committed1' }) });
  assert.equal((await ManifestService.getLatestManifest('ds1'))?.id, 'committed1');
});

test('createManifestFromManifest throws when the source is missing', async () => {
  seedManifest({ findOne: async () => null });
  await assert.rejects(ManifestService.createManifestFromManifest('src'), /Source manifest with id src/);
});

test('createManifestFromManifest copies files into a new draft', async () => {
  const saveFiles = mock.fn(async (e: any) => e);
  let call = 0;
  seedManifest({
    findOne: async (q: any) => {
      // getManifest(source) -> with relations; draft-check -> status draft (null); getNextManifestId -> null; getManifest(new) -> object
      if (q?.where?.status === 'draft') return null;
      call += 1;
      if (call === 1) {
        return { id: 'src', dataSetId: 'ds1', files: [{ uri: 's3://b/data_files/a.txt', fileName: 'a.txt' }], metadata: {} };
      }
      return { id: 'new1', dataSetId: 'ds1', files: [] };
    },
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'new1' }),
  });
  seedDataSet({ findOne: async () => ({ id: 'ds1' }) });
  seedFile({ create: (d: any) => ({ ...d }), save: saveFiles });
  const m = await ManifestService.createManifestFromManifest('src');
  assert.equal(m.id, 'new1');
  assert.equal(saveFiles.mock.callCount(), 1);
});

test('updateManifestStatus on a non-commit transition returns the reloaded manifest', async () => {
  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  const m = await ManifestService.updateManifestStatus('m1', 'draft');
  assert.equal(m.id, 'm1');
});

test('updateManifestStatus commit path is safe when the dataset has no bucket', async () => {
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
  // No bucketName -> writeManifestToS3 early-returns; status 'ready' -> import skipped.
  seedDataSet({ findOne: async () => ({ id: 'ds1', status: 'ready' }) });
  const m = await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(m.status, 'committed');
});

test('updateManifestStatus commit deprecates other committed manifests for the same dataset', async () => {
  const updateQb = makeQueryBuilder({ execute: { affected: 1 } });
  seedManifest({
    findOne: async (q: any) =>
      q?.relations
        ? {
            id: 'm2',
            dataSetId: 'ds1',
            manifestId: 2,
            status: 'committed',
            metadata: {},
            files: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : { id: 'm2', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
    createQueryBuilder: () => updateQb,
  });
  // No bucketName -> writeManifestToS3 early-returns; status 'ready' -> import skipped.
  seedDataSet({ findOne: async () => ({ id: 'ds1', status: 'ready' }) });
  await ManifestService.updateManifestStatus('m2', 'committed');

  assert.equal(updateQb.update.mock.callCount(), 1);
  const whereArgs = updateQb.where.mock.calls[0].arguments;
  assert.match(String(whereArgs[0]), /dataSetId/);
  assert.equal(whereArgs[1].dataSetId, 'ds1');
  const excludesSelf = updateQb.andWhere.mock.calls.some((c: any) => c.arguments[1]?.id === 'm2');
  const filtersCommitted = updateQb.andWhere.mock.calls.some((c: any) => c.arguments[1]?.committed === 'committed');
  assert.ok(excludesSelf, 'expected the just-committed manifest to be excluded from deprecation');
  assert.ok(filtersCommitted, 'expected only other committed manifests to be deprecated');
});

test('updateManifestStatus non-commit transition does not deprecate other manifests', async () => {
  const updateQb = makeQueryBuilder({ execute: { affected: 0 } });
  seedManifest({
    findOne: async (q: any) =>
      q?.relations ? { id: 'm1', dataSetId: 'ds1', status: 'draft', files: [] } : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
    createQueryBuilder: () => updateQb,
  });
  await ManifestService.updateManifestStatus('m1', 'draft');
  assert.equal(updateQb.update.mock.callCount(), 0);
});

test('updateManifestStatus commit writes manifest via internal s3Client', async () => {
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
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          }
        : { id: 'm1', dataSetId: 'ds1', status: 'draft' },
    save: async (e: any) => e,
  });
  seedDataSet({
    findOne: async () => ({ id: 'ds1', projectId: PROJECT, bucketName: 'default-nemo', status: 'in_progress' }),
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });
  await ManifestService.updateManifestStatus('m1', 'committed');
  assert.equal(s3Send.mock.callCount(), 1);
  const putCommand = s3Send.mock.calls[0].arguments[0] as { input: { Bucket: string; Key: string } };
  assert.equal(putCommand.input.Bucket, 'default-nemo');
  assert.match(putCommand.input.Key, /manifests\/v1\.manifest$/);
});

test('updateManifestStatus commit skips import for deprecated datasets', async () => {
  let importStarted = false;
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
      status: 'deprecated',
      bucketName: 'default-nemo',
    }),
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  await ManifestService.updateManifestStatus('m1', 'committed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(importStarted, false);
});

test('updateManifestStatus commit re-import drops existing catalog table for ready datasets', async () => {
  let deleteCalls = 0;
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        async deleteTable(_namespace: string[], tableName: string, warehouseName: string, opts?: { purge?: boolean }) {
          deleteCalls += 1;
          assert.equal(tableName, 'events');
          assert.equal(warehouseName, 'nemo');
          assert.equal(opts?.purge, true);
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
      status: 'ready',
      catalogTableName: 'events',
      namespace: PROJECT,
      warehouseName: 'nemo',
      bucketName: 'default-nemo',
      kind: 'unstructured',
      name: 'events',
    }),
    save: async (e: any) => e,
  });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: HOME_DIR }) });

  await ManifestService.updateManifestStatus('m1', 'committed');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 1);
});

test('prepareDatasetReimport: no-op when dataset is not eligible for re-import', async () => {
  let saved = false;
  seedDataSet({
    save: async () => {
      saved = true;
      return undefined;
    },
  });
  await ManifestService.prepareDatasetReimport(
    { id: 'ds1', projectId: PROJECT, status: 'in_progress', catalogTableName: 'events' } as any,
    'bucket',
    'prefix',
  );
  assert.equal(saved, false);
});

test('prepareDatasetReimport: acquired dataset drops catalog table and parquet prefix', async () => {
  let deleteTableCalls = 0;
  let deletePrefixCalls = 0;
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        async deleteTable(_namespace: string[], tableName: string) {
          deleteTableCalls += 1;
          assert.equal(tableName, 'events');
        }
      },
    }),
  );
  ManifestService = loadFresh('services/ManifestService').ManifestService;
  let savedStatus: string | undefined;
  seedDataSet({
    save: async (row: any) => {
      savedStatus = row.status;
      return row;
    },
  });
  const deletePrefix = mock.method(ManifestService, 'deleteS3Prefix', async () => {
    deletePrefixCalls += 1;
  });

  await ManifestService.prepareDatasetReimport(
    {
      id: 'ds1',
      projectId: PROJECT,
      status: 'ready',
      catalogTableName: 'events',
      namespace: PROJECT,
      warehouseName: 'nemo',
      type: 'acquired',
    } as any,
    'bucket',
    'projects/p1',
  );

  assert.equal(savedStatus, 'in_progress');
  assert.equal(deleteTableCalls, 1);
  assert.equal(deletePrefixCalls, 1);
  deletePrefix.mock.restore();
});

test('prepareDatasetReimport: manual errored dataset drops broken catalog table and waits', async () => {
  let deleteTableCalls = 0;
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        async deleteTable() {
          deleteTableCalls += 1;
          throw new Error('drop failed');
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
      type: 'manual',
    } as any,
    'bucket',
    'projects/p1',
  );

  assert.equal(deleteTableCalls, 1);
  assert.equal(deletePrefix.mock.callCount(), 1);
  deletePrefix.mock.restore();
  timer.mock.restore();
});

test('prepareDatasetReimport: manual ready dataset keeps existing catalog table', async () => {
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

  await ManifestService.prepareDatasetReimport(
    {
      id: 'ds1',
      projectId: PROJECT,
      status: 'ready',
      catalogTableName: 'events',
      type: 'manual',
    } as any,
    'bucket',
    'projects/p1',
  );

  assert.equal(deleteTableCalls, 0);
  assert.equal(deletePrefix.mock.callCount(), 0);
  deletePrefix.mock.restore();
});
