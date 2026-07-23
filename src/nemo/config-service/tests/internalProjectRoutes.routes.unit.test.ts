/**
 * Route-handler tests for routes/internalProjectRoutes.ts.
 *
 * Run: node --require ts-node/register --test tests/internalProjectRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import type { Express } from 'express';

const PROJECT = 'projtest0001';
const BASE = '/api/v1/internal/projects';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let app: Express;
let gatewayCalls: string[];

const teardownResult = {
  modelsRemoved: 1,
  modelsFound: 1,
  modelsFailed: 0,
  mcpServersRemoved: 0,
  mcpServersFound: 0,
  mcpServersFailed: 0,
  virtualKeyDeleted: true,
  teamDeleted: true,
  tokenSecretDeleted: true,
  sweepMcpClientsRemoved: 0,
  sweepModelConfigsRemoved: 0,
  sweepProviderBindingsRemoved: 0,
  sweepVirtualKeysRemoved: 0,
  sweepTeamsRemoved: 0,
};

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  gatewayCalls = [];

  let projectRow: any = {
    id: PROJECT,
    name: 'Test',
    home_dir: 's3://default-nemo/projects/projtest0001',
    init_status: 'provisioning',
    init_error: null,
  };

  handle.repos.Project = makeFakeRepo({
    findOne: async (q: any) => {
      const id = q?.where?.id ?? q?.id;
      return id === PROJECT ? { ...projectRow } : null;
    },
    update: async (id: any, data: any) => {
      if (id === PROJECT || id?.id === PROJECT) {
        projectRow = { ...projectRow, ...data };
        return { affected: 1 };
      }
      return { affected: 0 };
    },
  });

  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      listProjectsForVirtualKeyRotation: async () => ['proj-a', 'proj-b'],
      ensureProjectGateway: async (projectId: string) => {
        gatewayCalls.push(`ensure:${projectId}`);
        return {
          teamId: 'team-1',
          teamName: `as-proj-${projectId}`,
          virtualKeyId: 'vk-1',
          virtualKeyName: `as-proj-${projectId}-vk`,
        };
      },
      teardownProjectGateway: async (projectId: string) => {
        gatewayCalls.push(`teardown:${projectId}`);
        return teardownResult;
      },
      rotateProjectVirtualKey: async (projectId: string) => {
        gatewayCalls.push(`rotate:${projectId}`);
        return { projectId, rotated: true };
      },
      deleteRetiredProjectVirtualKey: async (projectId: string) => {
        gatewayCalls.push(`rotate-complete:${projectId}`);
        return { projectId, completed: true };
      },
      attachPlatformMcpServersToProjectVirtualKey: async (projectId: string) => {
        gatewayCalls.push(`attach-mcp:${projectId}`);
      },
    }),
  );
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => true }),
    }),
  );
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async seedBuiltinsForProject(projectId: string) {
          gatewayCalls.push(`seed:${projectId}`);
        }
        async registerBuiltinsWithGatewayForProject(projectId: string) {
          gatewayCalls.push(`register:${projectId}`);
        }
      },
    }),
  );

  app = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalProjectRoutes').default,
  });
});

afterEach(() => {
  scope.restoreAll();
  clearModule(
    'routes/internalProjectRoutes',
    'services/bifrost/bifrostProjectGovernance',
    'services/gatewayClient',
    'services/BuiltinModelsService',
  );
  handle.restore();
});

test('GET /gateway-rotation-targets: returns project id list', async () => {
  const res = await request(app, 'GET', `${BASE}/gateway-rotation-targets`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.projectIds, ['proj-a', 'proj-b']);
});

test('POST /:projectId/init-status: validation and success paths', async () => {
  assert.equal((await request(app, 'POST', `${BASE}//init-status`, { body: { status: 'ready' } })).status, 404);

  const bad = await request(app, 'POST', `${BASE}/${PROJECT}/init-status`, { body: { status: 'bogus' } });
  assert.equal(bad.status, 400);

  const ok = await request(app, 'POST', `${BASE}/${PROJECT}/init-status`, { body: { status: 'ready' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.initStatus, 'ready');

  const failed = await request(app, 'POST', `${BASE}/${PROJECT}/init-status`, {
    body: { status: 'failed', error: 'init blew up' },
  });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.initStatus, 'failed');

  handle.repos.Project = makeFakeRepo({
    findOne: async () => null,
    update: async () => ({ affected: 0 }),
  });
  assert.equal(
    (await request(app, 'POST', `${BASE}/missing/init-status`, { body: { status: 'ready' } })).status,
    404,
  );
});

test('POST /:projectId/gateway-setup: 404 missing project, 200 on success', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'POST', `${BASE}/missing/gateway-setup`)).status, 404);

  handle.repos.Project = makeFakeRepo({
    findOne: async (q: any) => (q?.where?.id === PROJECT ? { id: PROJECT } : null),
  });
  const ok = await request(app, 'POST', `${BASE}/${PROJECT}/gateway-setup`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.virtualKeyId, 'vk-1');
  assert.ok(gatewayCalls.includes(`ensure:${PROJECT}`));
  assert.ok(gatewayCalls.includes(`seed:${PROJECT}`));
  assert.ok(gatewayCalls.includes(`register:${PROJECT}`));
  assert.ok(gatewayCalls.includes(`attach-mcp:${PROJECT}`));
});

test('POST /:projectId/gateway-teardown: delegates with preloaded gateway metadata', async () => {
  const res = await request(app, 'POST', `${BASE}/${PROJECT}/gateway-teardown`, {
    body: {
      teamId: 'team-1',
      virtualKeyId: 'vk-1',
      teamName: 'tn',
      virtualKeyName: 'vn',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.modelsRemoved, 1);
  assert.ok(gatewayCalls.includes(`teardown:${PROJECT}`));
});

test('POST /:projectId/gateway-rotate and gateway-rotate-complete', async () => {
  const rotate = await request(app, 'POST', `${BASE}/${PROJECT}/gateway-rotate`);
  assert.equal(rotate.status, 200);
  assert.equal(rotate.body.rotated, true);

  const complete = await request(app, 'POST', `${BASE}/${PROJECT}/gateway-rotate-complete`);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.completed, true);
});

test('POST /:projectId/gateway-setup: 500 when ensureProjectGateway returns null', async () => {
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      listProjectsForVirtualKeyRotation: async () => [],
      ensureProjectGateway: async () => null,
      teardownProjectGateway: async () => teardownResult,
      rotateProjectVirtualKey: async () => ({ rotated: true }),
      deleteRetiredProjectVirtualKey: async () => ({ completed: true }),
      attachPlatformMcpServersToProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('routes/internalProjectRoutes');
  const failApp = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalProjectRoutes').default,
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT }),
  });
  const res = await request(failApp, 'POST', `${BASE}/${PROJECT}/gateway-setup`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /returned null/);
});

test('POST /:projectId/gateway-setup: continues when builtin seed or platform MCP attach fails', async () => {
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async seedBuiltinsForProject() {
          throw new Error('seed blew up');
        }
        async registerBuiltinsWithGatewayForProject() {
          throw new Error('register blew up');
        }
      },
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      listProjectsForVirtualKeyRotation: async () => [],
      ensureProjectGateway: async (projectId: string) => ({
        teamId: 'team-1',
        teamName: `as-proj-${projectId}`,
        virtualKeyId: 'vk-1',
        virtualKeyName: `as-proj-${projectId}-vk`,
      }),
      teardownProjectGateway: async () => teardownResult,
      rotateProjectVirtualKey: async () => ({ rotated: true }),
      deleteRetiredProjectVirtualKey: async () => ({ completed: true }),
      attachPlatformMcpServersToProjectVirtualKey: async () => {
        throw new Error('attach failed');
      },
    }),
  );
  clearModule('routes/internalProjectRoutes');
  const resilientApp = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalProjectRoutes').default,
  });
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT }),
  });
  const res = await request(resilientApp, 'POST', `${BASE}/${PROJECT}/gateway-setup`);
  assert.equal(res.status, 200);
  assert.equal(res.body.virtualKeyId, 'vk-1');
});

test('POST /:projectId/init-status: failed status without error clears init_error', async () => {
  let capturedError: string | null | undefined = 'unset';
  handle.repos.Project = makeFakeRepo({
    findOne: async () => ({ id: PROJECT }),
    update: async (_id: any, data: any) => {
      capturedError = data.init_error;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'POST', `${BASE}/${PROJECT}/init-status`, { body: { status: 'failed' } });
  assert.equal(res.status, 200);
  assert.equal(capturedError, null);
});

test('POST /:projectId/init-status: returns 404 when projectId segment is missing (route unmatched)', async () => {
  const res = await request(app, 'POST', `${BASE}//init-status`, { body: { status: 'ready' } });
  assert.equal(res.status, 404);
});

test('POST /:projectId/gateway-setup: returns 404 when projectId segment is missing (route unmatched)', async () => {
  const res = await request(app, 'POST', `${BASE}//gateway-setup`);
  assert.equal(res.status, 404);
});

test('POST /:projectId/gateway-teardown: accepts partial preloaded gateway metadata', async () => {
  const res = await request(app, 'POST', `${BASE}/${PROJECT}/gateway-teardown`, {
    body: { teamId: 'team-1', virtualKeyId: 123, teamName: null },
  });
  assert.equal(res.status, 200);
  assert.ok(gatewayCalls.includes(`teardown:${PROJECT}`));
});

test('POST /:projectId/gateway-teardown: returns 404 when projectId segment is missing (route unmatched)', async () => {
  const res = await request(app, 'POST', `${BASE}//gateway-teardown`, { body: {} });
  assert.equal(res.status, 404);
});

test('POST /:projectId/gateway-rotate: returns 404 when projectId segment is missing (route unmatched)', async () => {
  const res = await request(app, 'POST', `${BASE}//gateway-rotate`);
  assert.equal(res.status, 404);
});

test('POST /:projectId/gateway-rotate-complete: returns 404 when projectId segment is missing (route unmatched)', async () => {
  const res = await request(app, 'POST', `${BASE}//gateway-rotate-complete`);
  assert.equal(res.status, 404);
});

test('GET /gateway-rotation-targets: returns 500 when list fails', async () => {
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      listProjectsForVirtualKeyRotation: async () => {
        throw new Error('rotation list failed');
      },
      ensureProjectGateway: async () => null,
      teardownProjectGateway: async () => teardownResult,
      rotateProjectVirtualKey: async () => ({ rotated: true }),
      deleteRetiredProjectVirtualKey: async () => ({ completed: true }),
      attachPlatformMcpServersToProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('routes/internalProjectRoutes');
  const failApp = buildApp({
    basePath: BASE,
    router: loadFresh('routes/internalProjectRoutes').default,
  });
  const res = await request(failApp, 'GET', `${BASE}/gateway-rotation-targets`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /rotation list failed/);
});
