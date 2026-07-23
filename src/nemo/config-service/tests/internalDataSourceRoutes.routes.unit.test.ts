/**
 * Route-handler tests for routes/internalDataSourceRoutes.ts.
 *
 * The single internal callback endpoint persists scan state through
 * DataSourceRepository over the AppDataSource fake-repo seam. There are no
 * external systems involved (no axios, no @agentstudio/common), so the router
 * is imported directly and the scan-callback validator runs real.
 *
 * Run: node --require ts-node/register --test tests/internalDataSourceRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import internalDataSourceRouter from '../routes/internalDataSourceRoutes';
import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

const PROJECT = 'projtest0001';
const DS_ID = 'vol000000001';
const BASE = `/api/v1/internal/datasources`;
const URL = `${BASE}/${PROJECT}/${DS_ID}/scan-result`;

const app = buildApp({ basePath: BASE, router: internalDataSourceRouter });

let handle: FakeDataSourceHandle;

/** Entity-shaped row that survives DataSourceRepository.mapEntityToModel. */
function dsEntity(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: DS_ID,
    projectId: PROJECT,
    name: 'my-volume',
    type: 'volume',
    metadata: {},
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

const validScanResult = () => ({
  completed_at: '2024-01-02T00:00:00.000Z',
  total_files: 10,
  total_folders: 2,
  total_size_bytes: 4096,
  file_type_stats: [{ file_type: 'csv', count: 10 }],
});

beforeEach(() => {
  handle = installFakeRepositories({
    DataSource: makeFakeRepo({ findOne: async () => dsEntity({ type: 'volume' }) }),
  });
});

afterEach(() => handle.restore());

test('PATCH scan-result: missing scan_status returns 400', async () => {
  const res = await request(app, 'PATCH', URL, { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('PATCH scan-result: invalid scan_status.state returns 400', async () => {
  const res = await request(app, 'PATCH', URL, { body: { scan_status: { state: 'bogus' } } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('PATCH scan-result: malformed scan_result returns 400', async () => {
  const res = await request(app, 'PATCH', URL, {
    body: { scan_status: { state: 'completed' }, scan_result: { total_files: 1 } },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
});

test('PATCH scan-result: data source not found returns 404', async () => {
  handle.repos.DataSource = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'PATCH', URL, { body: { scan_status: { state: 'scanning' } } });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'NOT_FOUND');
});

test('PATCH scan-result: non-volume data source returns 400', async () => {
  handle.repos.DataSource = makeFakeRepo({ findOne: async () => dsEntity({ id: 'cn-000000001', type: 'connector' }) });
  const res = await request(app, 'PATCH', `${BASE}/${PROJECT}/cn-000000001/scan-result`, {
    body: { scan_status: { state: 'completed' }, scan_result: validScanResult() },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('PATCH scan-result: persists completed scan with result (200)', async () => {
  let savedScanResult: any;
  let savedScanStatus: any;
  handle.repos.DataSource = makeFakeRepo({
    findOne: async () => dsEntity({ type: 'volume' }),
    save: async (e: any) => {
      savedScanStatus = e.scanStatus;
      savedScanResult = e.scanResult;
      return e;
    },
  });
  const res = await request(app, 'PATCH', URL, {
    body: { scan_status: { state: 'completed' }, scan_result: validScanResult() },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, DS_ID);
  assert.equal(res.body.scan_status.state, 'completed');
  assert.equal(res.body.scan_result.total_files, 10);
  assert.equal(savedScanStatus.state, 'completed');
  assert.equal(savedScanResult.total_files, 10);
});

test('PATCH scan-result: persists status-only transition without result (200)', async () => {
  const res = await request(app, 'PATCH', URL, {
    body: { scan_status: { state: 'failed', last_error: 'boom' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.scan_status.state, 'failed');
});
