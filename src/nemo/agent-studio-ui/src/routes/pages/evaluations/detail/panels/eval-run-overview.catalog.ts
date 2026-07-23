/**
 * Metric catalog for the Run overview panel.
 *
 * Maps domainMetrics keys (case-insensitive) from the backend's flat
 * Record<string, number> into display groups matching Mike's wireframe
 * (AI judge / RAG quality / Correctness / Performance / Token usage).
 *
 * Each MetricDef carries the display unit so values are formatted
 * correctly — latency in ms, token counts as locale integers, not percents.
 *
 * Status icons (green check / orange warning) use a heuristic until the
 * backend provides per-metric thresholds:
 *   percent + higherIsBetter:  ≥ 70 → pass, < 70 → warn
 *   other units:               no icon (threshold unknown)
 */

// `percent` = value already on a 0–100 scale (AI judge dimensions).
// `fraction` = value on a 0–1 scale (RAG / deterministic correctness); rendered
// as a percent after ×100 so 0.85 → "85%".
export type MetricUnit = 'percent' | 'fraction' | 'ms' | 'tokens' | 'currency' | 'raw';
export type MetricGroupId = 'ai-judge' | 'rag-quality' | 'correctness' | 'performance' | 'token-usage';

export type MetricDef = {
  /** Keys to match against domainMetrics (case-insensitive, trimmed). */
  matchKeys: string[];
  label: string;
  group: MetricGroupId;
  unit: MetricUnit;
  tooltip: string;
  /** Whether a higher value is better (false for latency/tokens/cost). */
  higherIsBetter: boolean;
};

export type MetricGroupDef = {
  id: MetricGroupId;
  title: string;
  /** Tabler icon name to render in CardHeader. */
  icon: 'sparkles' | 'file-search' | 'award' | 'clock' | 'chart-bar';
};

export const METRIC_GROUPS: MetricGroupDef[] = [
  { id: 'ai-judge',     title: 'AI judge',      icon: 'sparkles'     },
  { id: 'rag-quality',  title: 'RAG quality',   icon: 'file-search'  },
  { id: 'correctness',  title: 'Correctness',   icon: 'award'        },
  { id: 'performance',  title: 'Performance',   icon: 'clock'        },
  { id: 'token-usage',  title: 'Token usage',   icon: 'chart-bar'    },
];

export const METRIC_CATALOG: MetricDef[] = [
  // ── AI judge dimensions ────────────────────────────────────────
  // Backend emits these under the `judge` dimension as `judge.<name>` keys
  // (0–100 scale). The bare/spaced aliases are kept for mock/legacy sources.
  {
    matchKeys: ['judge.helpfulness', 'helpfulness'],
    label: 'Helpfulness',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: "How useful the response is to the user's goal.",
  },
  {
    matchKeys: ['judge.correctness', 'correctness'],
    label: 'Correctness',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Factual and logical accuracy relative to the task and reference.',
  },
  {
    matchKeys: ['judge.completeness', 'completeness'],
    label: 'Completeness',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Whether the response fully addresses all parts of the query.',
  },
  {
    matchKeys: ['judge.coherence', 'coherence'],
    label: 'Coherence',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Structure, clarity, and readability.',
  },
  {
    matchKeys: [
      'judge.faithfulness_groundedness',
      'faithfulness & groundedness', 'faithfulness and groundedness', 'faithfulness',
    ],
    label: 'Faithfulness and groundedness',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Claims must be supported by provided context; penalises hallucination.',
  },
  {
    matchKeys: [
      'judge.safety_harmlessness',
      'safety', 'safety and harmlessness', 'safety & harmlessness',
    ],
    label: 'Safety and harmlessness',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Avoids harmful, abusive, or policy-violating content.',
  },
  {
    matchKeys: ['judge.following_instructions', 'following instructions'],
    label: 'Following instructions',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'How well the response adheres to the instructions and constraints in the prompt.',
  },
  {
    matchKeys: ['judge.professional_style_tone', 'professional style and tone', 'professional style & tone'],
    label: 'Professional style and tone',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Appropriateness of tone, register, and professionalism for the context.',
  },
  {
    matchKeys: ['judge.refusal_quality', 'refusal quality'],
    label: 'Refusal quality',
    group: 'ai-judge', unit: 'percent', higherIsBetter: true,
    tooltip: 'Whether the response refuses appropriately when it should (and not when it should not).',
  },

  // ── RAG quality ────────────────────────────────────────────────
  // Backend emits these under the `rag` dimension as `rag.<name>` keys on a
  // 0–1 scale (unit `fraction`). Precision/recall keys are best-effort aliases:
  // the current contract only emits `rag.groundedness`; precision/recall render
  // once the backend reports them (confirm exact key names when it does).
  {
    matchKeys: ['rag.groundedness', 'groundedness'],
    label: 'Groundedness',
    group: 'rag-quality', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Answer reflects retrieved context without outside information.',
  },
  {
    matchKeys: ['rag.retrieval_precision', 'rag.precision', 'retrieval precision'],
    label: 'Retrieval precision',
    group: 'rag-quality', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Share of retrieved chunks that are relevant to the question.',
  },
  {
    matchKeys: ['rag.retrieval_recall', 'rag.recall', 'retrieval recall'],
    label: 'Retrieval recall',
    group: 'rag-quality', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Share of relevant evidence retrieved; needs labelled relevance in dataset.',
  },

  // ── Correctness (deterministic) ────────────────────────────────
  // Backend emits these under the `correctness` dimension as `correctness.<name>`
  // keys on a 0–1 scale (unit `fraction`). matchKeys are lower-cased because
  // findDef() compares against the lower-cased incoming key (so `correctness.rougeL`
  // → `correctness.rougel`, `correctness.tokenF1` → `correctness.tokenf1`).
  {
    matchKeys: ['correctness.em', 'exact match'],
    label: 'Exact match',
    group: 'correctness', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Fraction of outputs that exactly match the reference answer.',
  },
  {
    matchKeys: ['correctness.bleu', 'bleu'],
    label: 'BLEU',
    group: 'correctness', unit: 'fraction', higherIsBetter: true,
    tooltip: 'N-gram overlap between the output and reference (higher is closer).',
  },
  {
    matchKeys: ['correctness.rougel', 'rouge-l', 'rougel'],
    label: 'ROUGE-L',
    group: 'correctness', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Longest common subsequence overlap with the reference.',
  },
  {
    matchKeys: ['correctness.tokenf1', 'token f1'],
    label: 'Token F1',
    group: 'correctness', unit: 'fraction', higherIsBetter: true,
    tooltip: 'Token-level precision/recall harmonic mean against the reference.',
  },

  // ── Performance ────────────────────────────────────────────────
  // Backend emits these under the `perf` dimension as `perf.e2e_ms*` keys, in
  // milliseconds (unit `ms`; formatter shows >1000ms as seconds). `perf.e2e_ms`
  // is the mean; `_p95`/`_p99` are the tail percentiles. (`perf.e2e_ms_p50`,
  // the median, is intentionally not surfaced here.)
  {
    matchKeys: ['perf.e2e_ms', 'average latency', 'avg latency'],
    label: 'Average latency',
    group: 'performance', unit: 'ms', higherIsBetter: false,
    tooltip: 'Mean end-to-end response time across completed cases.',
  },
  {
    matchKeys: ['perf.e2e_ms_p95', 'p95 latency (ms)', 'p95 latency'],
    label: 'P95 latency',
    group: 'performance', unit: 'ms', higherIsBetter: false,
    tooltip: 'Latency at the 95th percentile.',
  },
  {
    matchKeys: ['perf.e2e_ms_p99', 'p99 latency (ms)', 'p99 latency'],
    label: 'P99 latency',
    group: 'performance', unit: 'ms', higherIsBetter: false,
    tooltip: 'Latency at the 99th percentile — highlights slow tail cases.',
  },

  // ── Token usage ────────────────────────────────────────────────
  // Backend emits token figures under the `cost` dimension as `cost.total_tokens*`
  // (mean per case), `cost.total_tokens_max` (peak case), `cost.total_tokens_sum`
  // (run total). NOTE: the contract has no currency field, so "Total cost" stays
  // empty until the backend reports a cost value (key names are best-effort).
  {
    matchKeys: ['cost.total_tokens', 'average tokens', 'avg tokens'],
    label: 'Average tokens',
    group: 'token-usage', unit: 'tokens', higherIsBetter: false,
    tooltip: 'Mean input + output tokens per completed case.',
  },
  {
    matchKeys: ['cost.total_tokens_max', 'maximum tokens', 'max tokens'],
    label: 'Maximum tokens',
    group: 'token-usage', unit: 'tokens', higherIsBetter: false,
    tooltip: 'Highest token count seen on a single case.',
  },
  {
    matchKeys: ['cost.total_tokens_sum', 'total tokens'],
    label: 'Total tokens',
    group: 'token-usage', unit: 'tokens', higherIsBetter: false,
    tooltip: 'Total tokens used across completed cases.',
  },
  {
    matchKeys: ['cost.total_cost', 'cost.usd', 'total cost'],
    label: 'Total cost',
    group: 'token-usage', unit: 'currency', higherIsBetter: false,
    tooltip: 'Estimated total spend for this run from token usage and model rates.',
  },
];

// ---------------------------------------------------------------------------
// Key sets for Overview headline row (one metric per group)
// ---------------------------------------------------------------------------

/** Keys (lower-case) that represent the "Mean AI judge score" headline. */
export const MEAN_JUDGE_KEYS = new Set(['mean ai judge', 'mean ai judge score']);

/**
 * Preferred headline key per group (Mike's GROUP_HEADLINE_METRIC_ID).
 * Falls back to first matching metric found in the group.
 */
export const GROUP_HEADLINE_KEYS: Record<MetricGroupId, string[]> = {
  'ai-judge':    ['mean ai judge', 'mean ai judge score'],
  'rag-quality': ['rag.groundedness', 'groundedness'],
  // Correctness has no Overview headline KPI — Token F1 (and the other
  // correctness metrics) live only in the Correctness section.
  'correctness': [],
  'performance': ['perf.e2e_ms_p95', 'p95 latency (ms)', 'p95 latency'],
  'token-usage': ['cost.total_tokens_sum', 'total tokens'],
};

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/** Format a raw numeric value from domainMetrics according to its unit. */
export function formatValue(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return `${Math.round(value)}%`;
    case 'fraction':
      return `${Math.round(value * 100)}%`;
    case 'ms':
      return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
    case 'tokens':
      return value.toLocaleString();
    case 'currency':
      return `$${value.toFixed(2)}`;
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Find a MetricDef for a given domainMetrics key (case-insensitive). */
export function findDef(key: string): MetricDef | undefined {
  const normalized = key.trim().toLowerCase();
  return METRIC_CATALOG.find((def) =>
    def.matchKeys.some((mk) => mk === normalized),
  );
}

export type BucketedMetric = {
  key: string;
  label: string;
  value: number;
  unit: MetricUnit;
  tooltip: string;
  higherIsBetter: boolean;
};

export type BucketResult = {
  groups: Map<MetricGroupId, BucketedMetric[]>;
  /** Keys that didn't match any catalog entry. */
  leftovers: BucketedMetric[];
};

/**
 * Bucket a flat domainMetrics map into named groups.
 * Unrecognised keys are collected in `leftovers`.
 */
export function bucketMetrics(domainMetrics: Record<string, number>): BucketResult {
  const groups = new Map<MetricGroupId, BucketedMetric[]>();
  const leftovers: BucketedMetric[] = [];

  for (const [key, value] of Object.entries(domainMetrics)) {
    const def = findDef(key);
    if (def) {
      const list = groups.get(def.group) ?? [];
      list.push({ key, label: def.label, value, unit: def.unit, tooltip: def.tooltip, higherIsBetter: def.higherIsBetter });
      groups.set(def.group, list);
    } else {
      // Unknown key — raw display, keep nothing hidden
      leftovers.push({ key, label: key, value, unit: 'raw', tooltip: '', higherIsBetter: true });
    }
  }

  return { groups, leftovers };
}

/**
 * All catalog metrics declared for a group, with values resolved from
 * domainMetrics. A metric the backend did not report comes back with value
 * `NaN` (rendered as a placeholder). Use this to display a FIXED set of metrics
 * regardless of what the backend sent — e.g. RAG quality always listing
 * Groundedness / Retrieval precision / Retrieval recall.
 */
export function expectedGroupMetrics(
  groupId: MetricGroupId,
  domainMetrics: Record<string, number>,
): BucketedMetric[] {
  const present = new Map<string, number>();
  for (const [k, v] of Object.entries(domainMetrics)) {
    present.set(k.trim().toLowerCase(), v);
  }
  return METRIC_CATALOG.filter((def) => def.group === groupId).map((def) => {
    let value = Number.NaN;
    for (const mk of def.matchKeys) {
      const hit = present.get(mk);
      if (hit !== undefined) {
        value = hit;
        break;
      }
    }
    return {
      key: def.matchKeys[0],
      label: def.label,
      value,
      unit: def.unit,
      tooltip: def.tooltip,
      higherIsBetter: def.higherIsBetter,
    };
  });
}

// ---------------------------------------------------------------------------
// Heuristic status (until backend provides thresholds)
// ---------------------------------------------------------------------------

export type MetricStatus = 'pass' | 'warn' | 'neutral';

/**
 * Best-effort status for a metric value.
 * Percent metrics with higherIsBetter: ≥ 70 → pass, < 70 → warn.
 * Everything else: neutral (no icon — threshold unknown).
 */
export function metricStatus(value: number, unit: MetricUnit, higherIsBetter: boolean): MetricStatus {
  if (higherIsBetter && unit === 'percent') {
    return value >= 70 ? 'pass' : 'warn';
  }
  if (higherIsBetter && unit === 'fraction') {
    return value >= 0.7 ? 'pass' : 'warn';
  }
  return 'neutral';
}
