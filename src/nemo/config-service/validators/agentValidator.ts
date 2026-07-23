import { body, ValidationChain } from 'express-validator';
import { Request, Response, NextFunction } from 'express';
import { isUuid } from '../utils/uuid';
import { isValidJsonSchemaString } from './jsonSchemaValidation';

const VALID_AGENT_STATUSES = ['Healthy', 'Unhealthy'] as const;
const VALID_AGENT_DEPLOYMENT_STATUSES = [
  'draft',
  'preview',
  'not_deployed',
  'deploying',
  'deployed',
  'failed',
  'terminating',
  'terminated',
] as const;

const VALID_FUNCTION_CHOICE_BEHAVIORS = ['auto', 'none', 'required', 'any'] as const;

const VALID_RESPONSE_FORMATS = ['text', 'json_object'] as const;

/** Max length of `structuredOutput.outputSchema` (JSON schema string or text guidelines). */
const OUTPUT_SCHEMA_MAX_LENGTH = 5000;

const VALID_MESSAGE_RETENTION_POLICIES = ['sliding_window', 'summarize', 'none'] as const;

const VALID_RAG_SEARCH_MODES = ['semantic', 'hybrid', 'fts'] as const;

const GUARDRAIL_RULE_ARRAYS = ['input_guardrails', 'output_guardrails', 'tool_guardrails'] as const;

const VALID_TERMINATION_TYPES = [
  'maximum_iterations',
  'keyword',
  'timeout',
  'aggregator',
] as const;
const LEAF_TERMINATION_TYPES = ['maximum_iterations', 'keyword', 'timeout'] as const;
const VALID_AGGREGATOR_CONDITIONS = ['any', 'all'] as const;

/**
 * Custom guard for the structured-output card. When `enabled=true`, a
 * `responseFormat` (`"text"` | `"json_object"`) and a non-empty string
 * `outputSchema` are required. `outputSchema` carries either a JSON schema
 * (serialized as a string, for `json_object`) or free-form text guidelines
 * (for `text`). When `responseFormat` is `json_object`, `outputSchema` must
 * parse to a JSON Schema object (boolean schemas and non-object values are
 * rejected). All fields live inside the `structuredOutput`
 * object, so the guard is self-contained.
 */
function assertStructuredOutputShape(cfg: unknown): void {
  if (!cfg || typeof cfg !== 'object') return;
  const c = cfg as Record<string, unknown>;
  if (c.enabled === true) {
    if (!VALID_RESPONSE_FORMATS.includes(c.responseFormat as (typeof VALID_RESPONSE_FORMATS)[number])) {
      throw new Error(
        'structuredOutput.responseFormat is required and must be one of "text" | "json_object" when structuredOutput.enabled=true',
      );
    }
    if (typeof c.outputSchema !== 'string' || c.outputSchema.trim().length === 0) {
      throw new Error(
        'structuredOutput.outputSchema is required (non-empty string) when structuredOutput.enabled=true',
      );
    }
    if (c.outputSchema.length > OUTPUT_SCHEMA_MAX_LENGTH) {
      throw new Error(
        `structuredOutput.outputSchema must be at most ${OUTPUT_SCHEMA_MAX_LENGTH} characters`,
      );
    }
    if (
      c.responseFormat === 'json_object' &&
      !isValidJsonSchemaString(c.outputSchema)
    ) {
      throw new Error(
        'structuredOutput.outputSchema must be a valid JSON Schema object when structuredOutput.responseFormat is "json_object"',
      );
    }
  }
}

/**
 * Validate one lean guardrail rule: `{ guardrail_id, action?, config? }`.
 * `guardrail_id` references `guardrails_catalog.id`; `action` / `config` are
 * optional per-agent overrides. The catalog-aware checks (that the id exists,
 * its stage matches the array, and any `config` override satisfies the
 * definition's `config_schema`) are performed against the catalog in the route
 * layer — this only validates the structural shape.
 */
function assertGuardrailRuleShape(rule: unknown, ctx: string): void {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${ctx} entry must be an object`);
  }
  const r = rule as Record<string, unknown>;
  if (typeof r.guardrail_id !== 'string' || !r.guardrail_id.trim()) {
    throw new Error(`${ctx}.guardrail_id must be a non-empty string`);
  }
  if (!isUuid(r.guardrail_id.trim())) {
    throw new Error(`${ctx}.guardrail_id must be a UUID`);
  }
  if (r.action !== undefined && typeof r.action !== 'string') {
    throw new Error(`${ctx}.action must be a string when provided`);
  }
  if (
    r.config !== undefined &&
    (typeof r.config !== 'object' || r.config === null || Array.isArray(r.config))
  ) {
    throw new Error(`${ctx}.config must be an object when provided`);
  }
}

/**
 * Validate the unified agent guardrails object. Mirrors the runtime
 * `GuardrailSection` shape: optional suite settings (`enabled`, `fail_open`,
 * `log_blocked_requests`) and per-stage rule arrays (`input_guardrails`,
 * `output_guardrails`, `tool_guardrails`) of lean `GuardrailRule`s.
 *
 * `tool_policy` is no longer supported: any payload still carrying that key is
 * rejected so it can't be silently persisted (guardrails are stored wholesale).
 */
function assertAgentGuardrailsShape(cfg: unknown): void {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('guardrails must be an object');
  }
  const c = cfg as Record<string, unknown>;

  for (const flag of ['enabled', 'fail_open', 'log_blocked_requests'] as const) {
    if (c[flag] !== undefined && typeof c[flag] !== 'boolean') {
      throw new Error(`guardrails.${flag} must be a boolean`);
    }
  }

  for (const arr of GUARDRAIL_RULE_ARRAYS) {
    const v = c[arr];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      throw new Error(`guardrails.${arr} must be an array`);
    }
    v.forEach((rule, idx) => assertGuardrailRuleShape(rule, `guardrails.${arr}[${idx}]`));
  }

  if ('tool_policy' in c) {
    throw new Error('guardrails.tool_policy is no longer supported and must be removed');
  }
}

/**
 * Validate one termination strategy node. When `allowAggregator=false` the
 * `aggregator` variant is rejected (used for nested sub_strategies — only one
 * level of nesting is supported).
 */
function assertTerminationNode(node: unknown, ctx: string, allowAggregator: boolean): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`${ctx} must be an object`);
  }
  const n = node as Record<string, unknown>;
  const t = n.type as string | undefined;
  if (typeof t !== 'string' || !VALID_TERMINATION_TYPES.includes(t as (typeof VALID_TERMINATION_TYPES)[number])) {
    throw new Error(
      `${ctx}.type must be one of: ${VALID_TERMINATION_TYPES.join(', ')}`,
    );
  }
  if (!allowAggregator && t === 'aggregator') {
    throw new Error(
      `${ctx}.type cannot be 'aggregator' (nested aggregators are not supported)`,
    );
  }
  if (t !== 'aggregator' && n.sub_strategies !== undefined) {
    throw new Error(`${ctx}.sub_strategies is only allowed when type='aggregator'`);
  }
  if (t !== 'aggregator' && n.condition !== undefined) {
    throw new Error(`${ctx}.condition is only allowed when type='aggregator'`);
  }

  switch (t) {
    case 'maximum_iterations': {
      const max = Number(n.maximum_iterations);
      if (!Number.isInteger(max) || max < 1) {
        throw new Error(`${ctx}.maximum_iterations must be an integer >= 1`);
      }
      break;
    }
    case 'keyword': {
      if (!Array.isArray(n.keywords) || n.keywords.length === 0) {
        throw new Error(`${ctx}.keywords must be a non-empty array of strings`);
      }
      for (const k of n.keywords) {
        if (typeof k !== 'string' || !k) {
          throw new Error(`${ctx}.keywords entries must be non-empty strings`);
        }
      }
      break;
    }
    case 'timeout': {
      const t2 = Number(n.timeout_seconds);
      if (!Number.isInteger(t2) || t2 < 1) {
        throw new Error(`${ctx}.timeout_seconds must be an integer >= 1`);
      }
      break;
    }
    case 'aggregator': {
      const condition = n.condition as string | undefined;
      if (
        typeof condition !== 'string' ||
        !VALID_AGGREGATOR_CONDITIONS.includes(condition as (typeof VALID_AGGREGATOR_CONDITIONS)[number])
      ) {
        throw new Error(
          `${ctx}.condition must be one of: ${VALID_AGGREGATOR_CONDITIONS.join(', ')}`,
        );
      }
      const subs = n.sub_strategies;
      if (!Array.isArray(subs) || subs.length === 0) {
        throw new Error(`${ctx}.sub_strategies must be a non-empty array`);
      }
      subs.forEach((sub, idx) => {
        const subType = (sub as Record<string, unknown> | null | undefined)?.type;
        if (
          typeof subType !== 'string' ||
          !LEAF_TERMINATION_TYPES.includes(subType as (typeof LEAF_TERMINATION_TYPES)[number])
        ) {
          throw new Error(
            `${ctx}.sub_strategies[${idx}].type must be one of: ${LEAF_TERMINATION_TYPES.join(', ')}`,
          );
        }
        assertTerminationNode(sub, `${ctx}.sub_strategies[${idx}]`, false);
      });
      break;
    }
  }
}

/** Top-level termination_strategy guard. */
export function assertTerminationStrategyShape(cfg: unknown): void {
  if (cfg === null || cfg === undefined) return;
  assertTerminationNode(cfg, 'terminationStrategy', true);
}

const REQUIREMENT_LISTS = ['knowledgeBases', 'mcpServers'] as const;
const REQUIREMENT_LABEL_MAX = 120;
const REQUIREMENT_DESCRIPTION_MAX = 1000;

function assertRequirementEntry(entry: unknown, ctx: string): void {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${ctx} entry must be an object`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !isUuid(e.id)) {
    throw new Error(`${ctx}.id must be a UUID`);
  }
  if (typeof e.label !== 'string' || !e.label.trim()) {
    throw new Error(`${ctx}.label must be a non-empty string`);
  }
  // Normalise leading / trailing whitespace before length-checking and
  // mutate in place so the persisted value is the trimmed form (mirrors
  // ``body('name').trim()`` on the top-level agent name).
  e.label = (e.label as string).trim();
  if ((e.label as string).length > REQUIREMENT_LABEL_MAX) {
    throw new Error(`${ctx}.label must be <= ${REQUIREMENT_LABEL_MAX} chars`);
  }
  if (typeof e.description !== 'string') {
    throw new Error(`${ctx}.description must be a string`);
  }
  if (e.description.length > REQUIREMENT_DESCRIPTION_MAX) {
    throw new Error(`${ctx}.description must be <= ${REQUIREMENT_DESCRIPTION_MAX} chars`);
  }
  if (typeof e.required !== 'boolean') {
    throw new Error(`${ctx}.required must be a boolean`);
  }
}

/**
 * Validate the agent `requirements` JSONB. Shape:
 *   { knowledgeBases?: AgentResourceRequirement[], mcpServers?: AgentResourceRequirement[] }
 *
 * `id`s must be unique **within** each list (cross-list collisions are
 * allowed because the UI keys placeholders per-kind). Unknown top-level
 * keys are rejected so a typo doesn't get silently persisted into a
 * JSONB column nothing else reads.
 */
export function assertAgentRequirementsShape(cfg: unknown): void {
  if (cfg === null || cfg === undefined) return;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('requirements must be an object');
  }
  const c = cfg as Record<string, unknown>;

  for (const key of Object.keys(c)) {
    if (!REQUIREMENT_LISTS.includes(key as (typeof REQUIREMENT_LISTS)[number])) {
      throw new Error(
        `requirements.${key} is not a recognised key (allowed: ${REQUIREMENT_LISTS.join(', ')})`,
      );
    }
  }

  for (const list of REQUIREMENT_LISTS) {
    const v = c[list];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) {
      throw new Error(`requirements.${list} must be an array`);
    }
    const seenIds = new Set<string>();
    v.forEach((entry, idx) => {
      assertRequirementEntry(entry, `requirements.${list}[${idx}]`);
      const id = (entry as { id: string }).id;
      if (seenIds.has(id)) {
        throw new Error(`requirements.${list}: duplicate id "${id}"`);
      }
      seenIds.add(id);
    });
  }
}

/**
 * Common ModelParams leaf rules used by both `fallbackModelParams` (and
 * potentially other callers in the future). The express-validator chain
 * requires a per-path declaration so we expose a helper that builds the
 * leaves under a given path prefix.
 */
function modelParamsLeaves(prefix: string): ValidationChain[] {
  return [
    body(`${prefix}.temperature`).optional().isFloat({ min: 0, max: 2 }),
    body(`${prefix}.top_p`).optional().isFloat({ min: 0, max: 1 }),
    body(`${prefix}.top_k`).optional().isInt({ min: 0, max: 1000 }),
    body(`${prefix}.token_limit`).optional().isInt({ min: 1, max: 100000 }),
  ];
}

export const createAgentValidator: ValidationChain[] = [
  body('name').isString().notEmpty().trim(),
  body('description').optional().isString(),
  body('role').isString().notEmpty().withMessage('role is required'),
  body('systemPrompt').isString().notEmpty().withMessage('systemPrompt is required'),
  body('modelId').optional().isString().notEmpty(),
  body('modelClass').optional().isString().notEmpty(),
  body('temperature').optional().isFloat({ min: 0, max: 2 }),
  body('maxTokens').optional().isInt({ min: 1 }),
  body('mcpServerIds').optional().isArray(),
  body('mcpServerIds.*').optional().isString(),
  body('mcpServerConfig').optional().isObject(),
  body('knowledgeBaseIds').optional().isArray(),
  body('knowledgeBaseIds.*').optional().isString(),
  body('ragConfig').optional().isObject(),
  body('ragConfig.*.topK').isInt({ min: 1, max: 100 }),
  body('ragConfig.*.similarityThreshold').isFloat({ min: 0, max: 1 }),
  body('ragConfig.*.searchMode').isIn(VALID_RAG_SEARCH_MODES as unknown as string[]),
  body('ragConfig.*.rerankingEnabled').optional().isBoolean(),
  body('ragConfig.*.similarityThresholdEnabled').optional().isBoolean(),
  body('requirements').optional().custom((cfg: unknown) => {
    assertAgentRequirementsShape(cfg);
    return true;
  }),
  body('outcomeSchema').optional().isObject(),
  body('outcomeDescription').optional().isString(),
  body('memoryType').optional().isIn(['none', 'conversation', 'sliding_window']),
  body('memoryConfig').optional().isObject(),
  body('memoryConfig.windowSize').optional().isInt({ min: 1 }),
  body('guardrails').optional().custom((cfg: unknown) => {
    assertAgentGuardrailsShape(cfg);
    return true;
  }),
  // ── New configuration cards ────────────────────────────────────────────
  body('goal').optional().isString(),
  body('topP').optional().isFloat({ min: 0, max: 1 }),
  body('topK').optional().isInt({ min: 0, max: 1000 }),
  body('fallbackModelIds').optional().isArray(),
  body('fallbackModelIds.*').optional().isString(),
  body('fallbackModelParams').optional().isObject(),
  ...modelParamsLeaves('fallbackModelParams'),
  body('outputResponse').optional().isObject(),
  body('outputResponse.enabled').optional().isBoolean(),
  body('outputResponse.example_response').optional({ values: 'null' }).isString().isLength({ max: 500 }),
  body('structuredOutput').optional().isObject().custom((cfg) => {
    assertStructuredOutputShape(cfg);
    return true;
  }),
  body('structuredOutput.enabled').optional().isBoolean(),
  body('structuredOutput.responseFormat')
    .optional({ values: 'null' })
    .isIn(VALID_RESPONSE_FORMATS as unknown as string[]),
  body('structuredOutput.outputSchema')
    .optional({ values: 'null' })
    .isString()
    .isLength({ max: OUTPUT_SCHEMA_MAX_LENGTH }),
  body('memoryContext').optional().isObject(),
  body('memoryContext.enabled').optional().isBoolean(),
  // Legacy AgentMemoryContext shape (kept for back-compat; route
  // handler normalizes to the new shape on save).
  body('memoryContext.message_retention_policy')
    .optional()
    .isIn(VALID_MESSAGE_RETENTION_POLICIES as unknown as string[]),
  body('memoryContext.message_history_limit').optional().isInt({ min: 0, max: 200 }),
  body('memoryContext.session_history_limit').optional().isInt({ min: 0, max: 100 }),
  // New unified MemoryContext shape (type-conditional rules enforced
  // server-side in the route handler via `validateMemoryContextShape`).
  body('memoryContext.type')
    .optional()
    .isIn(['none', 'window', 'summary', 'summary_buffer']),
  // 1..200: the UI input already enforces a floor of 1; align the API
  // with that so there's no "0 = unlimited" magic mode that the UI can't
  // produce and never round-trips cleanly through the form.
  body('memoryContext.message_window_limit').optional().isInt({ min: 1, max: 200 }),
  body('memoryContext.message_token_limit').optional().isInt({ min: 0, max: 200_000 }),
  body('memoryContext.summary_token_limit')
    .optional()
    .isInt({ min: 0, max: 50_000 })
    .custom((v: unknown) => {
      // express-validator can hand the value off as a string when the
      // request body went through a permissive parser (e.g. URL-encoded
      // payloads, some middleware preprocessors). Coerce explicitly so
      // strict equality against 0 doesn't fail on "0".
      const n = Number(v);
      return Number.isFinite(n) && (n === 0 || n >= 64);
    })
    .withMessage('summary_token_limit must be 0 (use default) or at least 64'),
  body('memoryContext.summary_refresh_every_turns').optional().isInt({ min: 0, max: 50 }),
  body('memoryContext.summary_model').optional().isString().isLength({ max: 200 }),
  body('memoryContext.adaptive_summarize').optional().isObject(),
  body('memoryContext.adaptive_summarize.overflow_threshold')
    .optional()
    .isFloat({ min: 0, max: 1 }),
  body('memoryContext.budget').optional().isObject(),
  body('memoryContext.budget.tool_round_reservation').optional().isInt({ min: 0, max: 64_000 }),
  body('memoryContext.budget.output_reservation').optional().isInt({ min: 0, max: 64_000 }),
  body('memoryContext.budget.safety_buffer_pct').optional().isFloat({ min: 0, max: 0.5 }),
  body('retries').optional().isObject(),
  body('retries.enabled').optional().isBoolean(),
  body('retries.max_retries').optional().isInt({ min: 0, max: 10 }),
  body('rateLimiting').optional().isObject(),
  body('rateLimiting.enabled').optional().isBoolean(),
  body('rateLimiting.max_requests_per_minute').optional({ values: 'null' }).isInt({ min: 1 }),
  // ── Function-choice behavior ──────────────────────────────────────────
  body('functionChoiceBehavior')
    .optional()
    .isIn(VALID_FUNCTION_CHOICE_BEHAVIORS as unknown as string[]),
  // ── Termination strategy ──────────────────────────────────────────────
  body('terminationStrategy').optional().custom((cfg: unknown) => {
    assertTerminationStrategyShape(cfg);
    return true;
  }),
  // ── Labels ────────────────────────────────────────────────────────────
  body('labels').optional().isArray(),
  body('labels.*').optional().isString(),
  // ── Lifecycle / deployment status ─────────────────────────────────────
  body('status').optional().isIn(VALID_AGENT_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_DEPLOYMENT_STATUSES as unknown as string[]),
];

const optNull = { values: 'null' as const };

function modelParamsLeavesUpdate(prefix: string): ValidationChain[] {
  return [
    body(`${prefix}.temperature`).optional(optNull).isFloat({ min: 0, max: 2 }),
    body(`${prefix}.top_p`).optional(optNull).isFloat({ min: 0, max: 1 }),
    body(`${prefix}.top_k`).optional(optNull).isInt({ min: 0, max: 1000 }),
    body(`${prefix}.token_limit`).optional(optNull).isInt({ min: 1, max: 100000 }),
  ];
}

export const updateAgentValidator: ValidationChain[] = [
  body('name').optional().isString().notEmpty().trim(),
  body('description').optional(optNull).isString(),
  body('role').optional().isString().notEmpty(),
  body('systemPrompt').optional().isString().notEmpty(),
  body('modelId').optional(optNull).isString().notEmpty(),
  body('modelClass').optional(optNull).isString().notEmpty(),
  body('temperature').optional(optNull).isFloat({ min: 0, max: 2 }),
  body('maxTokens').optional(optNull).isInt({ min: 1 }),
  body('mcpServerIds').optional(optNull).isArray(),
  body('mcpServerIds.*').optional().isString(),
  body('mcpServerConfig').optional(optNull).isObject(),
  body('knowledgeBaseIds').optional(optNull).isArray(),
  body('knowledgeBaseIds.*').optional().isString(),
  body('ragConfig').optional(optNull).isObject(),
  body('ragConfig.*.topK').isInt({ min: 1, max: 100 }),
  body('ragConfig.*.similarityThreshold').isFloat({ min: 0, max: 1 }),
  body('ragConfig.*.searchMode').isIn(VALID_RAG_SEARCH_MODES as unknown as string[]),
  body('ragConfig.*.rerankingEnabled').optional(optNull).isBoolean(),
  body('ragConfig.*.similarityThresholdEnabled').optional(optNull).isBoolean(),
  body('requirements').optional(optNull).custom((cfg: unknown) => {
    assertAgentRequirementsShape(cfg);
    return true;
  }),
  body('outcomeSchema').optional(optNull).isObject(),
  body('outcomeDescription').optional(optNull).isString(),
  body('memoryType').optional(optNull).isIn(['none', 'conversation', 'sliding_window']),
  body('memoryConfig').optional(optNull).isObject(),
  body('memoryConfig.windowSize').optional(optNull).isInt({ min: 1 }),
  body('guardrails').optional(optNull).custom((cfg: unknown) => {
    assertAgentGuardrailsShape(cfg);
    return true;
  }),
  // ── New configuration cards ────────────────────────────────────────────
  body('goal').optional(optNull).isString(),
  body('topP').optional(optNull).isFloat({ min: 0, max: 1 }),
  body('topK').optional(optNull).isInt({ min: 0, max: 1000 }),
  body('fallbackModelIds').optional(optNull).isArray(),
  body('fallbackModelIds.*').optional().isString(),
  body('fallbackModelParams').optional(optNull).isObject(),
  ...modelParamsLeavesUpdate('fallbackModelParams'),
  body('outputResponse').optional(optNull).isObject(),
  body('outputResponse.enabled').optional(optNull).isBoolean(),
  body('outputResponse.example_response').optional({ values: 'null' }).isString().isLength({ max: 500 }),
  body('structuredOutput').optional(optNull).isObject().custom((cfg) => {
    assertStructuredOutputShape(cfg);
    return true;
  }),
  body('structuredOutput.enabled').optional(optNull).isBoolean(),
  body('structuredOutput.responseFormat')
    .optional({ values: 'null' })
    .isIn(VALID_RESPONSE_FORMATS as unknown as string[]),
  body('structuredOutput.outputSchema')
    .optional({ values: 'null' })
    .isString()
    .isLength({ max: OUTPUT_SCHEMA_MAX_LENGTH }),
  body('memoryContext').optional(optNull).isObject(),
  body('memoryContext.enabled').optional(optNull).isBoolean(),
  // Legacy AgentMemoryContext shape (kept; normalized at save time).
  body('memoryContext.message_retention_policy')
    .optional(optNull)
    .isIn(VALID_MESSAGE_RETENTION_POLICIES as unknown as string[]),
  body('memoryContext.message_history_limit').optional(optNull).isInt({ min: 0, max: 200 }),
  body('memoryContext.session_history_limit').optional(optNull).isInt({ min: 0, max: 100 }),
  // New unified MemoryContext shape.
  body('memoryContext.type')
    .optional(optNull)
    .isIn(['none', 'window', 'summary', 'summary_buffer']),
  body('memoryContext.message_window_limit').optional(optNull).isInt({ min: 1, max: 200 }),
  body('memoryContext.message_token_limit').optional(optNull).isInt({ min: 0, max: 200_000 }),
  body('memoryContext.summary_token_limit')
    .optional(optNull)
    .isInt({ min: 0, max: 50_000 })
    .custom((v: unknown) => {
      // express-validator can hand the value off as a string when the
      // request body went through a permissive parser (e.g. URL-encoded
      // payloads, some middleware preprocessors). Coerce explicitly so
      // strict equality against 0 doesn't fail on "0".
      const n = Number(v);
      return Number.isFinite(n) && (n === 0 || n >= 64);
    })
    .withMessage('summary_token_limit must be 0 (use default) or at least 64'),
  body('memoryContext.summary_refresh_every_turns').optional(optNull).isInt({ min: 0, max: 50 }),
  body('memoryContext.summary_model').optional(optNull).isString().isLength({ max: 200 }),
  body('memoryContext.adaptive_summarize').optional(optNull).isObject(),
  body('memoryContext.adaptive_summarize.overflow_threshold')
    .optional(optNull)
    .isFloat({ min: 0, max: 1 }),
  body('memoryContext.budget').optional(optNull).isObject(),
  body('memoryContext.budget.tool_round_reservation').optional(optNull).isInt({ min: 0, max: 64_000 }),
  body('memoryContext.budget.output_reservation').optional(optNull).isInt({ min: 0, max: 64_000 }),
  body('memoryContext.budget.safety_buffer_pct').optional(optNull).isFloat({ min: 0, max: 0.5 }),
  body('retries').optional(optNull).isObject(),
  body('retries.enabled').optional(optNull).isBoolean(),
  body('retries.max_retries').optional(optNull).isInt({ min: 0, max: 10 }),
  body('rateLimiting').optional(optNull).isObject(),
  body('rateLimiting.enabled').optional(optNull).isBoolean(),
  body('rateLimiting.max_requests_per_minute').optional({ values: 'null' }).isInt({ min: 1 }),
  // ── Function-choice behavior ──────────────────────────────────────────
  body('functionChoiceBehavior')
    .optional(optNull)
    .isIn(VALID_FUNCTION_CHOICE_BEHAVIORS as unknown as string[]),
  // ── Termination strategy ──────────────────────────────────────────────
  body('terminationStrategy').optional(optNull).custom((cfg: unknown) => {
    assertTerminationStrategyShape(cfg);
    return true;
  }),
  // ── Labels ────────────────────────────────────────────────────────────
  body('labels').optional(optNull).isArray(),
  body('labels.*').optional().isString(),
  // ── Lifecycle / deployment status ─────────────────────────────────────
  body('status').optional().isIn(VALID_AGENT_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_DEPLOYMENT_STATUSES as unknown as string[]),
];

/**
 * Dedicated validator for `PUT /agents/{id}/status`. Every field is
 * optional but at least one must be present; the route handler enforces
 * the "at least one" check after `validationResult` since express-validator
 * doesn't model "anyOf required".
 */
export const updateAgentStatusValidator: ValidationChain[] = [
  body('status').optional().isIn(VALID_AGENT_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_DEPLOYMENT_STATUSES as unknown as string[]),
];

/**
 * Middleware: at least one of modelId or modelClass must be present on create.
 * On update, if one is being cleared (null), the other must remain or be provided.
 */
export function validateAgentModelSelection(mode: 'create' | 'update') {
  return (req: Request, res: Response, next: NextFunction) => {
    const { modelId, modelClass } = req.body;
    if (mode === 'create') {
      if (!modelId && !modelClass) {
        return res.status(400).json({
          error: 'At least one of modelId or modelClass is required',
        });
      }
    } else {
      if (modelId === null && modelClass === null) {
        return res.status(400).json({
          error: 'Cannot clear both modelId and modelClass',
        });
      }
    }
    next();
  };
}
