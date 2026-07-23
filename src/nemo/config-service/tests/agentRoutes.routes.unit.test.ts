/**
 * Route-handler tests for routes/agentRoutes.ts mounted in a real express app.
 * DB access flows through the AppDataSource fake-repo seam; ReferenceEdgeService
 * runs against the same fakes (no DB, no network).
 *
 * Run: node --require ts-node/register --test tests/agentRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import agentRouter from '../routes/agentRoutes';
import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

const PROJECT = 'projtest0001';
const BASE = `/api/v1/projects/${PROJECT}/agents`;
const app = buildApp({ basePath: '/api/v1/projects/:projectId/agents', router: agentRouter });

let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({ findOne: async () => ({ id: PROJECT, name: 'Test Project' }) }),
  });
});
afterEach(() => handle.restore());

function seedAgentRepo(overrides: Record<string, any>) {
  handle.repos.Agent = makeFakeRepo(overrides);
}

test('POST /agents: valid body creates agent (201)', async () => {
  seedAgentRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'ag-new00001' }),
    save: async (e: any) => ({ ...e, id: 'ag-new00001' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'My Agent', role: 'assistant', systemPrompt: 'help', modelId: 'm1' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'ag-new00001');
});

test('POST /agents: duplicate name returns 409', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-existing', name: 'My Agent' }) });
  const res = await request(app, 'POST', BASE, {
    body: { name: 'My Agent', role: 'assistant', systemPrompt: 'help', modelId: 'm1' },
  });
  assert.equal(res.status, 409);
});

test('POST /agents: missing required fields returns 400 errors array', async () => {
  // modelId present so the model-selection guard passes and we reach validationResult.
  const res = await request(app, 'POST', BASE, { body: { name: 'x', modelId: 'm1' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /agents: model selection guard returns 400', async () => {
  const res = await request(app, 'POST', BASE, {
    body: { name: 'x', role: 'r', systemPrompt: 's' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /modelId or modelClass/);
});

test('POST /agents: ragConfig must cover every knowledgeBaseId (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'KB Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      knowledgeBaseIds: ['kb11111111'],
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /missing an entry/);
});

test('POST /agents: full 1:1 ragConfig creates agent (201)', async () => {
  seedAgentRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'ag-kb00001' }),
    save: async (e: any) => ({ ...e, id: 'ag-kb00001' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'KB Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      knowledgeBaseIds: ['kb11111111'],
      ragConfig: { kb11111111: { topK: 10, similarityThreshold: 0.3, searchMode: 'hybrid' } },
    },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'ag-kb00001');
});

test('POST /agents: orphan ragConfig key rejected (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'KB Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      knowledgeBaseIds: [],
      ragConfig: { kb11111111: { topK: 10, similarityThreshold: 0.3, searchMode: 'hybrid' } },
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /unknown knowledgeBaseId/);
});

test('PUT /agents/:id: changing only knowledgeBaseIds breaks 1:1 (400)', async () => {
  const existing = {
    id: 'ag-1',
    name: 'Old',
    projectId: PROJECT,
    knowledgeBaseIds: ['kb11111111'],
    ragConfig: { kb11111111: { topK: 10, similarityThreshold: 0.3, searchMode: 'hybrid' } },
  };
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => existing,
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1`, {
    body: { knowledgeBaseIds: ['kb11111111', 'kb22222222'] },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /missing an entry/);
});

test('POST /agents: well-formed requirements creates agent (201)', async () => {
  seedAgentRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'ag-req00001' }),
    save: async (e: any) => ({ ...e, id: 'ag-req00001' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [
          { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'Internal docs', description: 'product KB', required: true },
        ],
        mcpServers: [
          { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', label: 'GitHub search', description: 'code search', required: false },
        ],
      },
    },
  });
  assert.equal(res.status, 201);
});

test('POST /agents: requirements with unknown top-level key rejected (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: { datasets: [] },
    },
  });
  assert.equal(res.status, 400);
});

test('POST /agents: requirements entry with non-UUID id rejected (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [
          { id: 'not-a-uuid', label: 'X', description: 'y', required: false },
        ],
      },
    },
  });
  assert.equal(res.status, 400);
});

test('POST /agents: requirements entry label is trimmed on save (201)', async () => {
  let savedLabel: string | undefined;
  seedAgentRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'ag-trim00001' }),
    save: async (e: any) => {
      savedLabel = e?.requirements?.knowledgeBases?.[0]?.label;
      return { ...e, id: 'ag-trim00001' };
    },
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Trim Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            label: '   Spaced label   ',
            description: 'y',
            required: false,
          },
        ],
      },
    },
  });
  assert.equal(res.status, 201);
  assert.equal(savedLabel, 'Spaced label');
});

test('POST /agents: requirements entry missing required field rejected (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'X', description: 'Y' }],
      },
    },
  });
  assert.equal(res.status, 400);
});

test('POST /agents: requirements duplicate id within list rejected (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [
          { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'A', description: 'a', required: true },
          { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', label: 'B', description: 'b', required: false },
        ],
      },
    },
  });
  assert.equal(res.status, 400);
});

test('POST /agents: requirements duplicate id across lists allowed (201)', async () => {
  seedAgentRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'ag-req00002' }),
    save: async (e: any) => ({ ...e, id: 'ag-req00002' }),
  });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: {
        knowledgeBases: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'A', description: 'a', required: true }],
        mcpServers: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'B', description: 'b', required: false }],
      },
    },
  });
  assert.equal(res.status, 201);
});

test('POST /agents: requirements.knowledgeBases must be an array (400)', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'POST', BASE, {
    body: {
      name: 'Req Agent',
      role: 'assistant',
      systemPrompt: 'help',
      modelId: 'm1',
      requirements: { knowledgeBases: 'not-an-array' },
    },
  });
  assert.equal(res.status, 400);
});

test('PUT /agents/:id: clearing ragConfig while KBs remain is rejected (400)', async () => {
  const existing = {
    id: 'ag-1',
    name: 'Old',
    projectId: PROJECT,
    knowledgeBaseIds: ['kb11111111'],
    ragConfig: { kb11111111: { topK: 10, similarityThreshold: 0.3, searchMode: 'hybrid' } },
  };
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => existing,
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1`, { body: { ragConfig: null } });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /missing an entry/);
});

test('GET /agents: list returns items with dependentsSummary', async () => {
  seedAgentRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ag-1', name: 'A' }] }),
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ag-1');
  assert.ok(res.body[0].dependentsSummary);
});

test('GET /agents: project not found returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 404);
});

test('GET /agents/:id: found resolves attached mcp servers (200)', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1', mcpServerIds: ['mcp-1'] }) });
  handle.repos.MCPServer = makeFakeRepo({
    find: async ({ where }: any) =>
      where?.deploymentType === 'platform'
        ? []
        : [{ id: 'mcp-1', name: 'srv', status: 'active', transport: 'http' }],
  });
  const res = await request(app, 'GET', `${BASE}/ag-1`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'ag-1');
  assert.ok(res.body._resolvedMCPServers['mcp-1']);
});

test('GET /agents/:id: not found returns 404', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/ag-x`);
  assert.equal(res.status, 404);
});

test('PUT /agents/:id: updates an existing agent (200)', async () => {
  const existing = { id: 'ag-1', name: 'Old', projectId: PROJECT };
  let saved = { ...existing };
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => saved,
    update: async (_w: any, data: any) => {
      saved = { ...saved, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1`, { body: { description: 'updated', modelId: 'm2' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.description, 'updated');
});

test('PUT /agents/:id: not found returns 404', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'PUT', `${BASE}/ag-x`, { body: { description: 'x' } });
  assert.equal(res.status, 404);
});

test('DELETE /agents/:id: deletes when no dependents (200)', async () => {
  seedAgentRepo({
    findOne: async () => ({ id: 'ag-1' }),
    delete: async () => ({ affected: 1 }),
  });
  // ReferenceEdge.findOne (hasDependents) returns null -> no dependents
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/ag-1`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { deleted: true });
});

test('DELETE /agents/:id: blocked when dependents exist (409)', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1' }) });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => ({ projectId: PROJECT }) });
  const res = await request(app, 'DELETE', `${BASE}/ag-1`);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'HAS_DEPENDENTS');
});

test('DELETE /agents/:id: not found returns 404', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/ag-x`);
  assert.equal(res.status, 404);
});

test('GET /agents/:id/dependents: returns a page', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1' }) });
  const res = await request(app, 'GET', `${BASE}/ag-1/dependents?limit=10`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
});

test('GET /agents/:id/history: returns history or 404', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1' }) });
  handle.repos.AgentHistory = makeFakeRepo({ find: async () => [{ version: 2 }, { version: 1 }] });
  const ok = await request(app, 'GET', `${BASE}/ag-1/history`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.length, 2);

  handle.repos.AgentHistory = makeFakeRepo({ find: async () => [] });
  const none = await request(app, 'GET', `${BASE}/ag-1/history`);
  assert.equal(none.status, 404);
});

test('POST /agents/:id/restore-version: validates + restores', async () => {
  const missing = await request(app, 'POST', `${BASE}/ag-1/restore-version`, { body: {} });
  assert.equal(missing.status, 400);

  seedAgentRepo({
    findOne: async () => ({ id: 'ag-1', projectId: PROJECT }),
    update: async () => ({ affected: 1 }),
  });
  handle.repos.AgentHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'ag-1', name: 'Old', role: 'r' } }),
  });
  const ok = await request(app, 'POST', `${BASE}/ag-1/restore-version`, { body: { version: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restored, true);

  handle.repos.AgentHistory = makeFakeRepo({ findOne: async () => null });
  const noVersion = await request(app, 'POST', `${BASE}/ag-1/restore-version`, { body: { version: 9 } });
  assert.equal(noVersion.status, 404);
});

// ─── Deployment gate ────────────────────────────────────────────────────────
// PUT /:id/status and PUT /:id both reject a transition to
// `deploymentStatus='deployed'` while any `required: true` placeholder
// remains on the agent's `requirements` JSONB.

test('PUT /agents/:id/status: deployed with unmet required requirements rejected (400)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-1',
      projectId: PROJECT,
      requirements: {
        knowledgeBases: [
          { id: '11111111-1111-4111-8111-111111111111', label: 'Internal docs', description: 'x', required: true },
        ],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1/status`, {
    body: { deploymentStatus: 'deployed' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.unmetRequirements, [
    {
      kind: 'knowledgeBases',
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Internal docs',
    },
  ]);
});

test('PUT /agents/:id/status: deployed with only optional requirements passes (200)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-2',
      projectId: PROJECT,
      requirements: {
        mcpServers: [
          { id: '22222222-2222-4222-8222-222222222222', label: 'Nice to have', description: 'x', required: false },
        ],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-2/status`, {
    body: { deploymentStatus: 'deployed' },
  });
  assert.equal(res.status, 200);
});

test('PUT /agents/:id/status: deployed with colon in label preserves label verbatim (400)', async () => {
  // Regression: the unmetRequirements payload must carry labels verbatim
  // — labels can contain colons (e.g. "Q3:2026 Customer KB") and any
  // string-encoded form would split on them on the UI side.
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-colon',
      projectId: PROJECT,
      requirements: {
        knowledgeBases: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            label: 'Q3:2026 Customer KB',
            description: 'x',
            required: true,
          },
        ],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-colon/status`, {
    body: { deploymentStatus: 'deployed' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.unmetRequirements, [
    {
      kind: 'knowledgeBases',
      id: '66666666-6666-4666-8666-666666666666',
      label: 'Q3:2026 Customer KB',
    },
  ]);
});

test('PUT /agents/:id/status: draft transition allowed even with required reqs (200)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-3',
      projectId: PROJECT,
      requirements: {
        knowledgeBases: [{ id: '33333333-3333-4333-8333-333333333333', label: 'X', description: 'x', required: true }],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-3/status`, {
    body: { deploymentStatus: 'draft' },
  });
  assert.equal(res.status, 200);
});

test('GET /agents/:id/history: 404 when agent missing', async () => {
  seedAgentRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/ag-missing/history`);
  assert.equal(res.status, 404);
  assert.match(String(res.body.error), /Agent not found/);
});

test('GET /agents/:id/history: 500 when history query fails', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1', projectId: PROJECT }) });
  handle.repos.AgentHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/ag-1/history`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /history query failed/);
});

test('PUT /agents/:id/status: returns 400 for invalid status values', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-1', projectId: PROJECT }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1/status`, { body: { status: 'invalid-status' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('PUT /agents/:id/status: requires at least one status field (400)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-empty', projectId: PROJECT }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-empty/status`, { body: {} });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /At least one of status/);
});

test('PUT /agents/:id/status: returns 500 when update fails', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-1', projectId: PROJECT }),
    update: async () => {
      throw new Error('status update failed');
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1/status`, { body: { statusMessage: 'syncing' } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /status update failed/);
});

test('POST /agents/:id/restore-version: 404 when agent missing', async () => {
  handle.repos.Agent = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/ag-missing/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 404);
  assert.match(String(res.body.error), /Agent not found/);
});

test('POST /agents/:id/restore-version: 500 when update fails', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-boom', projectId: PROJECT }),
    update: async () => {
      throw new Error('update failed');
    },
  });
  handle.repos.AgentHistory = makeFakeRepo({
    findOne: async () => ({ version: 1, data: { id: 'ag-boom', name: 'Old' } }),
  });
  const res = await request(app, 'POST', `${BASE}/ag-boom/restore-version`, { body: { version: 1 } });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /update failed/);
});

test('PUT /agents/:id: full PUT to deployed with unmet stored reqs rejected (400)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-4',
      projectId: PROJECT,
      knowledgeBaseIds: [],
      ragConfig: null,
      requirements: {
        knowledgeBases: [
          { id: '44444444-4444-4444-8444-444444444444', label: 'Customer KB', description: 'x', required: true },
        ],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-4`, {
    body: { deploymentStatus: 'deployed' },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.unmetRequirements, [
    {
      kind: 'knowledgeBases',
      id: '44444444-4444-4444-8444-444444444444',
      label: 'Customer KB',
    },
  ]);
});

test('PUT /agents/:id: full PUT atomically clearing reqs + deploying passes (200)', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-5',
      projectId: PROJECT,
      knowledgeBaseIds: [],
      ragConfig: null,
      requirements: {
        knowledgeBases: [
          { id: '55555555-5555-4555-8555-555555555555', label: 'About to be cleared', description: 'x', required: true },
        ],
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  // Same body clears the placeholder AND flips deployment — should pass
  // because the deployment gate validates the *effective* merged state.
  const res = await request(app, 'PUT', `${BASE}/ag-5`, {
    body: {
      requirements: { knowledgeBases: [] },
      deploymentStatus: 'deployed',
    },
  });
  assert.equal(res.status, 200);
});

test('PUT /agents/:id: ignores datasetIds and normalizes memoryContext', async () => {
  let updatePayload: Record<string, unknown> | undefined;
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-mem',
      projectId: PROJECT,
      knowledgeBaseIds: [],
      ragConfig: null,
      requirements: {},
    }),
    update: async (_w: any, data: any) => {
      updatePayload = data;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ag-mem`, {
    body: {
      datasetIds: ['should-be-skipped'],
      memoryContext: { type: 'window', message_window_limit: 10 },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(updatePayload?.datasetIds, undefined);
  assert.equal((updatePayload?.memoryContext as any)?.type, 'window');
});

test('PUT /agents/:id: invalid memoryContext returns 400', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-bad-mem',
      projectId: PROJECT,
      knowledgeBaseIds: [],
      ragConfig: null,
    }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-bad-mem`, {
    body: { memoryContext: { type: 'not-a-real-type' } },
  });
  assert.equal(res.status, 400);
});

test('DELETE /agents/:id: returns 500 when delete fails', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-del', projectId: PROJECT }),
    delete: async () => {
      throw new Error('delete failed');
    },
  });
  handle.repos.ReferenceEdge = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/ag-del`);
  assert.equal(res.status, 500);
});

test('GET /agents/:id/dependents: returns 500 when lookup fails', async () => {
  handle.repos.Agent = makeFakeRepo({ findOne: async () => ({ id: 'ag-1', projectId: PROJECT }) });
  handle.query.mock.mockImplementation(async () => {
    throw new Error('dependents query failed');
  });
  const res = await request(app, 'GET', `${BASE}/ag-1/dependents`);
  assert.equal(res.status, 500);
});

test('GET /agents: supports field/value filters and nameRegex', async () => {
  seedAgentRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ag-filter', name: 'Filter Agent', role: 'assistant' }] }),
  });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.KnowledgeBase = makeFakeRepo({ find: async () => [] });
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const res = await request(app, 'GET', `${BASE}?field=role&value=assistant&nameRegex=Filter`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].id, 'ag-filter');
});

test('GET /agents: omits dependentsSummary when include=dependentsSummary=false', async () => {
  seedAgentRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'ag-1', name: 'A' }] }),
  });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.KnowledgeBase = makeFakeRepo({ find: async () => [] });
  handle.repos.AgentTeam = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const res = await request(app, 'GET', `${BASE}?include=dependentsSummary=false`);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].dependentsSummary, undefined);
});

test('GET /agents: returns empty list without enrichment queries', async () => {
  seedAgentRepo({ createQueryBuilder: () => makeQueryBuilder({ many: [] }) });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('GET /agents/:id: enriches model, KBs, teams, and platform MCP servers', async () => {
  const prevWeb = process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP;
  const prevAnalytics = process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP;
  process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP = 'true';
  process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP = 'true';
  try {
    seedAgentRepo({
      findOne: async () => ({
        id: 'ag-rich',
        modelId: 'model-1',
        fallbackModelIds: ['model-2'],
        knowledgeBaseIds: ['kb-1'],
        mcpServerIds: ['mcp-err', 'mcp-ok'],
      }),
    });
    handle.repos.Model = makeFakeRepo({
      find: async ({ where }: any) => {
        const ids = where?.id?.value ?? where?.id ?? [];
        const list = Array.isArray(ids) ? ids : [ids];
        return list.map((id: string) => ({
          id,
          name: id,
          provider: 'openai',
          providerModelId: 'gpt-4',
          gatewayModelId: null,
        }));
      },
    });
    handle.repos.KnowledgeBase = makeFakeRepo({
      find: async () => [{ id: 'kb-1', name: 'Docs' }],
    });
    handle.repos.AgentTeam = makeFakeRepo({
      createQueryBuilder: () =>
        makeQueryBuilder({
          many: [{ id: 'team-1', name: 'Ops', members: [{ memberType: 'agent', memberId: 'ag-rich' }] }],
        }),
    });
    handle.repos.MCPServer = makeFakeRepo({
      find: async ({ where }: any) => {
        if (where?.deploymentType === 'platform') {
          return [
            {
              id: 'plat-1',
              name: 'Platform MCP',
              catalogId: 'artifact-store',
              status: 'connected',
              transport: 'http',
              syncStatus: 'synced',
            },
          ];
        }
        return [
          { id: 'mcp-err', name: 'Broken', status: 'error', transport: 'http' },
          { id: 'mcp-ok', name: 'Good', status: 'connected', transport: 'http', syncStatus: 'synced' },
        ];
      },
    });
    const res = await request(app, 'GET', `${BASE}/ag-rich`);
    assert.equal(res.status, 200);
    assert.equal(res.body.model.id, 'model-1');
    assert.equal(res.body.fallbackModels.length, 1);
    assert.equal(res.body.associatedResources.knowledgeBases[0].name, 'Docs');
    assert.equal(res.body.associatedResources.agentTeams[0].name, 'Ops');
    assert.ok(res.body._resolvedMCPServers['mcp-ok']);
    assert.ok(res.body._resolvedMCPServers['plat-1']);
    assert.equal(res.body._resolvedMCPServers['mcp-err'], undefined);
  } finally {
    if (prevWeb === undefined) delete process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP;
    else process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP = prevWeb;
    if (prevAnalytics === undefined) delete process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP;
    else process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP = prevAnalytics;
  }
});

test('GET /agents/:id: returns 500 when enrichment fails', async () => {
  seedAgentRepo({ findOne: async () => ({ id: 'ag-1', modelId: 'm1' }) });
  handle.repos.Model = makeFakeRepo({
    find: async () => {
      throw new Error('model lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/ag-1`);
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /model lookup failed/);
});

test('PUT /agents/:id: clears memoryContext with explicit null', async () => {
  let savedMemory: unknown = 'unset';
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({
      id: 'ag-nullmem',
      projectId: PROJECT,
      knowledgeBaseIds: [],
      ragConfig: null,
    }),
    update: async (_w: any, data: any) => {
      savedMemory = data.memoryContext;
      return { affected: 1 };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ag-nullmem`, {
    body: { memoryContext: null, modelId: 'm1' },
  });
  assert.equal(res.status, 200);
  assert.equal(savedMemory, null);
});

test('PUT /agents/:id: duplicate name returns 409', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async (q: any) => {
      if (q?.where?.name === 'Taken') return { id: 'ag-other', name: 'Taken' };
      return { id: 'ag-1', name: 'Old', projectId: PROJECT };
    },
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1`, { body: { name: 'Taken', modelId: 'm1' } });
  assert.equal(res.status, 409);
});

test('PUT /agents/:id/status: returns 404 when agent disappears after update', async () => {
  let calls = 0;
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => {
      calls += 1;
      if (calls === 1) return { id: 'ag-vanish', projectId: PROJECT };
      return null;
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-vanish/status`, { body: { status: 'Healthy' } });
  assert.equal(res.status, 404);
});

test('PUT /agents/:id/status: updates status and statusMessage fields', async () => {
  handle.repos.Agent = makeFakeRepo({
    findOne: async () => ({ id: 'ag-1', projectId: PROJECT, status: 'Healthy' }),
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PUT', `${BASE}/ag-1/status`, {
    body: { status: 'Unhealthy', statusMessage: 'probe failed' },
  });
  assert.equal(res.status, 200);
});

test('GET /agents: returns 500 when list query fails', async () => {
  seedAgentRepo({
    createQueryBuilder: () => {
      throw new Error('list query failed');
    },
  });
  const res = await request(app, 'GET', BASE);
  assert.equal(res.status, 500);
});
