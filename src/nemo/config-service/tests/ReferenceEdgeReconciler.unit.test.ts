/**
 * Unit tests for services/ReferenceEdgeReconciler.ts. Runs the real reconcile
 * loop and the real synchronous write path (ReferenceEdgeService.applyForEntity)
 * against in-memory fake repositories (no DB/network). Drift is driven by
 * programming the ReferenceEdge.count() before/after applyForEntity.
 *
 * Run: node --require ts-node/register --test tests/ReferenceEdgeReconciler.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, ensureKbReferenceEdgesIfCold } from '../services/ReferenceEdgeReconciler';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';

let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => {
  handle.restore();
  mock.restoreAll();
});

/** A ReferenceEdge repo whose count() returns the supplied sequence in order. */
function edgeRepoWithCounts(sequence: number[]) {
  let i = 0;
  return makeFakeRepo({
    count: async () => {
      const v = sequence[Math.min(i, sequence.length - 1)] ?? 0;
      i += 1;
      return v;
    },
  });
}

test('reconcile counts an added edge (drift in the "added" direction)', async () => {
  handle.repos.Agent = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({ many: [{ id: 'a1', projectId: 'proj1', modelId: 'm1' }] }),
  });
  // before applyForEntity -> 0, after -> 1
  handle.repos.ReferenceEdge = edgeRepoWithCounts([0, 1]);

  const summary = await reconcile({ projectId: 'proj1', sourceType: 'agent' });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 0);
  assert.equal(summary.byKind.agent.scanned, 1);
  assert.equal(summary.byKind.agent.added, 1);
  assert.equal(summary.truncated, false);
});

test('reconcile counts a removed edge (drift in the "removed" direction)', async () => {
  handle.repos.Agent = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'a1', projectId: 'proj1' }] }),
  });
  // before -> 2, after -> 1
  handle.repos.ReferenceEdge = edgeRepoWithCounts([2, 1]);

  const summary = await reconcile({ projectId: 'proj1', sourceType: 'agent' });
  assert.equal(summary.scanned, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.added, 0);
});

test('reconcile with no scope discovers projects via the Project query builder', async () => {
  handle.repos.Project = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ raw: [{ id: 'proj1' }] }),
  });
  // graphOnly limits to the pipeline kind; its repo returns no rows -> nothing scanned.
  const summary = await reconcile({ graphOnly: true });
  assert.equal(summary.scanned, 0);
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 0);
});

test('reconcile honours maxRows by truncating', async () => {
  handle.repos.Agent = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'a1', projectId: 'proj1' }] }),
  });
  const summary = await reconcile({ projectId: 'proj1', sourceType: 'agent', maxRows: 0 });
  assert.equal(summary.truncated, true);
  assert.equal(summary.scanned, 0);
});

test('reconcile with an unknown sourceType scans nothing', async () => {
  const summary = await reconcile({ projectId: 'proj1', sourceType: 'not_a_kind' as any });
  assert.equal(summary.scanned, 0);
  assert.deepEqual(summary.byKind, {});
});

test('ensureKbReferenceEdgesIfCold returns early when there are no KB rows', async () => {
  handle.query.mock.mockImplementation(async () => []);
  await assert.doesNotReject(ensureKbReferenceEdgesIfCold('cold-no-kb'));
});

test('ensureKbReferenceEdgesIfCold returns early when edges already exist', async () => {
  handle.query.mock.mockImplementation(async () => [{ kb: 2, edges: 3 }]);
  await assert.doesNotReject(ensureKbReferenceEdgesIfCold('cold-has-edges'));
});

test('ensureKbReferenceEdgesIfCold runs a scoped reconcile when cold', async () => {
  handle.query.mock.mockImplementation(async () => [{ kb: 1, edges: 0 }]);
  // KnowledgeBase repo returns no rows so the scoped reconcile is a quick no-op.
  await assert.doesNotReject(ensureKbReferenceEdgesIfCold('cold-reconcile'));
  // Second call is short-circuited by the per-process guard (no throw).
  await assert.doesNotReject(ensureKbReferenceEdgesIfCold('cold-reconcile'));
});

test('ensureKbReferenceEdgesIfCold swallows reconcile failures', async () => {
  mock.method(console, 'warn', () => undefined);
  handle.query.mock.mockImplementation(async () => [{ kb: 1, edges: 0 }]);
  handle.repos.KnowledgeBase = makeFakeRepo({
    createQueryBuilder: () => {
      const qb = makeQueryBuilder();
      qb.getMany = async () => {
        throw new Error('db exploded');
      };
      return qb;
    },
  });
  await assert.doesNotReject(ensureKbReferenceEdgesIfCold('cold-error'));
});
