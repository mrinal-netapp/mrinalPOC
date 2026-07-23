jest.mock('../../../../src/lib/workflow-engine-client', () => ({
  startWorkflowViaEngine: jest.fn(),
}));

import { startWorkflowViaEngine } from '../../../../src/lib/workflow-engine-client';
import { startEvaluation } from '../../../../src/lib/evaluation/lib/trigger';
import type {
  EvaluationTemplate,
  GoldenTestCase,
  RunOptions,
} from '../../../../src/lib/evaluation';

const mockStart = startWorkflowViaEngine as jest.MockedFunction<
  typeof startWorkflowViaEngine
>;

function makeTemplate(
  over: Partial<EvaluationTemplate> = {},
): EvaluationTemplate {
  const now = '2026-06-01T00:00:00Z';
  return {
    templateId: 'tpl-1',
    projectId: 'p-1',
    evalName: 'eval-x',
    createdAt: now,
    updatedAt: now,
    target: 'agent_version',
    agent: { agentTeam: 'team' },
    models: ['gpt-4o'],
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
      gates: [],
      coverageMinPct: 0,
      infraFailureMaxPct: 100,
      safetyP0Threshold: 0,
    },
    cases: { schemaVersion: 'golden_test_v1' },
    runMode: 'single',
    ...over,
  };
}

// startEvaluation now requires a runId — callers must POST the run row
// to config-service first and pass back the runId. Tests that don't care
// about the specific value just inherit this stable test id.
const baseOptions: RunOptions = { actor: 'svc', runId: 'r-test' };
const cases: GoldenTestCase[] = [];

describe('startEvaluation', () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockStart.mockResolvedValue({ workflowId: 'wf', runId: 'r' });
  });

  it('starts the workflow under `evaluation-agent-run-{runId}` and uses the caller-supplied runId when present', async () => {
    const out = await startEvaluation({
      template: makeTemplate(),
      cases,
      runOptions: { ...baseOptions, runId: 'my-run' },
    });
    expect(out.runId).toBe('my-run');
    expect(out.workflowId).toBe('evaluation-agent-run-my-run');
    const startCall = mockStart.mock.calls[0][0];
    expect(startCall.workflowId).toBe('evaluation-agent-run-my-run');
    expect(startCall.taskQueue).toBe('eval-task-queue');
    expect(startCall.args).toEqual([{ runId: 'my-run', projectId: 'p-1' }]);
  });

  it('rejects when runOptions.runId is missing (caller must reserve it via config-service first)', async () => {
    const { runId: _ignored, ...optsWithoutRunId } = baseOptions;
    await expect(
      startEvaluation({
        template: makeTemplate(),
        cases,
        runOptions: optsWithoutRunId,
      }),
    ).rejects.toThrow(/runOptions\.runId is required/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('normalizes legacy "deterministic_only" → "deterministic" before validating', async () => {
    await startEvaluation({
      template: makeTemplate({
        evaluators: {
          ...makeTemplate().evaluators,
          strategy:
            'deterministic_only' as unknown as EvaluationTemplate['evaluators']['strategy'],
        },
      }),
      cases,
      runOptions: baseOptions,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  // ── validation failures (no workflow started) ─────────────────────

  it('rejects when projectId is empty', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({ projectId: '' }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow('template.projectId is required');
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('rejects when evalName is empty', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({ evalName: '' }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow('template.evalName is required');
  });

  it('rejects when agent.agentTeam is missing', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          agent: { agentTeam: '' } as EvaluationTemplate['agent'],
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow('template.agent.agentTeam is required');
  });

  it('rejects when models is empty', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({ models: [] }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow('template.models must be non-empty');
  });

  it('rejects no-golden templates that gate on golden-dependent metrics', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          evaluators: {
            ...makeTemplate().evaluators,
            goldenAvailable: false,
          },
          thresholds: {
            gates: [
              { id: 'correctness.em', level: 'blocking', threshold: 0.8 },
              { id: 'rag.context_precision', level: 'warning', threshold: 0.5 },
            ],
            coverageMinPct: 0,
            infraFailureMaxPct: 100,
            safetyP0Threshold: 0,
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/correctness\.em.*rag\.context_precision/);
  });

  it('rejects llm_judge strategy without any rubrics configured', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          evaluators: {
            ...makeTemplate().evaluators,
            strategy: 'llm_judge',
            enabledRubric: [],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/requires at least one rubric/);
  });

  it('accepts no-golden template when gates only reference reference-free metrics', async () => {
    await startEvaluation({
      template: makeTemplate({
        evaluators: {
          ...makeTemplate().evaluators,
          goldenAvailable: false,
        },
        thresholds: {
          gates: [
            { id: 'perf.e2e_ms', level: 'warning', threshold: 2000 },
          ],
          coverageMinPct: 0,
          infraFailureMaxPct: 100,
          safetyP0Threshold: 0,
        },
      }),
      cases,
      runOptions: baseOptions,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  // ── regression.expectations validation ─────────────────────────────

  it('accepts a well-formed regression.expectations array', async () => {
    await startEvaluation({
      template: makeTemplate({
        runMode: 'regression',
        regression: {
          expectations: [
            { id: 'rag.groundedness', value: 0.85 },
            { id: 'correctness.em', value: 0.7, tolerancePct: 3 },
          ],
        },
      }),
      cases,
      runOptions: baseOptions,
    });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it('rejects expectation entries with empty id', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          runMode: 'regression',
          regression: {
            expectations: [{ id: '', value: 0.5 }],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/id must be a non-empty string/);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('rejects expectation entries with non-finite value', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          runMode: 'regression',
          regression: {
            expectations: [{ id: 'rag.groundedness', value: NaN }],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/value must be a finite number/);
  });

  it('rejects negative tolerancePct', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          runMode: 'regression',
          regression: {
            expectations: [
              { id: 'rag.groundedness', value: 0.8, tolerancePct: -1 },
            ],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/tolerancePct must be >= 0/);
  });

  it('rejects non-finite tolerancePct', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          runMode: 'regression',
          regression: {
            expectations: [
              { id: 'rag.groundedness', value: 0.8, tolerancePct: Infinity },
            ],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/tolerancePct must be a finite number/);
  });

  it('rejects duplicate metric ids in expectations', async () => {
    await expect(
      startEvaluation({
        template: makeTemplate({
          runMode: 'regression',
          regression: {
            expectations: [
              { id: 'rag.groundedness', value: 0.8 },
              { id: 'rag.groundedness', value: 0.9 },
            ],
          },
        }),
        cases,
        runOptions: baseOptions,
      }),
    ).rejects.toThrow(/duplicate metric id 'rag.groundedness'/);
  });
});
