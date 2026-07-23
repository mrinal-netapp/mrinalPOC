/**
 * Developer dev-harness — kicks off a local AgentEvaluationWorkflow run via the
 * shared trigger lib so you can exercise the full flow end-to-end against a
 * local Temporal cluster and workflow-engine.
 *
 * Architecture: one workflow, all run modes (single, regression, ab_compare,
 * repeats). The trigger takes an EvaluationTemplate + cases + RunOptions.
 * See EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §4.5.
 *
 * Prerequisites:
 *   1. A Temporal dev server on localhost:7233 (e.g. `temporal server start-dev`).
 *   2. eval-worker running and registered against EVAL_TASK_QUEUE.
 *   3. workflow-engine running on WORKFLOW_ENGINE_URL (default
 *      http://workflow-engine:8080); from the dev container point at the
 *      local cluster.
 *   4. Env vars the activities need: CONFIG_SERVICE_URL, AGENT_SERVICE_URL,
 *      LLM_GATEWAY_URL, plus NEMO_DEFAULT_STORE_ROOT (POSIX-on-PVC root for
 *      results-file writes — defaults to /mnt/pvcs/default-nemo in clusters,
 *      a tmpdir under the dev harness). config-service is always real.
 *
 * Run:
 *   TEMPORAL_ADDRESS=localhost:7233 \
 *     WORKFLOW_ENGINE_URL=http://localhost:8080 \
 *     npx ts-node scripts/trigger-eval.ts --runMode single
 */
import { randomUUID } from 'node:crypto';
import {
  awaitWorkflowResultViaEngine,
  queryWorkflowViaEngine,
} from '../src/lib/workflow-engine-client';
import {
  startEvaluation,
  type EvaluationJob,
  type EvaluationProgress,
  type EvaluationResults,
  type EvaluationTemplate,
  type GoldenTestCase,
  type PreflightSummary,
  type RunMode,
  type RunOptions,
  EVALUATION_PREFLIGHT_QUERY,
  EVALUATION_PROGRESS_QUERY,
  EVALUATION_RESULTS_QUERY,
} from '../src/lib/evaluation';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx < process.argv.length - 1) return process.argv[idx + 1];
  return fallback;
}

const RUN_MODES: readonly RunMode[] = [
  'single',
  'regression',
  'ab_compare',
];

function parseRunMode(raw: string | undefined): RunMode {
  const value = raw ?? 'single';
  if ((RUN_MODES as readonly string[]).includes(value)) {
    return value as RunMode;
  }
  throw new Error(
    `Invalid --runMode '${value}'. Supported: ${RUN_MODES.join(', ')}.`,
  );
}

function sampleTemplate(runMode: RunMode): EvaluationTemplate {
  const now = new Date().toISOString();
  return {
    templateId: arg('templateId') ?? `tpl-${randomUUID()}`,
    projectId: arg('projectId') ?? 'proj-dev',
    evalName: arg('evalName') ?? 'dev-harness',
    createdAt: now,
    updatedAt: now,
    target: 'agent_version',
    agent: {
      agentTeam: arg('agentTeam') ?? 'team-dev',
      agentId: arg('agentId'),
    },
    models: (arg('models') ?? 'gpt-4o').split(','),
    evaluationScope: 'full_agent_execution',
    suite: 'rag',
    evaluators: {
      strategy: 'deterministic',
      rubricPreset: 'none',
      enabledRubric: [],
      judgeEvalMode: 'pointwise',
      judgeSamplingMode: 'all',
      judgeStratifiedSlices: false,
      judgeGateWhenSampled: 'informational',
    },
    thresholds: {
      gates: [{ id: 'rag.groundedness', level: 'warning', threshold: 0.8 }],
      coverageMinPct: 90,
      infraFailureMaxPct: 10,
      safetyP0Threshold: 0,
      minCompletedCases: 1,
    },
    cases: {
      schemaVersion: 'golden_test_v1',
      sample: { mode: 'all' },
    },
    runMode,
    regression:
      runMode === 'regression'
        ? { baselineRunId: arg('baselineRunId') ?? 'baseline-dev' }
        : undefined,
    ab:
      runMode === 'ab_compare'
        ? {
            variants: [
              {
                variantId: 'A',
                label: 'control',
                overrides: { temperature: 0.2 },
              },
              {
                variantId: 'B',
                label: 'candidate',
                overrides: { temperature: 0.7 },
              },
            ],
            comparabilityChecks: [],
          }
        : undefined,
    concurrency: 4,
  };
}

function sampleCases(): GoldenTestCase[] {
  // Inline cases for the dev harness — in production these come from
  // the eval-owned JSONL on the PVC at
  // `projects/{p}/evaluations/{evalId}/testcases/cases.jsonl`,
  // validated by the eval worker's `validateTestCases` activity at
  // workflow start.
  return [
    {
      id: 'case-dev-1',
      input: { query: 'What is the capital of France?' },
      evaluation: {
        expected_response: {
          final: { expected_answer: 'Paris' },
        },
      },
    },
  ];
}

async function main(): Promise<void> {
  const runMode = parseRunMode(arg('runMode'));
  const template = sampleTemplate(runMode);
  const cases = sampleCases();
  const runOptions: RunOptions = {
    runId: arg('runId'),
    actor: arg('actor') ?? 'dev-harness',
    reason: arg('reason') ?? 'local dev kickoff',
  };

  console.log('── Starting evaluation ────────────────────────────────');
  console.log(`   runMode:      ${runMode}`);
  console.log(`   templateId:   ${template.templateId}`);
  console.log(`   models:       [${template.models.join(', ')}]`);

  const { workflowId, runId } = await startEvaluation({
    template,
    cases,
    runOptions,
  });
  console.log(`   runId:        ${runId}`);
  console.log(`   workflowId:   ${workflowId}\n`);

  // Poll progress until terminal status.
  const terminal = new Set(['completed', 'failed', 'stopped']);
  let lastPhase = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const preflight = await queryWorkflowViaEngine<
        PreflightSummary | undefined
      >({ workflowId, queryName: EVALUATION_PREFLIGHT_QUERY });
      if (preflight && lastPhase !== 'preflight-seen') {
        lastPhase = 'preflight-seen';
        console.log('   preflight:    ', preflight.summary);
      }
      const p = await queryWorkflowViaEngine<EvaluationProgress>({
        workflowId,
        queryName: EVALUATION_PROGRESS_QUERY,
      });
      console.log(
        `   [${p.phase.padEnd(9)}] ${p.completedCases}/${p.totalCases} done, ${p.failedCases} failed, ${p.inFlightCases} in-flight (${p.percentage.toFixed(1)}%)`,
      );
      if (terminal.has(p.status)) break;
    } catch (err) {
      console.log(
        '   (progress not ready)',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const results = await queryWorkflowViaEngine<EvaluationResults | undefined>({
    workflowId,
    queryName: EVALUATION_RESULTS_QUERY,
  });
  console.log('\n── Results ────────────────────────────────────────────');
  console.log(JSON.stringify(results, null, 2));

  const final = await awaitWorkflowResultViaEngine<EvaluationJob>({
    workflowId,
  });
  console.log('\n── Workflow return value ──────────────────────────────');
  console.log(JSON.stringify(final, null, 2));
}

main().catch((err) => {
  console.error('trigger-eval failed:', err);
  process.exit(1);
});
