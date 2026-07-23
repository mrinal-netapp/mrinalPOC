/**
 * Route-handler tests for routes/agentTeamRoutes.ts.
 *
 * Run: node --require ts-node/register --test tests/agentTeamRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import teamRouter from '../routes/agentTeamRoutes';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/agent-teams`;
const app = buildApp({ basePath: '/api/v1/projects/:projectId/agent-teams', router: teamRouter });

let handle: FakeDataSourceHandle;
beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: PROJECT }) }),
    Agent: makeFakeRepo({ find: async () => [{ id: 'a1' }] }),
    AgentTeam: makeFakeRepo({ find: async () => [] }),
  });
});
afterEach(() => handle.restore());

const validBody = () => ({
  name: 'Team',
  manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'm1' },
  members: [{ memberType: 'agent', memberId: 'a1' }],
});

test('POST /agent-teams: creates a team (201)', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => null,
    find: async () => [],
    create: (d: any) => ({ ...d, id: 'agr-001' }),
    save: async (e: any) => ({ ...e, id: 'agr-001' }),
  });
  const res = await request(app, 'POST', BASE, { body: validBody() });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'agr-001');
});

test('POST /agent-teams: duplicate name returns 409', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-x', name: 'Team' }) });
  const res = await request(app, 'POST', BASE, { body: validBody() });
  assert.equal(res.status, 409);
});

test('POST /agent-teams: unknown member returns 400', async () => {
  handle.repos.Agent = makeFakeRepo({ find: async () => [] }); // a1 not found
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null, find: async () => [] });
  const res = await request(app, 'POST', BASE, { body: validBody() });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /not found in this project/);
});

test('POST /agent-teams: validation error returns 400', async () => {
  const res = await request(app, 'POST', BASE, { body: { name: 'T', members: [] } });
  assert.equal(res.status, 400);
});

test('POST /agent-teams: manager without model returns 400', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'T', manager: { name: 'm', systemPrompt: 's' }, members: [{ memberType: 'agent', memberId: 'a1' }] },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /at least one of modelId or modelClass/i);
});

test('GET /agent-teams: list with summary', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'agr-1', name: 'T' }] }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.ok(res.body[0].dependentsSummary);
});

test('GET /agent-teams/:id: found / not found', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1' }) });
  assert.equal((await request(app, 'GET', `${BASE}/agr-1`)).status, 200);
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/agr-x`)).status, 404);
});

test('PUT /agent-teams/:id: updates (200) and 404', async () => {
  let saved: any = { id: 'agr-1', name: 'Old', projectId: PROJECT, members: [] };
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => saved,
    find: async () => [],
    update: async (_w: any, data: any) => {
      saved = { ...saved, ...data };
      return { affected: 1 };
    },
  });
  const ok = await request(app, 'PUT', `${BASE}/agr-1`, { body: { description: 'new' } });
  assert.equal(ok.status, 200);

  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  const nf = await request(app, 'PUT', `${BASE}/agr-x`, { body: { description: 'new' } });
  assert.equal(nf.status, 404);
});

test('DELETE /agent-teams/:id: delete, dependents, not-found', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1' }),
    createQueryBuilder: () => makeQueryBuilder({ one: null }),
    delete: async () => ({ affected: 1 }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/agr-1`)).status, 200);

  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1' }) });
  assert.equal((await request(app, 'DELETE', `${BASE}/agr-1`)).status, 409);

  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'DELETE', `${BASE}/agr-x`)).status, 404);
});

test('GET /agent-teams/:id/dependents + /history', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1' }) });
  assert.equal((await request(app, 'GET', `${BASE}/agr-1/dependents`)).status, 200);

  handle.repos.AgentTeamHistory = makeFakeRepo({ find: async () => [{ version: 1 }] });
  assert.equal((await request(app, 'GET', `${BASE}/agr-1/history`)).status, 200);
  handle.repos.AgentTeamHistory = makeFakeRepo({ find: async () => [] });
  assert.equal((await request(app, 'GET', `${BASE}/agr-1/history`)).status, 404);
});

test('POST /agent-teams/:id/restore-version', async () => {
  assert.equal((await request(app, 'POST', `${BASE}/agr-1/restore-version`, { body: {} })).status, 400);
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1' }), update: async () => ({ affected: 1 }) });
  handle.repos.AgentTeamHistory = makeFakeRepo({ findOne: async () => ({ version: 1, data: { id: 'agr-1', name: 'X' } }) });
  assert.equal((await request(app, 'POST', `${BASE}/agr-1/restore-version`, { body: { version: 1 } })).status, 200);
  handle.repos.AgentTeamHistory = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'POST', `${BASE}/agr-1/restore-version`, { body: { version: 9 } })).status, 404);
});

test('PUT /agent-teams/:id/status: updates lifecycle fields and validates body', async () => {
  let saved: any = { id: 'agr-1', projectId: PROJECT, status: 'ready' };
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => saved,
    update: async (_w: any, data: any) => {
      saved = { ...saved, ...data };
      return { affected: 1 };
    },
  });

  const empty = await request(app, 'PUT', `${BASE}/agr-1/status`, { body: {} });
  assert.equal(empty.status, 400);
  assert.match(String(empty.body.error), /At least one of status/);

  const ok = await request(app, 'PUT', `${BASE}/agr-1/status`, {
    body: { status: 'Healthy', deploymentStatus: 'deploying' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deploymentStatus, 'deploying');

  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'PUT', `${BASE}/agr-x/status`, { body: { status: 'Healthy' } })).status, 404);
});

test('POST /agent-teams/:id/restore-version: 404 when team missing', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/agr-missing/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 404);
  assert.match(String(res.body.error), /Agent team not found/);
});

test('POST /agent-teams/:id/restore-version: 500 when update fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT }),
    update: async () => {
      throw new Error('team update failed');
    },
  });
  handle.repos.AgentTeamHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'agr-1', name: 'Team' } }),
  });
  const res = await request(app, 'POST', `${BASE}/agr-1/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /team update failed/);
});

test('GET /agent-teams/:id/history: 404 when team missing', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/agr-missing/history`);
  assert.equal(res.status, 404);
  assert.match(String(res.body.error), /Agent team not found/);
});

test('GET /agent-teams/:id/history: 500 when history query fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1', projectId: PROJECT }) });
  handle.repos.AgentTeamHistory = makeFakeRepo({
    find: async () => {
      throw new Error('team history failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/agr-1/history`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /team history failed/);
});

test('PUT /agent-teams/:id/status: returns 400 for invalid status values', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT }),
  });
  const res = await request(app, 'PUT', `${BASE}/agr-1/status`, { body: { status: 'bad-status' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('PUT /agent-teams/:id/status: returns 500 when update fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT }),
    update: async () => {
      throw new Error('team status update failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/agr-1/status`, { body: { statusMessage: 'rolling' } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /team status update failed/);
});

test('PUT /agent-teams/:id: rejects cyclic team membership graph', async () => {
  let saved: any = {
    id: 'agr-root',
    projectId: PROJECT,
    members: [{ memberType: 'team', memberId: 'agr-child' }],
  };
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => saved,
    find: async () => [
      { id: 'agr-root', members: [{ memberType: 'team', memberId: 'agr-child' }] },
      { id: 'agr-child', members: [{ memberType: 'team', memberId: 'agr-root' }] },
    ],
    update: async (_w: any, data: any) => {
      saved = { ...saved, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/agr-root`, {
    body: { members: [{ memberType: 'team', memberId: 'agr-child' }] },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /cycle/i);
});

test('DELETE /agent-teams/:id: blocks delete when legacy member reference exists', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1' }),
    createQueryBuilder: () =>
      makeQueryBuilder({
        one: { id: 'agr-parent', members: [{ memberType: 'team', memberId: 'agr-1' }] },
      }),
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/agr-1`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HAS_DEPENDENTS');
});

test('DELETE /agent-teams/:id: returns 500 when delete fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1' }),
    createQueryBuilder: () => makeQueryBuilder({ one: null }),
    delete: async () => {
      throw new Error('team delete failed');
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/agr-1`);
  assert.equal(res.status, 500);
});

test('GET /agent-teams/:id/dependents: returns 500 when lookup fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({ findOne: async () => ({ id: 'agr-1', projectId: PROJECT }) });
  handle.query.mock.mockImplementation(async () => {
    throw new Error('team dependents failed');
  });
  const res = await request(app, 'GET', `${BASE}/agr-1/dependents`);
  assert.equal(res.status, 500);
});

test('GET /agent-teams: supports nameRegex and omits dependentsSummary', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'agr-1', name: 'Alpha Team', members: [] }] }),
  });
  handle.repos.Agent = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  const withSummary = await request(app, 'GET', `${BASE}?nameRegex=Alpha`);
  assert.equal(withSummary.status, 200);
  assert.ok(withSummary.body[0].dependentsSummary);

  const withoutSummary = await request(app, 'GET', `${BASE}?include=dependentsSummary=false`);
  assert.equal(withoutSummary.status, 200);
  assert.equal(withoutSummary.body[0].dependentsSummary, undefined);
});

test('GET /agent-teams: returns empty list without enrichment', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /agent-teams/:id: enriches members and manager model', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({
      id: 'agr-rich',
      name: 'Rich Team',
      members: [
        { memberType: 'agent', memberId: 'a1' },
        { memberType: 'team', memberId: 'agr-child' },
      ],
      manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'model-1' },
    }),
  });
  handle.repos.Agent = makeFakeRepo({
    find: async () => [{ id: 'a1', name: 'Worker' }],
  });
  handle.repos.Model = makeFakeRepo({
    find: async () => [
      {
        id: 'model-1',
        name: 'Primary',
        provider: 'openai',
        providerModelId: 'gpt-4',
        gatewayModelId: null,
      },
    ],
  });
  const res = await request(app, 'GET', `${BASE}/agr-rich`);
  assert.equal(res.status, 200);
  assert.equal(res.body.associatedResources.agents[0].name, 'Worker');
  assert.equal(res.body.manager.model.gatewayModelId, 'openai/gpt-4');
});

test('POST /agent-teams: rejects cyclic graph on create', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => null,
    find: async () => [{ id: 'agr-child', members: [{ memberType: 'team', memberId: 'agr-new' }] }],
    create: (d: any) => ({ ...d, id: 'agr-new' }),
    save: async (e: any) => ({ ...e, id: 'agr-new', members: [{ memberType: 'team', memberId: 'agr-child' }] }),
    delete: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Cycle Team',
      manager: { name: 'mgr', systemPrompt: 'lead', modelId: 'm1' },
      members: [{ memberType: 'team', memberId: 'agr-child' }],
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /cycle/i);
});

test('PUT /agent-teams/:id: clears memoryContext with explicit null', async () => {
  let savedMemory: unknown = 'unset';
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-null', projectId: PROJECT, members: [] }),
    find: async () => [],
    update: async (_w: any, data: any) => {
      savedMemory = data.memoryContext;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/agr-null`, { body: { memoryContext: null } });
  assert.equal(res.status, 200);
  assert.equal(savedMemory, null);
});

test('PUT /agent-teams/:id: duplicate name returns 409', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name === 'Taken') return { id: 'agr-other', name: 'Taken' };
      return { id: 'agr-1', name: 'Old', projectId: PROJECT, members: [] };
    },
    find: async () => [],
  });
  const res = await request(app, 'PUT', `${BASE}/agr-1`, { body: { name: 'Taken' } });
  assert.equal(res.status, 409);
});

test('PUT /agent-teams/:id: invalid manager agent_id returns 400', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT, members: [] }),
    find: async () => [],
  });
  handle.repos.Agent = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/agr-1`, {
    body: { manager: { name: 'mgr', systemPrompt: 's', modelId: 'm1', agent_id: 'missing-agent' } },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Manager agent_id/);
});

test('PUT /agent-teams/:id: maps orchestration alias to orchestrationPolicy', async () => {
  let savedPolicy: string | undefined;
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT, members: [] }),
    find: async () => [],
    update: async (_w: any, data: any) => {
      savedPolicy = data.orchestrationPolicy;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/agr-1`, { body: { orchestration: 'delegate' } });
  assert.equal(res.status, 200);
  assert.equal(savedPolicy, 'delegate');
});

test('PUT /agent-teams/:id: invalid memoryContext returns 400', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    findOne: async () => ({ id: 'agr-1', projectId: PROJECT, members: [] }),
  });
  const res = await request(app, 'PUT', `${BASE}/agr-1`, {
    body: { memoryContext: { type: 'not-valid' } },
  });
  assert.equal(res.status, 400);
});

test('GET /agent-teams: returns 500 when list query fails', async () => {
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => {
      throw new Error('team list failed');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});
