/**
 * Evaluation validator + id-generator unit tests (no HTTP / DB).
 *
 * Run: `node --require ts-node/register --test tests/evaluation.unit.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runValidators, validationMessages } from './helpers/validationRunner';
import {
  createEvaluationTemplateValidator,
  updateEvaluationTemplateValidator,
  runOptionsValidator,
} from '../validators/evaluationValidator';
import { EvaluationIdGenerator } from '../services/EvaluationIdGenerator';
import { JUDGE_DIMENSIONS, DETERMINISTIC_METRICS } from '../catalog/evaluationRubricCatalog';

function baseTemplate(overrides: Record<string, unknown> = {}) {
  return {
    evalName: 'RAG Validation',
    description: 'Golden-set regression',
    labels: ['staging', 'production'],
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

// ── ID generator ──

test('EvaluationIdGenerator produces valid template ids', () => {
  const t = EvaluationIdGenerator.template();
  assert.match(t, /^evt-[a-z0-9]{8}$/);
  assert.equal(EvaluationIdGenerator.validateTemplate(t), true);
  assert.equal(EvaluationIdGenerator.validateTemplate('evc-abcd1234'), false);
});

// ── Create template validator ──

test('create template: valid body passes', async () => {
  const result = await runValidators(createEvaluationTemplateValidator, { body: baseTemplate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: server-managed audit fields are rejected with clear messages', async () => {
  const result = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({
      owner: 'spoofed-owner',
      createdBy: 'spoofed-creator',
      lastModifiedBy: 'spoofed-editor',
    }),
  });

  const messages = validationMessages(result);
  assert.equal(result.isEmpty(), false);
  assert.match(messages, /owner is server-managed/);
  assert.match(messages, /createdBy is server-managed/);
  assert.match(messages, /lastModifiedBy is server-managed/);
});

test('create template: invalid evalName characters fail', async () => {
  const result = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({ evalName: 'eval@#!$' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /letters, numbers, spaces, hyphens, and underscores/);
});

test('create template: missing evalName fails', async () => {
  const body = baseTemplate();
  delete (body as any).evalName;
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: missing agentId and agentTeam fails', async () => {
  const body = baseTemplate({ agent: { agentVersion: 'v1' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /agent must include either agentId or agentTeam/);
});

test('create template: team-only agent binding passes', async () => {
  const body = baseTemplate({ agent: { agentTeam: 'team-1' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: empty agent object fails', async () => {
  const body = baseTemplate({ agent: {} });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /agent must include either agentId or agentTeam/);
});

test('create template: whitespace-only agentId fails', async () => {
  const body = baseTemplate({ agent: { agentId: '   ' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: non-object agent does not run binding validator', async () => {
  const body = baseTemplate({ agent: 'not-an-object' as unknown as Record<string, string> });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  const messages = validationMessages(result);
  assert.doesNotMatch(messages, /agent must include either agentId or agentTeam/);
});

test('create template: missing agent.agentVersion passes (optional placeholder)', async () => {
  // agentVersion is intentionally unenforced — the Agent entity has no
  // version column today, so a mandatory string would force callers to
  // fabricate a meaningless placeholder. See @deprecated note on
  // EvaluationAgentBinding.agentVersion.
  const body = baseTemplate({ agent: { agentId: 'agt-abc12345' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: AI-judge strategy requires aiJudge.models', async () => {
  const body = baseTemplate({ evaluators: { strategy: 'both', aiJudge: { dimensions: ['helpfulness'] } } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /models/);
});

test('create template: deterministic strategy does not require a judge', async () => {
  const body = baseTemplate({ evaluators: { strategy: 'deterministic', deterministic: { metrics: ['rag_quality'] } } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: deterministic strategy requires deterministic.metrics', async () => {
  const body = baseTemplate({ evaluators: { strategy: 'deterministic' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /deterministic\.metrics/);
});

test('create template: both strategy requires deterministic.metrics', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'both', aiJudge: { models: ['m'], dimensions: ['helpfulness'] } },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: telemetry metric is rejected', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'deterministic', deterministic: { metrics: ['rag_quality', 'latency'] } },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /not yet available/);
});

test('create template: unknown judge dimension is rejected', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'both', aiJudge: { models: ['m'], dimensions: ['made_up_dimension'] } },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: deterministic metric used as a judge dimension is rejected', async () => {
  // 'tool_use' is a deterministic metric, not a judge dimension.
  const body = baseTemplate({
    evaluators: { strategy: 'both', aiJudge: { models: ['m'], dimensions: ['tool_use'] } },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('rubric catalog: 9 judge dimensions, telemetry metrics disabled', () => {
  assert.equal(JUDGE_DIMENSIONS.length, 9);
  const disabled = DETERMINISTIC_METRICS.filter((m) => !m.enabled).map((m) => m.key).sort();
  assert.deepEqual(disabled, ['cost', 'latency', 'token_usage']);
});

test('create template: too many labels fail', async () => {
  const body = baseTemplate({ labels: Array.from({ length: 33 }, (_, i) => `l${i}`) });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: invalid schedule (weekly without days) fails', async () => {
  const body = baseTemplate({ schedule: { enabled: true, scheduleType: 'weekly', hourUtc: 10, minuteUtc: 0 } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: valid daily schedule passes', async () => {
  const body = baseTemplate({ schedule: { enabled: true, scheduleType: 'daily', hourUtc: 10, minuteUtc: 15, timezone: 'UTC' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: schedule hourUtc/minuteUtc and monthly branches', async () => {
  const badHour = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({ schedule: { enabled: true, scheduleType: 'daily', hourUtc: 25, minuteUtc: 0 } }),
  });
  assert.equal(badHour.isEmpty(), false);

  const badMinute = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({ schedule: { enabled: true, scheduleType: 'daily', hourUtc: 1, minuteUtc: 99 } }),
  });
  assert.equal(badMinute.isEmpty(), false);

  const badWeeklyDow = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({
      schedule: { enabled: true, scheduleType: 'weekly', hourUtc: 9, minuteUtc: 0, daysOfWeek: [9] },
    }),
  });
  assert.equal(badWeeklyDow.isEmpty(), false);

  const badMonthly = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({
      schedule: { enabled: true, scheduleType: 'monthly', hourUtc: 9, minuteUtc: 0, dayOfMonth: 40 },
    }),
  });
  assert.equal(badMonthly.isEmpty(), false);

  const disabled = await runValidators(createEvaluationTemplateValidator, {
    body: baseTemplate({ schedule: { enabled: false, scheduleType: 'weekly' } }),
  });
  assert.equal(disabled.isEmpty(), true, validationMessages(disabled));
});

test('create template: golden gate compatibility rejects golden-only metrics when goldenAvailable=false', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'deterministic', deterministic: { metrics: ['rag_quality'] }, goldenAvailable: false },
    thresholds: { gates: [{ id: 'correctness.em', op: 'gte', value: 0.8 }] },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /goldenAvailable=false/);
});

// ── Update template validator ──

test('update template: empty body passes (all optional)', async () => {
  const result = await runValidators(updateEvaluationTemplateValidator, { body: {} });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('update template: server-managed audit fields are rejected with clear messages', async () => {
  const result = await runValidators(updateEvaluationTemplateValidator, {
    body: {
      owner: 'spoofed-owner',
      createdBy: 'spoofed-creator',
      lastModifiedBy: 'spoofed-editor',
    },
  });

  const messages = validationMessages(result);
  assert.equal(result.isEmpty(), false);
  assert.match(messages, /owner is server-managed/);
  assert.match(messages, /createdBy is server-managed/);
  assert.match(messages, /lastModifiedBy is server-managed/);
});

test('update template: cron schedule requires cron string', async () => {
  const result = await runValidators(updateEvaluationTemplateValidator, {
    body: { schedule: { enabled: true, scheduleType: 'cron' } },
  });
  assert.equal(result.isEmpty(), false);
});

// ── Run options validator ──

test('run options: empty body passes', async () => {
  const result = await runValidators(runOptionsValidator, { body: {} });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('run options: bad concurrency fails', async () => {
  const result = await runValidators(runOptionsValidator, { body: { overrides: { concurrency: 0 } } });
  assert.equal(result.isEmpty(), false);
});

test('run options: non-UUID runId fails', async () => {
  const result = await runValidators(runOptionsValidator, { body: { runId: 'not-a-uuid' } });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /UUID/);
});

test('run options: UUID runId passes', async () => {
  const result = await runValidators(runOptionsValidator, {
    body: { runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: llm_judge-only strategy passes', async () => {
  const body = baseTemplate({
    evaluators: {
      strategy: 'llm_judge',
      aiJudge: { models: ['m-judge'], dimensions: ['helpfulness'] },
    },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: invalid evaluator strategy fails', async () => {
  const body = baseTemplate({ evaluators: { strategy: 'magic' } });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /strategy must be one of/);
});

test('create template: evaluators must be an object', async () => {
  const body = baseTemplate({ evaluators: 'bad' as unknown as Record<string, string> });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /evaluators must be an object/);
});

test('create template: unknown deterministic metric fails', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'deterministic', deterministic: { metrics: ['made_up_metric'] } },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  assert.match(validationMessages(result), /unknown metric/);
});

test('create template: invalid label entry fails', async () => {
  const body = baseTemplate({ labels: [''] });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
});

test('create template: valid weekly schedule passes', async () => {
  const body = baseTemplate({
    schedule: { enabled: true, scheduleType: 'weekly', hourUtc: 9, minuteUtc: 30, daysOfWeek: [1, 3] },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: valid cron schedule passes', async () => {
  const body = baseTemplate({
    schedule: { enabled: true, scheduleType: 'cron', cron: '0 2 * * *' },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('create template: golden gate lists all offending metrics', async () => {
  const body = baseTemplate({
    evaluators: { strategy: 'deterministic', deterministic: { metrics: ['rag_quality'] }, goldenAvailable: false },
    thresholds: {
      gates: [
        { id: 'correctness.em', op: 'gte', value: 0.8 },
        { id: 'rag.context_precision', op: 'gte', value: 0.5 },
      ],
    },
  });
  const result = await runValidators(createEvaluationTemplateValidator, { body });
  assert.equal(result.isEmpty(), false);
  const messages = validationMessages(result);
  assert.match(messages, /correctness\.em/);
  assert.match(messages, /rag\.context_precision/);
});

test('update template: optional evaluators validation applies', async () => {
  const result = await runValidators(updateEvaluationTemplateValidator, {
    body: { evaluators: { strategy: 'deterministic' } },
  });
  assert.equal(result.isEmpty(), false);
});

test('run options: fromRunId and overrides.sampleOverride pass', async () => {
  const result = await runValidators(runOptionsValidator, {
    body: {
      fromRunId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      overrides: { sampleOverride: { limit: 10 } },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
