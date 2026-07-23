/**
 * Route-handler tests for routes/evaluationAgentRoutes.ts.
 *
 * Run: node --require ts-node/register --test tests/evaluationAgentRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import http from 'node:http';
import type { Express } from 'express';
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

const PROJECT = 'projtest0001';
const TEMPLATE_ID = 'evt-abc12345';
const RUN_ID = 'run-abc12345';
const BASE = `/api/v1/projects/${PROJECT}/evaluation/agents`;

function baseTemplate(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    evalName: 'RAG Validation',
    description: 'Golden-set regression',
    labels: ['staging'],
    target: 'agent_version',
    agent: { agentId: 'agt-abc12345', agentVersion: 'v2.4.1' },
    models: [],
    evaluationScope: 'full_agent_execution',
    suite: 'rag',
    evaluators: {
      strategy: 'both',
      aiJudge: { models: ['m-judge'], dimensions: ['helpfulness', 'correctness'] },
      deterministic: { metrics: ['rag_quality'] },
    },
    runMode: 'single',
    ...overrides,
  };
}

function requestRaw(
  app: Express,
  method: string,
  urlPath: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('failed to bind'));
      }
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: urlPath,
          method,
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(body.byteLength),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: any = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = { _raw: text };
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.write(body);
      req.end();
    });
  });
}

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let app: Express;
let s3Calls: Array<{ command: string; input: Record<string, unknown> }>;
let workflow: {
  reconcileSchedule: () => Promise<{ temporalScheduleId?: string }>;
  tearDownSchedule: () => Promise<void>;
  startEvaluationRun: () => Promise<{ workflowId: string }>;
  signal: (...args: unknown[]) => Promise<void>;
  cancel: (...args: unknown[]) => Promise<void>;
};

let templateRow: Record<string, unknown>;
let runRow: Record<string, unknown>;

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  s3Calls = [];
  templateRow = baseTemplate();
  runRow = {
    runId: RUN_ID,
    projectId: PROJECT,
    templateId: TEMPLATE_ID,
    status: 'running',
    workflowId: 'evaluation-agent-run-run-abc',
    audit: [],
    createdAt: new Date('2024-06-01'),
    updatedAt: new Date('2024-06-01'),
  };

  workflow = {
    reconcileSchedule: async () => ({ temporalScheduleId: undefined }),
    tearDownSchedule: async () => undefined,
    startEvaluationRun: async () => ({ workflowId: 'evaluation-agent-run-run-new' }),
    signal: async () => undefined,
    cancel: async () => undefined,
  };

  handle.repos.Project = makeFakeRepo({
    findOne: async (q: any) =>
      q?.where?.id === PROJECT
        ? {
            id: PROJECT,
            name: 'Test',
            home_dir: 's3://default-nemo/projects/projtest0001',
            metadata: {},
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            init_status: 'ready',
            init_error: null,
          }
        : null,
  });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      if (w.projectId && w.projectId !== PROJECT) return null;
      if (w.templateId && w.templateId !== TEMPLATE_ID) return null;
      if (w.evalName && w.evalName !== templateRow.evalName) return null;
      if (w.templateId === TEMPLATE_ID || w.evalName === templateRow.evalName) return { ...templateRow };
      return null;
    },
    find: async (q: any) => (q?.where?.projectId === PROJECT ? [{ ...templateRow }] : []),
    create: (d: any) => ({ templateId: 'evt-new0001', ...d }),
    save: async (d: any) => d,
    update: async (_w: any, data: any) => {
      templateRow = { ...templateRow, ...data };
      return { affected: 1 };
    },
    softDelete: async () => ({ affected: 1 }),
    remove: async () => undefined,
    createQueryBuilder: () => makeQueryBuilder({ many: [{ ...templateRow }] }),
  });
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      if (w.runId === RUN_ID && w.projectId === PROJECT) return { ...runRow };
      return null;
    },
    create: (d: any) => d,
    save: async (d: any) => d,
    update: async (_w: any, data: any) => {
      runRow = { ...runRow, ...data };
      return { affected: 1 };
    },
    delete: async () => ({ affected: 1 }),
    createQueryBuilder: () => makeQueryBuilder({ many: [{ ...runRow }] }),
  });
  handle.repos.EvaluationTemplateHistory = makeFakeRepo({
    find: async () => [{ version: 2 }, { version: 1 }],
    findOne: async (q: any) =>
      q?.where?.version === 1 ? { version: 1, data: { ...templateRow, description: 'old' } } : null,
  });
  handle.repos.ReferenceEdge = makeFakeRepo({
    delete: async () => ({ affected: 0 }),
  });

  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async (cmd: any) => {
          s3Calls.push({ command: cmd.constructor?.name ?? 'Command', input: cmd.input ?? {} });
          if (cmd.constructor?.name === 'GetObjectCommand') {
            return {
              Body: {
                transformToByteArray: async () => Buffer.from('{"q":"a"}\n'),
              },
            };
          }
          return {};
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );

  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/evaluationAgentRoutes', 'utils/s3Utils', 'services/EvaluationWorkflowClient');
  handle.restore();
});

test('POST /templates: creates template (201) and rejects duplicate (409)', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ templateId: 'evt-new0001', ...d }),
    save: async (d: any) => d,
    update: async () => ({ affected: 1 }),
  });
  const created = await request(app, 'POST', `${BASE}/templates`, { body: baseTemplate({ templateId: undefined }) });
  assert.equal(created.status, 201);

  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ templateId: TEMPLATE_ID }),
  });
  const dupe = await request(app, 'POST', `${BASE}/templates`, { body: baseTemplate({ templateId: undefined }) });
  assert.equal(dupe.status, 409);
});

test('GET /templates and GET /templates/:templateId', async () => {
  const list = await request(app, 'GET', `${BASE}/templates`);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));

  const one = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.templateId, TEMPLATE_ID);

  assert.equal((await request(app, 'GET', `${BASE}/templates/missing`)).status, 404);
});

test('PATCH /templates/:templateId updates and POST /templates/estimate computes impact', async () => {
  const patched = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { description: 'updated desc' },
  });
  assert.equal(patched.status, 200);

  const estimate = await request(app, 'POST', `${BASE}/templates/estimate`, {
    body: {
      testCaseCount: 5,
      evaluators: {
        strategy: 'both',
        aiJudge: { dimensions: ['helpfulness'] },
        deterministic: { metrics: ['rag_quality'] },
      },
    },
  });
  assert.equal(estimate.status, 200);
  assert.ok(estimate.body.estimatedDurationMinutes > 0);
});

test('DELETE /templates/:templateId soft-deletes (204)', async () => {
  const res = await request(app, 'DELETE', `${BASE}/templates/${TEMPLATE_ID}`);
  assert.equal(res.status, 204);
});

test('GET /templates/:templateId/history and restore-version', async () => {
  const history = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.length, 2);

  const restored = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/restore-version`, {
    body: { version: 1 },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored, true);
});

test('GET /templates/:templateId/schedule returns schedule metadata', async () => {
  templateRow = baseTemplate({ schedule: { enabled: false }, scheduleStatus: { state: 'paused' } });
  const res = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}/schedule`);
  assert.equal(res.status, 200);
  assert.equal(res.body.scheduleStatus.state, 'paused');
});

test('PUT/GET/DELETE /evaluations/:evalId/testcases', async () => {
  const evalId = 'rag-validation';
  const put = await requestRaw(
    app,
    'PUT',
    `${BASE}/evaluations/${evalId}/testcases`,
    Buffer.from('{"input":"x","expected":"y"}\n'),
  );
  assert.equal(put.status, 200);
  assert.equal(put.body.lineCount, 1);
  assert.ok(s3Calls.some((c) => c.command === 'PutObjectCommand'));

  const meta = await request(app, 'GET', `${BASE}/evaluations/${evalId}/testcases`);
  assert.equal(meta.status, 200);
  assert.ok(meta.body.byteCount > 0);

  const body = await request(app, 'GET', `${BASE}/evaluations/${evalId}/testcases?include=body`);
  assert.equal(body.status, 200);
  assert.match(body.text, /"q":"a"/);

  const del = await request(app, 'DELETE', `${BASE}/evaluations/${evalId}/testcases`);
  assert.equal(del.status, 204);
});

test('POST /templates/:templateId/runs starts run (202)', async () => {
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/runs`, {
    body: { name: 'manual-run' },
  });
  assert.equal(res.status, 202);
  assert.equal(res.body.status, 'queued');
  assert.ok(res.body.workflowId);
});

test('GET /runs, GET/PATCH/POST cancel/baseline/audit for a run', async () => {
  const list = await request(app, 'GET', `${BASE}/runs?templateId=${TEMPLATE_ID}`);
  assert.equal(list.status, 200);

  const one = await request(app, 'GET', `${BASE}/runs/${RUN_ID}`);
  assert.equal(one.status, 200);

  const patched = await request(app, 'PATCH', `${BASE}/runs/${RUN_ID}`, {
    body: { status: 'success', auditAppend: [{ type: 'workflow_event', message: 'done' }] },
  });
  assert.equal(patched.status, 200);

  const cancelled = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(cancelled.status, 200);

  runRow = { ...runRow, status: 'success' };
  const baseline = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/baseline`);
  assert.equal(baseline.status, 200);

  const auditGet = await request(app, 'GET', `${BASE}/runs/${RUN_ID}/audit-events`);
  assert.equal(auditGet.status, 200);

  const auditPost = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/audit-events`, {
    body: { type: 'note', message: 'manual note' },
  });
  assert.equal(auditPost.status, 201);
  assert.equal(auditPost.body.type, 'note');
});

test('GET /templates: supports runMode/suite/status filters', async () => {
  // Capture the query builder so we can assert the filters are actually pushed
  // into the WHERE clause (a handler that drops them still returns 200).
  const qb = makeQueryBuilder({ many: [{ ...templateRow }] });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => qb,
  });

  const res = await request(app, 'GET', `${BASE}/templates?runMode=single&suite=rag&status=active`);
  assert.equal(res.status, 200);

  const andWhereArgs = (qb.andWhere as any).mock.calls.map((c: any) => c.arguments);
  assert.ok(
    andWhereArgs.some(([clause, params]: any[]) => /runMode/.test(clause) && params?.runMode === 'single'),
    'expected runMode filter to be applied to the query',
  );
  assert.ok(
    andWhereArgs.some(([clause, params]: any[]) => /suite/.test(clause) && params?.suite === 'rag'),
    'expected suite filter to be applied to the query',
  );
});

test('PATCH /templates/:templateId: duplicate evalName returns 409', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async (q: any) => {
      const w = q?.where ?? {};
      if (w.evalName === 'Taken Name' && w.templateId) return { templateId: 'other' };
      if (w.templateId === TEMPLATE_ID) return { ...templateRow, evalName: 'RAG Validation' };
      return null;
    },
    update: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { evalName: 'Taken Name' },
  });
  assert.equal(res.status, 409);
});

test('DELETE /templates/:templateId: hard delete tolerates schedule tearDown failures', async () => {
  templateRow = baseTemplate({ schedule: { enabled: true } });
  workflow.tearDownSchedule = async () => {
    throw new Error('temporal down');
  };
  const res = await request(app, 'DELETE', `${BASE}/templates/${TEMPLATE_ID}?hard=true`);
  assert.equal(res.status, 204);
});

test('DELETE /templates/:templateId: soft delete pauses schedule when disabled', async () => {
  templateRow = baseTemplate({
    schedule: { enabled: false },
    scheduleStatus: { state: 'active', temporalScheduleId: 'sched-1' },
  });
  const res = await request(app, 'DELETE', `${BASE}/templates/${TEMPLATE_ID}`);
  assert.equal(res.status, 204);
});

test('GET /templates/:templateId/history: empty history returns 404', async () => {
  handle.repos.EvaluationTemplateHistory = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}/history`);
  assert.equal(res.status, 404);
});

test('POST /templates/:templateId/restore-version: missing version returns 400', async () => {
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/restore-version`, { body: {} });
  assert.equal(res.status, 400);
});

test('PUT /evaluations/:evalId/testcases: rejects invalid filename and empty body', async () => {
  const badName = await requestRaw(
    app,
    'PUT',
    `${BASE}/evaluations/rag-validation/testcases?filename=bad%20name.jsonl`,
    Buffer.from('{"input":"x"}\n'),
  );
  assert.equal(badName.status, 400);

  const empty = await requestRaw(app, 'PUT', `${BASE}/evaluations/rag-validation/testcases`, Buffer.from(''));
  assert.equal(empty.status, 400);
});

test('PUT /evaluations/:evalId/testcases: project missing returns 404', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await requestRaw(
    app,
    'PUT',
    `${BASE}/evaluations/rag-validation/testcases`,
    Buffer.from('{"input":"x"}\n'),
  );
  assert.equal(res.status, 404);
});

test('GET /evaluations/:evalId/testcases: metadata response and missing object 404', async () => {
  const meta = await request(app, 'GET', `${BASE}/evaluations/rag-validation/testcases?include=metadata`);
  assert.equal(meta.status, 200);
  assert.ok(meta.body.byteCount > 0);

  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async () => {
          const err: any = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });

  const missing = await request(app, 'GET', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(missing.status, 404);
});

test('DELETE /evaluations/:evalId/testcases: ignores missing S3 object', async () => {
  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async (cmd: any) => {
          if (cmd.constructor?.name === 'DeleteObjectCommand') {
            const err: any = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            throw err;
          }
          return {};
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });

  const res = await request(app, 'DELETE', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(res.status, 204);
});

test('POST /runs/:runId/cancel: falls back to hard cancel when signal fails', async () => {
  let cancelled = false;
  workflow.signal = async () => {
    throw new Error('signal failed');
  };
  workflow.cancel = async () => {
    cancelled = true;
  };
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(cancelled, true);
});

test('POST /runs/:runId/baseline: maps not-found and conflict errors', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'POST', `${BASE}/runs/${RUN_ID}/baseline`)).status, 404);

  runRow = { ...runRow, status: 'running' };
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({ ...runRow }),
    find: async () => [{ ...runRow }],
  });
  assert.equal((await request(app, 'POST', `${BASE}/runs/${RUN_ID}/baseline`)).status, 409);
});

test('POST /runs/:runId/audit-events: requires type', async () => {
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/audit-events`, { body: { message: 'x' } });
  assert.equal(res.status, 400);
});

test('PATCH /templates/:templateId: schedule reconcile runs when schedule is patched', async () => {
  let reconciled = false;
  workflow.reconcileSchedule = async () => {
    reconciled = true;
    return { temporalScheduleId: 'sched-123' };
  };
  templateRow = baseTemplate({
    schedule: { enabled: true, scheduleType: 'cron', cron: '0 0 * * *' },
  });
  const res = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { schedule: { enabled: true, scheduleType: 'cron', cron: '0 1 * * *' } },
  });
  assert.equal(res.status, 200);
  assert.equal(reconciled, true);
});

test('GET /runs: supports templateId/status/limit/skip filters', async () => {
  const res = await request(app, 'GET', `${BASE}/runs?templateId=${TEMPLATE_ID}&status=running&limit=10&skip=0`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('GET /evaluations/:evalId/testcases: streams body via readable fallback', async () => {
  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async (cmd: any) => {
          if (cmd.constructor?.name === 'GetObjectCommand') {
            return {
              Body: (async function* () {
                yield Buffer.from('{"streamed":true}\n');
              })(),
            };
          }
          return {};
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ preferred_username: 'eval-user', email: 'eval-user@example.com' })],
  });

  const res = await request(app, 'GET', `${BASE}/evaluations/rag-validation/testcases?include=body`);
  assert.equal(res.status, 200);
  assert.match(res.text, /streamed/);
});

test('POST /runs/:runId/cancel: uses signal when workflowId is present', async () => {
  let signaled = false;
  workflow.signal = async () => {
    signaled = true;
  };
  workflow.cancel = async () => {
    throw new Error('should not hard cancel');
  };
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(res.status, 200);
  assert.equal(signaled, true);
});

test('POST /runs/:runId/cancel: works when run has no workflowId', async () => {
  runRow = { ...runRow, workflowId: undefined };
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({ ...runRow }),
    update: async (_w: any, data: any) => {
      runRow = { ...runRow, ...data };
      return { affected: 1 };
    },
  });
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(res.status, 200);
});

test('PATCH /runs/:runId: no-op when body has no allowed fields', async () => {
  const res = await request(app, 'PATCH', `${BASE}/runs/${RUN_ID}`, { body: { unknown: true } });
  assert.equal(res.status, 200);
});

test('GET /runs/:runId: 404 when missing', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/runs/missing`)).status, 404);
});

test('GET /runs/:runId/audit-events: 404 when run missing', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/runs/missing/audit-events`)).status, 404);
});

test('POST /runs/:runId/audit-events: 404 when run missing', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/runs/missing/audit-events`, {
    body: { type: 'note', message: 'x' },
  });
  assert.equal(res.status, 404);
});

test('GET /templates/:templateId/schedule: 404 when template missing', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({ findOne: async () => null });
  assert.equal((await request(app, 'GET', `${BASE}/templates/missing/schedule`)).status, 404);
});

test('POST /templates/:templateId/restore-version: 404 when history version missing', async () => {
  handle.repos.EvaluationTemplateHistory = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/restore-version`, {
    body: { version: 99 },
  });
  assert.equal(res.status, 404);
});

test('POST /templates/estimate: llm_judge-only strategy', async () => {
  const res = await request(app, 'POST', `${BASE}/templates/estimate`, {
    body: {
      testCaseCount: 3,
      evaluators: { strategy: 'llm_judge', aiJudge: { dimensions: ['helpfulness', 'tone'] } },
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.estimatedDurationMinutes > 0);
});

test('PUT /evaluations/:evalId/testcases: stores custom filename pointer', async () => {
  let updatedCases: any = null;
  handle.repos.EvaluationTemplate = makeFakeRepo({
    find: async () => [{ ...templateRow, evalName: 'RAG Validation' }],
    findOne: async () => ({ ...templateRow, evalName: 'RAG Validation' }),
    update: async (_w: any, patch: any) => {
      updatedCases = patch.cases;
      return { affected: 1 };
    },
  });
  const res = await requestRaw(
    app,
    'PUT',
    `${BASE}/evaluations/rag-validation/testcases?filename=golden.jsonl`,
    Buffer.from('{"input":"x"}\n'),
  );
  assert.equal(res.status, 200);
  assert.equal(updatedCases?.filename, 'golden.jsonl');
});

test('DELETE /templates/:templateId: hard delete with enabled schedule tears down', async () => {
  templateRow = baseTemplate({ schedule: { enabled: true } });
  let tornDown = false;
  workflow.tearDownSchedule = async () => {
    tornDown = true;
  };
  handle.repos.EvaluationRun = makeFakeRepo({ delete: async () => ({ affected: 0 }) });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ ...templateRow }),
    remove: async () => undefined,
    softDelete: async () => ({ affected: 1 }),
  });
  const res = await request(app, 'DELETE', `${BASE}/templates/${TEMPLATE_ID}?hard=true`);
  assert.equal(res.status, 204);
  assert.equal(tornDown, true);
});

test('POST /templates: validation errors return 400', async () => {
  const res = await request(app, 'POST', `${BASE}/templates`, { body: { evalName: '' } });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('POST /runs/:runId/baseline: maps generic service errors to 500', async () => {
  scope.add(
    mockModule('services/EvaluationService', {
      EvaluationService: {
        setBaseline: async () => {
          throw new Error('unexpected');
        },
      },
      EvaluationNotFound: class EvaluationNotFound extends Error {},
      EvaluationConflict: class EvaluationConflict extends Error {},
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/baseline`);
  assert.equal(res.status, 500);
});

test('GET /evaluations/:evalId/testcases: 404 when eval slug not found', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({ find: async () => [] });
  const res = await request(app, 'GET', `${BASE}/evaluations/unknown-eval/testcases`);
  assert.equal(res.status, 404);
});

test('GET /evaluations/:evalId/testcases: 404 when project missing', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'GET', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(res.status, 404);
});

test('GET /evaluations/:evalId/testcases: 500 on unexpected S3 errors', async () => {
  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async () => {
          throw new Error('s3 exploded');
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'GET', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(res.status, 500);
});

test('DELETE /evaluations/:evalId/testcases: 500 when delete throws non-404', async () => {
  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async () => {
          throw Object.assign(new Error('access denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'DELETE', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(res.status, 500);
});

test('POST /templates/:templateId/runs: 404 when template missing', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/templates/missing/runs`, { body: {} });
  assert.equal(res.status, 404);
});

test('GET /templates: 500 when listTemplates throws', async () => {
  scope.add(
    mockModule('services/EvaluationService', {
      EvaluationService: {
        listTemplates: async () => {
          throw new Error('list failed');
        },
        estimateImpact: (input: any) => ({
          estimatedDurationMinutes: 1,
          estimatedCostUsd: 0,
          ...input,
        }),
        createRun: async () => ({ runId: 'r1' }),
        setBaseline: async () => ({}),
      },
      EvaluationNotFound: class EvaluationNotFound extends Error {},
      EvaluationConflict: class EvaluationConflict extends Error {},
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'GET', `${BASE}/templates`);
  assert.equal(res.status, 500);
});

test('POST /runs/:runId/cancel: returns 500 when update fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({ ...runRow }),
    update: async () => {
      throw new Error('cancel update failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(res.status, 500);
});

test('GET /runs/:runId/audit-events: returns 500 when query fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => {
      throw new Error('audit read failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/runs/${RUN_ID}/audit-events`);
  assert.equal(res.status, 500);
});

test('POST /runs/:runId/audit-events: returns 500 when update fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({ ...runRow }),
    update: async () => {
      throw new Error('audit write failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/audit-events`, {
    body: { type: 'note', message: 'hello' },
  });
  assert.equal(res.status, 500);
});

test('GET /runs: returns 500 when list query fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          orderBy: () => ({
            skip: () => ({
              take: () => ({
                getMany: async () => {
                  throw new Error('runs list failed');
                },
              }),
            }),
          }),
        }),
        orderBy: () => ({
          skip: () => ({
            take: () => ({
              getMany: async () => {
                throw new Error('runs list failed');
              },
            }),
          }),
        }),
      }),
    }),
  });
  const res = await request(app, 'GET', `${BASE}/runs`);
  assert.equal(res.status, 500);
});

test('GET /runs/:runId: returns 500 when lookup fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => {
      throw new Error('run lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/runs/${RUN_ID}`);
  assert.equal(res.status, 500);
});

test('PATCH /runs/:runId: returns 400 when update fails', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({ ...runRow }),
    update: async () => {
      throw new Error('patch failed');
    },
  });
  const res = await request(app, 'PATCH', `${BASE}/runs/${RUN_ID}`, { body: { status: 'failed' } });
  assert.equal(res.status, 400);
});

test('POST /templates/:templateId/runs: returns 400 when createRun throws', async () => {
  scope.add(
    mockModule('services/EvaluationService', {
      EvaluationService: {
        listTemplates: async () => [],
        estimateImpact: (input: any) => input,
        createRun: async () => {
          throw new Error('create run failed');
        },
        setBaseline: async () => ({}),
      },
      EvaluationNotFound: class EvaluationNotFound extends Error {},
      EvaluationConflict: class EvaluationConflict extends Error {},
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/runs`, { body: {} });
  assert.equal(res.status, 400);
});

test('POST /templates/:templateId/runs: validation error returns 400 for invalid runId', async () => {
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/runs`, {
    body: { runId: 'not-a-uuid' },
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.errors));
});

test('DELETE /evaluations/:evalId/testcases: 404 when project missing', async () => {
  handle.repos.Project = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'DELETE', `${BASE}/evaluations/rag-validation/testcases`);
  assert.equal(res.status, 404);
  assert.match(String(res.body.error), /Project not found/i);
});

test('GET /templates/:templateId/history: returns 500 when history query fails', async () => {
  handle.repos.EvaluationTemplateHistory = makeFakeRepo({
    find: async () => {
      throw new Error('history query failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}/history`);
  assert.equal(res.status, 500);
});

test('POST /templates/:templateId/restore-version: returns 500 when update fails', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ ...templateRow }),
    update: async () => {
      throw new Error('restore update failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/templates/${TEMPLATE_ID}/restore-version`, {
    body: { version: 1 },
  });
  assert.equal(res.status, 500);
});

test('GET /templates/:templateId/schedule: returns 500 when lookup fails', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => {
      throw new Error('schedule lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}/schedule`);
  assert.equal(res.status, 500);
});

test('PATCH /templates/:templateId: returns 400 when update fails', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ ...templateRow }),
    update: async () => {
      throw new Error('patch template failed');
    },
  });
  const res = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { description: 'boom' },
  });
  assert.equal(res.status, 400);
});

test('DELETE /templates/:templateId: returns 500 when soft delete fails', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ ...templateRow }),
    softDelete: async () => {
      throw new Error('soft delete failed');
    },
  });
  const res = await request(app, 'DELETE', `${BASE}/templates/${TEMPLATE_ID}`);
  assert.equal(res.status, 500);
});

test('PUT /evaluations/:evalId/testcases: returns 500 when S3 put fails', async () => {
  scope.restoreAll();
  scope.add(
    mockModule('utils/s3Utils', {
      s3Client: {
        send: async () => {
          throw new Error('put failed');
        },
      },
    }),
  );
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await requestRaw(
    app,
    'PUT',
    `${BASE}/evaluations/rag-validation/testcases`,
    Buffer.from('{"input":"x"}\n'),
  );
  assert.equal(res.status, 500);
});

test('POST /templates/estimate: returns 400 when estimateImpact throws', async () => {
  scope.add(
    mockModule('services/EvaluationService', {
      EvaluationService: {
        estimateImpact: () => {
          throw new Error('estimate failed');
        },
      },
      EvaluationNotFound: class EvaluationNotFound extends Error {},
      EvaluationConflict: class EvaluationConflict extends Error {},
    }),
  );
  app = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ name: 'tester', email: 'tester@example.com' })],
  });
  const res = await request(app, 'POST', `${BASE}/templates/estimate`, {
    body: { testCaseCount: 1, evaluators: { strategy: 'llm_judge', aiJudge: { dimensions: ['x'] } } },
  });
  assert.equal(res.status, 400);
});

test('POST /templates: returns 400 when save throws', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => d,
    save: async () => {
      throw new Error('create template failed');
    },
  });
  const res = await request(app, 'POST', `${BASE}/templates`, { body: baseTemplate() });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /create template failed/);
});

test('GET /templates/:templateId: returns 500 when lookup throws', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => {
      throw new Error('template lookup failed');
    },
  });
  const res = await request(app, 'GET', `${BASE}/templates/${TEMPLATE_ID}`);
  assert.equal(res.status, 500);
});

test('POST /runs/:runId/cancel: returns 404 when run missing', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  const res = await request(app, 'POST', `${BASE}/runs/${RUN_ID}/cancel`);
  assert.equal(res.status, 404);
});

test('PATCH /templates/:templateId: pauses schedule when schedule.enabled is false', async () => {
  templateRow = baseTemplate({
    schedule: { enabled: true },
    scheduleStatus: { state: 'active', temporalScheduleId: 'sched-old' },
  });
  const res = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { schedule: { enabled: false } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.scheduleStatus.state, 'paused');
});

test('PATCH /templates/:templateId: reconciles enabled schedule with workflow client', async () => {
  workflow.reconcileSchedule = async () => ({ temporalScheduleId: 'sched-reconciled' });
  templateRow = baseTemplate({
    schedule: { enabled: true, scheduleType: 'cron', cron: '0 0 * * *' },
  });
  const res = await request(app, 'PATCH', `${BASE}/templates/${TEMPLATE_ID}`, {
    body: { schedule: { enabled: true, scheduleType: 'cron', cron: '0 1 * * *' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.scheduleStatus.temporalScheduleId, 'sched-reconciled');
});

test('POST /templates: uses actor name from preferred_username', async () => {
  const actorApp = buildApp({
    basePath: '/api/v1/projects/:projectId/evaluation/agents',
    router: loadFresh('routes/evaluationAgentRoutes').default,
    pre: [withUser({ preferred_username: 'svc-bot', email: 'bot@example.com' })],
  });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (d: any) => d,
  });
  const res = await request(actorApp, 'POST', `${BASE}/templates`, { body: baseTemplate() });
  assert.equal(res.status, 201);
  assert.equal(res.body.createdBy, 'svc-bot');
});

test('GET /templates: returns 500 when list query throws', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          orderBy: () => ({
            getMany: async () => {
              throw new Error('template list failed');
            },
          }),
        }),
      }),
    }),
  });
  const res = await request(app, 'GET', `${BASE}/templates`);
  assert.equal(res.status, 500);
});

