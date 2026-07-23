// Catalog of metric IDs emitted by the eval-worker, partitioned by whether
// they can be computed without a golden ("reference") dataset.
//
// Use this as the single source of truth when:
//   • Validating templates (e.g. rejecting a gate that depends on a
//     metric the run won't produce — see `trigger.ts`).
//   • Surfacing eligible metrics in the configuration UI for templates
//     where the user has flipped `evaluators.goldenAvailable` to `false`.
//   • Cross-checking that a new scorer's emitted IDs land in the right
//     bucket (extend this file when adding scorers).
//
// Lists were derived from the scorer-by-scorer audit of
// `server/apps/eval-worker/src/activities/scoring.activities.ts`. The two
// sets are intentionally disjoint — the `metrics-catalog.test.ts` suite
// enforces that.

/**
 * Metrics the deterministic scoring pipeline can produce *without* any
 * golden ground-truth on the test case. Safe to gate on for no-golden
 * eval templates (`evaluators.goldenAvailable: false`).
 */
export const METRICS_REFERENCE_FREE: readonly string[] = [
  // perf
  'perf.e2e_ms',
  'perf.ttft_ms',
  'perf.sla_e2e_compliance',
  'perf.sla_ttft_compliance',
  // cost
  'cost.per_case_usd',
  'cost.budget_compliance',
  // tools (call success is reference-free; selection/arg/plan accuracy are not)
  'tool.call_success',
  // RAG (groundedness only — context_precision/recall need a reference)
  'rag.groundedness',
  // safety (refusalQuality is reference-free; unsafe_rate / false_refusal_rate
  // depend on `expectedRefusal`).
  'safety.refusalQuality',
  // structured output
  'structured.schema_valid',
  'structured.format',
  'structured.contract',
] as const;

/**
 * Metrics that require golden ground-truth fields on the test case
 * (e.g. `expected_answer`, `reference_text`, `must_include`, expected tool
 * trajectory). Configuring these as gates on a `goldenAvailable: false`
 * template is a validation error — there is no signal for them to grade.
 */
export const METRICS_GOLDEN_DEPENDENT: readonly string[] = [
  // correctness (golden answer / reference text)
  'correctness.em',
  'correctness.bleu',
  'correctness.rougeL',
  'correctness.tokenF1',
  // RAG retrieval comparison (needs labeled relevant chunks)
  'rag.context_precision',
  'rag.context_recall',
  'rag.citation_alignment',
  // citation coverage (needs must_cite)
  'must_cite.coverage',
  // tool trajectory (needs expected_tool_use)
  'tool.selection_accuracy',
  'tool.arg_validity',
  'tool.plan_accuracy',
  // safety (need expected refusal labels)
  'safety.unsafe_rate',
  'safety.false_refusal_rate',
  'safety.boundary',
] as const;

const REFERENCE_FREE_SET: ReadonlySet<string> = new Set(METRICS_REFERENCE_FREE);
const GOLDEN_DEPENDENT_SET: ReadonlySet<string> = new Set(
  METRICS_GOLDEN_DEPENDENT,
);

/**
 * Returns `true` iff the metric ID is in the reference-free catalog. An
 * unknown / uncataloged ID returns `false` — the caller should not assume
 * it's safe for no-golden runs without an explicit entry above.
 */
export function isReferenceFree(metricId: string): boolean {
  return REFERENCE_FREE_SET.has(metricId);
}

/**
 * Returns `true` iff the metric ID is in the golden-dependent catalog.
 * Useful for the trigger-side validation that rejects gates referencing
 * golden-only metrics on no-golden templates.
 */
export function isGoldenDependent(metricId: string): boolean {
  return GOLDEN_DEPENDENT_SET.has(metricId);
}
