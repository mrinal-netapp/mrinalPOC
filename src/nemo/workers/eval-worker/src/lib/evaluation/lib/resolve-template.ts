// Bridge between the external Template/RunOptions shape (the
// over-the-wire contract with config-service / workflow-engine) and the
// internal `EvaluationJobInput` shape consumed by the workflow body and
// activities.
//
// Pure function — no I/O, deterministic. Tested in resolve-template.test.ts.

import type { EvaluationJobInput } from './job-types';
import type { ProvenanceEnvelope } from './provenance';
import type {
  MinimalProvenance,
  ResolvedWorkflowSnapshot,
} from './template-types';

/**
 * Convert the resolved snapshot (loaded from the persisted EvaluationRun
 * row by `loadRunSnapshot`) into the internal `EvaluationJobInput` shape
 * consumed by the workflow body. Pure function — no I/O.
 *
 * Mapping rules:
 *   - Template fields pass through 1:1.
 *   - `runOptions.overrides.concurrency` wins over `template.concurrency`.
 *   - `runOptions.overrides.sampleOverride` wins over `template.cases.sample`.
 *   - Identity-only `MinimalProvenance` is widened into the full
 *     `ProvenanceEnvelope` with empty placeholder hashes for the fields
 *     deferred per §17 of the design spec.
 *
 * Test cases: `template.cases` carries `{ schemaVersion, filename?,
 * sample?, filter? }`. The actual JSONL bytes live on
 * the PVC under `projects/{projectId}/evaluations/{evalId}/testcases/`
 * (no datasetId indirection). The mapping below threads only the
 * storage pointer (filename) and the runtime sampling/filter parameters
 * into the `testCases` block.
 */
export function resolveTemplateRuntime(
  input: ResolvedWorkflowSnapshot,
): EvaluationJobInput {
  const template = input.templateSnapshot;
  const overrides = input.overrides;

  const tmplCases: Partial<NonNullable<typeof template.cases>> =
    template.cases ?? {};
  const sample: EvaluationJobInput['testCases']['sample'] =
    overrides?.sampleOverride !== undefined
      ? {
          mode: overrides.sampleOverride.mode,
          fraction: overrides.sampleOverride.fraction,
        }
      : (tmplCases.sample ?? { mode: 'all' });

  return {
    runId: input.runId,
    evalName: template.evalName,
    projectId: template.projectId,
    target: template.target,
    agentTeam: template.agent.agentTeam,
    agentId: template.agent.agentId,
    evaluationScope: template.evaluationScope,
    suite: template.suite,
    runMode: template.runMode,
    testCases: {
      schemaVersion: tmplCases.schemaVersion ?? 'golden_test_v1',
      ...(tmplCases.filename !== undefined && {
        filename: tmplCases.filename,
      }),
      sample,
      filter: tmplCases.filter,
    },
    models: template.models,
    // Config-service stores the AI-judge config under
    // `evaluators.aiJudge.{dimensions, models, evalMode, samplingMode, ...}`
    // (see config-service EvaluationAiJudgeConfig). Eval-worker's
    // `EvaluationJobInput.evaluators` is the older flat shape with
    // `enabledRubric`, `evaluatorModel`, `judgeEvalMode`, etc. Without
    // the translation below, `enabledRubric` stays empty even when the
    // template has 9 judge dimensions, so `judgeRubricIds = []` and
    // `invokeJudge` is never called — the AI judge silently no-ops.
    evaluators: resolveEvaluators(template.evaluators),
    // `thresholds` is required by the EvaluationJobInput type but the
    // config-service template validator marks it optional. Fall back to
    // a permissive default (no gates, lenient bounds) so computeGates /
    // buildResults don't NPE on a template that didn't declare any.
    thresholds: template.thresholds ?? {
      gates: [],
      coverageMinPct: 0,
      infraFailureMaxPct: 100,
      safetyP0Threshold: 0,
    },
    regression: template.regression
      ? {
          ...(template.regression.baselineRunId && {
            baselineJobId: template.regression.baselineRunId,
          }),
          ...(template.regression.expectations && {
            expectations: template.regression.expectations,
          }),
        }
      : undefined,
    ab: template.ab,
    repeats: template.repeats
      ? { count: template.repeats.count, seeds: template.repeats.seeds }
      : undefined,
    provenance: widenProvenance(input.provenance),
    concurrency: overrides?.concurrency ?? template.concurrency,
  };
}

/**
 * Widen `MinimalProvenance` into the full `ProvenanceEnvelope`. Hash
 * fields are placeholders today — every owning service that provides a
 * stable version identifier (§17 of the design spec) will populate the
 * corresponding field.
 *
 * `envelopeHash` is derived deterministically from the canonical JSON
 * of the surrounding fields. Returning `''` (the old default) made
 * `enforceComparability`'s `a.envelopeHash !== b.envelopeHash` check a
 * no-op because two unrelated variants both compared equal as ''. With
 * a content-derived hash, runs that share inputs hash the same and runs
 * that differ in any populated field (e.g. rubricIds) hash distinctly.
 */
function widenProvenance(p: MinimalProvenance): ProvenanceEnvelope {
  const envelope: Omit<ProvenanceEnvelope, 'envelopeHash'> = {
    agentVersionHash: '',
    datasetVersion: 'snapshot',
    retrievalIndexVersion: '',
    toolRegistryVersion: '',
    generatorModelVersion: '',
    rubricIds: [...p.rubricIds],
    rubricPrompts: [],
  };
  return {
    ...envelope,
    envelopeHash: hashEnvelope(envelope),
  };
}

/**
 * Pure JS FNV-1a 32-bit hash. Workflow-sandbox-safe (no Node built-ins).
 * Fine for "are these envelopes content-identical" comparisons; not a
 * cryptographic hash. Returned as 8-char hex.
 */
function fnv1aHex(s: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply via shift-add (avoids JS double rounding).
    hash =
      (hash +
        ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) |
      0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Bridge between config-service's `EvaluationEvaluators` (which keeps
 * AI-judge config under a nested `aiJudge` object — see
 * `config-service/models/EvaluationTemplate.ts`) and the worker's
 * `EvaluationJobInput.evaluators` flat shape (`enabledRubric`,
 * `evaluatorModel`, `judgeEvalMode`, ...).
 *
 * Mapping rules (only applied when the field on the flat shape is
 * absent, so a template that already conforms to the flat shape is
 * passed through unchanged):
 *
 *   aiJudge.dimensions     → enabledRubric
 *   aiJudge.models[0]      → evaluatorModel
 *   aiJudge.evalMode       → judgeEvalMode
 *   aiJudge.samplingMode   → judgeSamplingMode  (mapped: stratified/fraction → 'sample')
 *   aiJudge.stratifiedSlices → judgeStratifiedSlices
 *   aiJudge.gateWhenSampled → judgeGateWhenSampled
 *                              (config-service: 'informational'|'blocking',
 *                               worker:        'informational'|'gating' — translate 'blocking' → 'gating')
 *   aiJudge.goldenAvailable → goldenAvailable (or top-level fallback)
 */
function resolveEvaluators(
  templateEvaluators: Record<string, unknown>,
): EvaluationJobInput['evaluators'] {
  const e = templateEvaluators as Record<string, unknown>;
  const aiJudge = (e['aiJudge'] ?? {}) as Record<string, unknown>;

  const dimensions = Array.isArray(aiJudge['dimensions'])
    ? (aiJudge['dimensions'] as string[])
    : [];
  const models = Array.isArray(aiJudge['models'])
    ? (aiJudge['models'] as string[])
    : [];

  const samplingModeRaw = aiJudge['samplingMode'] as string | undefined;
  const judgeSamplingMode: 'all' | 'sample' =
    e['judgeSamplingMode'] === 'all' || e['judgeSamplingMode'] === 'sample'
      ? (e['judgeSamplingMode'] as 'all' | 'sample')
      : samplingModeRaw === 'all'
        ? 'all'
        : samplingModeRaw === undefined
          ? 'all'
          : 'sample';

  const gateRaw = aiJudge['gateWhenSampled'] as string | undefined;
  const judgeGateWhenSampled: 'gating' | 'informational' =
    e['judgeGateWhenSampled'] === 'gating' ||
    e['judgeGateWhenSampled'] === 'informational'
      ? (e['judgeGateWhenSampled'] as 'gating' | 'informational')
      : gateRaw === 'blocking'
        ? 'gating'
        : 'informational';

  return {
    strategy: (e['strategy'] as EvaluationJobInput['evaluators']['strategy']) ?? 'deterministic',
    rubricPreset:
      (e['rubricPreset'] as EvaluationJobInput['evaluators']['rubricPreset']) ?? 'none',
    enabledRubric:
      Array.isArray(e['enabledRubric']) && (e['enabledRubric'] as string[]).length > 0
        ? (e['enabledRubric'] as string[])
        : dimensions,
    evaluatorModel:
      (e['evaluatorModel'] as string | undefined) ?? models[0],
    evaluatorVersion: e['evaluatorVersion'] as string | undefined,
    judgeEvalMode:
      (e['judgeEvalMode'] as EvaluationJobInput['evaluators']['judgeEvalMode']) ??
      (aiJudge['evalMode'] as EvaluationJobInput['evaluators']['judgeEvalMode']) ??
      'pointwise',
    judgeSamplingMode,
    judgeSampleSize:
      (e['judgeSampleSize'] as number | undefined) ??
      (aiJudge['sampleSize'] as number | undefined),
    judgeStratifiedSlices:
      (e['judgeStratifiedSlices'] as boolean | undefined) ??
      (aiJudge['stratifiedSlices'] as boolean | undefined) ??
      false,
    judgeGateWhenSampled,
    goldenAvailable:
      (e['goldenAvailable'] as boolean | undefined) ??
      (aiJudge['goldenAvailable'] as boolean | undefined),
    scorers: e['scorers'] as EvaluationJobInput['evaluators']['scorers'],
  };
}

function hashEnvelope(e: Omit<ProvenanceEnvelope, 'envelopeHash'>): string {
  // Canonical JSON: stable key order + sorted rubricIds so two envelopes
  // with the same content always hash to the same value regardless of
  // input ordering.
  const canonical = JSON.stringify({
    agentVersionHash: e.agentVersionHash,
    datasetVersion: e.datasetVersion,
    retrievalIndexVersion: e.retrievalIndexVersion,
    toolRegistryVersion: e.toolRegistryVersion,
    generatorModelVersion: e.generatorModelVersion,
    evaluatorModel: e.evaluatorModel ?? null,
    evaluatorVersion: e.evaluatorVersion ?? null,
    rubricIds: [...e.rubricIds].sort(),
    rubricPrompts: e.rubricPrompts
      .map((r) => ({ id: r.id, prompt: r.prompt }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return fnv1aHex(canonical);
}
