import { body, Meta, ValidationChain } from 'express-validator';
import {
  JUDGE_DIMENSION_KEYS,
  DETERMINISTIC_METRIC_KEYS,
  DISABLED_DETERMINISTIC_METRIC_KEYS,
} from '../catalog/evaluationRubricCatalog';

const EVAL_NAME_REGEX = /^[a-zA-Z0-9\s\-_]+$/;

const STRATEGIES = ['deterministic', 'llm_judge', 'both'] as const;
const SCHEDULE_TYPES = ['hourly', 'daily', 'weekly', 'monthly', 'cron'] as const;
const RUN_MODES = ['single', 'regression', 'ab_compare', 'tuning_sweep', 'repeats'] as const;
const SCOPES = ['full_agent_execution', 'response_only', 'retrieval_only'] as const;
const SUITES = ['rag', 'safety', 'tool_use', 'custom'] as const;

const optNull = { values: 'null' as const };

const serverManagedFieldRule = (field: string) =>
  body(field).not().exists().withMessage(`${field} is server-managed`);

function validateAgentBinding(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== 'object') {
    throw new Error('agent must be an object');
  }
  const agent = value as Record<string, unknown>;
  const agentId = typeof agent.agentId === 'string' ? agent.agentId.trim() : '';
  const agentTeam = typeof agent.agentTeam === 'string' ? agent.agentTeam.trim() : '';
  if (!agentId && !agentTeam) {
    throw new Error('agent must include either agentId or agentTeam');
  }
  return true;
}

/**
 * Validate the `evaluators` block. AI judging and deterministic metrics are
 * two distinct lists (mirroring the UI's two Configure dialogs):
 *   - aiJudge.dimensions  → keys from JUDGE_DIMENSION_KEYS
 *   - deterministic.metrics → keys from DETERMINISTIC_METRIC_KEYS (telemetry
 *     metrics are rejected until a source exists)
 * The judge model(s) are required when the strategy includes AI judging.
 */
function validateEvaluators(value: any): boolean {
  if (value === undefined || value === null) {
    throw new Error('evaluators is required');
  }
  if (typeof value !== 'object') {
    throw new Error('evaluators must be an object');
  }
  const strategy = value.strategy;
  if (!STRATEGIES.includes(strategy)) {
    throw new Error(`evaluators.strategy must be one of ${STRATEGIES.join(', ')}`);
  }

  const usesJudge = strategy === 'llm_judge' || strategy === 'both';
  const usesDeterministic = strategy === 'deterministic' || strategy === 'both';

  if (usesJudge) {
    const aiJudge = value.aiJudge;
    if (!aiJudge || typeof aiJudge !== 'object') {
      throw new Error('evaluators.aiJudge is required when strategy includes AI judging');
    }
    if (!Array.isArray(aiJudge.models) || aiJudge.models.length === 0) {
      throw new Error('evaluators.aiJudge.models is required when strategy includes AI judging');
    }
    if (!aiJudge.models.every((m: unknown) => typeof m === 'string' && m.trim().length > 0)) {
      throw new Error('evaluators.aiJudge.models must be non-empty strings');
    }
    if (!Array.isArray(aiJudge.dimensions) || aiJudge.dimensions.length === 0) {
      throw new Error('evaluators.aiJudge.dimensions must be a non-empty array');
    }
    for (const key of aiJudge.dimensions) {
      if (typeof key !== 'string' || !JUDGE_DIMENSION_KEYS.has(key)) {
        throw new Error(`evaluators.aiJudge.dimensions contains unknown dimension: ${key}`);
      }
    }
  }

  if (usesDeterministic) {
    const det = value.deterministic;
    if (!det || typeof det !== 'object' || !Array.isArray(det.metrics) || det.metrics.length === 0) {
      throw new Error('evaluators.deterministic.metrics is required and must be a non-empty array when strategy includes deterministic checks');
    }
    for (const key of det.metrics) {
      if (typeof key !== 'string' || !DETERMINISTIC_METRIC_KEYS.has(key)) {
        throw new Error(`evaluators.deterministic.metrics contains unknown metric: ${key}`);
      }
      if (DISABLED_DETERMINISTIC_METRIC_KEYS.has(key)) {
        throw new Error(`metric '${key}' is not yet available`);
      }
    }
  }
  return true;
}

function validateSchedule(value: any): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object') throw new Error('schedule must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('schedule.enabled must be a boolean');
  if (!value.enabled) return true;
  if (!SCHEDULE_TYPES.includes(value.scheduleType)) {
    throw new Error(`schedule.scheduleType must be one of ${SCHEDULE_TYPES.join(', ')}`);
  }
  if (value.scheduleType === 'cron') {
    if (typeof value.cron !== 'string' || value.cron.trim() === '') {
      throw new Error('schedule.cron is required when scheduleType is cron');
    }
  } else {
    if (value.hourUtc !== undefined && (!Number.isInteger(value.hourUtc) || value.hourUtc < 0 || value.hourUtc > 23)) {
      throw new Error('schedule.hourUtc must be an integer 0-23');
    }
    if (value.minuteUtc !== undefined && (!Number.isInteger(value.minuteUtc) || value.minuteUtc < 0 || value.minuteUtc > 59)) {
      throw new Error('schedule.minuteUtc must be an integer 0-59');
    }
    if (value.scheduleType === 'weekly') {
      if (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.length === 0) {
        throw new Error('schedule.daysOfWeek is required for weekly schedules');
      }
      if (!value.daysOfWeek.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
        throw new Error('schedule.daysOfWeek entries must be integers 0-6');
      }
    }
    if (value.scheduleType === 'monthly') {
      if (!Number.isInteger(value.dayOfMonth) || value.dayOfMonth < 1 || value.dayOfMonth > 31) {
        throw new Error('schedule.dayOfMonth must be an integer 1-31 for monthly schedules');
      }
    }
  }
  return true;
}

/**
 * Metric IDs that REQUIRE golden ground-truth fields on the test case
 * (expected_answer, reference_text, must_include, expected_tool_use, etc.).
 * Configuring these as gates on a `goldenAvailable: false` template is a
 * validation error — the scorer has no signal to grade.
 *
 * MUST stay in sync with `METRICS_GOLDEN_DEPENDENT` in the eval-worker's
 * `lib/evaluation/lib/metrics-catalog.ts`. The list is duplicated here
 * because config-service is in a separate package; a contract test in
 * `tests/evaluation.unit.test.ts` should pin the parity.
 */
const GOLDEN_DEPENDENT_METRIC_IDS: ReadonlySet<string> = new Set([
  'correctness.em',
  'correctness.bleu',
  'correctness.rougeL',
  'correctness.tokenF1',
  'rag.context_precision',
  'rag.context_recall',
  'rag.citation_alignment',
  'must_cite.coverage',
  'tool.selection_accuracy',
  'tool.arg_validity',
  'tool.plan_accuracy',
  'safety.unsafe_rate',
  'safety.false_refusal_rate',
  'safety.boundary',
]);

/**
 * Cross-field rule: when `evaluators.goldenAvailable === false`, reject
 * any threshold gate whose id is in {@link GOLDEN_DEPENDENT_METRIC_IDS}.
 * Mirrors the worker's `validateTemplate` check in trigger.ts so the
 * same misconfiguration fails at POST time instead of after the workflow
 * has run for hours.
 */
function validateGoldenGateCompatibility(_v: unknown, meta: Meta): boolean {
  const body = (meta.req as { body?: any })?.body;
  if (!body || typeof body !== 'object') return true;
  if (body.evaluators?.goldenAvailable !== false) return true;
  const gates = body.thresholds?.gates;
  if (!Array.isArray(gates)) return true;
  const offenders: string[] = [];
  for (const g of gates) {
    if (g && typeof g.id === 'string' && GOLDEN_DEPENDENT_METRIC_IDS.has(g.id)) {
      offenders.push(g.id);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `evaluators.goldenAvailable=false is incompatible with gates referencing golden-only metrics: ${offenders.join(', ')}. ` +
        `Either remove these gates or set evaluators.goldenAvailable=true and provide a golden case set.`,
    );
  }
  return true;
}

const labelsRule = (chain: ValidationChain) =>
  chain
    .isArray({ max: 32 })
    .withMessage('labels must be an array of at most 32 items')
    .bail()
    .custom((arr: unknown[]) => {
      for (const l of arr) {
        if (typeof l !== 'string' || l.length < 1 || l.length > 64) {
          throw new Error('each label must be a non-empty string of at most 64 chars');
        }
      }
      return true;
    });

export const createEvaluationTemplateValidator: ValidationChain[] = [
  body('evalName')
    .isString()
    .trim()
    .notEmpty()
    .withMessage('evalName is required')
    .bail()
    .matches(EVAL_NAME_REGEX)
    .withMessage('evalName may only contain letters, numbers, spaces, hyphens, and underscores'),
  body('description').optional(optNull).isString(),
  labelsRule(body('labels').optional()),
  serverManagedFieldRule('owner'),
  serverManagedFieldRule('createdBy'),
  serverManagedFieldRule('lastModifiedBy'),
  body('target').optional().isIn(['agent_version']).withMessage('target must be agent_version'),
  body('agent').isObject().withMessage('agent is required').bail().custom(validateAgentBinding),
  body('agent.agentId').optional().trim().notEmpty(),
  // agent.agentVersion is intentionally optional and unenforced: see the
  // `@deprecated` note on `EvaluationAgentBinding.agentVersion` — the
  // Agent entity has no version column today, so requiring a non-empty
  // string would force every caller to fabricate a placeholder that
  // means nothing. Producers may include it as display metadata.
  body('agent.agentVersion').optional({ values: 'falsy' }).isString(),
  body('agent.agentTeam').optional().trim().notEmpty(),
  body('models').optional().isArray(),
  body('models.*').optional().isString(),
  body('evaluationScope').optional().isIn(SCOPES as unknown as string[]),
  body('suite').optional().isIn(SUITES as unknown as string[]),
  body('evaluators').custom(validateEvaluators),
  body('thresholds').optional().isObject(),
  body('thresholds').custom(validateGoldenGateCompatibility),
  body('cases').optional().isObject(),
  // Test cases are eval-owned (NOT a project Dataset). The JSONL bytes
  // live at `projects/{projectId}/evaluations/{evalId}/testcases/{filename}`
  // and are uploaded via the eval-scoped `PUT /evaluations/{evalId}/testcases`
  // route; the template carries only the storage pointer (filename).
  body('cases.filename').optional().isString().notEmpty(),
  body('schedule').optional(optNull).custom(validateSchedule),
  body('runMode').optional().isIn(RUN_MODES as unknown as string[]),
  body('concurrency').optional().isInt({ min: 1 }),
];

export const updateEvaluationTemplateValidator: ValidationChain[] = [
  body('evalName')
    .optional()
    .isString()
    .trim()
    .notEmpty()
    .withMessage('evalName is required')
    .bail()
    .matches(EVAL_NAME_REGEX)
    .withMessage('evalName may only contain letters, numbers, spaces, hyphens, and underscores'),
  body('description').optional(optNull).isString(),
  labelsRule(body('labels').optional(optNull)),
  serverManagedFieldRule('owner'),
  serverManagedFieldRule('createdBy'),
  serverManagedFieldRule('lastModifiedBy'),
  body('agent').optional().isObject().bail().custom(validateAgentBinding),
  body('agent.agentId').optional().trim().notEmpty(),
  // See create-validator note: agentVersion is unenforced placeholder.
  body('agent.agentVersion').optional({ values: 'falsy' }).isString(),
  body('agent.agentTeam').optional().trim().notEmpty(),
  body('models').optional(optNull).isArray(),
  body('models.*').optional().isString(),
  body('evaluationScope').optional().isIn(SCOPES as unknown as string[]),
  body('suite').optional().isIn(SUITES as unknown as string[]),
  body('evaluators').optional().custom(validateEvaluators),
  body('thresholds').optional(optNull).isObject(),
  body('thresholds').optional(optNull).custom(validateGoldenGateCompatibility),
  body('cases').optional(optNull).isObject(),
  body('cases.filename').optional().isString().notEmpty(),
  body('schedule').optional(optNull).custom(validateSchedule),
  body('runMode').optional().isIn(RUN_MODES as unknown as string[]),
  body('concurrency').optional(optNull).isInt({ min: 1 }),
];

export const runOptionsValidator: ValidationChain[] = [
  body('runId').optional().isUUID().withMessage('runId must be a UUID'),
  body('name').optional().isString().notEmpty().trim(),
  body('actor').optional().isString().notEmpty(),
  body('reason').optional().isString(),
  body('fromRunId').optional().isUUID().withMessage('fromRunId must be a UUID'),
  body('overrides').optional().isObject(),
  body('overrides.concurrency').optional().isInt({ min: 1 }),
  body('overrides.sampleOverride').optional().isObject(),
];
