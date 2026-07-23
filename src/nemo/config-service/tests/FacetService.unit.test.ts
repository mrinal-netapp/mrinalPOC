/**
 * Unit tests for services/FacetService.ts. Pure AppDataSource access through
 * the fake-repo seam (no DB/network).
 *
 * Run: node --require ts-node/register --test tests/FacetService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FacetService } from '../services/FacetService';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';

const PROJECT = 'projtest0001';
let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => handle.restore());

function seedFacet(overrides: Record<string, any>) {
  handle.repos.Facet = makeFakeRepo(overrides);
}

test('listFacets returns rows ordered query result', async () => {
  const rows = [{ id: 'f1', facetType: 'a' }];
  seedFacet({ find: async () => rows });
  const result = await FacetService.listFacets(PROJECT, 'agent' as any, 'e1');
  assert.deepEqual(result, rows);
});

test('listFacetsBatch returns empty map for empty id list', async () => {
  seedFacet({});
  const map = await FacetService.listFacetsBatch(PROJECT, 'agent' as any, []);
  assert.equal(map.size, 0);
});

test('listFacetsBatch groups facets by entityId', async () => {
  seedFacet({
    find: async () => [
      { entityId: 'e1', facetType: 'a' },
      { entityId: 'e1', facetType: 'b' },
      { entityId: 'e2', facetType: 'a' },
    ],
  });
  const map = await FacetService.listFacetsBatch(PROJECT, 'agent' as any, ['e1', 'e2']);
  assert.equal(map.get('e1')?.length, 2);
  assert.equal(map.get('e2')?.length, 1);
});

test('getFacet delegates to findOne', async () => {
  seedFacet({ findOne: async () => ({ id: 'f1', facetType: 'tags' }) });
  const f = await FacetService.getFacet(PROJECT, 'agent' as any, 'e1', 'tags');
  assert.equal(f?.id, 'f1');
});

test('upsertFacet updates an existing row', async () => {
  const existing: any = { id: 'f1', state: 'ready', summary: undefined };
  seedFacet({
    createQueryBuilder: () => makeQueryBuilder(),
    findOne: async () => existing,
    save: async (e: any) => e,
  });
  const result = await FacetService.upsertFacet(PROJECT, 'agent' as any, 'e1', 'tags', {
    state: 'ready',
    summary: { count: 3 },
  });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.summary, { count: 3 });
});

test('upsertFacet throws when the row is missing after insert', async () => {
  seedFacet({ createQueryBuilder: () => makeQueryBuilder(), findOne: async () => null });
  await assert.rejects(
    FacetService.upsertFacet(PROJECT, 'agent' as any, 'e1', 'tags', { state: 'ready' }),
    /Failed to upsert facet/,
  );
});

test('updateFacetState creates a new facet when none exists', async () => {
  seedFacet({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'f-new' }),
  });
  const f = await FacetService.updateFacetState(PROJECT, 'agent' as any, 'e1', 'tags', 'in_progress', {
    jobId: 'job-1',
  });
  assert.equal(f.id, 'f-new');
  assert.equal(f.state, 'in_progress');
  assert.equal(f.jobId, 'job-1');
});

test('updateFacetState throws ConflictError on jobId mismatch', async () => {
  seedFacet({
    findOne: async () => ({ state: 'in_progress', jobId: 'real-job' }),
    save: async (e: any) => e,
  });
  await assert.rejects(
    FacetService.updateFacetState(PROJECT, 'agent' as any, 'e1', 'tags', 'ready', {
      expectedJobId: 'other-job',
    }),
    /Facet jobId mismatch/,
  );
});

test('updateFacetState transitions to ready, clearing job and storing summary', async () => {
  const existing: any = { state: 'in_progress', jobId: 'job-1', errorMessage: 'old' };
  seedFacet({ findOne: async () => existing, save: async (e: any) => e });
  const f = await FacetService.updateFacetState(PROJECT, 'agent' as any, 'e1', 'tags', 'ready', {
    summary: { ok: true },
  });
  assert.equal(f.state, 'ready');
  assert.equal(f.jobId, null);
  assert.equal(f.errorMessage, null);
  assert.deepEqual(f.summary, { ok: true });
});

test('updateFacetState transitions to errored, recording the error message', async () => {
  const existing: any = { state: 'in_progress', jobId: 'job-1', summary: { prior: 1 } };
  seedFacet({ findOne: async () => existing, save: async (e: any) => e });
  const f = await FacetService.updateFacetState(PROJECT, 'agent' as any, 'e1', 'tags', 'errored', {
    errorMessage: 'kaboom',
  });
  assert.equal(f.state, 'errored');
  assert.equal(f.jobId, null);
  assert.equal(f.errorMessage, 'kaboom');
  assert.deepEqual(f.summary, { prior: 1 });
});

test('updateFacetState transitions an existing row to in_progress', async () => {
  const existing: any = { state: 'ready', jobId: null };
  seedFacet({ findOne: async () => existing, save: async (e: any) => e });
  const f = await FacetService.updateFacetState(PROJECT, 'agent' as any, 'e1', 'tags', 'in_progress', {
    jobId: 'job-2',
  });
  assert.equal(f.state, 'in_progress');
  assert.equal(f.jobId, 'job-2');
});

test('startFacetJob returns started=true when the atomic update affects a row', async () => {
  seedFacet({
    createQueryBuilder: () => makeQueryBuilder({ execute: { affected: 1 } }),
    findOneOrFail: async () => ({ id: 'f1', state: 'in_progress', jobId: 'job-1' }),
  });
  const r = await FacetService.startFacetJob(PROJECT, 'agent' as any, 'e1', 'tags', 'job-1');
  assert.equal(r.started, true);
  assert.equal(r.facet.id, 'f1');
});

test('startFacetJob returns started=false when row already in_progress', async () => {
  seedFacet({
    createQueryBuilder: () => makeQueryBuilder({ execute: { affected: 0 } }),
    findOne: async () => ({ id: 'f1', state: 'in_progress', jobId: 'other' }),
  });
  const r = await FacetService.startFacetJob(PROJECT, 'agent' as any, 'e1', 'tags', 'job-1');
  assert.equal(r.started, false);
  assert.equal(r.facet.jobId, 'other');
});

test('startFacetJob creates a row when none exists', async () => {
  seedFacet({
    createQueryBuilder: () => makeQueryBuilder({ execute: { affected: 0 } }),
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'f-created' }),
  });
  const r = await FacetService.startFacetJob(PROJECT, 'agent' as any, 'e1', 'tags', 'job-9');
  assert.equal(r.started, true);
  assert.equal(r.facet.id, 'f-created');
  assert.equal(r.facet.state, 'in_progress');
});

test('lazyBackfill returns the (re)loaded facet', async () => {
  seedFacet({
    createQueryBuilder: () => makeQueryBuilder(),
    findOne: async () => ({ id: 'f1', state: 'ready' }),
  });
  const f = await FacetService.lazyBackfill(PROJECT, 'agent' as any, 'e1', 'tags', { n: 1 });
  assert.equal(f?.id, 'f1');
});

test('deleteForProject returns the affected count', async () => {
  seedFacet({ delete: async () => ({ affected: 7 }) });
  assert.equal(await FacetService.deleteForProject(PROJECT), 7);
});

test('deleteForProject returns 0 when affected is undefined', async () => {
  seedFacet({ delete: async () => ({}) });
  assert.equal(await FacetService.deleteForProject(PROJECT), 0);
});
