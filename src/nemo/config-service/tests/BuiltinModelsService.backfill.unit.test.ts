/**
 * Unit tests for BuiltinModelsService.backfillEmbeddingDimensions().
 *
 * Verifies that the startup backfill stamps `model_info.dimensions` on
 * embedding models registered before the catalog existed, that catalog-
 * unknown rows are left untouched (and logged), and that re-running is
 * a no-op (idempotent).
 *
 * Run: node --require ts-node/register --test tests/BuiltinModelsService.backfill.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { BuiltinModelsService } from '../services/BuiltinModelsService';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { AppDataSource } from '../db/postgres';

let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});

afterEach(() => {
  handle.restore();
});

function fakeEmbeddingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'mdl-xyz',
    projectId: 'projtest0001',
    name: 'my-openai-embed',
    provider: 'openai',
    providerModelId: 'text-embedding-3-small',
    modelType: 'embedding',
    model_info: null,
    ...overrides,
  };
}

test('backfillEmbeddingDimensions: catalog-known row gets model_info.dimensions stamped', async () => {
  const row = fakeEmbeddingRow();
  const updateCalls: any[] = [];
  handle.repos.Model = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [row] }),
    update: async (where: any, patch: any) => {
      updateCalls.push({ where, patch });
      return { affected: 1 };
    },
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillEmbeddingDimensions();
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].where.id, 'mdl-xyz');
  assert.equal(updateCalls[0].patch.model_info.dimensions, 1536);
  assert.equal(updateCalls[0].patch.model_info.category, 'balanced');
});

test('backfillEmbeddingDimensions: catalog-unknown row is left untouched (logged warning)', async () => {
  const row = fakeEmbeddingRow({
    provider: 'openai_compatible',
    providerModelId: 'totally-made-up-vendor',
  });
  const updateCalls: any[] = [];
  handle.repos.Model = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [row] }),
    update: async (where: any, patch: any) => {
      updateCalls.push({ where, patch });
      return { affected: 1 };
    },
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillEmbeddingDimensions();
  assert.equal(updateCalls.length, 0, 'unknown rows must not be touched');
});

test('backfillEmbeddingDimensions: caller-provided model_info fields survive merge', async () => {
  const row = fakeEmbeddingRow({
    provider: 'openai',
    providerModelId: 'text-embedding-3-small',
    model_info: { description: 'team-specific note', customField: 'keep' },
  });
  let updatePatch: any = null;
  handle.repos.Model = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [row] }),
    update: async (_where: any, patch: any) => {
      updatePatch = patch;
      return { affected: 1 };
    },
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillEmbeddingDimensions();
  assert.equal(updatePatch.model_info.dimensions, 1536, 'catalog filled missing dimensions');
  assert.equal(updatePatch.model_info.description, 'team-specific note', 'user description preserved');
  assert.equal(updatePatch.model_info.customField, 'keep', 'unrelated keys preserved');
});

test('backfillEmbeddingDimensions: no candidates → no updates, no errors', async () => {
  handle.repos.Model = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillEmbeddingDimensions();
  // Reach into mock to confirm no update was issued.
  const updateMock = handle.repos.Model.update as any;
  assert.equal(updateMock.mock.callCount(), 0);
});

test('backfillEmbeddingDimensions: idempotent — second run finds nothing if dimensions already set', async () => {
  // Simulate the second-run state: model_info already has dimensions, so
  // the WHERE clause filters it out (query builder returns []).
  let runCount = 0;
  const calls: any[] = [];
  handle.repos.Model = makeFakeRepo({
    createQueryBuilder: () => {
      runCount++;
      // First call returns the candidate row; second call (after the
      // update would have flipped its model_info.dimensions to a value)
      // returns empty because the SQL filter no longer matches.
      const rows = runCount === 1
        ? [fakeEmbeddingRow({ provider: 'openai', providerModelId: 'text-embedding-3-small' })]
        : [];
      return makeQueryBuilder({ many: rows });
    },
    update: async (where: any, patch: any) => {
      calls.push({ where, patch });
      return { affected: 1 };
    },
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillEmbeddingDimensions();
  assert.equal(calls.length, 1);
  await svc.backfillEmbeddingDimensions();
  assert.equal(calls.length, 1, 'second run must not touch any row');
});
