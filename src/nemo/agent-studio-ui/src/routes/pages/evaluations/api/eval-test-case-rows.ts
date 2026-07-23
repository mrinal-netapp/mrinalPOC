import type { ParsedEvalCase } from './cases-file';
import type { PerCaseArtifact } from './eval.types';

export const EMPTY_VALUE = '—';

export type EvalTestCaseRowMetrics = {
  actual: string;
  meanJudgeScore: string;
  helpfulness: string;
  correctness: string;
  faithfulnessGroundedness: string;
  groundedness: string;
  retrievalPrecision: string;
  retrievalRecall: string;
  exactMatch: string;
  bleu: string;
  rougeL: string;
  tokenF1: string;
  averageLatency: string;
  p95Latency: string;
  p99Latency: string;
  averageTokens: string;
  maximumTokens: string;
  totalTokens: string;
  totalCost: string;
  resultStatus: string;
  hasResult: boolean;
};

export type JoinedEvalTestCase = ParsedEvalCase & EvalTestCaseRowMetrics & {
  artifact?: PerCaseArtifact;
};

function normalizeCaseId(caseId: string | undefined): string {
  return (caseId ?? '').trim().toLowerCase();
}

function valueAsNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,%\s]/g, ''));
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function formatPercent(value: unknown): string {
  const numberValue = valueAsNumber(value);
  if (numberValue === undefined) {
    return EMPTY_VALUE;
  }
  const normalized = numberValue <= 1 ? numberValue * 100 : numberValue;
  return `${Math.round(normalized)}%`;
}

function formatResultValue(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return EMPTY_VALUE;
  }
  if (typeof value === 'number') {
    return formatPercent(value);
  }
  return String(value);
}

function formatDuration(value: unknown): string {
  const numberValue = valueAsNumber(value);
  if (numberValue !== undefined) {
    return `${new Intl.NumberFormat('en-US').format(Math.round(numberValue))} ms`;
  }
  return formatResultValue(value);
}

function formatCount(value: unknown): string {
  const numberValue = valueAsNumber(value);
  if (numberValue !== undefined) {
    return new Intl.NumberFormat('en-US').format(Math.round(numberValue));
  }
  return formatResultValue(value);
}

function metricValue(
  metrics: Record<string, number> | undefined,
  keys: string[],
): unknown {
  if (!metrics) {
    return undefined;
  }
  for (const key of keys) {
    if (metrics[key] !== undefined) {
      return metrics[key];
    }
  }
  return undefined;
}

function judgeScore(artifact: PerCaseArtifact | undefined, rubricId: string): string {
  const rubric = artifact?.judgeRubrics?.find((entry) => entry.rubricId === rubricId);
  if (!rubric || rubric.errored || rubric.score === undefined) {
    return EMPTY_VALUE;
  }
  return formatPercent(rubric.score);
}

function meanJudgeScore(artifact: PerCaseArtifact | undefined): string {
  const scores = (artifact?.judgeRubrics ?? [])
    .filter((entry) => !entry.errored && entry.score !== undefined)
    .map((entry) => valueAsNumber(entry.score))
    .filter((score): score is number => score !== undefined);

  if (scores.length === 0) {
    return EMPTY_VALUE;
  }

  return formatPercent(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function resultStatus(artifact: PerCaseArtifact | undefined): string {
  if (!artifact) {
    return EMPTY_VALUE;
  }
  if (artifact.error) {
    const status = artifact.status ?? 'ERROR';
    return `${status}: ${artifact.error}`;
  }
  return artifact.status || EMPTY_VALUE;
}

export function mapArtifactToRowMetrics(artifact: PerCaseArtifact | undefined): EvalTestCaseRowMetrics {
  const metrics = artifact?.deterministicMetrics;
  const telemetry = artifact?.telemetry;

  return {
    actual: formatResultValue(artifact?.response),
    meanJudgeScore: meanJudgeScore(artifact),
    helpfulness: judgeScore(artifact, 'helpfulness'),
    correctness: judgeScore(artifact, 'correctness'),
    faithfulnessGroundedness: judgeScore(artifact, 'faithfulness_groundedness'),
    groundedness: formatPercent(metricValue(metrics, ['rag.groundedness'])),
    retrievalPrecision: formatPercent(metricValue(metrics, ['rag.context_precision'])),
    retrievalRecall: formatPercent(metricValue(metrics, ['rag.context_recall'])),
    exactMatch: formatPercent(metricValue(metrics, ['correctness.em'])),
    bleu: formatPercent(metricValue(metrics, ['correctness.bleu'])),
    rougeL: formatPercent(metricValue(metrics, ['correctness.rougeL'])),
    tokenF1: formatPercent(metricValue(metrics, ['correctness.tokenF1'])),
    averageLatency: formatDuration(telemetry?.e2eMs ?? metricValue(metrics, ['perf.e2e_ms'])),
    p95Latency: EMPTY_VALUE,
    p99Latency: EMPTY_VALUE,
    averageTokens: EMPTY_VALUE,
    maximumTokens: EMPTY_VALUE,
    totalTokens: formatCount(metricValue(metrics, ['cost.total_tokens'])),
    totalCost: EMPTY_VALUE,
    resultStatus: resultStatus(artifact),
    hasResult: Boolean(artifact),
  };
}

export function joinCasesWithArtifacts(
  cases: ParsedEvalCase[],
  artifacts: PerCaseArtifact[],
): JoinedEvalTestCase[] {
  const artifactById = new Map<string, PerCaseArtifact>();
  for (const artifact of artifacts) {
    artifactById.set(normalizeCaseId(artifact.caseId), artifact);
  }

  const seen = new Set<string>();
  const rows: JoinedEvalTestCase[] = [];

  for (const testCase of cases) {
    const normalizedId = normalizeCaseId(testCase.caseId);
    seen.add(normalizedId);
    const artifact = artifactById.get(normalizedId);
    rows.push({
      ...testCase,
      ...mapArtifactToRowMetrics(artifact),
      artifact,
    });
  }

  for (const artifact of artifacts) {
    const normalizedId = normalizeCaseId(artifact.caseId);
    if (seen.has(normalizedId)) {
      continue;
    }
    rows.push({
      caseId: artifact.caseId,
      query: EMPTY_VALUE,
      expected: EMPTY_VALUE,
      ...mapArtifactToRowMetrics(artifact),
      artifact,
    });
  }

  return rows;
}

export function buildEvalRunStorageKeys(
  pathPrefix: string,
  evalId: string,
  runId: string,
): { casesKey: string; resultsKey: string } {
  const base = `${pathPrefix}/evaluations/${evalId}/runs/${runId}`;
  return {
    casesKey: `${base}/_input/cases.jsonl`,
    resultsKey: `${base}/results.json`,
  };
}

export function parseEvaluationResultsFile(text: string): { perCaseArtifacts: PerCaseArtifact[] } {
  const parsed = JSON.parse(text) as { perCaseArtifacts?: PerCaseArtifact[] };
  return {
    perCaseArtifacts: Array.isArray(parsed.perCaseArtifacts) ? parsed.perCaseArtifacts : [],
  };
}
