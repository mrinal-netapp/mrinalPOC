/**
 * Eval form ↔ API mapping layer.
 *
 * Strategy, dimension keys, and metric keys now match the backend exactly
 * (post PR #42 alignment). The main work here is:
 *   - building the nested aiJudge/deterministic evaluators payload
 *   - parsing agentVersionKey ↔ AgentRef
 *   - mapping form state → create/patch request and back
 */

import type {
  AgentRef,
  EvaluationTemplate,
  EvalScoringStrategy,
  EvalTemplateCreateRequest,
  EvalTemplateUpdateRequest,
  EvalTestCaseSource,
  EvalDatasetColumnMapping,
  EvaluatorConfig,
} from './eval.types';

// ---------------------------------------------------------------------------
// Agent binding helpers
// ---------------------------------------------------------------------------

/**
 * The agent record has no version concept; agentVersion is display-only on the
 * template, but the backend requires it non-empty. Send a stable placeholder.
 */
const DEFAULT_AGENT_VERSION = 'latest';

export type EvalTargetKind = 'agent' | 'team';

export type ParsedEvalTargetKey = {
  kind: EvalTargetKind;
  id: string;
  agentVersion: string;
};

/** Encode a single agent or team selection for the eval form dropdown. */
export function encodeEvalTargetKey(kind: EvalTargetKind, id: string): string {
  return `${kind}::${id}`;
}

/**
 * Decode the eval target dropdown value.
 * Supports legacy bare agent ids and optional version suffixes (`agentId::v1`).
 */
export function parseEvalTargetKey(key: string): ParsedEvalTargetKey {
  if (key.startsWith('agent::')) {
    const remainder = key.slice('agent::'.length);
    const versionSep = remainder.indexOf('::');
    if (versionSep === -1) {
      return { kind: 'agent', id: remainder, agentVersion: '' };
    }
    return {
      kind: 'agent',
      id: remainder.slice(0, versionSep),
      agentVersion: remainder.slice(versionSep + 2),
    };
  }
  if (key.startsWith('team::')) {
    return { kind: 'team', id: key.slice('team::'.length), agentVersion: '' };
  }

  const sep = key.indexOf('::');
  if (sep === -1) {
    return { kind: 'agent', id: key, agentVersion: '' };
  }
  return { kind: 'agent', id: key.slice(0, sep), agentVersion: key.slice(sep + 2) };
}

function buildAgentRef(form: EvalFormState): AgentRef {
  const target = parseEvalTargetKey(form.agentVersionKey);
  if (target.kind === 'team') {
    return { agentTeam: target.id };
  }
  return {
    agentId: target.id,
    agentVersion: target.agentVersion || DEFAULT_AGENT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Metric ID mapping  (UI catalog ↔ backend catalog)
//
// Mike's wireframe uses "performance" and "token_usage" as display-friendly
// IDs. The backend catalog uses "latency" for what Mike calls "performance",
// and marks latency/token_usage/cost as disabled (telemetry not yet wired).
// We only send metrics that the backend currently accepts as enabled.
// ---------------------------------------------------------------------------

/** Maps UI metric IDs → backend metric keys. Omit if there is no backend equivalent. */
const UI_METRIC_TO_BACKEND: Record<string, string | null> = {
  rag_quality: 'rag_quality',
  correctness: 'correctness',
  // "performance" = Mike's label for latency; latency is disabled on the backend for now
  performance: null,
  // token_usage exists on the backend but is disabled (no telemetry source yet)
  token_usage: null,
  // Any other keys pass through unchanged
};

/** Backend-accepted enabled metric keys (from the rubric catalog). */
const BACKEND_ENABLED_METRICS = new Set([
  'rag_quality', 'correctness', 'tool_use', 'safety',
  'structural_compliance', 'confusion_matrix',
]);

/**
 * Converts UI metric IDs to backend-valid enabled keys.
 * Drops metrics that don't exist on the backend or are currently disabled.
 */
export function toBackendMetricIds(uiIds: string[]): string[] {
  const result: string[] = [];
  for (const id of uiIds) {
    const mapped = id in UI_METRIC_TO_BACKEND ? UI_METRIC_TO_BACKEND[id] : id;
    if (mapped && BACKEND_ENABLED_METRICS.has(mapped)) {
      result.push(mapped);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Evaluators payload builder
// ---------------------------------------------------------------------------

function buildEvaluators(
  strategy: EvalScoringStrategy,
  judgeModel: string,
  judgeDimensionIds: string[],
  deterministicMetricIds: string[],
): EvaluatorConfig {
  const evaluators: EvaluatorConfig = { strategy };

  if (strategy === 'llm_judge' || strategy === 'both') {
    evaluators.aiJudge = {
      models: judgeModel ? [judgeModel] : [],
      dimensions: judgeDimensionIds,
    };
  }

  if (strategy === 'deterministic' || strategy === 'both') {
    evaluators.deterministic = {
      metrics: toBackendMetricIds(deterministicMetricIds),
    };
  }

  return evaluators;
}

// ---------------------------------------------------------------------------
// EvalFormState
// ---------------------------------------------------------------------------

export type EvalFormState = {
  name: string;
  description: string;
  selectedLabels: string[];
  agentVersionKey: string;
  strategy: EvalScoringStrategy;
  judgeModel: string;
  judgeDimensionIds: string[];
  deterministicMetricIds: string[];
  testCaseSource: EvalTestCaseSource;
  datasetColumnMapping: EvalDatasetColumnMapping;
  uploadedFileName: string;
  scheduleEnabled: boolean;
  /**
   * The PVC filename the form just uploaded to S3 (set by eval-form once
   * ``putObject`` succeeds). Undefined when the operator skipped upload.
   * Lands on ``cases.filename`` in the create/update payload.
   */
  casesFilename?: string;
  /**
   * Test-case schema version derived from the upload's file extension.
   * ``flat_csv_legacy`` for ``.csv`` and ``golden_test_v1`` for ``.jsonl``.
   */
  casesSchemaVersion?: string;
};

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Slugify an eval name into the ``evalId`` segment that lands in S3 keys
 * (``projects/.../evaluations/{evalId}/...``). The implementation must
 * stay byte-stable with config-service's ``slugifyEvalName`` and the
 * eval-worker's ``slugify`` in ``posix-store.ts`` — the worker uses the
 * same slug to read the file back.
 */
export function slugifyEvalName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

/** Map a filename extension onto the eval-worker's parser dispatch key. */
export function casesSchemaVersionFor(filename: string): string {
  return filename.toLowerCase().endsWith('.csv')
    ? 'flat_csv_legacy'
    : 'golden_test_v1';
}

/**
 * Canonicalise the operator-picked filename to a predictable storage name.
 *
 * The eval-worker reads from
 * ``projects/.../evaluations/{evalId}/testcases/{filename}``; collapsing
 * arbitrary uploads to ``cases.csv`` / ``cases.jsonl`` keeps the key
 * stable, prevents one upload from shadowing a previous run's bytes
 * under a different name, and matches the worker's default of
 * ``cases.jsonl`` when ``cases.filename`` is unset.
 */
export function canonicalCasesFilename(filename: string): string {
  return filename.toLowerCase().endsWith('.csv') ? 'cases.csv' : 'cases.jsonl';
}

// ---------------------------------------------------------------------------
// toCreateTemplateRequest
// ---------------------------------------------------------------------------

/** Build the full POST /templates request body from form state. */
export function toCreateTemplateRequest(form: EvalFormState): EvalTemplateCreateRequest {
  return {
    evalName: form.name.trim(),
    labels: form.selectedLabels,
    description: form.description.trim() || undefined,
    target: 'agent_version',
    agent: buildAgentRef(form),
    models: form.judgeModel ? [form.judgeModel] : [],
    evaluationScope: 'full_agent_execution',
    suite: 'rag',
    evaluators: buildEvaluators(
      form.strategy,
      form.judgeModel,
      form.judgeDimensionIds,
      form.deterministicMetricIds,
    ),
    cases: {
      source: form.testCaseSource,
      ...(form.casesFilename ? { filename: form.casesFilename } : {}),
      ...(form.casesSchemaVersion ? { schemaVersion: form.casesSchemaVersion } : {}),
    },
    runMode: 'single',
  };
}

// ---------------------------------------------------------------------------
// toUpdateDelta
// ---------------------------------------------------------------------------

/** Build the PATCH /templates/:id body as a delta vs the original. */
export function toUpdateDelta(
  form: EvalFormState,
  original: EvaluationTemplate,
): EvalTemplateUpdateRequest {
  const delta: EvalTemplateUpdateRequest = {};

  const trimmedDescription = form.description.trim();
  if (trimmedDescription !== (original.description ?? '')) {
    delta.description = trimmedDescription || undefined;
  }

  const sortedNew = [...form.selectedLabels].sort().join(',');
  const sortedOld = [...(original.labels ?? [])].sort().join(',');
  if (sortedNew !== sortedOld) {
    delta.labels = form.selectedLabels;
  }

  // Diff on the selected eval target (single agent vs team). agentVersion is
  // display-only for singles, so compare on id/kind only.
  const target = parseEvalTargetKey(form.agentVersionKey);
  const originalAgentId = original.agent?.agentId ?? '';
  const originalAgentTeam = original.agent?.agentTeam ?? '';
  const targetChanged = target.kind === 'team'
    ? target.id !== originalAgentTeam
    : target.id !== originalAgentId;
  if (target.id && targetChanged) {
    delta.agent = buildAgentRef(form);
  }

  const origAiJudge = original.evaluators?.aiJudge;
  const origDet = original.evaluators?.deterministic;
  const strategyChanged = form.strategy !== original.evaluators?.strategy;
  const judgeModelChanged = form.judgeModel !== (origAiJudge?.models?.[0] ?? '');
  const dimensionsChanged =
    JSON.stringify([...form.judgeDimensionIds].sort()) !==
    JSON.stringify([...(origAiJudge?.dimensions ?? [])].sort());
  const metricsChanged =
    JSON.stringify([...form.deterministicMetricIds].sort()) !==
    JSON.stringify([...(origDet?.metrics ?? [])].sort());

  if (strategyChanged || judgeModelChanged || dimensionsChanged || metricsChanged) {
    delta.evaluators = buildEvaluators(
      form.strategy,
      form.judgeModel,
      form.judgeDimensionIds,
      form.deterministicMetricIds,
    );
  }

  // Test-case pointer + source. Diffed coarsely (any of source/filename/
  // schemaVersion change re-sends the whole ``cases`` block) so the server
  // sees a self-consistent record instead of a half-applied update.
  const origCases = original.cases ?? {};
  const sourceChanged = form.testCaseSource !== (origCases.source ?? 'upload');
  const filenameChanged = (form.casesFilename ?? '') !== (origCases.filename ?? '');
  const schemaVersionChanged =
    !!form.casesSchemaVersion && form.casesSchemaVersion !== origCases.schemaVersion;
  if (sourceChanged || filenameChanged || schemaVersionChanged) {
    delta.cases = {
      source: form.testCaseSource,
      ...(form.casesFilename ? { filename: form.casesFilename } : {}),
      ...(form.casesSchemaVersion ? { schemaVersion: form.casesSchemaVersion } : {}),
    };
  }

  return delta;
}

// ---------------------------------------------------------------------------
// fromTemplate — API → form state for edit pre-fill
// ---------------------------------------------------------------------------

const ALL_DIMENSION_IDS = [
  'helpfulness', 'correctness', 'completeness', 'coherence',
  'following_instructions', 'professional_style_tone', 'faithfulness_groundedness',
  'safety_harmlessness', 'refusal_quality',
];

const ALL_METRIC_IDS = [
  'rag_quality', 'correctness', 'performance', 'token_usage',
];

/** Map an EvaluationTemplate from the API into the EvalForm's initial state. */
export function fromTemplate(template: EvaluationTemplate): Partial<EvalFormState> {
  const agentRef = template.agent;
  const agentVersionKey = agentRef?.agentTeam
    ? encodeEvalTargetKey('team', agentRef.agentTeam)
    : agentRef?.agentId
      ? encodeEvalTargetKey('agent', agentRef.agentId)
      : '';

  const strategy: EvalScoringStrategy = template.evaluators?.strategy ?? 'both';
  const aiJudge = template.evaluators?.aiJudge;
  const deterministic = template.evaluators?.deterministic;

  const judgeDimensionIds = aiJudge?.dimensions?.length
    ? aiJudge.dimensions
    : ALL_DIMENSION_IDS;

  const deterministicMetricIds = deterministic?.metrics?.length
    ? deterministic.metrics
    : ALL_METRIC_IDS;

  const judgeModel = aiJudge?.models?.[0] ?? (template.models?.[0] ?? '');

  const testCaseSource: EvalTestCaseSource = 'upload';

  return {
    name: template.evalName,
    description: template.description ?? '',
    selectedLabels: template.labels ?? [],
    agentVersionKey,
    strategy,
    judgeModel,
    judgeDimensionIds,
    deterministicMetricIds,
    testCaseSource,
    scheduleEnabled: false,
  };
}
