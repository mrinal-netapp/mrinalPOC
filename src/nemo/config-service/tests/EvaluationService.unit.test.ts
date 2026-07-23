/**
 * Unit tests for services/EvaluationService.ts.
 *
 * Run: node --require ts-node/register --test tests/EvaluationService.unit.test.ts
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
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';
const TEMPLATE_ID = 'evt-abc12345';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let workflow: { startEvaluationRun: (...args: any[]) => Promise<{ workflowId: string }> };
let EvaluationService: typeof import('../services/EvaluationService').EvaluationService;
let EvaluationNotFound: typeof import('../services/EvaluationService').EvaluationNotFound;
let EvaluationConflict: typeof import('../services/EvaluationService').EvaluationConflict;

function baseTemplate(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    evalName: 'RAG Validation',
    agent: { agentId: 'agt-abc12345', agentVersion: 'v2' },
    models: ['m-1'],
    evaluators: {
      aiJudge: { dimensions: ['helpfulness'] },
      deterministic: { metrics: ['rag_quality'] },
    },
    updatedAt: new Date('2024-06-01'),
    ...overrides,
  };
}

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  workflow = {
    startEvaluationRun: async () => ({ workflowId: 'evaluation-agent-run-run-1' }),
  };
  scope.add(
    mockModule('services/EvaluationWorkflowClient', {
      getEvaluationWorkflowClient: () => workflow,
    }),
  );
  const mod = loadFresh<typeof import('../services/EvaluationService')>('services/EvaluationService');
  EvaluationService = mod.EvaluationService;
  EvaluationNotFound = mod.EvaluationNotFound;
  EvaluationConflict = mod.EvaluationConflict;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/EvaluationService', 'services/EvaluationWorkflowClient');
  handle.restore();
});

test('estimateImpact: no AI judge yields zero cost', () => {
  const out = EvaluationService.estimateImpact({
    testCaseCount: 10,
    judgeDimensionCount: 3,
    usesAiJudge: false,
  });
  assert.equal(out.estimatedCostUsd, 0);
  assert.ok(out.estimatedDurationMinutes > 0);
  assert.equal(out.assumptions.preflightSec, 60);
});

test('estimateImpact: AI judge adds per-dimension time and cost', () => {
  const out = EvaluationService.estimateImpact({
    testCaseCount: 4,
    judgeDimensionCount: 2,
    usesAiJudge: true,
  });
  assert.equal(out.estimatedCostUsd, 0.02);
  assert.ok(out.estimatedDurationMinutes >= 1);
});

test('generateRunName: embeds template name, version, and timestamp', () => {
  const name = EvaluationService.generateRunName(baseTemplate() as any);
  assert.match(name, /^RAG-Validation-v2-\d{13}$/);
});

test('listTemplates: enriches templates with latest run metadata', async () => {
  const templates = [baseTemplate(), baseTemplate({ templateId: 'evt-other01', evalName: 'Other' })];
  const latestRun = {
    templateId: TEMPLATE_ID,
    status: 'success',
    updatedAt: new Date('2024-06-02'),
    createdAt: new Date('2024-06-02'),
  };
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: templates }),
  });
  let runQbCall = 0;
  handle.repos.EvaluationRun = makeFakeRepo({
    createQueryBuilder: () => {
      runQbCall += 1;
      if (runQbCall === 1) {
        return makeQueryBuilder({ raw: [{ templateId: TEMPLATE_ID, count: '3' }] });
      }
      return makeQueryBuilder({ many: [latestRun] });
    },
  });

  const items = await EvaluationService.listTemplates(PROJECT);
  assert.equal(items.length, 2);
  const first = items.find((i) => i.templateId === TEMPLATE_ID);
  assert.equal(first?.runCount, 3);
  assert.equal(first?.latestRunStatus, 'success');
  assert.deepEqual(first?.lastRunUpdatedAt, latestRun.updatedAt);
});

test('listTemplates: filters by latest run status', async () => {
  const templates = [baseTemplate()];
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: templates }),
  });
  let runQbCall = 0;
  handle.repos.EvaluationRun = makeFakeRepo({
    createQueryBuilder: () => {
      runQbCall += 1;
      if (runQbCall === 1) return makeQueryBuilder({ raw: [] });
      return makeQueryBuilder({
        many: [{ templateId: TEMPLATE_ID, status: 'failed', updatedAt: new Date(), createdAt: new Date() }],
      });
    },
  });

  const items = await EvaluationService.listTemplates(PROJECT, { status: 'success' });
  assert.deepEqual(items, []);
});

test('createRun: persists queued run and stores workflow id', async () => {
  let saved: any = null;
  handle.repos.EvaluationRun = makeFakeRepo({
    create: (data: any) => ({ ...data }),
    save: async (entity: any) => {
      saved = { ...entity, runId: 'run-uuid-1' };
      return saved;
    },
    update: async () => ({ affected: 1 }),
  });

  const run = await EvaluationService.createRun(baseTemplate() as any, {
    actor: 'alice',
    reason: 'manual',
  });
  assert.equal(run.status, 'queued');
  assert.equal(run.workflowId, 'evaluation-agent-run-run-1');
  assert.equal(saved.trigger.actor, 'alice');
});

test('createRun: marks run failed when workflow handoff fails', async () => {
  workflow.startEvaluationRun = async () => {
    throw new Error('workflow-engine down');
  };
  let failedUpdate: any = null;
  handle.repos.EvaluationRun = makeFakeRepo({
    create: (data: any) => ({ ...data }),
    save: async (entity: any) => ({ ...entity, runId: 'run-fail-1', audit: entity.audit }),
    update: async (_where: any, patch: any) => {
      failedUpdate = patch;
      return { affected: 1 };
    },
  });

  await assert.rejects(
    () => EvaluationService.createRun(baseTemplate() as any, { actor: 'bob' }),
    /workflow-engine down/,
  );
  assert.equal(failedUpdate.status, 'failed');
  assert.ok(failedUpdate.audit.some((e: any) => e.type === 'evaluation.failed'));
});

test('setBaseline: promotes successful run and recomputes sibling statuses', async () => {
  const baselineRun = {
    runId: 'run-base',
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    status: 'success',
    results: { qualityPct: 80 },
    baselineStatus: 'not_set',
  };
  const above = {
    runId: 'run-above',
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    status: 'success',
    results: { qualityPct: 90 },
    baselineStatus: 'not_set',
  };
  const below = {
    runId: 'run-below',
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    status: 'success',
    results: { qualityPct: 70 },
    baselineStatus: 'not_set',
  };
  const updates: Array<{ runId: string; baselineStatus: string }> = [];

  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.runId === 'run-base') return { ...baselineRun, baselineStatus: 'current_baseline' };
      return null;
    },
    find: async () => [baselineRun, above, below],
    update: async (where: any, patch: any) => {
      updates.push({ runId: where.runId, baselineStatus: patch.baselineStatus });
      return { affected: 1 };
    },
  });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ templateId: TEMPLATE_ID, projectId: PROJECT }),
    update: async () => ({ affected: 1 }),
  });

  const updated = await EvaluationService.setBaseline(PROJECT, 'run-base');
  assert.equal(updated.runId, 'run-base');
  assert.deepEqual(
    updates.sort((a, b) => a.runId.localeCompare(b.runId)),
    [
      { runId: 'run-above', baselineStatus: 'above_baseline' },
      { runId: 'run-base', baselineStatus: 'current_baseline' },
      { runId: 'run-below', baselineStatus: 'below_baseline' },
    ],
  );
});

test('setBaseline: rejects non-success runs', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async () => ({
      runId: 'run-1',
      projectId: PROJECT,
      status: 'failed',
      templateId: TEMPLATE_ID,
    }),
  });
  await assert.rejects(
    () => EvaluationService.setBaseline(PROJECT, 'run-1'),
    (err: any) => err instanceof EvaluationConflict,
  );
});

test('setBaseline: throws when run missing', async () => {
  handle.repos.EvaluationRun = makeFakeRepo({ findOne: async () => null });
  await assert.rejects(
    () => EvaluationService.setBaseline(PROJECT, 'missing'),
    (err: any) => err instanceof EvaluationNotFound,
  );
});

test('estimateImpact: zero cases with AI judge disabled yields zero cost', () => {
  const out = EvaluationService.estimateImpact({
    testCaseCount: 0,
    judgeDimensionCount: 5,
    usesAiJudge: false,
  });
  assert.equal(out.estimatedCostUsd, 0);
  assert.ok(out.estimatedDurationMinutes >= 1);
});

test('estimateImpact: AI judge ignored when dimension count is zero', () => {
  const out = EvaluationService.estimateImpact({
    testCaseCount: 10,
    judgeDimensionCount: 0,
    usesAiJudge: true,
  });
  assert.equal(out.estimatedCostUsd, 0);
});

test('generateRunName: omits version segment when agentVersion missing', () => {
  const name = EvaluationService.generateRunName(
    baseTemplate({ agent: { agentId: 'agt-abc12345' } }) as any,
  );
  assert.match(name, /^RAG-Validation-\d{13}$/);
  assert.doesNotMatch(name, /-v\d/);
});

test('listTemplates: applies runMode and suite filters', async () => {
  const templates = [baseTemplate(), baseTemplate({ templateId: 'evt-other01', suite: 'safety' })];
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [templates[0]] }),
  });
  handle.repos.EvaluationRun = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ raw: [], many: [] }),
  });
  const items = await EvaluationService.listTemplates(PROJECT, { runMode: 'single', suite: 'rag' });
  assert.equal(items.length, 1);
  assert.equal(items[0].templateId, TEMPLATE_ID);
});

test('listTemplates: returns empty array when project has no templates', async () => {
  handle.repos.EvaluationTemplate = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [] }),
  });
  const items = await EvaluationService.listTemplates(PROJECT);
  assert.deepEqual(items, []);
});

test('createRun: honors custom runId and trimmed name', async () => {
  let saved: any = null;
  handle.repos.EvaluationRun = makeFakeRepo({
    create: (data: any) => ({ ...data }),
    save: async (entity: any) => {
      saved = entity;
      return { ...entity, runId: entity.runId ?? 'generated' };
    },
    update: async () => ({ affected: 1 }),
  });
  const run = await EvaluationService.createRun(baseTemplate() as any, {
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    name: '  Manual Run  ',
    actor: 'carol',
    reason: 'adhoc',
  });
  assert.equal(saved.runId, '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  assert.equal(saved.name, 'Manual Run');
  assert.equal(run.workflowId, 'evaluation-agent-run-run-1');
});

test('createRun: still throws when failed-status update also fails', async () => {
  workflow.startEvaluationRun = async () => {
    throw new Error('workflow-engine down');
  };
  handle.repos.EvaluationRun = makeFakeRepo({
    create: (data: any) => ({ ...data }),
    save: async (entity: any) => ({ ...entity, runId: 'run-fail-2', audit: entity.audit }),
    update: async () => {
      throw new Error('db update failed');
    },
  });
  await assert.rejects(
    () => EvaluationService.createRun(baseTemplate() as any, { actor: 'bob' }),
    /workflow-engine down/,
  );
});

test('setBaseline: marks siblings not_set when qualityPct missing', async () => {
  const baselineRun = {
    runId: 'run-base',
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    status: 'success',
    results: {},
    baselineStatus: 'not_set',
  };
  const sibling = {
    runId: 'run-other',
    templateId: TEMPLATE_ID,
    projectId: PROJECT,
    status: 'success',
    results: { qualityPct: 90 },
    baselineStatus: 'above_baseline',
  };
  const updates: Array<{ runId: string; baselineStatus: string }> = [];
  handle.repos.EvaluationRun = makeFakeRepo({
    findOne: async ({ where }: any) =>
      where.runId === 'run-base' ? { ...baselineRun, baselineStatus: 'current_baseline' } : null,
    find: async () => [baselineRun, sibling],
    update: async (where: any, patch: any) => {
      updates.push({ runId: where.runId, baselineStatus: patch.baselineStatus });
      return { affected: 1 };
    },
  });
  handle.repos.EvaluationTemplate = makeFakeRepo({
    findOne: async () => ({ templateId: TEMPLATE_ID, projectId: PROJECT }),
    update: async () => ({ affected: 1 }),
  });
  await EvaluationService.setBaseline(PROJECT, 'run-base');
  assert.ok(updates.some((u) => u.runId === 'run-other' && u.baselineStatus === 'not_set'));
});
