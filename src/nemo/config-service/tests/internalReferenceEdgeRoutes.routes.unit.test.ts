/**
 * Route-handler tests for routes/internalReferenceEdgeRoutes.ts.
 *
 * The reconciler, referenceCatalog and FacetService all run real against the
 * AppDataSource fake-repo seam. `AppDataSource.query` is stubbed by the seam
 * (returns [] by default) so lineage name/total resolution is hermetic.
 *
 * Run: node --require ts-node/register --test tests/internalReferenceEdgeRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import referenceEdgeRouter from '../routes/internalReferenceEdgeRoutes';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

const BASE = '/api/v1/internal/reference-edges';
const app = buildApp({ basePath: BASE, router: referenceEdgeRouter });

let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => handle.restore());

test('POST /reconcile: empty scope -> 200 zero-drift summary', async () => {
  // No projects (Project query builder getRawMany -> []), so the reconciler
  // walks nothing and returns an all-zero summary.
  const res = await request(app, 'POST', `${BASE}/reconcile`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.scanned, 0);
  assert.equal(res.body.added, 0);
  assert.equal(res.body.removed, 0);
  assert.equal(res.body.truncated, false);
  assert.deepEqual(res.body.byKind, {});
});

test('POST /reconcile: unknown sourceType -> 400', async () => {
  const res = await request(app, 'POST', `${BASE}/reconcile`, { body: { sourceType: 'bogus' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Unknown sourceType/i);
});

test('POST /reconcile: scoped to project + sourceType -> 200, kind bucket present', async () => {
  const res = await request(app, 'POST', `${BASE}/reconcile`, {
    body: { projectId: 'p1', sourceType: 'agent' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.scanned, 0);
  // The agent kind bucket is initialised even though there are no rows to scan.
  assert.ok(res.body.byKind.agent);
  assert.equal(res.body.byKind.agent.scanned, 0);
});

test('GET /graph-data: no edges -> empty projects map (200)', async () => {
  const res = await request(app, 'GET', `${BASE}/graph-data`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { projects: {} });
});

test('GET /graph-data: groups edges by project, resolves names (null without DB)', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            projectId: 'p1',
            sourceType: 'agent',
            sourceId: 'a1',
            targetType: 'model',
            targetId: 'm1',
            relation: 'uses',
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/graph-data`);
  assert.equal(res.status, 200);
  const p1 = res.body.projects.p1;
  assert.ok(p1);
  assert.equal(p1.edges.length, 1);
  assert.equal(p1.edges[0].sourceId, 'a1');
  assert.equal(p1.entities.length, 2);
  // AppDataSource.query is stubbed to [], so names resolve to null.
  for (const ent of p1.entities) {
    assert.equal(ent.name, null);
  }
  assert.ok(typeof p1.entityTotals === 'object');
});

test('GET /graph-data?projectId=p1: filter applies (200)', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const res = await request(app, 'GET', `${BASE}/graph-data?projectId=p1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { projects: {} });
});

test('GET /graph-data: unknown entity kinds resolve null names without querying catalog tables', async () => {
  handle.repos.ReferenceEdge = makeFakeRepo({
    createQueryBuilder: () =>
      makeQueryBuilder({
        many: [
          {
            projectId: 'p1',
            sourceType: 'unknown_kind',
            sourceId: 'u1',
            targetType: 'model',
            targetId: 'm1',
            relation: 'uses',
          },
        ],
      }),
  });
  const res = await request(app, 'GET', `${BASE}/graph-data`);
  assert.equal(res.status, 200);
  const unknown = res.body.projects.p1.entities.find((e: any) => e.kind === 'unknown_kind');
  assert.equal(unknown.name, null);
});

test('PUT /lineage-facet/:projectId: invalid state -> 400', async () => {
  const res = await request(app, 'PUT', `${BASE}/lineage-facet/p1`, { body: { state: 'nope' } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Invalid state/i);
});

test('PUT /lineage-facet/:projectId: stores lineage facet -> 200', async () => {
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({
      id: 'facet-1',
      projectId: 'p1',
      entityType: 'project',
      entityId: 'p1',
      facetType: 'lineage',
      state: 'in_progress',
    }),
    save: async (e: any) => e,
  });
  const res = await request(app, 'PUT', `${BASE}/lineage-facet/p1`, {
    body: { state: 'ready', graph: { nodes: [], edges: [] } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'ready');
  assert.deepEqual(res.body.summary, { nodes: [], edges: [] });
});
