// Template + Run shapes for the API described in
// EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §4.5.
//
// These are the EXTERNAL shapes that flow over the wire between
// config-service ↔ workflow-engine ↔ eval-worker. The
// `EvaluationJobInput` shape in `job-types.ts` is the INTERNAL resolved
// shape that the workflow body + activities consume — see
// `resolveTemplateRuntime()` in `resolve-template.ts`.

import type { ABVariantSpec } from './ab-types';
import type { AuditEvent } from './audit-types';
import type {
  BaselineExpectation,
  EvalSuite,
  EvaluationResults,
  EvaluationScope,
  EvaluationStatus,
  EvaluationStrategy,
  GateLevel,
  RunMode,
} from './job-types';
// ── EvaluationTemplate ──────────────────────────────────────────────

/**
 * Template = "what to evaluate, how, with which cases, in which run mode".
 *
 * Stored in config-service. Mutable in place via PATCH; runs snapshot the
 * template at trigger time so PATCHes don't affect in-flight runs.
 *
 * Version pinning across agent / tools / retrieval / rubrics is deferred —
 * see EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §11.6.
 */
export interface EvaluationTemplate {
  templateId: string;
  projectId: string;
  evalName: string;
  description?: string;
  createdAt: string;
  updatedAt: string;

  // ── What we evaluate ──────────────────────────────────────────────
  target: 'agent_version' | 'pre_generated';
  agent: {
    agentTeam: string;
    /** When set, eval-worker calls the per-agent invoke route; otherwise the team route. */
    agentId?: string;
  };
  models: string[];

  evaluationScope: EvaluationScope;
  suite: EvalSuite;

  // ── How we evaluate ───────────────────────────────────────────────
  evaluators: {
    strategy: EvaluationStrategy;
    rubricPreset: 'none' | 'rag' | 'safety' | 'custom';
    enabledRubric: string[];
    evaluatorModel?: string;
    evaluatorVersion?: string;
    judgeEvalMode: 'pointwise' | 'pairwise' | 'both';
    judgeSamplingMode: 'all' | 'sample';
    judgeSampleSize?: number;
    judgeStratifiedSlices: boolean;
    judgeGateWhenSampled: 'gating' | 'informational';
    goldenAvailable?: boolean;
    scorers?: {
      goldenAssertions?: boolean;
      golden?: boolean;
      suiteDeterministic?: boolean;
      safetyClassifier?: boolean;
    };
  };

  thresholds: {
    gates: Array<{ id: string; level: GateLevel; threshold: number }>;
    coverageMinPct: number;
    infraFailureMaxPct: number;
    safetyP0Threshold: number;
    minCompletedCases?: number;
  };

  // ── Test cases (eval-owned, NOT a project Dataset) ──
  // The JSONL bytes live at
  //   projects/{projectId}/evaluations/{evalId}/testcases/{cases.filename ?? 'cases.jsonl'}
  // alongside the eval's run history. The worker reads + validates the
  // JSONL via `validateTestCases` at workflow start.
  //
  // `evalId` is derived from the template at run-staging time
  // (`slugify(evalName)`), so the storage path is implicit — it is NOT
  // a separate field on the template.
  cases: {
    schemaVersion: 'golden_test_v1' | 'flat_csv_legacy';
    /**
     * Override the default `cases.jsonl` filename inside the eval's
     * `testcases/` folder. Optional — most templates use the default.
     */
    filename?: string;
    sample?: {
      mode: 'all' | 'fraction' | 'stratified';
      fraction?: number;
      stratifyBy?: Array<'category' | 'difficulty' | 'tags'>;
      seed?: number;
    };
    filter?: {
      category?: string[];
      difficulty?: string[];
      tags?: string[];
      includeLabelSuspect?: boolean;
      caseIds?: string[];
    };
  };

  // ── Run mode + mode-specific config (template-level, not per-run) ──
  runMode: RunMode;
  /**
   * Regression-mode config. Either / both fields can be set:
   *   - `baselineRunId` — compare against the headline of this prior run.
   *   - `expectations` — compare against inline per-metric targets.
   * When both are set, expectations override the prior-run value for any
   * metric id they specify (other metrics still come from the run).
   */
  regression?: {
    baselineRunId?: string;
    expectations?: BaselineExpectation[];
  };
  ab?: {
    variants: ABVariantSpec[];
    comparabilityChecks: string[];
    acknowledgedIssues?: string[];
  };
  repeats?: { count: number; seeds?: number[] };

  /** Child fan-out cap; can be overridden per-run via `RunOptions.overrides.concurrency`. */
  concurrency?: number;
}

// ── RunOptions (trigger body) ───────────────────────────────────────

/**
 * The POST `/templates/{id}/runs` body. Intentionally thin — almost
 * everything lives in the template.
 */
export interface RunOptions {
  /** Optional caller-supplied id; server generates a UUID if absent. */
  runId?: string;
  actor: string;
  reason?: string;
  overrides?: {
    concurrency?: number;
    sampleOverride?: {
      mode: 'all' | 'fraction';
      fraction?: number;
    };
  };
}

// ── AgentEvaluationWorkflowInput (Temporal entry shape) ─────────────

/**
 * Thin workflow entry input — just the keys needed to load the run row.
 * The workflow's first activity (`loadRunSnapshot`) fetches the snapshot
 * from config-service and stages the template into `<runDir>/_input/`
 * before resolving the internal `EvaluationJobInput` shape the workflow
 * body and downstream activities consume. Test cases are loaded from
 * PVC by the next activity (`validateTestCases`) — the entry input
 * does not carry them.
 *
 * Keeping the entry payload to two IDs:
 *   - stays well under Temporal's payload limit even for runs with
 *     thousands of cases;
 *   - keeps the workflow-engine REST contract a simple `{runId, projectId}`
 *     forward from config-service.
 */
export interface AgentEvaluationWorkflowInput {
  runId: string;
  projectId: string;
}

/**
 * Resolved workflow-input shape — what `loadRunSnapshot` materializes from
 * the persisted EvaluationRun row before handing off to
 * `resolveTemplateRuntime()`. Not a wire type; only used between the
 * snapshot activity and the workflow body.
 *
 * Cases are NOT in the snapshot — the workflow calls `validateTestCases`
 * immediately after `loadRunSnapshot` to load them from the eval's own
 * `testcases/` folder on the PVC. Only the resolved `evalId` is needed
 * to locate the file (no datasetId indirection).
 */
export interface ResolvedWorkflowSnapshot {
  runId: string;
  templateSnapshot: EvaluationTemplate;
  provenance: MinimalProvenance;
  overrides?: RunOptions['overrides'];
}

// ── MinimalProvenance ──────────────────────────────────────────────

/**
 * Identity-only provenance captured at run start. Version hashes
 * (`agentVersionHash`, `casesVersion`, `toolRegistryVersion`,
 * `retrievalIndexVersion`, `generatorModelVersion`, `rubricVersionHashes`,
 * composite `envelopeHash`) are deferred — see §17 of the design spec.
 *
 * What we record post-hoc (per case) lives in `CaseRunArtifact` and is
 * sourced from agent-service's response (e.g. `citations.respondingAgent`).
 */
export interface MinimalProvenance {
  /** RFC 3339 timestamp at run start. */
  triggeredAt: string;
  agentRef: {
    projectId: string;
    agentTeam: string;
    agentId?: string;
  };
  models: string[];
  rubricIds: string[];
}

// ── EvaluationRun (persisted run row) ───────────────────────────────

/**
 * The persisted "run row" in config-service. Carries the frozen
 * `templateSnapshot` (immutable once written) plus mutable run state
 * (status, results, audit). Test cases live on the data plane under
 * the eval's own `testcases/` folder on the PVC — never replicated into
 * config-service or copied into a `casesSnapshot` field.
 */
export interface EvaluationRun {
  runId: string;
  templateId: string;
  workflowId: string;
  projectId: string;
  status: EvaluationStatus;
  trigger: {
    actor: string;
    reason?: string;
    triggeredAt: string;
  };
  provenance: MinimalProvenance;
  templateSnapshot: EvaluationTemplate;
  results?: EvaluationResults;
  audit: AuditEvent[];
  startTime?: string;
  endTime?: string;
}
