// Canonical names, timeouts, and signal/query identifiers for the evaluation
// workflows. Single source of truth so starters, UI polling code, and e2e
// tests all reference the same strings.
//
// A single flat workflow lives in eval-worker —
// `AgentEvaluationWorkflow`. Per-case work is dispatched inline via the
// `runCase` helper (no child workflow). Run modes (A/B, regression,
// sweep, repeats, reshard) are COMPOSITION patterns driven by
// config-service over many AgentEvaluationWorkflow instances.

// ── Task queue + timeouts ───────────────────────────────────────────
/**
 * Temporal task queue for the evaluation worker (workflows + activities).
 * Kept isolated from scan/KB queues so eval bursts don't starve the data
 * pipelines.
 */
export const EVAL_TASK_QUEUE = 'eval-task-queue';
/** Default maximum test cases running concurrently inside a single evaluation.
 *
 *  Each case runs 1 agent invoke + N judge calls (N = selected rubric count,
 *  up to ~11). With C cases in parallel the peak burst on the LLM gateway is
 *  ~C × (1 + N) calls. The previous default of 10 produced ~120-call bursts
 *  that exceeded Bifrost's per-model rate limit on tightly-throttled deployments
 *  (e.g. project-scoped Azure model keys), causing the agent invoke to surface
 *  500s and judges to soft-fail with 429s. 3 keeps the peak burst around 36
 *  while still finishing an 18-case run in a few sequential waves. Per-run
 *  overrides via `EvaluationJobInput.concurrency` still apply. */
export const DEFAULT_EVAL_CONCURRENCY = 3;
/** Default per-activity startToClose timeout for LLM / agent invocations.
 *  Must exceed the HTTP timeout in `invokeAgent` (currently 6m) so the
 *  Temporal layer doesn't pre-empt the in-flight HTTP call. */
export const DEFAULT_LLM_ACTIVITY_TIMEOUT = '7m';
/** Default retry attempts for LLM / agent activities (transient 5xx, rate limits). */
export const DEFAULT_LLM_RETRY_ATTEMPTS = 3;

// ── Workflow names ──────────────────────────────────────────────────
/**
 * The single eval workflow. Run by config-service per variant / config / seed.
 * The `AGENT_` prefix scopes this to the agent-evaluation domain so future
 * evaluation types (dataset, KB, etc.) can ship their own workflow names
 * without collision.
 */
export const AGENT_EVALUATION_WORKFLOW_NAME = 'AgentEvaluationWorkflow';

// ── Signals ─────────────────────────────────────────────────────────
export const EVALUATION_CANCEL_SIGNAL = 'evaluation.cancel';
export const EVALUATION_TRADEOFF_SIGNAL = 'evaluation.tradeoff.record';
export const EVALUATION_OVERRIDE_SIGNAL = 'evaluation.override.accept';

// ── Queries ─────────────────────────────────────────────────────────
export const EVALUATION_PROGRESS_QUERY = 'evaluation.progress';
export const EVALUATION_RESULTS_QUERY = 'evaluation.results';
export const EVALUATION_PREFLIGHT_QUERY = 'evaluation.preflight';

// ── Tuning (still consumed by config-service composition driver) ────
export const DEFAULT_SWEEP_GLOBAL_MAX_CONFIGS = 256;
export const DEFAULT_SWEEP_SINGLE_PHASE_MAX_CONFIGS = 64;
export const DEFAULT_SWEEP_MAX_CONCURRENT = 4;
export const DEFAULT_STOP_GRACE_SECONDS = 120;
