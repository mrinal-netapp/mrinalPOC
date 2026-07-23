/**
 * Route-handler tests for routes/searchRoutes.ts.
 *
 * The handler builds TypeORM query builders against AppDataSource; all DB access
 * flows through the fake-repo seam (no DB, no network).
 *
 * Run: node --require ts-node/register --test tests/searchRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import searchRouter from '../routes/searchRoutes';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

const BASE = '/api/v1/search';
const app = buildApp({ basePath: BASE, router: searchRouter });

let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => handle.restore());

test('POST /search: missing entityType -> 400', async () => {
  const res = await request(app, 'POST', BASE, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /entityType is required/i);
});

test('POST /search: invalid entityType -> 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { entityType: 'agents' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Invalid entityType/i);
});

test('POST /search: connectors returns matching data sources (200)', async () => {
  handle.repos.DataSource = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ds-1', name: 'conn', type: 'connector' }] }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { entityType: 'connectors', fields: { projectId: 'p1' }, nameRegex: 'con', limit: 5, skip: 0 },
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body[0].id, 'ds-1');
});

test('POST /search: datasources returns rows (200)', async () => {
  handle.repos.DataSource = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ds-2', name: 'src' }] }),
  });
  const res = await request(app, 'POST', BASE, { body: { entityType: 'datasources', fields: { status: 'active' } } });
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ds-2');
});

test('POST /search: datasets returns rows (200)', async () => {
  handle.repos.DataSet = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'dset-1', name: 'd' }] }),
  });
  const res = await request(app, 'POST', BASE, { body: { entityType: 'datasets', nameRegex: 'd' } });
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'dset-1');
});

test('POST /search: empty result set returns [] (200)', async () => {
  const res = await request(app, 'POST', BASE, { body: { entityType: 'datasets' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('POST /search: underlying query error -> 500', async () => {
  const qb = makeQueryBuilder();
  qb.getMany = async () => {
    throw new Error('db exploded');
  };
  handle.repos.DataSource = makeFakeRepo({ createQueryBuilder: () => qb });
  const res = await request(app, 'POST', BASE, { body: { entityType: 'connectors' } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /db exploded/i);
});
