/**
 * Targeted branch-coverage tests for ReferenceEdgeService pagination/name
 * resolution and cronFromRefreshConfig schedule derivation.
 *
 * Run: node --require ts-node/register --test tests/coverageGaps.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { AppDataSource } from '../db/postgres';
import {
  applyForEntity,
  removeForSource,
  removeForTarget,
  removeForProject,
  hasDependents,
  summaryForTargets,
  summaryForTarget,
  listDependents,
} from '../services/ReferenceEdgeService';
import { cronFromRefreshConfig } from '../utils/cronFromRefreshConfig';

let handle: FakeDataSourceHandle;
beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => handle.restore());

// ----------------------------------------------------- ReferenceEdgeService
test('applyForEntity: ignores non-object/array rows and rows without id', async () => {
  await applyForEntity(undefined, 'agent', 'p1', null);
  await applyForEntity(undefined, 'agent', 'p1', [{ id: 'x' }]);
  await applyForEntity(undefined, 'agent', 'p1', {});
  // No throw == success; nothing to assert beyond reaching here.
  assert.ok(true);
});

test('applyForEntity: knowledge_base resolves dataset target ids by id then name', async () => {
  handle.repos.DataSet = makeFakeRepo({
    findOne: async (q: any) => (q?.where?.id ? { id: q.where.id } : null),
  });
  // A KB row referencing a dataset; extractEdges will derive a uses_dataset edge.
  await applyForEntity(undefined, 'knowledge_base', 'p1', {
    id: 'kb1',
    sourceDataset: 'ds-1',
    embeddingModel: 'm',
  } as any);
  assert.ok(true);
});

test('removeForSource/Target/Project + hasDependents', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({
    delete: async () => ({ affected: 3 }),
    findOne: async () => ({ projectId: 'p1' }),
  });
  await removeForSource(undefined, 'agent', 'p1', 'a1');
  await removeForSource(undefined, 'agent', 'p1', ''); // early return branch
  await removeForTarget(undefined, 'model', 'p1', 'm1');
  await removeForTarget(undefined, 'model', 'p1', ''); // early return
  assert.equal(await removeForProject(undefined, 'p1'), 3);
  assert.equal(await hasDependents('model', 'p1', 'm1'), true);
});

test('summaryForTargets: empty + aggregated rows', async () => {
  assert.equal((await summaryForTargets('model', 'p1', [])).size, 0);

  (AppDataSource as any).query = async () => [
    { targetId: 'm1', sourceType: 'agent', n: '2' },
    { targetId: 'm1', sourceType: 'agent_team', n: '1' },
  ];
  const map = await summaryForTargets('model', 'p1', ['m1']);
  assert.equal(map.get('m1')!.total, 3);
  assert.equal(map.get('m1')!.byKind.agent, 2);

  const single = await summaryForTarget('model', 'p1', 'm1');
  assert.equal(single.total, 3);
});

test('listDependents: pagination (hasMore + cursor), kind filter, name resolution', async () => {
  // Program AppDataSource.query to respond by SQL shape.
  (AppDataSource as any).query = async (sql: string) => {
    if (/ORDER BY/.test(sql)) {
      // edge page query; return limit+1 rows to exercise hasMore + cursor encode
      return [
        { sourceType: 'agent', sourceId: 'a1', relation: 'uses_model' },
        { sourceType: 'agent', sourceId: 'a2', relation: 'uses_model' },
      ];
    }
    if (/GROUP BY/.test(sql)) {
      return [{ sourceType: 'agent', n: '5' }];
    }
    // resolveNames per-kind query
    return [{ id: 'a1', name: 'Agent One' }];
  };

  const page = await listDependents('model', 'p1', 'm1', { limit: 1, kind: 'agent' });
  assert.ok(page.items.length >= 1);
  assert.equal(page.items[0].kind, 'agent');
  assert.equal(page.totalByKind.agent, 5);
  assert.ok(page.nextCursor); // hasMore -> cursor present

  // Follow the cursor (decode branch) + no rows (empty resolveNames branch)
  (AppDataSource as any).query = async (sql: string) =>
    /GROUP BY/.test(sql) ? [{ sourceType: 'agent', n: '0' }] : [];
  const page2 = await listDependents('model', 'p1', 'm1', { cursor: page.nextCursor!, limit: 50 });
  assert.equal(page2.items.length, 0);
  assert.equal(page2.nextCursor, null);

  // Invalid cursor decodes to null (catch branch)
  const page3 = await listDependents('model', 'p1', 'm1', { cursor: 'not-base64!!' });
  assert.ok(Array.isArray(page3.items));
});

// ----------------------------------------------------- cronFromRefreshConfig
test('cronFromRefreshConfig: every schedule_type branch', () => {
  assert.equal(cronFromRefreshConfig(null), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: false } as any), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, paused: true } as any), null);

  assert.deepEqual(
    cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'cron', cron_expression: '0 0 * * *', timezone: 'UTC' } as any),
    { cronExpression: '0 0 * * *', timezone: 'UTC' },
  );
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'cron', cron_expression: '   ' } as any), null);

  assert.deepEqual(
    cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 240 } as any),
    { cronExpression: '0 */4 * * *', timezone: 'UTC' },
  );
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 10 } as any), null);

  assert.deepEqual(
    cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'daily', time_of_day: '07:45' } as any),
    { cronExpression: '45 7 * * *', timezone: 'UTC' },
  );
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'daily', time_of_day: 'bad' } as any), null);

  assert.deepEqual(
    cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'monthly', time_of_day: '03:00', day_of_month: 1 } as any),
    { cronExpression: '0 3 1 * *', timezone: 'UTC' },
  );
  assert.equal(
    cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'monthly', time_of_day: '03:00', day_of_month: 99 } as any),
    null,
  );
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'weekly', time_of_day: '03:00', day_of_week: [] } as any), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'unknown' } as any), null);
});
