/**
 * Route-handler tests for routes/projectRoutes.ts.
 *
 * The router defines absolute `/api/v1/projects...` paths, so it is mounted at
 * '/'. Project lifecycle services that reach K8s/Keycloak (ProjectInitService,
 * ProjectDeleteService, ProjectServiceAccountService, WorkspaceTemplateService)
 * are module-mocked; the repositories, ReferenceEdgeService and FacetService
 * run real against the AppDataSource fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/projectRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request, withUser } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import { parsePolicyName as realParsePolicyName } from '../services/KeycloakAuthzClient';
import type { Express, Router } from 'express';

const PROJECT = 'projtest0001';
const projectRow = () => ({
  id: PROJECT,
  name: 'Test Project',
  created_at: new Date('2024-01-01T00:00:00Z'),
  updated_at: new Date('2024-01-02T00:00:00Z'),
  metadata: {},
  home_dir: `s3://default-nemo/projects/${PROJECT}`,
});

let handle: FakeDataSourceHandle;
let app: Express;
let router: Router;
let scope: ReturnType<typeof restoreScope>;
let saSvc: any;

// Keycloak stub state for GET /api/v1/projects (caller-scoped). Tests set
// `kcPolicies` to the policy rows the stub `listPolicies` should return, or an
// Error to simulate a Keycloak failure.
let kcPolicies: Array<{ id: string; name: string }> | Error = [];
let kcCalls: Array<{ prefix: string; max: number }> = [];
let initProjectImpl: () => Promise<void> = async () => undefined;

beforeEach(() => {
  handle = installFakeRepositories({});

  saSvc = {
    create: async (projectId: string) => ({
      projectId,
      clientId: 'svc-client-id',
      createdAt: new Date('2024-01-03T00:00:00Z'),
    }),
    getByProjectId: async (projectId: string) => ({
      projectId,
      clientId: 'svc-client-id',
      clientSecret: 'svc-secret',
      createdAt: new Date('2024-01-03T00:00:00Z'),
    }),
  };

  scope = restoreScope();
  scope.add(
    mockModule('services/ProjectInitService', {
      ProjectInitService: class {
        initializeProject() {
          return initProjectImpl();
        }
      },
    }),
  );
  scope.add(
    mockModule('services/ProjectDeleteService', {
      ProjectDeleteService: class {
        deleteProject() {
          return Promise.resolve();
        }
      },
    }),
  );
  scope.add(mockModule('services/ProjectServiceAccountService', { ProjectServiceAccountService: saSvc }));
  scope.add(
    mockModule('services/WorkspaceTemplateService', {
      WorkspaceTemplateService: { seedDefaultTemplates: async () => undefined },
    }),
  );

  // Stub the Keycloak Authz client used by GET /api/v1/projects, but keep the
  // real parsePolicyName so the policy-name parsing is exercised for real.
  kcPolicies = [];
  kcCalls = [];
  initProjectImpl = async () => undefined;
  scope.add(
    mockModule('services/KeycloakAuthzClient', {
      parsePolicyName: realParsePolicyName,
      getRouteKeycloakAuthzClient: () => ({
        listPolicies: async (prefix: string, max: number) => {
          kcCalls.push({ prefix, max });
          if (kcPolicies instanceof Error) throw kcPolicies;
          return kcPolicies;
        },
      }),
    }),
  );

  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/projectRoutes');
  handle.restore();
});

function seedProject(overrides: Record<string, any>) {
  handle.repos.Project = makeFakeRepo(overrides);
}

// ─── POST /api/v1/projects (create) ───────────────────────────────────────────

test('POST /projects: missing name returns 400', async () => {
  const res = await request(app, 'POST', '/api/v1/projects', { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('POST /projects: creates project (201)', async () => {
  seedProject({
    save: async (e: any) => ({ ...e, created_at: new Date(), updated_at: new Date() }),
  });
  const res = await request(app, 'POST', '/api/v1/projects', { body: { name: 'My Project' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'My Project');
  assert.ok(res.body.id);
});

// ─── GET /api/v1/projects/:projectId ──────────────────────────────────────────

test('GET /projects/:id: found / not found', async () => {
  seedProject({ findOne: async () => projectRow() });
  const ok = await request(app, 'GET', `/api/v1/projects/${PROJECT}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, PROJECT);

  seedProject({ findOne: async () => null });
  const missing = await request(app, 'GET', `/api/v1/projects/${PROJECT}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'NOT_FOUND');
});

// ─── PUT /api/v1/projects/:projectId ──────────────────────────────────────────

test('PUT /projects/:id: updates project (200)', async () => {
  seedProject({
    count: async () => 1,
    findOne: async () => projectRow(),
    save: async (e: any) => ({ ...e, created_at: new Date(), updated_at: new Date() }),
  });
  const res = await request(app, 'PUT', `/api/v1/projects/${PROJECT}`, { body: { name: 'Renamed' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
});

test('PUT /projects/:id: not found returns 404', async () => {
  seedProject({ count: async () => 0 });
  const res = await request(app, 'PUT', `/api/v1/projects/${PROJECT}`, { body: { name: 'X' } });
  assert.equal(res.status, 404);
});

// ─── DELETE /api/v1/projects/:projectId ───────────────────────────────────────

test('DELETE /projects/:id: deletes project (204)', async () => {
  seedProject({ findOne: async () => projectRow(), delete: async () => ({ affected: 1 }) });
  const res = await request(app, 'DELETE', `/api/v1/projects/${PROJECT}`);
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
});

test('DELETE /projects/:id: not found returns 404', async () => {
  seedProject({ findOne: async () => null });
  const res = await request(app, 'DELETE', `/api/v1/projects/${PROJECT}`);
  assert.equal(res.status, 404);
});

// ─── GET /api/v1/projects (caller-scoped list) ────────────────────────────────

test('GET /projects: lists the caller\'s projects with role (200)', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  seedProject({ find: async () => [projectRow()] });
  const res = await request(app, 'GET', '/api/v1/projects');
  assert.equal(res.status, 200);
  assert.equal(res.body.projects.length, 1);
  assert.equal(res.body.projects[0].id, PROJECT);
  assert.equal(res.body.projects[0].role, 'admin');
  // Server-side query is narrowed to this caller's policies only.
  assert.equal(kcCalls[0].prefix, 'usr-user-1-proj-');
});

test('GET /projects: returns empty list when caller has no memberships (200)', async () => {
  kcPolicies = [];
  // find would return a project, but listByIds must short-circuit on no ids.
  seedProject({ find: async () => [projectRow()] });
  const res = await request(app, 'GET', '/api/v1/projects');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projects, []);
});

test('GET /projects: 401 when unauthenticated', async () => {
  const anonApp = buildApp({ basePath: '/', router });
  const res = await request(anonApp, 'GET', '/api/v1/projects');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('GET /projects: surfaces Keycloak errors as 500', async () => {
  kcPolicies = new Error('keycloak unreachable');
  const res = await request(app, 'GET', '/api/v1/projects');
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
});

// ─── POST /api/v1/projects/:projectId/reinitialize ───────────────────────────

test('POST /reinitialize: admin retries a failed project (202)', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  seedProject({
    findOne: async () => ({ ...projectRow(), init_status: 'failed', init_error: 'bifrost down' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'provisioning');
  // Authorization query is scoped to this caller + project.
  assert.equal(kcCalls[0].prefix, `usr-user-1-proj-${PROJECT}-`);
});

test('POST /reinitialize: non-failed project returns 409', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  seedProject({ findOne: async () => ({ ...projectRow(), init_status: 'ready' }) });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('POST /reinitialize: in-flight provisioning project returns 409', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  seedProject({ findOne: async () => ({ ...projectRow(), init_status: 'provisioning' }) });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'CONFLICT');
});

test('POST /reinitialize: non-admin caller returns 403', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-viewer` }];
  seedProject({ findOne: async () => ({ ...projectRow(), init_status: 'failed' }) });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'FORBIDDEN');
});

test('POST /reinitialize: missing project returns 404', async () => {
  seedProject({ findOne: async () => null });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 404);
});

test('POST /reinitialize: 401 when unauthenticated', async () => {
  const anonApp = buildApp({ basePath: '/', router });
  const res = await request(anonApp, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('POST /reinitialize: workflow trigger failure restores failed status (502)', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  initProjectImpl = async () => {
    throw new Error('workflow-engine unavailable');
  };
  const updates: Array<{ init_status: string; init_error: string | null }> = [];
  seedProject({
    findOne: async () => ({ ...projectRow(), init_status: 'failed', init_error: 'bifrost down' }),
    update: async (_id: string, data: { init_status: string; init_error: string | null }) => {
      updates.push(data);
      return { affected: 1 };
    },
  });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'UPSTREAM_ERROR');
  assert.equal(updates.length, 2);
  assert.equal(updates[0]?.init_status, 'provisioning');
  assert.equal(updates[1]?.init_status, 'failed');
  assert.equal(updates[1]?.init_error, 'bifrost down');
});

// ─── members ──────────────────────────────────────────────────────────────────
//
// Project membership endpoints have moved out of projectRoutes.ts:
//   - reads  → routes/projectMembershipRoutes.ts (Keycloak-backed)
//     covered by tests/projectMembership.unit.test.ts
//   - writes → workflow-engine (Temporal workflows)
// See routes/projectRoutes.ts header comment and PR #31 for details.

// ─── service-account ──────────────────────────────────────────────────────────

test('POST /projects/:id/service-account: creates account (201)', async () => {
  seedProject({ count: async () => 1 });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/service-account`, { body: {} });
  assert.equal(res.status, 201);
  assert.equal(res.body.clientId, 'svc-client-id');
});

test('POST /projects/:id/service-account: already exists returns existing (200)', async () => {
  seedProject({ count: async () => 1 });
  saSvc.create = async () => {
    throw new Error('Service account already exists');
  };
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/service-account`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.clientId, 'svc-client-id');
});

test('POST /projects/:id/service-account: project not found returns 404', async () => {
  seedProject({ count: async () => 0 });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/service-account`, { body: {} });
  assert.equal(res.status, 404);
});

test('GET /projects/:id/service-account: returns account incl. secret (200)', async () => {
  seedProject({ count: async () => 1 });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/service-account`);
  assert.equal(res.status, 200);
  assert.equal(res.body.clientSecret, 'svc-secret');
});

test('GET /projects/:id/service-account: not found returns 404', async () => {
  seedProject({ count: async () => 1 });
  saSvc.getByProjectId = async () => {
    throw new Error('Service account not found');
  };
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/service-account`);
  assert.equal(res.status, 404);
});

// ─── overview-dataset-metrics ─────────────────────────────────────────────────

test('GET /projects/:id/overview-dataset-metrics: aggregates (200)', async () => {
  seedProject({ count: async () => 1 });
  handle.repos.DataSet = makeFakeRepo({
    count: async (q: any) => (q?.where?.kind === 'structured' ? 2 : 3),
  });
  handle.repos.DataSetManifest = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ count: 5 }),
  });
  handle.repos.DataSetManifestFile = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ count: 7 }),
  });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/overview-dataset-metrics`);
  assert.equal(res.status, 200);
  assert.equal(res.body.structured, 2);
  assert.equal(res.body.unstructured, 3);
  assert.equal(res.body.datasetsTotal, 5);
  assert.equal(res.body.manifestVersions, 5);
  assert.equal(res.body.filesInManifests, 7);
});

test('GET /projects/:id/overview-dataset-metrics: project not found returns 404', async () => {
  seedProject({ count: async () => 0 });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/overview-dataset-metrics`);
  assert.equal(res.status, 404);
});

// ─── project-level facets ─────────────────────────────────────────────────────

test('GET /projects/:id/facets/:facetType: found (200) / facet not found (404)', async () => {
  seedProject({ count: async () => 1 });
  handle.repos.Facet = makeFakeRepo({
    findOne: async () => ({ projectId: PROJECT, facetType: 'lineage', state: 'ready' }),
  });
  const ok = await request(app, 'GET', `/api/v1/projects/${PROJECT}/facets/lineage`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.facetType, 'lineage');

  handle.repos.Facet = makeFakeRepo({ findOne: async () => null });
  const missing = await request(app, 'GET', `/api/v1/projects/${PROJECT}/facets/lineage`);
  assert.equal(missing.status, 404);
});

test('GET /projects/:id/facets/:facetType: project not found returns 404', async () => {
  seedProject({ count: async () => 0 });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/facets/lineage`);
  assert.equal(res.status, 404);
});

test('POST /projects: 401 when unauthenticated', async () => {
  const anonApp = buildApp({ basePath: '/', router });
  const res = await request(anonApp, 'POST', '/api/v1/projects', { body: { name: 'No Auth' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHENTICATED');
});

test('POST /projects: still returns 201 when template seeding fails', async () => {
  scope.add(
    mockModule('services/WorkspaceTemplateService', {
      WorkspaceTemplateService: {
        seedDefaultTemplates: async () => {
          throw new Error('template seed failed');
        },
      },
    }),
  );
  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
  seedProject({
    save: async (e: any) => ({ ...e, created_at: new Date(), updated_at: new Date() }),
  });
  const res = await request(app, 'POST', '/api/v1/projects', { body: { name: 'Seeded Anyway' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Seeded Anyway');
});

test('GET /projects: 500 when Keycloak client cannot initialize', async () => {
  scope.add(
    mockModule('services/KeycloakAuthzClient', {
      parsePolicyName: realParsePolicyName,
      getRouteKeycloakAuthzClient: () => {
        throw new Error('missing KEYCLOAK env');
      },
    }),
  );
  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(app, 'GET', '/api/v1/projects');
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
});

test('GET /projects: 500 when project metadata load fails', async () => {
  kcPolicies = [{ id: '1', name: `usr-user-1-proj-${PROJECT}-admin` }];
  seedProject({
    find: async () => {
      throw new Error('db unavailable');
    },
  });
  const res = await request(app, 'GET', '/api/v1/projects');
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /failed to list projects/);
});

test('POST /reinitialize: 500 when Keycloak client cannot initialize', async () => {
  seedProject({ findOne: async () => ({ ...projectRow(), init_status: 'failed' }) });
  scope.add(
    mockModule('services/KeycloakAuthzClient', {
      parsePolicyName: realParsePolicyName,
      getRouteKeycloakAuthzClient: () => {
        throw new Error('missing KEYCLOAK env');
      },
    }),
  );
  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 500);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
});

test('POST /reinitialize: 500 when Keycloak policy lookup fails', async () => {
  kcPolicies = new Error('keycloak list failed');
  seedProject({ findOne: async () => ({ ...projectRow(), init_status: 'failed' }) });
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/reinitialize`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /failed to verify authorization/);
});

test('POST /projects/:id/service-account: 500 when existing lookup also fails', async () => {
  seedProject({ count: async () => 1 });
  saSvc.create = async () => {
    throw new Error('Service account already exists');
  };
  saSvc.getByProjectId = async () => {
    throw new Error('lookup failed');
  };
  const res = await request(app, 'POST', `/api/v1/projects/${PROJECT}/service-account`, { body: {} });
  assert.equal(res.status, 500);
});

test('GET /projects/:id/service-account: 500 on unexpected errors', async () => {
  seedProject({ count: async () => 1 });
  saSvc.getByProjectId = async () => {
    throw new Error('unexpected upstream failure');
  };
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/service-account`);
  assert.equal(res.status, 500);
});

test('DELETE /projects/:id: deletes with gateway metadata and cleanup hooks', async () => {
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      teardownProjectGateway: async () => ({
        modelsRemoved: 1,
        modelsFound: 1,
        mcpServersRemoved: 0,
        mcpServersFound: 0,
        virtualKeyDeleted: true,
        teamDeleted: true,
        sweepMcpClientsRemoved: 0,
        sweepVirtualKeysRemoved: 0,
      }),
    }),
  );
  scope.add(
    mockModule('services/ReferenceEdgeService', {
      removeForProject: async () => 2,
    }),
  );
  scope.add(
    mockModule('services/FacetService', {
      FacetService: {
        deleteForProject: async () => 1,
        getFacet: async () => null,
      },
    }),
  );
  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
  seedProject({
    findOne: async () => ({
      ...projectRow(),
      metadata: { _gateway: { teamId: 'team-1', virtualKeyId: 'vk-1' } },
    }),
    delete: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'DELETE', `/api/v1/projects/${PROJECT}`);
  assert.equal(res.status, 204);
});

test('GET /projects/:id/overview-dataset-metrics: 500 on repository error', async () => {
  seedProject({ count: async () => 1 });
  handle.repos.DataSet = makeFakeRepo({
    count: async () => {
      throw new Error('count failed');
    },
  });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/overview-dataset-metrics`);
  assert.equal(res.status, 500);
});

test('GET /projects/:id/facets/:facetType: 500 on service error', async () => {
  seedProject({ count: async () => 1 });
  scope.add(
    mockModule('services/FacetService', {
      FacetService: {
        getFacet: async () => {
          throw new Error('facet lookup failed');
        },
      },
    }),
  );
  router = loadFresh('routes/projectRoutes').default;
  app = buildApp({ basePath: '/', router, pre: [withUser({ sub: 'user-1' })] });
  const res = await request(app, 'GET', `/api/v1/projects/${PROJECT}/facets/lineage`);
  assert.equal(res.status, 500);
});
