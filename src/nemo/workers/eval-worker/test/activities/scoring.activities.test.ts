// Representative unit tests for the pure scoring/gating activities (spec §7.3, §9).
//
// The scoring math itself is tested via the exported `*Core` helpers — this
// keeps the hot inner loop free of PVC fixtures. A small set of "wrapper"
// tests at the bottom mocks `readCaptureFile` to verify the activity
// boundary contracts (caseRef + capturePath in, scorer output out).

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockReadCaptureFile = jest.fn();

jest.mock('../../src/lib/capture-file', () => ({
  readCaptureFile: (...a: any[]) => mockReadCaptureFile(...a),
}));

import {
  aggregateMetrics,
  compareToBaseline,
  computeGates,
  scoreGolden,
  scoreGoldenAssertions,
  scoreGoldenAssertionsCore,
  scoreGoldenCore,
  scoreSafetyClassifier,
  scoreSafetyClassifierCore,
  scoreSuiteDeterministic,
  scoreSuiteDeterministicCore,
} from '../../src/activities/scoring.activities';
import type {
  AgentInvocationResult,
  CaseRef,
  CaseRunArtifact,
  CaseRunSlot,
  CaptureFile,
  EvaluationDimension,
  EvaluationJobInput,
  GoldenTestCase,
  PerAgentTelemetry,
  PreflightSummary,
  RetrievedChunk,
  Telemetry,
  ToolCallTrace,
} from '../../src/lib/evaluation';

// ── Fixtures ────────────────────────────────────────────────────────

function makeCase(overrides: Partial<GoldenTestCase> = {}): GoldenTestCase {
  return {
    id: 'case-1',
    input: { query: 'What is the capital of France?' },
    evaluation: {
      expected_response: {
        final: {
          expected_answer: 'Paris',
          must_include: [{ pattern: 'Paris', match: 'substring' }],
          forbidden: [{ pattern: 'Berlin', match: 'substring' }],
        },
      },
    },
    ...overrides,
  };
}

function makeCaseRef(overrides: Partial<CaseRef> = {}): CaseRef {
  return {
    projectId: 'p-1',
    evalId: 'eval-1',
    runId: 'run-1',
    caseId: 'case-1',
    model: 'gpt-4o',
    ...overrides,
  };
}

function makeCapture(
  overrides: Partial<AgentInvocationResult> = {},
): AgentInvocationResult {
  return {
    response: '',
    citations: [],
    retrievedChunks: [],
    toolCalls: [],
    perAgent: [],
    telemetry: { e2eMs: 100 },
    retrievalAnnotation: null,
    resolvedRuntimeParams: {},
    ...overrides,
  };
}

function makeCaptureFile(
  capture: Partial<AgentInvocationResult> = {},
): CaptureFile {
  return {
    schemaVersion: 1,
    caseRef: makeCaseRef(),
    envelopeHash: 'env-1',
    capturedAt: new Date().toISOString(),
    capture: makeCapture(capture),
  };
}

const emptyTelemetry: Telemetry = { e2eMs: 100 };
const emptyChunks: RetrievedChunk[] = [];
const emptyTools: ToolCallTrace[] = [];
const emptyPerAgent: PerAgentTelemetry[] = [];

beforeEach(() => {
  jest.clearAllMocks();
});

// ── scoreGoldenAssertionsCore ───────────────────────────────────────

describe('scoreGoldenAssertionsCore', () => {
  it('marks must_include satisfied when response contains the pattern', () => {
    const report = scoreGoldenAssertionsCore({
      case: makeCase(),
      response: 'The capital of France is Paris.',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(report.final.mustInclude[0].satisfied).toBe(true);
    expect(report.final.forbidden[0].violated).toBe(false);
    expect(report.final.schemaValid).toBe(true);
  });

  it('flags forbidden pattern when present', () => {
    const report = scoreGoldenAssertionsCore({
      case: makeCase(),
      response: 'Berlin is actually the capital — wait no, Paris.',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(report.final.forbidden[0].violated).toBe(true);
  });
});

// ── scoreGoldenCore ─────────────────────────────────────────────────

describe('scoreGoldenCore', () => {
  it('returns em=1 on exact match', () => {
    const out = scoreGoldenCore({
      response: 'Paris',
      expectedAnswer: 'Paris',
    });
    expect(out.em).toBe(1);
    expect(out.tokenF1).toBe(1);
  });

  it('returns notComputedReason when no reference provided', () => {
    const out = scoreGoldenCore({ response: 'something' });
    expect(out.notComputedReason).toBe('no_reference');
  });
});

// ── scoreSafetyClassifierCore ───────────────────────────────────────

describe('scoreSafetyClassifierCore', () => {
  it('flags unsafe when refusal was expected but not given', () => {
    const out = scoreSafetyClassifierCore({
      response: 'Sure, here is how to do X.',
      expectedRefusal: true,
      prompt: 'prompt',
    });
    expect(out.unsafe).toBe(true);
    expect(out.falseRefusal).toBe(false);
  });

  it('flags false refusal when model refused a benign prompt', () => {
    const out = scoreSafetyClassifierCore({
      response: "I'm not able to help with that.",
      expectedRefusal: false,
      prompt: 'prompt',
    });
    expect(out.unsafe).toBe(false);
    expect(out.falseRefusal).toBe(true);
  });
});

// ── scoreSuiteDeterministicCore — safety_refusal fan-out ────────────

describe('scoreSuiteDeterministicCore', () => {
  it('returns empty metrics for safety_refusal suite (delegated)', () => {
    const out = scoreSuiteDeterministicCore({
      suite: 'safety_refusal',
      case: makeCase(),
      response: 'any',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      telemetry: emptyTelemetry,
    });
    expect(out).toEqual({});
  });
});

// ── Activity wrappers (read capture from PVC, call core) ────────────

describe('scoreGoldenAssertions (activity wrapper)', () => {
  it('reads capture.json from capturePath and forwards to core', async () => {
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({
        response: 'The capital of France is Paris.',
      }),
    );
    const report = await scoreGoldenAssertions({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///some/capture.json',
      case: makeCase(),
    });
    expect(mockReadCaptureFile).toHaveBeenCalledWith('posix:///some/capture.json');
    expect(report.final.mustInclude[0].satisfied).toBe(true);
  });
});

describe('scoreGolden (activity wrapper)', () => {
  it('reads capture.response from PVC', async () => {
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ response: 'Paris' }),
    );
    const out = await scoreGolden({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///c.json',
      expectedAnswer: 'Paris',
    });
    expect(out.em).toBe(1);
  });
});

describe('scoreSafetyClassifier (activity wrapper)', () => {
  it('reads capture.response from PVC', async () => {
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ response: 'Sure, here is how to do X.' }),
    );
    const out = await scoreSafetyClassifier({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///c.json',
      expectedRefusal: true,
      prompt: 'prompt',
    });
    expect(out.unsafe).toBe(true);
  });
});

describe('scoreSuiteDeterministic (activity wrapper)', () => {
  it('reads capture from PVC and dispatches by suite', async () => {
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ response: 'any' }),
    );
    const out = await scoreSuiteDeterministic({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///c.json',
      suite: 'safety_refusal',
      case: makeCase(),
    });
    expect(out).toEqual({});
  });
});

// ── aggregateMetrics ────────────────────────────────────────────────

describe('aggregateMetrics', () => {
  it('groups metrics by prefix into dimensions (legacy artifacts input)', async () => {
    const artifacts: CaseRunArtifact[] = [
      makeArtifact({ 'rag.groundedness': 0.9, 'perf.e2e_ms': 100 }),
      makeArtifact({ 'rag.groundedness': 0.8, 'perf.e2e_ms': 200 }),
    ];
    const dims = await aggregateMetrics({
      runId: 'eval-1',
      suite: 'rag',
      scope: 'full_agent_execution',
      artifacts,
    });
    const rag = dims.find((d) => d.id === 'rag');
    const perf = dims.find((d) => d.id === 'perf');
    expect(rag?.headline['rag.groundedness']).toBeCloseTo(0.85);
    // perf dims get distribution data.
    expect(perf?.distribution?.['perf.e2e_ms']?.p95).toBeDefined();
  });

  it('groups metrics from slot.deterministicMetrics (stage-1 path)', async () => {
    const slots = [
      makeSlotWithMetrics({ 'rag.groundedness': 0.9, 'perf.e2e_ms': 100 }),
      makeSlotWithMetrics({ 'rag.groundedness': 0.8, 'perf.e2e_ms': 200 }),
    ];
    const dims = await aggregateMetrics({
      runId: 'eval-1',
      suite: 'rag',
      scope: 'full_agent_execution',
      slots,
    });
    const rag = dims.find((d) => d.id === 'rag');
    expect(rag?.headline['rag.groundedness']).toBeCloseTo(0.85);
  });

  it('skips FAILED slots when aggregating from slots[]', async () => {
    const slots = [
      makeSlotWithMetrics({ 'rag.groundedness': 0.9 }),
      makeSlotWithMetrics(
        { 'rag.groundedness': 0.1 },
        { status: 'FAILED', passed: false },
      ),
    ];
    const dims = await aggregateMetrics({
      runId: 'eval-1',
      suite: 'rag',
      scope: 'full_agent_execution',
      slots,
    });
    const rag = dims.find((d) => d.id === 'rag');
    // FAILED slot's metrics are excluded; mean reduces to a single COMPLETED.
    expect(rag?.headline['rag.groundedness']).toBeCloseTo(0.9);
  });
});

// ── computeGates ────────────────────────────────────────────────────

describe('computeGates', () => {
  it("returns 'pass' when coverage + suite gates all clear", async () => {
    const dimensions: EvaluationDimension[] = [
      {
        id: 'rag',
        label: 'rag',
        headline: { 'rag.groundedness': 0.9 },
      },
    ];
    const { triggeredGates, verdict } = await computeGates({
      runId: 'eval-1',
      dimensions,
      jobInput: makeJobInput([
        { id: 'rag.groundedness', level: 'blocking', threshold: 0.8 },
      ]),
      coverage: { completed: 100, total: 100 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    expect(verdict).toBe('pass');
    const rag = triggeredGates.find((g) => g.id === 'rag.groundedness');
    expect(rag?.status).toBe('passed');
  });

  it("returns 'blocked' when coverage is under the floor", async () => {
    const { verdict } = await computeGates({
      runId: 'eval-1',
      dimensions: [],
      jobInput: makeJobInput([]),
      coverage: { completed: 30, total: 100 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    expect(verdict).toBe('blocked');
  });

  it("returns 'fail' when a blocking suite gate fails", async () => {
    const dimensions: EvaluationDimension[] = [
      {
        id: 'rag',
        label: 'rag',
        headline: { 'rag.groundedness': 0.5 },
      },
    ];
    const { verdict } = await computeGates({
      runId: 'eval-1',
      dimensions,
      jobInput: makeJobInput([
        { id: 'rag.groundedness', level: 'blocking', threshold: 0.8 },
      ]),
      coverage: { completed: 100, total: 100 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    expect(verdict).toBe('fail');
  });
});

// ── compareToBaseline ───────────────────────────────────────────────

describe('compareToBaseline', () => {
  it('computes percent delta vs baseline dimensions', async () => {
    const cmp = await compareToBaseline({
      runId: 'candidate',
      baselineJobId: 'baseline-1',
      dimensions: [
        {
          id: 'rag',
          label: 'rag',
          headline: { 'rag.groundedness': 0.9 },
        },
      ],
      baselineDimensions: [
        {
          id: 'rag',
          label: 'rag',
          headline: { 'rag.groundedness': 0.8 },
        },
      ],
    });
    expect(cmp?.baselineJobId).toBe('baseline-1');
    const entry = cmp?.metrics.find((m) => m.id === 'rag.groundedness');
    expect(entry?.delta).toBeCloseTo(0.1);
    expect(entry?.deltaPercent).toBeCloseTo(12.5);
    expect(entry?.significant).toBe(true); // >= 5%
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeArtifact(metrics: Record<string, number>): CaseRunArtifact {
  return {
    runId: 'eval-1',
    caseId: 'case',
    model: 'gpt-4o',
    status: 'COMPLETED',
    passed: true,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 100,
    citations: [],
    retrievedChunks: [],
    toolCalls: [],
    perAgent: [],
    retrievalAnnotation: null,
    resolvedRuntimeParams: {},
    deterministicMetrics: metrics,
    judgeRubrics: [],
    telemetry: { e2eMs: 100 },
  };
}

function makeSlotWithMetrics(
  metrics: Record<string, number>,
  overrides: { status?: 'COMPLETED' | 'FAILED'; passed?: boolean } = {},
): CaseRunSlot {
  const now = new Date().toISOString();
  return {
    caseRef: makeCaseRef(),
    status: overrides.status ?? 'COMPLETED',
    passed: overrides.passed ?? true,
    startedAt: now,
    completedAt: now,
    durationMs: 100,
    capturePath:
      'posix:///projects/p-1/evaluations/eval-1/runs/run-1/cases/case-1/capture.json',
    telemetry: { e2eMs: 100 },
    retrievalAnnotation: null,
    resolvedRuntimeParams: {},
    deterministicMetrics: metrics,
    judgeRubrics: [],
  };
}

function makeJobInput(
  gates: EvaluationJobInput['thresholds']['gates'],
): EvaluationJobInput {
  return {
    runId: 'eval-1',
    evalName: 'test',
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
      gates,
      coverageMinPct: 95,
      infraFailureMaxPct: 5,
      safetyP0Threshold: 0,
      minCompletedCases: 50,
    },
    provenance: {
      agentVersionHash: 'h',
      datasetVersion: 'v1',
      retrievalIndexVersion: 'r',
      toolRegistryVersion: 't',
      generatorModelVersion: 'g',
      rubricIds: [],
      rubricPrompts: [],
      envelopeHash: 'e',
    },
  };
}

// Silence unused import.
void ({} as PreflightSummary);
