/**
 * MemoryContext ↔ legacy memoryType / memoryConfig derivation.
 *
 * config-service stores three columns on agent and agent_teams rows:
 *
 *   - `memoryContext`  (jsonb, new — source of truth going forward)
 *   - `memoryType`     (varchar, legacy — consumed by agent-service)
 *   - `memoryConfig`   (jsonb, legacy — consumed by agent-service)
 *
 * The locked memory-context plan keeps all three populated until
 * agent-service is decommissioned. This module owns the bidirectional
 * mapping:
 *
 *   {@link normalizeMemoryContextInput} — accept either the new
 *     MemoryContext shape OR the legacy AgentMemoryContext shape from
 *     a client and normalize to the new shape.
 *   {@link deriveLegacyFromContext} — given the (normalized) new shape,
 *     compute the matching `memoryType` + `memoryConfig` payload so
 *     agent-service continues to read its expected fields.
 *
 * Both helpers are pure functions with no I/O — safe to use in any
 * route handler before the DB write.
 */

// ---------------------------------------------------------------------------
// Types — kept here so they're decoupled from the AgentTeam / Agent entity
// declarations. Mirror the schema locked in deployments/helm and the runtime
// MemorySection in agent-service-maf.
// ---------------------------------------------------------------------------

/**
 * Public memory strategy. Maps 1:1 to MAF's runtime buffer strategies:
 *
 *   none           → memory disabled, no history sent
 *   window         → sliding window (last K messages or N tokens)
 *   summary        → LLM-summarized history with minimal verbatim tail
 *   summary_buffer → last K verbatim + summary of older
 */
export type MemoryType = 'none' | 'window' | 'summary' | 'summary_buffer';

/** Canonical set of accepted `MemoryType` values. Source of truth for
 * runtime enum validation in {@link normalizeMemoryContextInput}; both
 * the agent and team validators reference the same string list. */
const MEMORY_TYPE_VALUES: ReadonlySet<MemoryType> = new Set([
  'none',
  'window',
  'summary',
  'summary_buffer',
]);

function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === 'string' && MEMORY_TYPE_VALUES.has(v as MemoryType);
}

// ---------------------------------------------------------------------------
// Defaults — applied when MemoryContext fields are absent. Kept here as
// constants so backend derivation, MAF Stage 2 translation, and (later) UI
// hints share one source of truth.
// ---------------------------------------------------------------------------

/** Default last-K messages kept verbatim under `window` and `summary_buffer`. */
export const DEFAULT_MESSAGE_WINDOW_LIMIT = 20;

/** Default max-tokens cap on the generated summary blob. */
export const DEFAULT_SUMMARY_TOKEN_LIMIT = 2000;

/** Default summary refresh cadence (0 = always summarize on overflow). */
export const DEFAULT_SUMMARY_REFRESH_EVERY_TURNS = 0;

export interface MemoryBudget {
  tool_round_reservation?: number;
  output_reservation?: number;
  safety_buffer_pct?: number;
}

export interface AdaptiveSummarizeConfig {
  overflow_threshold: number;
}

/**
 * The new MemoryContext shape persisted under the `memory_context` jsonb
 * column.
 *
 * All fields are optional on the wire — clients can POST the
 * minimum-viable `{ type: 'window' }` and the backend fills in sensible
 * defaults via {@link normalizeMemoryContextInput} (default `enabled =
 * true`, default `type = 'window'` when only `enabled` is provided).
 *
 * Range checks for the optional integer fields live in the express-
 * validator layer (`agentValidator.ts` / `agentTeamValidator.ts`); this
 * interface only pins the wire shape.
 */
export interface MemoryContext {
  enabled: boolean;
  type: MemoryType;
  message_window_limit?: number;
  message_token_limit?: number;
  /**
   * Max-tokens cap on the generated summary blob. `0` is the documented
   * "use server default" sentinel; non-zero values must be at least 64
   * because the MAF SummaryBuffer can't produce a meaningful summary
   * below that — the validator enforces this.
   */
  summary_token_limit?: number;
  /** Cadence between summarization passes. `0` = always summarize on overflow. */
  summary_refresh_every_turns?: number;
  summary_model?: string;
  adaptive_summarize?: AdaptiveSummarizeConfig;
  budget?: MemoryBudget;
}

/** Legacy memoryConfig shape consumed by agent-service. */
export interface LegacyMemoryConfig {
  windowSize?: number;
  contextStrategy?: 'trim' | 'summarize' | 'hybrid' | 'sliding_window_strict' | 'none';
  summaryModel?: string;
  verbatimTurns?: number;
  toolRoundReservation?: number;
  outputReservation?: number;
  safetyBufferPct?: number;
  summaryRefreshEveryTurns?: number;
}

export interface LegacyMemoryFields {
  memoryType: 'none' | 'conversation' | 'sliding_window';
  memoryConfig: LegacyMemoryConfig;
}

// ---------------------------------------------------------------------------
// Normalization — accept old or new shape on the wire, produce new shape
// ---------------------------------------------------------------------------

/**
 * Legacy `AgentMemoryContext` shape kept around for backward-compat. The
 * UI used to write this and existing agent rows may still carry it inside
 * the `memory_context` jsonb column. We normalize on write so going
 * forward the column always holds the unified new shape.
 */
interface LegacyAgentMemoryContext {
  enabled?: boolean;
  message_retention_policy?: 'sliding_window' | 'summarize' | 'none';
  message_history_limit?: number;
  /** Out of scope in the new schema; kept for round-trip safety. */
  session_history_limit?: number;
}

function isLegacyShape(v: Record<string, unknown>): boolean {
  // The legacy shape uses `message_retention_policy` + `message_history_limit`
  // and has NO `type` field. A new-shape payload that includes a VALID
  // `type` enum value wins even when one of the legacy fields is also
  // present. (A garbage `type` string falls through to legacy detection
  // and ultimately to "unrecognised shape" if no legacy fields exist.)
  if (isMemoryType(v.type)) return false;
  const hasPolicy = typeof v.message_retention_policy === 'string';
  const hasLimit = typeof v.message_history_limit === 'number';
  return hasPolicy || hasLimit;
}

function isMemoryContext(v: Record<string, unknown>): boolean {
  // Either field is enough — the schema declares both as optional, so
  // `{ type: 'window' }` and `{ enabled: false }` both qualify. Requiring
  // both would reject documented minimum-viable payloads. The `type`
  // value, when present, MUST be one of the canonical enum members;
  // otherwise we'd silently persist garbage like `{ type: 'foobar' }`.
  if (typeof v.enabled === 'boolean') return true;
  return isMemoryType(v.type);
}

/**
 * Accept either the new MemoryContext or the legacy AgentMemoryContext
 * from a client and return the normalized new shape (or `undefined` when
 * the input is missing / unrecognised).
 *
 * Mapping for legacy input:
 *   `message_retention_policy='none'`            → `type='none'`, `enabled=false`
 *   `message_retention_policy='sliding_window'`  → `type='window'`,
 *                                                  `message_window_limit=message_history_limit`
 *   `message_retention_policy='summarize'`       → `type='summary_buffer'`,
 *                                                  `message_window_limit=message_history_limit`
 *
 * `session_history_limit` is dropped — it's out of scope for the unified
 * schema (deferred).
 */
export function normalizeMemoryContextInput(
  input: unknown,
): MemoryContext | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input !== 'object') return undefined;
  const v = input as Record<string, unknown>;

  // Legacy shape wins when its discriminator fields are present and the
  // payload has no `type`. Checking legacy first prevents the widened
  // `isMemoryContext` (which now accepts `enabled` OR `type`) from
  // gobbling a legacy body that happens to carry `enabled`.
  if (isLegacyShape(v)) {
    const enabled = v.enabled !== false;
    const policy = v.message_retention_policy;
    const limit = typeof v.message_history_limit === 'number' ? v.message_history_limit : undefined;

    if (!enabled || policy === 'none' || limit === 0) {
      return { enabled: false, type: 'none' };
    }
    if (policy === 'summarize') {
      const out: MemoryContext = { enabled: true, type: 'summary_buffer' };
      if (limit !== undefined && limit > 0) out.message_window_limit = limit;
      return out;
    }
    // Default / explicit sliding_window
    const out: MemoryContext = { enabled: true, type: 'window' };
    if (limit !== undefined && limit > 0) out.message_window_limit = limit;
    return out;
  }

  if (isMemoryContext(v)) {
    // Already the new shape — pass through with mild coercion to drop
    // any unknown keys before persistence. Both `enabled` and `type` are
    // optional on the wire; missing `enabled` defaults to `true` (not
    // `false` — a missing field must NOT silently disable memory), and
    // missing `type` defaults to `'window'` when memory is enabled or
    // `'none'` when explicitly disabled.
    const enabled = typeof v.enabled === 'boolean' ? v.enabled : true;
    // Only accept `type` values that belong to the canonical enum. A
    // garbage string makes it through `isMemoryContext` only when
    // `enabled` is also present — defensively drop the bad type and
    // fall back to the default so we never persist
    // `{ type: 'foobar' }` to the jsonb column.
    const rawType = isMemoryType(v.type) ? v.type : undefined;
    const type: MemoryType = rawType ?? (enabled ? 'window' : 'none');
    const out: MemoryContext = { enabled, type };
    if (typeof v.message_window_limit === 'number') out.message_window_limit = v.message_window_limit;
    if (typeof v.message_token_limit === 'number') out.message_token_limit = v.message_token_limit;
    if (typeof v.summary_token_limit === 'number') out.summary_token_limit = v.summary_token_limit;
    if (typeof v.summary_refresh_every_turns === 'number') {
      out.summary_refresh_every_turns = v.summary_refresh_every_turns;
    }
    if (typeof v.summary_model === 'string' && v.summary_model) out.summary_model = v.summary_model;
    if (v.adaptive_summarize && typeof v.adaptive_summarize === 'object') {
      const a = v.adaptive_summarize as unknown as Record<string, unknown>;
      if (typeof a.overflow_threshold === 'number') {
        out.adaptive_summarize = { overflow_threshold: a.overflow_threshold };
      }
    }
    if (v.budget && typeof v.budget === 'object') {
      const b = v.budget as unknown as Record<string, unknown>;
      const budget: MemoryBudget = {};
      if (typeof b.tool_round_reservation === 'number') budget.tool_round_reservation = b.tool_round_reservation;
      if (typeof b.output_reservation === 'number') budget.output_reservation = b.output_reservation;
      if (typeof b.safety_buffer_pct === 'number') budget.safety_buffer_pct = b.safety_buffer_pct;
      if (Object.keys(budget).length > 0) out.budget = budget;
    }
    return out;
  }

  // Unrecognised shape — drop quietly so a malformed payload doesn't
  // corrupt the column. Validators should reject this upstream.
  return undefined;
}

// ---------------------------------------------------------------------------
// Derivation — new MemoryContext → legacy memoryType + memoryConfig
// ---------------------------------------------------------------------------

/**
 * Compute the legacy `memoryType` + `memoryConfig` payload that
 * agent-service still reads, from the unified new-shape `MemoryContext`.
 *
 * Mapping:
 *
 *   type='none'           → memoryType='none', memoryConfig={}
 *   type='window'         → memoryType='sliding_window',
 *                           memoryConfig.windowSize = message_window_limit
 *   type='summary'        → memoryType='conversation',
 *                           memoryConfig.contextStrategy='summarize',
 *                           verbatimTurns=1 (summary mode keeps minimal verbatim)
 *   type='summary_buffer' → memoryType='conversation',
 *                           contextStrategy='hybrid' when adaptive_summarize
 *                             is set, else 'summarize',
 *                           windowSize + verbatimTurns = message_window_limit
 *
 * Budget reservations pass through verbatim under the legacy snake_case
 * → camelCase rename.
 */
export function deriveLegacyFromContext(ctx: MemoryContext): LegacyMemoryFields {
  if (!ctx.enabled || ctx.type === 'none') {
    return { memoryType: 'none', memoryConfig: {} };
  }

  const memoryConfig: LegacyMemoryConfig = {};

  // Budget reservations (always pass through when set, regardless of type)
  if (ctx.budget) {
    if (typeof ctx.budget.tool_round_reservation === 'number') {
      memoryConfig.toolRoundReservation = ctx.budget.tool_round_reservation;
    }
    if (typeof ctx.budget.output_reservation === 'number') {
      memoryConfig.outputReservation = ctx.budget.output_reservation;
    }
    if (typeof ctx.budget.safety_buffer_pct === 'number') {
      memoryConfig.safetyBufferPct = ctx.budget.safety_buffer_pct;
    }
  }

  // Summary-side knobs (only meaningful for summary / summary_buffer).
  // `summary_model` left blank → MAF's _resolve_summary_model fallback chain
  // picks it (manager model → first agent's model → framework default).
  if (ctx.summary_model) memoryConfig.summaryModel = ctx.summary_model;
  memoryConfig.summaryRefreshEveryTurns =
    typeof ctx.summary_refresh_every_turns === 'number'
      ? ctx.summary_refresh_every_turns
      : DEFAULT_SUMMARY_REFRESH_EVERY_TURNS;

  if (ctx.type === 'window') {
    memoryConfig.windowSize =
      typeof ctx.message_window_limit === 'number'
        ? ctx.message_window_limit
        : DEFAULT_MESSAGE_WINDOW_LIMIT;
    return { memoryType: 'sliding_window', memoryConfig };
  }

  if (ctx.type === 'summary') {
    memoryConfig.contextStrategy = 'summarize';
    memoryConfig.verbatimTurns = 1;
    return { memoryType: 'conversation', memoryConfig };
  }

  // type === 'summary_buffer'
  // When adaptive_summarize is present, mirror the legacy 'hybrid' strategy
  // so agent-service's ContextManager keeps the cost optimization. Without
  // it, fall back to plain summarize semantics.
  memoryConfig.contextStrategy = ctx.adaptive_summarize ? 'hybrid' : 'summarize';
  const windowSize =
    typeof ctx.message_window_limit === 'number'
      ? ctx.message_window_limit
      : DEFAULT_MESSAGE_WINDOW_LIMIT;
  memoryConfig.windowSize = windowSize;
  memoryConfig.verbatimTurns = windowSize;
  return { memoryType: 'conversation', memoryConfig };
}

// ---------------------------------------------------------------------------
// Validation helpers (type-conditional)
// ---------------------------------------------------------------------------

/**
 * Verify that a normalized `MemoryContext` is internally consistent.
 *
 * After locking sensible defaults (see {@link DEFAULT_MESSAGE_WINDOW_LIMIT},
 * {@link DEFAULT_SUMMARY_TOKEN_LIMIT}, {@link DEFAULT_SUMMARY_REFRESH_EVERY_TURNS})
 * no field is strictly required per-type — operators can POST the minimum
 * shape `{ enabled: true, type: 'summary' }` and the backend fills in
 * sensible values via {@link deriveLegacyFromContext}.
 *
 * Field-level type/range validation runs at the express-validator layer.
 * This function exists as an extensibility hook for cross-field rules
 * (e.g. "summary_token_limit can't exceed message_token_limit") if/when
 * we add them. Today: returns `null` for any acceptable type.
 */
export function validateMemoryContextShape(ctx: MemoryContext): string | null {
  if (!ctx.enabled || ctx.type === 'none') return null;
  // No required-field enforcement: defaults fill in the gaps. Reserved
  // for future cross-field invariants.
  return null;
}
