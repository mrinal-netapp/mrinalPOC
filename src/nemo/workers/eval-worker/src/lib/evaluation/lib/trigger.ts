// Starter for the evaluation worker. See EVAL_BACKEND_TEMPORAL_TECH_SPEC.md
// §4.5 for the full architecture.
//
// Trigger inputs: a template (what to evaluate, how, with which cases, in
// which run mode) plus thin RunOptions (actor, reason, optional overrides).
//
// config-service POST /templates/{id}/runs writes the EvaluationRun row
// (template + cases snapshotted onto the row) and posts {runId, projectId}
// to workflow-engine. The worker's `loadRunSnapshot` activity reads the row
// back at workflow start. The dev harness (scripts/trigger-eval.ts) hits the
// same routes, so it also requires a reachable config-service.
//
// Idempotent on `workflowId`: the underlying workflow-engine rejects
// duplicates and returns the existing handle on retry.

// Deep import to keep the trigger surface light (the public barrel pulls
// in @temporalio/client transitively).
import { startWorkflowViaEngine } from '../../workflow-engine-client';
import {
  EVAL_TASK_QUEUE,
  AGENT_EVALUATION_WORKFLOW_NAME,
} from './workflow-signals';
import type { GoldenTestCase } from './golden-types';
import type {
  AgentEvaluationWorkflowInput,
  EvaluationTemplate,
  RunOptions,
} from './template-types';
import { isGoldenDependent } from './metrics-catalog';
import { normalizeStrategy, resolveJudgeToggles } from './judge-toggles';

export interface StartEvaluationOptions {
  template: EvaluationTemplate;
  cases: GoldenTestCase[];
  runOptions: RunOptions;
}

export interface StartEvaluationResult {
  workflowId: string;
  runId: string;
}

/**
 * Validate the template and start `AgentEvaluationWorkflow` via
 * workflow-engine with only `{runId, projectId}`.
 *
 * The EvaluationRun row (template + cases snapshotted) must already exist in
 * config-service under `runId` — production callers POST
 * `/api/v1/projects/{pid}/evaluation/agents/templates/{tid}/runs` to write
 * the row, and the dev harness must do the same before calling here. The
 * workflow's `loadRunSnapshot` activity reads the row back at start.
 */
export async function startEvaluation(
  options: StartEvaluationOptions,
): Promise<StartEvaluationResult> {
  const template = normalizeTemplate(options.template);
  validateTemplate(template);

  // `runId` is required: the EvaluationRun row in config-service is
  // keyed by it, and `loadRunSnapshot` will fail at workflow start if
  // no row exists. A randomly-generated fallback used to mask that
  // ordering bug (workflow started before the row was written). Callers
  // must POST `/templates/{id}/runs` first, take the row's runId, and
  // pass it here.
  const runId = options.runOptions.runId;
  if (!runId || typeof runId !== 'string' || runId.trim() === '') {
    throw new Error(
      'runOptions.runId is required — create the EvaluationRun row via ' +
        'POST /templates/{id}/runs first, then pass its runId here',
    );
  }
  const workflowId = `evaluation-agent-run-${runId}`;

  const workflowInput: AgentEvaluationWorkflowInput = {
    runId,
    projectId: template.projectId,
  };

  await startWorkflowViaEngine({
    workflowName: AGENT_EVALUATION_WORKFLOW_NAME,
    workflowId,
    taskQueue: EVAL_TASK_QUEUE,
    args: [workflowInput],
  });

  return { workflowId, runId };
}

// ── Internals ──────────────────────────────────────────────────────

function normalizeTemplate(t: EvaluationTemplate): EvaluationTemplate {
  return {
    ...t,
    evaluators: {
      ...t.evaluators,
      strategy: normalizeStrategy(t.evaluators?.strategy),
    },
  };
}

/**
 * Pre-flight validation that catches mis-configured templates at trigger
 * time instead of after the workflow has run for hours. The
 * `provenance.envelopeHash` field is intentionally not required here;
 * envelope hashing is deferred per §17 of the design spec.
 */
function validateTemplate(t: EvaluationTemplate): void {
  if (!t.projectId) throw new Error('template.projectId is required');
  if (!t.evalName) throw new Error('template.evalName is required');
  if (!t.agent?.agentTeam)
    throw new Error('template.agent.agentTeam is required');
  if (!t.models || t.models.length === 0)
    throw new Error('template.models must be non-empty');

  if (t.evaluators?.goldenAvailable === false) {
    const offenders = (t.thresholds?.gates ?? [])
      .map((g) => g.id)
      .filter((id) => isGoldenDependent(id));
    if (offenders.length > 0) {
      throw new Error(
        `evaluators.goldenAvailable=false is incompatible with gates referencing golden-only metrics: ${offenders.join(', ')}. ` +
          `Either remove these gates or set evaluators.goldenAvailable=true and provide a golden case set.`,
      );
    }
  }

  const toggles = resolveJudgeToggles(t.evaluators);
  if (toggles.judgeEnabled && toggles.rubrics.length === 0) {
    throw new Error(
      `evaluators.strategy='${toggles.strategy}' requires at least one rubric in evaluators.enabledRubric. ` +
        `Configure the rubric registry IDs you want the LLM judge to grade, or switch the strategy to 'deterministic'.`,
    );
  }

  if (t.regression?.expectations) {
    validateExpectations(t.regression.expectations);
  }
}

/**
 * Surface obvious mis-configurations of `regression.expectations` at trigger
 * time so they fail loudly before the workflow starts a multi-hour run.
 * Rejects empty/non-string ids, non-finite values, negative tolerances,
 * and duplicate metric ids.
 */
function validateExpectations(
  expectations: NonNullable<EvaluationTemplate['regression']>['expectations'],
): void {
  if (!expectations) return;
  const seen = new Set<string>();
  for (const [i, e] of expectations.entries()) {
    if (!e || typeof e !== 'object') {
      throw new Error(
        `regression.expectations[${i}] must be an object`,
      );
    }
    if (typeof e.id !== 'string' || e.id.length === 0) {
      throw new Error(
        `regression.expectations[${i}].id must be a non-empty string`,
      );
    }
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) {
      throw new Error(
        `regression.expectations[${i}].value must be a finite number (got: ${String(e.value)})`,
      );
    }
    if (e.tolerancePct !== undefined) {
      if (typeof e.tolerancePct !== 'number' || !Number.isFinite(e.tolerancePct)) {
        throw new Error(
          `regression.expectations[${i}].tolerancePct must be a finite number when set`,
        );
      }
      if (e.tolerancePct < 0) {
        throw new Error(
          `regression.expectations[${i}].tolerancePct must be >= 0 (got: ${e.tolerancePct})`,
        );
      }
    }
    if (seen.has(e.id)) {
      throw new Error(
        `regression.expectations has duplicate metric id '${e.id}' — each id may appear at most once`,
      );
    }
    seen.add(e.id);
  }
}

