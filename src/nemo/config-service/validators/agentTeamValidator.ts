import { body, ValidationChain } from 'express-validator';
import { Request, Response, NextFunction } from 'express';
import { assertTerminationStrategyShape } from './agentValidator';

const VALID_AGENT_TEAM_STATUSES = ['Healthy', 'Unhealthy'] as const;
const VALID_AGENT_TEAM_DEPLOYMENT_STATUSES = [
  'draft',
  'preview',
  'not_deployed',
  'deploying',
  'deployed',
  'failed',
  'terminating',
  'terminated',
] as const;

/**
 * Custom guard for the new A2A server card. When `enabled=true` a non-empty
 * `server_url` is required.
 */
function assertA2AServerShape(cfg: unknown): void {
  if (!cfg || typeof cfg !== 'object') return;
  const c = cfg as Record<string, unknown>;
  if (c.enabled === true) {
    if (typeof c.server_url !== 'string' || c.server_url.trim() === '') {
      throw new Error('a2aServer.server_url is required (non-empty string) when a2aServer.enabled=true');
    }
  }
}

/**
 * Custom guard for the manager card. Two valid shapes:
 *   1. `{ agent_id: 'ag-…' }`   — reference an existing agent. Other manager
 *      fields are optional.
 *   2. Inline manager           — on create, `name` + `systemPrompt` required
 *      (model selection enforced by `validateTeamManagerModelSelection`). On
 *      update, identity fields are validated only when explicitly patched.
 *
 * An empty `{}` (neither shape) is rejected on create; allowed on update.
 */
function assertManagerShape(manager: unknown, mode: 'create' | 'update' = 'create'): void {
  if (manager === undefined || manager === null) return;
  if (typeof manager !== 'object' || Array.isArray(manager)) {
    throw new Error('manager must be an object');
  }
  const m = manager as Record<string, unknown>;

  const hasAgentRef = typeof m.agent_id === 'string' && m.agent_id.trim() !== '';
  if (hasAgentRef) {
    // Reference mode — inline fields are optional. Validate only their types
    // when present; the dedicated leaves below cover the type checks.
    return;
  }

  if (mode === 'update') {
    // PATCH semantics: clearing modelId/modelClass or tuning temperature must
    // not force resending the full inline manager card.
    const hasNameKey = Object.prototype.hasOwnProperty.call(m, 'name');
    const hasSystemPromptKey = Object.prototype.hasOwnProperty.call(m, 'systemPrompt');
    if (!hasNameKey && !hasSystemPromptKey) {
      return;
    }
    if (hasNameKey && (typeof m.name !== 'string' || m.name.trim() === '')) {
      throw new Error('manager.name must be a non-empty string when provided');
    }
    if (hasSystemPromptKey && (typeof m.systemPrompt !== 'string' || m.systemPrompt.trim() === '')) {
      throw new Error('manager.systemPrompt must be a non-empty string when provided');
    }
    return;
  }

  if (typeof m.name !== 'string' || m.name.trim() === '') {
    throw new Error('manager.name is required when manager.agent_id is not provided');
  }
  if (typeof m.systemPrompt !== 'string' || m.systemPrompt.trim() === '') {
    throw new Error('manager.systemPrompt is required when manager.agent_id is not provided');
  }
}

export const createAgentTeamValidator: ValidationChain[] = [
  body('name').isString().notEmpty().trim(),
  body('description').optional().isString(),
  body('orchestrationPolicy')
    .optional()
    .isIn(['coordinate', 'route', 'collaborate', 'sequential', 'concurrent'])
    .withMessage('orchestrationPolicy must be coordinate, route, collaborate, sequential, or concurrent'),
  body('manager').optional().isObject().custom((m) => {
    assertManagerShape(m);
    return true;
  }),
  body('manager.agent_id').optional().isString().notEmpty(),
  body('manager.name').optional().isString().notEmpty(),
  body('manager.systemPrompt').optional().isString().notEmpty(),
  body('manager.modelId').optional().isString().notEmpty(),
  body('manager.modelClass').optional().isString().notEmpty(),
  body('manager.temperature').optional().isFloat({ min: 0, max: 2 }),
  body('manager.maxTokens').optional().isInt({ min: 1 }),
  body('members').isArray({ min: 1 }).withMessage('At least one member is required'),
  body('members.*.memberType')
    .isIn(['agent', 'team'])
    .withMessage('Each member must have memberType of agent or team'),
  body('members.*.memberId').isString().notEmpty().withMessage('Each member must have a memberId'),
  body('members.*.role').optional().isString(),
  body('sharedKnowledgeBaseIds').optional().isArray(),
  body('sharedKnowledgeBaseIds.*').optional().isString(),
  body('sharedDatasetIds').optional().isArray(),
  body('sharedDatasetIds.*').optional().isString(),
  // ── A2A external-server card ───────────────────────────────────────────
  body('a2aServer').optional().isObject().custom((cfg) => {
    assertA2AServerShape(cfg);
    return true;
  }),
  body('a2aServer.enabled').optional().isBoolean(),
  body('a2aServer.server_url').optional().isString(),
  // ── Termination strategy ──────────────────────────────────────────────
  body('terminationStrategy').optional().custom((cfg: unknown) => {
    assertTerminationStrategyShape(cfg);
    return true;
  }),
  // ── Labels ────────────────────────────────────────────────────────────
  body('labels').optional().isArray(),
  body('labels.*').optional().isString(),
  // ── Lifecycle / deployment status ─────────────────────────────────────
  body('status').optional().isIn(VALID_AGENT_TEAM_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_TEAM_DEPLOYMENT_STATUSES as unknown as string[]),
  // ── Memory context (new unified schema; type-conditional rules
  //    enforced server-side in the route handler via
  //    `validateMemoryContextShape`. Field-level rules here keep the
  //    surface predictable. Either the new shape (with `type`) OR the
  //    legacy AgentMemoryContext shape (with `message_retention_policy`)
  //    is accepted; the route handler normalizes either to the new shape
  //    before persistence.
  body('memoryContext').optional().isObject(),
  body('memoryContext.enabled').optional().isBoolean(),
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
  // Legacy AgentMemoryContext fields (still accepted on the wire; route
  // handler normalizes them to the new shape before save).
  body('memoryContext.message_retention_policy')
    .optional()
    .isIn(['sliding_window', 'summarize', 'none']),
  body('memoryContext.message_history_limit').optional().isInt({ min: 0, max: 200 }),
  body('memoryContext.session_history_limit').optional().isInt({ min: 0, max: 100 }),
];

const optNull = { values: 'null' as const };

export const updateAgentTeamValidator: ValidationChain[] = [
  body('name').optional().isString().notEmpty().trim(),
  body('description').optional().isString(),
  body('orchestrationPolicy')
    .optional()
    .isIn(['coordinate', 'route', 'collaborate', 'sequential', 'concurrent'])
    .withMessage('orchestrationPolicy must be coordinate, route, collaborate, sequential, or concurrent'),
  body('manager').optional().isObject().custom((m) => {
    assertManagerShape(m, 'update');
    return true;
  }),
  body('manager.agent_id').optional(optNull).isString().notEmpty(),
  body('manager.name').optional().isString().notEmpty(),
  body('manager.systemPrompt').optional().isString().notEmpty(),
  body('manager.modelId').optional(optNull).isString().notEmpty(),
  body('manager.modelClass').optional(optNull).isString().notEmpty(),
  body('manager.temperature').optional().isFloat({ min: 0, max: 2 }),
  body('manager.maxTokens').optional().isInt({ min: 1 }),
  body('members').optional().isArray({ min: 1 }).withMessage('At least one member is required'),
  body('members.*.memberType')
    .optional()
    .isIn(['agent', 'team']),
  body('members.*.memberId').optional().isString().notEmpty(),
  body('members.*.role').optional().isString(),
  body('sharedKnowledgeBaseIds').optional().isArray(),
  body('sharedKnowledgeBaseIds.*').optional().isString(),
  body('sharedDatasetIds').optional().isArray(),
  body('sharedDatasetIds.*').optional().isString(),
  // ── A2A external-server card (update path) ─────────────────────────────
  body('a2aServer').optional(optNull).isObject().custom((cfg) => {
    assertA2AServerShape(cfg);
    return true;
  }),
  body('a2aServer.enabled').optional(optNull).isBoolean(),
  body('a2aServer.server_url').optional(optNull).isString(),
  // ── Termination strategy ──────────────────────────────────────────────
  body('terminationStrategy').optional(optNull).custom((cfg: unknown) => {
    assertTerminationStrategyShape(cfg);
    return true;
  }),
  // ── Labels ────────────────────────────────────────────────────────────
  body('labels').optional(optNull).isArray(),
  body('labels.*').optional().isString(),
  // ── Lifecycle / deployment status ─────────────────────────────────────
  body('status').optional().isIn(VALID_AGENT_TEAM_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_TEAM_DEPLOYMENT_STATUSES as unknown as string[]),
  // ── Memory context (new unified schema; same surface as create).
  //    Both new and legacy AgentMemoryContext shapes are accepted; the
  //    route handler normalizes to new shape before persistence.
  body('memoryContext').optional(optNull).isObject(),
  body('memoryContext.enabled').optional(optNull).isBoolean(),
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
  body('memoryContext.message_retention_policy')
    .optional(optNull)
    .isIn(['sliding_window', 'summarize', 'none']),
  body('memoryContext.message_history_limit').optional(optNull).isInt({ min: 0, max: 200 }),
  body('memoryContext.session_history_limit').optional(optNull).isInt({ min: 0, max: 100 }),
];

/**
 * Dedicated validator for `PUT /agent-teams/{id}/status`. Every field is
 * optional but at least one must be present; the route handler enforces
 * the "at least one" rule.
 */
export const updateAgentTeamStatusValidator: ValidationChain[] = [
  body('status').optional().isIn(VALID_AGENT_TEAM_STATUSES as unknown as string[]),
  body('statusMessage').optional({ values: 'null' }).isString(),
  body('deploymentStatus').optional().isIn(VALID_AGENT_TEAM_DEPLOYMENT_STATUSES as unknown as string[]),
];

/**
 * Middleware: when an inline manager is provided, at least one of
 * `manager.modelId` or `manager.modelClass` must be set. Skipped entirely
 * when `manager.agent_id` is provided (the team resolves the manager from
 * the referenced agent in that mode).
 */
export function validateTeamManagerModelSelection(mode: 'create' | 'update') {
  return (req: Request, res: Response, next: NextFunction) => {
    const manager = req.body.manager;
    if (!manager) return next();

    // Reference mode: the referenced agent supplies the model. Skip the
    // inline model-required check.
    if (typeof manager.agent_id === 'string' && manager.agent_id.trim() !== '') {
      return next();
    }

    if (mode === 'create') {
      if (!manager.modelId && !manager.modelClass) {
        return res.status(400).json({
          error: 'Manager must have at least one of modelId or modelClass (or set manager.agent_id)',
        });
      }
    } else {
      if (manager.modelId === null && manager.modelClass === null) {
        return res.status(400).json({
          error: 'Cannot clear both manager.modelId and manager.modelClass',
        });
      }
    }
    next();
  };
}
