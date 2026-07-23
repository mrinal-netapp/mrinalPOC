/**
 * Unit tests for services/DataSetValidator.ts. validateCreateRequest/validateUpdate
 * are pure; checkDuplicateName uses the AppDataSource fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/DataSetValidator.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { DataSetValidator } from '../services/DataSetValidator';
import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';

const PROJECT = 'projtest0001';
let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => handle.restore());

test('validateCreateRequest requires a projectId', () => {
  assert.throws(
    () => DataSetValidator.validateCreateRequest('', { name: 'valid_name' } as any),
    /projectId is required/,
  );
});

test('validateCreateRequest rejects an invalid dataset name', () => {
  assert.throws(
    () => DataSetValidator.validateCreateRequest(PROJECT, { name: 'Has Spaces!' } as any),
    /Dataset name/,
  );
});

test('validateCreateRequest accepts a valid request', () => {
  assert.doesNotThrow(() =>
    DataSetValidator.validateCreateRequest(PROJECT, { name: 'my_dataset' } as any),
  );
});

test('checkDuplicateName throws ConflictError when a row exists', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => ({ id: 'd1', name: 'dup' }) });
  await assert.rejects(DataSetValidator.checkDuplicateName(PROJECT, 'dup'), /already exists/);
});

test('checkDuplicateName passes when no row exists', async () => {
  handle.repos.DataSet = makeFakeRepo({ findOne: async () => null });
  await assert.doesNotReject(DataSetValidator.checkDuplicateName(PROJECT, 'fresh'));
});

test('checkDuplicateName excludes the current id when provided', async () => {
  let received: any;
  handle.repos.DataSet = makeFakeRepo({
    findOne: async (q: any) => {
      received = q;
      return null;
    },
  });
  await DataSetValidator.checkDuplicateName(PROJECT, 'name', 'self-id');
  assert.ok(received.where.id, 'excludeId should add an id condition');
});

test('validateUpdate forbids changing the type', () => {
  assert.throws(
    () => DataSetValidator.validateUpdate({ type: 'manual', kind: 'structured' } as any, { type: 'acquired' }),
    /Cannot change dataset type/,
  );
});

test('validateUpdate forbids changing the kind', () => {
  assert.throws(
    () => DataSetValidator.validateUpdate({ type: 'manual', kind: 'structured' } as any, { kind: 'unstructured' }),
    /Cannot change dataset kind/,
  );
});

test('validateUpdate forbids renaming once a catalog table exists', () => {
  assert.throws(
    () =>
      DataSetValidator.validateUpdate(
        { name: 'old', catalogTableName: 'old_tbl' } as any,
        { name: 'new' },
      ),
    /Cannot change dataset name after catalog table/,
  );
});

test('validateUpdate allows a compatible update', () => {
  assert.doesNotThrow(() =>
    DataSetValidator.validateUpdate(
      { name: 'old', type: 'manual', kind: 'structured' } as any,
      { description: 'updated' },
    ),
  );
});
