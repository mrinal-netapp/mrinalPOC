/**
 * Unit tests for services/EvaluationWorkflowClient.ts.
 *
 * Run: node --require ts-node/register --test tests/EvaluationWorkflowClient.unit.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

let scope: ReturnType<typeof restoreScope>;
let httpCalls: Array<{ method: string; url: string; body?: unknown }>;
let getEvaluationWorkflowClient: () => import('../services/EvaluationWorkflowClient').EvaluationWorkflowClient;

beforeEach(() => {
  scope = restoreScope();
  httpCalls = [];
  const client = {
    post: async (url: string, body?: unknown) => {
      httpCalls.push({ method: 'POST', url, body });
      return { data: { workflowId: 'returned-wf-id' } };
    },
    get: async () => ({ data: {} }),
  };
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => null,
    }),
  );
  scope.add(
    mockModule('axios', {
      default: { create: () => client },
      create: () => client,
    }),
  );
  clearModule('services/EvaluationWorkflowClient');
  getEvaluationWorkflowClient = loadFresh<typeof import('../services/EvaluationWorkflowClient')>(
    'services/EvaluationWorkflowClient',
  ).getEvaluationWorkflowClient;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/EvaluationWorkflowClient', 'axios', '@agentstudio/common');
});

test('startEvaluationRun: posts AgentEvaluationWorkflow payload', async () => {
  const client = getEvaluationWorkflowClient();
  const result = await client.startEvaluationRun('proj1', 'evt-1', 'run-1');
  assert.equal(result.workflowId, 'returned-wf-id');
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].url, '/api/v1/workflows');
  const body = httpCalls[0].body as Record<string, unknown>;
  assert.equal(body.workflowName, 'AgentEvaluationWorkflow');
  assert.equal(body.workflowId, 'evaluation-agent-run-run-1');
  assert.equal(body.taskQueue, 'eval-task-queue');
  assert.deepEqual(body.args, [{ runId: 'run-1', projectId: 'proj1' }]);
});

test('cancel: swallows 404 when workflow already gone', async () => {
  const client = getEvaluationWorkflowClient();
  (client as any).client.post = async (url: string) => {
    httpCalls.push({ method: 'POST', url });
    const err: any = new Error('not found');
    err.response = { status: 404 };
    throw err;
  };
  await client.cancel('wf-missing');
  assert.match(httpCalls[0].url, /\/cancel$/);
});

test('signal: posts payload and swallows 404', async () => {
  const client = getEvaluationWorkflowClient();
  await client.signal('wf-1', 'evaluation.cancel', { reason: 'user' });
  assert.equal(httpCalls.length, 1);
  assert.match(httpCalls[0].url, /\/signal\/evaluation\.cancel$/);
  assert.deepEqual((httpCalls[0].body as any).payload, { reason: 'user' });
});

test('reconcileSchedule and tearDownSchedule are placeholders', async () => {
  const client = getEvaluationWorkflowClient();
  const schedule = await client.reconcileSchedule({ templateId: 'evt-1' } as any);
  assert.equal(schedule.temporalScheduleId, undefined);
  await client.tearDownSchedule({ templateId: 'evt-1' } as any);
});

test('startEvaluationRun: propagates workflow-engine errors', async () => {
  const client = getEvaluationWorkflowClient();
  (client as any).client.post = async () => {
    const err: any = new Error('engine down');
    err.response = { status: 503, data: { error: 'unavailable' } };
    throw err;
  };
  await assert.rejects(() => client.startEvaluationRun('p1', 't1', 'run-err'), /engine down/);
});

test('cancel: rethrows non-404 failures', async () => {
  const client = getEvaluationWorkflowClient();
  (client as any).client.post = async () => {
    const err: any = new Error('forbidden');
    err.response = { status: 403, data: { error: 'denied' } };
    throw err;
  };
  await assert.rejects(() => client.cancel('wf-1'), /forbidden/);
});

test('signal: swallows 404 and rethrows other errors', async () => {
  const client = getEvaluationWorkflowClient();
  (client as any).client.post = async (url: string) => {
    httpCalls.push({ method: 'POST', url });
    const err: any = new Error('gone');
    err.response = { status: 404 };
    throw err;
  };
  await client.signal('wf-gone', 'evaluation.cancel');
  assert.equal(httpCalls.length, 1);

  (client as any).client.post = async () => {
    const err: any = new Error('timeout');
    err.response = { status: 504 };
    throw err;
  };
  await assert.rejects(() => client.signal('wf-1', 'evaluation.cancel'), /timeout/);
});

test('getEvaluationWorkflowClient: uses service account client when available', () => {
  scope.restoreAll();
  scope = restoreScope();
  const fakeSaClient = {
    createAuthenticatedClient: (baseUrl: string) => ({
      post: async () => ({ data: { workflowId: 'sa-wf' } }),
      defaults: { baseURL: baseUrl },
    }),
  };
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => fakeSaClient,
    }),
  );
  clearModule('services/EvaluationWorkflowClient');
  const { getEvaluationWorkflowClient: getClient } = loadFresh<
    typeof import('../services/EvaluationWorkflowClient')
  >('services/EvaluationWorkflowClient');
  const c1 = getClient();
  const c2 = getClient();
  assert.equal(c1, c2);
});
