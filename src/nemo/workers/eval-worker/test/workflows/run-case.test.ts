// Unit test for the inline `runCase` per-case orchestrator — mocks the
// @temporalio/workflow surface so the two-phase capture + score flow can be
// exercised as plain async code.
//
// Architecture v3 + stage-1 path-only payloads: runCase no longer calls
// `upsertCaseRun` and no longer carries the heavy capture payload back to
// the parent. It returns a small `CaseRunSlot` (in `summary.slot`) carrying
// the capturePath + scorer outputs + numeric metadata. The parent
// AgentEvaluationWorkflow accumulates these slots; Phase c's
// `writeResultsFile` reads each slot's capture.json from PVC when
// serializing `results.json`.

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Activity mocks ─────────────────────────────────────────────────
const mockInvokeAgent = jest.fn();
const mockInvokeJudge = jest.fn();
const mockScoreGoldenAssertions = jest.fn();
const mockScoreSuiteDeterministic = jest.fn();
const mockScoreGolden = jest.fn();
const mockScoreSafetyClassifier = jest.fn();
const mockSendObservabilityTrace = jest.fn().mockResolvedValue({
  traceRef: 'trace-1',
});

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    invokeAgent: (...args: any[]) => mockInvokeAgent(...args),
    invokeJudge: (...args: any[]) => mockInvokeJudge(...args),
    scoreGoldenAssertions: (...args: any[]) =>
      mockScoreGoldenAssertions(...args),
    scoreSuiteDeterministic: (...args: any[]) =>
      mockScoreSuiteDeterministic(...args),
    scoreGolden: (...args: any[]) => mockScoreGolden(...args),
    scoreSafetyClassifier: (...args: any[]) =>
      mockScoreSafetyClassifier(...args),
    sendObservabilityTrace: (...args: any[]) =>
      mockSendObservabilityTrace(...args),
  }),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isCancellation: () => false,
  CancelledFailure: class CancelledFailureMock extends Error {},
  ApplicationFailure: Object.assign(
    class ApplicationFailureMock extends Error {
      public type?: string;
      constructor(msg: string, type?: string) {
        super(msg);
        this.type = type;
      }
    },
    {
      nonRetryable: (msg: string, type: string) => {
        const err = new Error(msg) as Error & { type: string };
        err.type = type;
        return err;
      },
    },
  ),
}));

import { runCase } from '../../src/workflows/run-case';
import type {
  EvaluationJobInput,
  GoldenTestCase,
  ResolvedScorerToggles,
} from '../../src/lib/evaluation';

const ALL_ON_TOGGLES: ResolvedScorerToggles = {
  goldenAssertions: true,
  golden: true,
  suiteDeterministic: true,
  safetyClassifier: true,
};

const CAPTURE_PATH =
  'posix:///projects/p-1/evaluations/eval-1/runs/eval-1/cases/case-1/single/gpt-4o/0/capture.json';

/** Stage-1 invokeAgent output — capturePath + small numeric headline. */
const CAPTURE_OK = {
  capturePath: CAPTURE_PATH,
  telemetry: { e2eMs: 200 },
  retrievalAnnotation: null,
  resolvedRuntimeParams: { model: 'gpt-4o' },
};

// ── Fixtures ───────────────────────────────────────────────────────

const testCase: GoldenTestCase = {
  id: 'case-1',
  input: { query: 'What is the capital of France?' },
  evaluation: {
    expected_response: {
      final: {
        expected_answer: 'Paris',
        must_include: [{ pattern: 'Paris', match: 'substring' }],
      },
    },
  },
};

const jobInput: EvaluationJobInput = {
  runId: 'eval-1',
  evalName: 'demo',
  projectId: 'p-1',
  agentTeam: 'team-test',
  target: 'agent_version',
  evaluationScope: 'full_agent_execution',
  suite: 'rag',
  runMode: 'single',
  testCases: {
    schemaVersion: 'golden_test_v1',
    sample: { mode: 'all' },
  },
  models: ['gpt-4o'],
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
    coverageMinPct: 95,
    infraFailureMaxPct: 5,
    safetyP0Threshold: 0,
  },
  provenance: {
    agentVersionHash: 'h',
    datasetVersion: 'v1',
    retrievalIndexVersion: 'r',
    toolRegistryVersion: 't',
    generatorModelVersion: 'g',
    rubricIds: [],
    rubricPrompts: [],
    envelopeHash: 'env-hash-abc',
  },
};

function baseInput(overrides: Partial<Parameters<typeof runCase>[0]> = {}) {
  return {
    runId: 'eval-1',
    projectId: 'p-1',
    evalId: 'eval-1',
    agentTeam: 'team-a',
    case: testCase,
    overrides: { model: 'gpt-4o' },
    model: 'gpt-4o',
    envelopeHash: 'env-hash-abc',
    jobInput,
    judgeRubricIds: [],
    scorerToggles: ALL_ON_TOGGLES,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('runCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs Phase 1 capture then parallel Phase 2 scoring and returns the slot', async () => {
    mockInvokeAgent.mockResolvedValue(CAPTURE_OK);
    mockScoreGoldenAssertions.mockResolvedValue({
      final: {
        mustInclude: [
          { pattern: 'Paris', match: 'substring', satisfied: true },
        ],
        mustCite: [],
        forbidden: [],
        schemaValid: true,
        schemaErrors: [],
      },
      subAgents: [],
    });
    mockScoreSuiteDeterministic.mockResolvedValue({
      'rag.groundedness': 0.95,
    });
    mockScoreGolden.mockResolvedValue({ em: 1, tokenF1: 1 });
    mockScoreSafetyClassifier.mockResolvedValue({
      unsafe: false,
      falseRefusal: false,
      boundaryAdherence: 1,
    });

    const summary = await runCase(baseInput());

    expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
    expect(mockScoreGoldenAssertions).toHaveBeenCalledTimes(1);
    expect(mockScoreSuiteDeterministic).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('COMPLETED');
    expect(summary.passed).toBe(true);
    expect(summary.traceRef).toBe('trace-1');
    expect(summary.slot).toBeDefined();
    expect(summary.slot.status).toBe('COMPLETED');
    expect(summary.slot.capturePath).toBe(CAPTURE_PATH);
    expect(summary.slot.deterministicMetrics).toMatchObject({
      'rag.groundedness': 0.95,
      'correctness.em': 1,
    });
  });

  it('threads capturePath into every Phase 2 scorer + observability call', async () => {
    mockInvokeAgent.mockResolvedValue(CAPTURE_OK);
    mockScoreGoldenAssertions.mockResolvedValue({
      final: {
        mustInclude: [],
        mustCite: [],
        forbidden: [],
        schemaValid: true,
        schemaErrors: [],
      },
      subAgents: [],
    });
    mockScoreSuiteDeterministic.mockResolvedValue({});
    mockScoreGolden.mockResolvedValue({ em: 1, tokenF1: 1 });
    mockScoreSafetyClassifier.mockResolvedValue({
      unsafe: false,
      falseRefusal: false,
      boundaryAdherence: 1,
    });

    await runCase(baseInput());

    const inspect = (mock: jest.Mock): unknown =>
      mock.mock.calls[0]?.[0];

    expect(inspect(mockSendObservabilityTrace)).toMatchObject({
      caseRef: { caseId: 'case-1', runId: 'eval-1', projectId: 'p-1' },
      capturePath: CAPTURE_PATH,
    });
    expect(inspect(mockScoreGoldenAssertions)).toMatchObject({
      capturePath: CAPTURE_PATH,
    });
    expect(inspect(mockScoreSuiteDeterministic)).toMatchObject({
      capturePath: CAPTURE_PATH,
    });
    expect(inspect(mockScoreGolden)).toMatchObject({
      capturePath: CAPTURE_PATH,
    });
    expect(inspect(mockScoreSafetyClassifier)).toMatchObject({
      capturePath: CAPTURE_PATH,
    });
  });

  it('forwards judge-rubric activities with capturePath threaded through', async () => {
    mockInvokeAgent.mockResolvedValue(CAPTURE_OK);
    mockScoreGoldenAssertions.mockResolvedValue({
      final: {
        mustInclude: [],
        mustCite: [],
        forbidden: [],
        schemaValid: true,
        schemaErrors: [],
      },
      subAgents: [],
    });
    mockScoreSuiteDeterministic.mockResolvedValue({});
    mockScoreGolden.mockResolvedValue({ em: 1, tokenF1: 1 });
    mockScoreSafetyClassifier.mockResolvedValue({
      unsafe: false,
      falseRefusal: false,
      boundaryAdherence: 1,
    });
    mockInvokeJudge.mockResolvedValue({
      rubricId: 'r1',
      judgeModelName: '',
      judgeVersion: '',
      rubricPromptHash: 'r1',
      mode: 'pointwise',
      score: 0.9,
    });

    await runCase(baseInput({ judgeRubricIds: ['r1'] }));
    expect(mockInvokeJudge).toHaveBeenCalledTimes(1);
    expect(mockInvokeJudge.mock.calls[0][0]).toMatchObject({
      capturePath: CAPTURE_PATH,
      rubricId: 'r1',
    });
  });

  it('returns a FAILED slot and skips Phase 2 when invokeAgent throws', async () => {
    mockInvokeAgent.mockRejectedValue(new Error('agent-service 500'));

    const summary = await runCase(baseInput({ overrides: {} }));

    expect(mockScoreGoldenAssertions).not.toHaveBeenCalled();
    expect(summary.status).toBe('FAILED');
    expect(summary.passed).toBe(false);
    expect(summary.slot).toBeDefined();
    expect(summary.slot.status).toBe('FAILED');
    expect(summary.slot.capturePath).toBeUndefined();
    expect(summary.slot.error).toBe('agent-service 500');
  });

  describe('scorer gating', () => {
    function captureFixture() {
      mockInvokeAgent.mockResolvedValue(CAPTURE_OK);
      mockScoreSuiteDeterministic.mockResolvedValue({
        'rag.groundedness': 0.88,
      });
      mockScoreSafetyClassifier.mockResolvedValue({
        unsafe: false,
        falseRefusal: false,
        boundaryAdherence: 1,
        refusalQuality: 0.9,
      });
    }

    it('does not invoke golden-only scorers when goldenAvailable=false (reference-free metrics only)', async () => {
      captureFixture();

      const summary = await runCase(
        baseInput({
          scorerToggles: {
            goldenAssertions: false,
            golden: false,
            suiteDeterministic: true,
            safetyClassifier: true,
          },
        }),
      );

      expect(mockScoreGoldenAssertions).not.toHaveBeenCalled();
      expect(mockScoreGolden).not.toHaveBeenCalled();
      expect(mockScoreSuiteDeterministic).toHaveBeenCalledTimes(1);
      expect(mockScoreSafetyClassifier).toHaveBeenCalledTimes(1);

      expect(summary.slot.deterministicMetrics).not.toHaveProperty(
        'correctness.em',
      );
      expect(summary.slot.deterministicMetrics).not.toHaveProperty(
        'correctness.bleu',
      );
      expect(summary.slot.deterministicMetrics).toMatchObject({
        'rag.groundedness': 0.88,
        'safety.unsafe_rate': 0,
        'safety.boundary': 1,
      });
      // The empty golden-assertion report keeps derivePass branch-free.
      expect(summary.slot.goldenAssertions?.final.mustInclude).toEqual([]);
    });

    it('invokes scoreGolden when a per-scorer override re-enables it on a no-golden run', async () => {
      captureFixture();
      mockScoreGolden.mockResolvedValue({ em: 0, tokenF1: 0.4 });

      await runCase(
        baseInput({
          scorerToggles: {
            goldenAssertions: false,
            golden: true,
            suiteDeterministic: true,
            safetyClassifier: true,
          },
        }),
      );

      expect(mockScoreGoldenAssertions).not.toHaveBeenCalled();
      expect(mockScoreGolden).toHaveBeenCalledTimes(1);
    });

    it('drops all rag.* and other suiteDeterministic keys when that scorer is gated off', async () => {
      captureFixture();
      mockScoreGoldenAssertions.mockResolvedValue({
        final: {
          mustInclude: [],
          mustCite: [],
          forbidden: [],
          schemaValid: true,
          schemaErrors: [],
        },
        subAgents: [],
      });
      mockScoreGolden.mockResolvedValue({ em: 1, tokenF1: 1 });

      const summary = await runCase(
        baseInput({
          scorerToggles: {
            goldenAssertions: true,
            golden: true,
            suiteDeterministic: false,
            safetyClassifier: true,
          },
        }),
      );

      expect(mockScoreSuiteDeterministic).not.toHaveBeenCalled();
      const metricKeys = Object.keys(summary.slot.deterministicMetrics ?? {});
      expect(metricKeys).not.toContain('rag.groundedness');
      expect(metricKeys).toContain('correctness.em');
      expect(metricKeys).toContain('safety.unsafe_rate');
    });
  });
});
