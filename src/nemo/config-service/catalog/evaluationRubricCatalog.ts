/**
 * Static catalog of evaluation criteria, served read-only to the GUI so the
 * "Configure AI judge" and "Configure deterministic metrics" dialogs can
 * render their tables (label + description + enabled flag + output).
 *
 * This is the single source of truth for the valid criteria keys; the
 * validator imports the key sets from here so they cannot drift.
 */

export type JudgeDimensionKey =
  | 'helpfulness'
  | 'correctness'
  | 'completeness'
  | 'coherence'
  | 'following_instructions'
  | 'professional_style_tone'
  | 'faithfulness_groundedness'
  | 'safety_harmlessness'
  | 'refusal_quality';

export type DeterministicMetricKey =
  | 'rag_quality'
  | 'correctness'
  | 'tool_use'
  | 'safety'
  | 'structural_compliance'
  | 'latency'
  | 'token_usage'
  | 'cost'
  | 'confusion_matrix';

export interface JudgeDimensionDef {
  key: JudgeDimensionKey;
  label: string;
  description: string;
  /** What the judge emits for this dimension. */
  output: string;
}

export interface DeterministicMetricDef {
  key: DeterministicMetricKey;
  label: string;
  description: string;
  /** Telemetry-backed metrics are disabled until a telemetry source exists. */
  enabled: boolean;
}

/** AI-judge dimensions (UI "Configure AI judge" dialog). Each emits a score + rationale. */
export const JUDGE_DIMENSIONS: readonly JudgeDimensionDef[] = [
  { key: 'helpfulness', label: 'Helpfulness', description: "How useful the response is to the user's goal.", output: 'Score, rationale' },
  { key: 'correctness', label: 'Correctness', description: 'Factual and logical accuracy relative to the task and any reference.', output: 'Score, rationale' },
  { key: 'completeness', label: 'Completeness', description: 'Whether the response fully addresses all parts of the query.', output: 'Score, rationale' },
  { key: 'coherence', label: 'Coherence', description: 'Structure, clarity, and readability.', output: 'Score, rationale' },
  { key: 'following_instructions', label: 'Following instructions', description: 'Adherence to system/developer/user constraints.', output: 'Score, rationale' },
  { key: 'professional_style_tone', label: 'Professional style and tone', description: 'Appropriate register for the audience and brand.', output: 'Score, rationale' },
  { key: 'faithfulness_groundedness', label: 'Faithfulness and groundedness', description: 'Claims must be supported by provided context; penalize hallucination.', output: 'Score, rationale' },
  { key: 'safety_harmlessness', label: 'Safety and harmlessness', description: 'Avoid harmful, abusive, or policy-violating content.', output: 'Score, rationale' },
  { key: 'refusal_quality', label: 'Refusal quality', description: 'Refuse when appropriate; avoid false refusals on benign tasks.', output: 'Score, rationale' },
];

/** Deterministic metrics (UI "Configure deterministic metrics" dialog). */
export const DETERMINISTIC_METRICS: readonly DeterministicMetricDef[] = [
  { key: 'rag_quality', label: 'RAG quality', description: 'Precision, recall, and groundedness of retrieved evidence vs answer.', enabled: true },
  { key: 'correctness', label: 'Correctness', description: 'Task-appropriate match to expected answers or rubric-aligned labels.', enabled: true },
  { key: 'tool_use', label: 'Tool use', description: 'Selection, arguments, and multi-step planning against allowed tools.', enabled: true },
  { key: 'safety', label: 'Safety', description: 'Unsafe completions, policy violations, and false refusal patterns.', enabled: true },
  { key: 'structural_compliance', label: 'Structural compliance', description: 'JSON/schema validation and downstream contract compatibility.', enabled: true },
  { key: 'latency', label: 'Latency', description: 'End-to-end and component latency vs budgets.', enabled: false },
  { key: 'token_usage', label: 'Token usage', description: 'Input/output and retrieval overhead drivers.', enabled: false },
  { key: 'cost', label: 'Cost', description: 'Cost per request and per successful outcome vs targets.', enabled: false },
  { key: 'confusion_matrix', label: 'Confusion-matrix metrics', description: 'TP/FP/FN/TN style signals for retrieval, tools, or classifiers when labeled.', enabled: true },
];

export const JUDGE_DIMENSION_KEYS: ReadonlySet<string> = new Set(JUDGE_DIMENSIONS.map((d) => d.key));
export const DETERMINISTIC_METRIC_KEYS: ReadonlySet<string> = new Set(DETERMINISTIC_METRICS.map((m) => m.key));
export const ENABLED_DETERMINISTIC_METRIC_KEYS: ReadonlySet<string> = new Set(
  DETERMINISTIC_METRICS.filter((m) => m.enabled).map((m) => m.key),
);
export const DISABLED_DETERMINISTIC_METRIC_KEYS: ReadonlySet<string> = new Set(
  DETERMINISTIC_METRICS.filter((m) => !m.enabled).map((m) => m.key),
);

/** Full catalog payload returned by GET /api/v1/evaluation/rubric-catalog. */
export function getEvaluationRubricCatalog() {
  return {
    judgeDimensions: JUDGE_DIMENSIONS,
    deterministicMetrics: DETERMINISTIC_METRICS,
    testCaseSources: [
      { key: 'skip', label: 'Skip test cases', description: "Continue without individual test cases. Expected results won't be calculated." },
      { key: 'upload', label: 'Upload test cases', description: 'Select a CSV or JSONL file to add test cases and expected results.' },
      { key: 'generate', label: 'Generate test cases', description: 'Describe a scenario to generate test cases with AI.' },
    ],
  };
}
