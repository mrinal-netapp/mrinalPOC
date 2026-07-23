// Unit test for AgentEvaluationWorkflow — mocks the @temporalio/workflow surface
// and the inline `runCase` helper so we can exercise the parent body as plain
// async code and assert the new Phase a / b / c structure end-to-end.
//
// Architecture v3 + stage-1 path-only payloads:
//   - Phase a: per-case fan-out (inline `runCase`) collects small per-case
//     `CaseRunSlot[]` in workflow memory. There is no child workflow.
//   - Phase c: `writeResultsFile` is called with `perCaseSlots`; the activity
//     reads each slot's `capturePath` from PVC and denormalizes the full
//     `CaseRunArtifact` row when serializing `results.json`.

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockRunCase = jest.fn();

const mockRunPreflight = jest.fn();
const mockLoadRunSnapshot = jest.fn();
const mockValidateTestCases = jest.fn();
const mockAggregateMetrics = jest.fn();
const mockComputeGates = jest.fn();
const mockCompareToBaseline = jest.fn();
const mockFindPreviousRun = jest.fn();
const mockUpdateJobStatus = jest.fn().mockResolvedValue(undefined);
const mockUpdateJobResults = jest.fn().mockResolvedValue(undefined);
const mockWriteAuditEvent = jest.fn().mockResolvedValue(undefined);
const mockGetEvaluationJob = jest.fn();
const mockIsCancellation: jest.Mock<boolean, [unknown]> = jest.fn(
  (_err: unknown) => false,
);

const mockWriteResultsFile = jest.fn();
const mockWriteStakeholderReport = jest.fn();
const mockBuildCompareReport = jest.fn();

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    runPreflight: (...a: any[]) => mockRunPreflight(...a),
    loadRunSnapshot: (...a: any[]) => mockLoadRunSnapshot(...a),
    validateTestCases: (...a: any[]) => mockValidateTestCases(...a),
    aggregateMetrics: (...a: any[]) => mockAggregateMetrics(...a),
    computeGates: (...a: any[]) => mockComputeGates(...a),
    compareToBaseline: (...a: any[]) => mockCompareToBaseline(...a),
    findPreviousRun: (...a: any[]) => mockFindPreviousRun(...a),
    updateJobStatus: (...a: any[]) => mockUpdateJobStatus(...a),
    updateJobResults: (...a: any[]) => mockUpdateJobResults(...a),
    recordTradeoffDecision: jest.fn(),
    writeAuditEvent: (...a: any[]) => mockWriteAuditEvent(...a),
    getEvaluationJob: (...a: any[]) => mockGetEvaluationJob(...a),
    writeResultsFile: (...a: any[]) => mockWriteResultsFile(...a),
    writeStakeholderReport: (...a: any[]) => mockWriteStakeholderReport(...a),
    buildCompareReport: (...a: any[]) => mockBuildCompareReport(...a),
  }),
  defineQuery: jest.fn(() => ({})),
  defineSignal: jest.fn(() => ({})),
  setHandler: jest.fn(),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isCancellation: (err: unknown) => mockIsCancellation(err),
  CancelledFailure: class CancelledFailureMock extends Error {},
  workflowInfo: () => ({ runId: 'run-12345678' }),
  CancellationScope: (() => {
    class CancellationScopeMock {
      cancel = jest.fn();
      run(fn: () => Promise<void>): Promise<void> { return fn(); }
    }
    const ctor: any = CancellationScopeMock;
    ctor.cancellable = async (fn: () => Promise<void>) => {
      // Push a fake "current" scope for the duration of fn so that
      // `CancellationScope.current()` returns something cancel-able.
      const prev = ctor.__current;
      const scope = new CancellationScopeMock();
      ctor.__current = scope;
      try {
        return await fn();
      } finally {
        ctor.__current = prev;
      }
    };
    ctor.current = () => ctor.__current ?? new CancellationScopeMock();
    return ctor;
  })(),
  condition: jest.fn(() => Promise.resolve()),
  sleep: jest.fn(() => Promise.resolve()),
}));

// Replace the inline per-case helper. The parent now calls `runCase()`
// directly instead of `executeChild(AgentTestCaseWorkflow, ...)`, so we
// intercept that call and stub a CaseRunSummary back. Tests use
// `mockRunCase.mock.calls[i][0]` to inspect the per-case input.
jest.mock('../../src/workflows/run-case', () => ({
  runCase: (...a: any[]) => mockRunCase(...a),
}));

import { AgentEvaluationWorkflow } from '../../src/workflows/agent-evaluation.workflow';
import type {
  AgentEvaluationWorkflowInput,
  CaseRef,
  CaseRunSlot,
  CaseRunSummary,
  EvaluationJobInput,
} from '../../src/lib/evaluation';

/**
 * Build the thin workflow entry input ({runId, projectId}) the workflow
 * now accepts, and stage the supplied `EvaluationJobInput` as the value
 * `mockLoadRunSnapshot` will return for this test. The workflow's first
 * activity is `loadRunSnapshot`, the second is `validateTestCases`
 * (which now returns the cases). Tests that customise `baseInput()` use
 * this helper; tests that only customise the case list mutate
 * `mockValidateTestCases.mockResolvedValue` directly.
 */
function wrap(legacy: EvaluationJobInput): AgentEvaluationWorkflowInput {
  mockLoadRunSnapshot.mockImplementationOnce(async () => ({
    jobInput: legacy,
    jobFolderUri:
      'posix:///projects/p-1/evaluations/phase-c-test/runs/eval-42/_input',
    evalId: 'phase-c-test',
    templateId: 'tpl-test',
    testCasesRef: {},
  }));
  return { runId: legacy.runId, projectId: legacy.projectId };
}

function baseInput(): EvaluationJobInput {
  return {
    runId: 'eval-42',
    evalName: 'phase-c-test',
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
    // Provenance shape mirrors what `loadRunSnapshot` produces: a
    // MinimalProvenance widened by `resolveTemplateRuntime` with the
    // version-pinned hash fields left empty (§11.6 — deferred).
    provenance: {
      agentVersionHash: '',
      datasetVersion: 'snapshot',
      retrievalIndexVersion: '',
      toolRegistryVersion: '',
      generatorModelVersion: '',
      rubricIds: [],
      rubricPrompts: [],
      envelopeHash: '',
    },
    concurrency: 1,
  };
}

function makeCaseRef(
  caseId: string,
  opts: { variantId?: string; seed?: number; model?: string } = {},
): CaseRef {
  return {
    projectId: 'p-1',
    evalId: 'phase-c-test',
    runId: 'eval-42',
    caseId,
    model: opts.model ?? 'gpt-4o',
    ...(opts.variantId !== undefined ? { variantId: opts.variantId } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
}

function makeSlot(
  caseId: string,
  opts: { variantId?: string; seed?: number; model?: string } = {},
): CaseRunSlot {
  return {
    caseRef: makeCaseRef(caseId, opts),
    status: 'COMPLETED',
    passed: true,
    startedAt: '2025-01-01T00:00:00Z',
    completedAt: '2025-01-01T00:00:01Z',
    durationMs: 1000,
    capturePath:
      `posix:///projects/p-1/evaluations/phase-c-test/runs/eval-42/cases/${caseId}/capture.json`,
    telemetry: { e2eMs: 1000 },
    retrievalAnnotation: null,
    resolvedRuntimeParams: { model: opts.model ?? 'gpt-4o' },
    deterministicMetrics: {},
    judgeRubrics: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  mockRunPreflight.mockResolvedValue({
    summary: 'ready',
    checks: [],
    ranAt: '2025-01-01T00:00:00Z',
  });
  // `validateTestCases` is the workflow's second activity. Tests
  // that need a custom case fixture override
  // `mockValidateTestCases.mockResolvedValueOnce({ cases: [...] })`.
  mockValidateTestCases.mockResolvedValue({
    cases: [
      { id: 'case-1', input: { query: 'q1' }, evaluation: {} },
      { id: 'case-2', input: { query: 'q2' }, evaluation: {} },
    ],
    rowCount: 2,
    testCasesUri:
      'posix:///projects/p-1/evaluations/phase-c-test/testcases/cases.jsonl',
    inputCopyUri:
      'posix:///projects/p-1/evaluations/phase-c-test/runs/eval-42/_input/cases.jsonl',
  });
  // Default snapshot: returns baseInput() as the resolved jobInput.
  mockLoadRunSnapshot.mockImplementation(async () => ({
    jobInput: baseInput(),
    jobFolderUri:
      'posix:///projects/p-1/evaluations/phase-c-test/runs/eval-42/_input',
    evalId: 'phase-c-test',
    templateId: 'tpl-test',
    testCasesRef: {},
  }));
  mockAggregateMetrics.mockResolvedValue([]);
  mockComputeGates.mockResolvedValue({ triggeredGates: [], verdict: 'pass' });
  // Default: no previous run for the template — compare-default-baseline
  // does not fire. Tests that exercise the default path override this.
  mockFindPreviousRun.mockResolvedValue({ runId: null });
  mockBuildCompareReport.mockResolvedValue({
    runIdA: 'eval-42',
    runIdB: '',
    metricCount: 0,
    sliceCount: 0,
    pairwiseRan: false,
  });
  mockGetEvaluationJob.mockResolvedValue({
    runId: 'eval-42',
    status: 'success',
    input: baseInput(),
    audit: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  });
  mockWriteResultsFile.mockResolvedValue({
    resultsFileUri: 'artifact://results/eval-42.json',
  });
  mockWriteStakeholderReport.mockResolvedValue({
    reportUri: 'artifact://reports/eval-42.md',
  });

  mockRunCase.mockImplementation(
    async (input: {
      case: { id: string };
      model: string;
      variantId?: string;
      seed?: number;
    }) => {
      const summary: CaseRunSummary = {
        runId: 'eval-42',
        caseId: input.case.id,
        model: input.model,
        ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
        ...(input.seed !== undefined ? { repeatSeed: input.seed } : {}),
        status: 'COMPLETED',
        passed: true,
        durationMs: 1000,
        slot: makeSlot(input.case.id, {
          model: input.model,
          ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        }),
      };
      return summary;
    },
  );
});

describe('AgentEvaluationWorkflow — Phase c artifact dump', () => {
  it('accumulates per-case slots and dumps them via writeResultsFile + writeStakeholderReport', async () => {
    await AgentEvaluationWorkflow(wrap(baseInput()));

    expect(mockWriteResultsFile).toHaveBeenCalledTimes(1);
    expect(mockWriteResultsFile).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'eval-42',
        // envelopeHash is empty for now — version pinning is deferred to
        // EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §11.6. Re-tighten this assertion
        // when the versioning roadmap lands.
        provenance: expect.objectContaining({ envelopeHash: '' }),
        // Stage-1 path-only payloads: the parent passes `perCaseSlots`
        // (small, capture-path-bearing) — NOT full `CaseRunArtifact`s. The
        // activity reads each slot's `capturePath` from PVC at Phase c.
        perCaseSlots: expect.arrayContaining([
          expect.objectContaining({
            caseRef: expect.objectContaining({ caseId: 'case-1' }),
            capturePath: expect.stringMatching(/capture\.json$/),
          }),
          expect.objectContaining({
            caseRef: expect.objectContaining({ caseId: 'case-2' }),
            capturePath: expect.stringMatching(/capture\.json$/),
          }),
        ]),
      }),
    );
    expect(mockWriteStakeholderReport).toHaveBeenCalledTimes(1);
  });

  it('persists results before dumping artifacts', async () => {
    const order: string[] = [];
    mockUpdateJobResults.mockImplementation(async () => {
      order.push('updateJobResults');
    });
    mockWriteResultsFile.mockImplementation(async () => {
      order.push('writeResultsFile');
      return { resultsFileUri: 'uri' };
    });

    await AgentEvaluationWorkflow(wrap(baseInput()));

    expect(order.indexOf('updateJobResults')).toBeLessThan(
      order.indexOf('writeResultsFile'),
    );
  });

  it('still completes when stakeholder PDF rendering fails', async () => {
    mockWriteStakeholderReport.mockRejectedValueOnce(new Error('renderer 503'));
    // No throw expected — Phase c failures are non-fatal.
    await expect(AgentEvaluationWorkflow(wrap(baseInput()))).resolves.toBeDefined();
    // Results file still got written even though the PDF failed.
    expect(mockWriteResultsFile).toHaveBeenCalledTimes(1);
  });
});

describe('AgentEvaluationWorkflow — strategy → per-case input wiring', () => {
  function caseInputOf(callIndex: number): {
    judgeRubricIds: string[];
    scorerToggles: {
      goldenAssertions: boolean;
      golden: boolean;
      suiteDeterministic: boolean;
      safetyClassifier: boolean;
    };
  } {
    return mockRunCase.mock.calls[callIndex][0] as never;
  }

  it("forwards all-off scorerToggles to runCase when strategy='llm_judge'", async () => {
    const input = baseInput();
    input.evaluators.strategy = 'llm_judge';
    input.evaluators.enabledRubric = ['rag.faithfulness'];

    await AgentEvaluationWorkflow(wrap(input));

    const caseInput = caseInputOf(0);
    expect(caseInput.scorerToggles).toEqual({
      goldenAssertions: false,
      golden: false,
      suiteDeterministic: false,
      safetyClassifier: false,
    });
    expect(caseInput.judgeRubricIds).toEqual(['rag.faithfulness']);
  });

  it("forwards an empty rubric list when strategy='deterministic'", async () => {
    const input = baseInput();
    input.evaluators.strategy = 'deterministic';
    input.evaluators.enabledRubric = ['ignored.rubric'];

    await AgentEvaluationWorkflow(wrap(input));

    const caseInput = caseInputOf(0);
    expect(caseInput.judgeRubricIds).toEqual([]);
    // Deterministic scorers stay default-on (goldenAvailable defaults to true).
    expect(caseInput.scorerToggles.goldenAssertions).toBe(true);
    expect(caseInput.scorerToggles.suiteDeterministic).toBe(true);
  });

  it("enables both axes when strategy='deterministic_plus_llm_judge'", async () => {
    const input = baseInput();
    input.evaluators.strategy = 'deterministic_plus_llm_judge';
    input.evaluators.enabledRubric = ['rag.faithfulness', 'qa.helpfulness'];

    await AgentEvaluationWorkflow(wrap(input));

    const caseInput = caseInputOf(0);
    expect(caseInput.scorerToggles).toEqual({
      goldenAssertions: true,
      golden: true,
      suiteDeterministic: true,
      safetyClassifier: true,
    });
    expect(caseInput.judgeRubricIds).toEqual([
      'rag.faithfulness',
      'qa.helpfulness',
    ]);
  });
});

// ── Phase 4: ab_compare / regression / repeats matrix ─────────────────

describe('AgentEvaluationWorkflow — ab_compare matrix', () => {
  function tuplesFromCaseCalls(): Array<{
    caseId: string;
    model: string;
    variantId?: string;
    seed?: number;
    overrides: Record<string, unknown>;
  }> {
    return mockRunCase.mock.calls.map((call) => {
      const arg = call[0] as {
        case: { id: string };
        model: string;
        variantId?: string;
        seed?: number;
        overrides: Record<string, unknown>;
      };
      return {
        caseId: arg.case.id,
        model: arg.model,
        variantId: arg.variantId,
        seed: arg.seed,
        overrides: arg.overrides,
      };
    });
  }

  it('fans out cases × models × variants when ab.variants is set', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [
        { id: 'case-1', input: { query: 'q1' }, evaluation: {} },
        { id: 'case-2', input: { query: 'q2' }, evaluation: {} },
        { id: 'case-3', input: { query: 'q3' }, evaluation: {} },
      ],
      rowCount: 3,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    input.runMode = 'ab_compare';
    input.ab = {
      variants: [
        { variantId: 'A', label: 'control', overrides: { temperature: 0.2 } },
        { variantId: 'B', label: 'candidate', overrides: { temperature: 0.7 } },
      ],
      comparabilityChecks: [],
    };

    await AgentEvaluationWorkflow(wrap(input));

    const tuples = tuplesFromCaseCalls();
    // 3 cases × 1 model × 2 variants = 6 runCase invocations
    expect(tuples).toHaveLength(6);

    const grouped = tuples.reduce<Record<string, string[]>>((acc, t) => {
      acc[t.variantId ?? 'none'] ??= [];
      acc[t.variantId ?? 'none'].push(t.caseId);
      return acc;
    }, {});
    expect(grouped.A.sort()).toEqual(['case-1', 'case-2', 'case-3']);
    expect(grouped.B.sort()).toEqual(['case-1', 'case-2', 'case-3']);
  });

  it('applies the variant overrides to each per-case input', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [{ id: 'case-1', input: { query: 'q1' }, evaluation: {} }],
      rowCount: 1,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    input.runMode = 'ab_compare';
    input.ab = {
      variants: [
        { variantId: 'A', label: 'a', overrides: { temperature: 0.2 } },
        { variantId: 'B', label: 'b', overrides: { temperature: 0.9, maxTokens: 1024 } },
      ],
      comparabilityChecks: [],
    };

    await AgentEvaluationWorkflow(wrap(input));

    const tuples = tuplesFromCaseCalls();
    const a = tuples.find((t) => t.variantId === 'A');
    const b = tuples.find((t) => t.variantId === 'B');
    // `templateSnapshot.models[]` is reserved for a future tuning /
    // model-sweep feature and is intentionally NOT wired into the
    // agent fan-out today. The workflow no longer threads `model`
    // into the per-case `overrides` bag; the agent runs on its own
    // configured model regardless of what `input.models` contains.
    expect(a?.overrides).toMatchObject({ temperature: 0.2 });
    expect(a?.overrides).not.toHaveProperty('model');
    expect(b?.overrides).toMatchObject({
      temperature: 0.9,
      maxTokens: 1024,
    });
    expect(b?.overrides).not.toHaveProperty('model');
  });

  // Note: the legacy "pre-fanned-out variantId by a config-service composition
  // driver" path inside variantAxis() is preserved as a fallback for direct
  // workflow callers, but it's not reachable through the new template-based
  // entry (resolveTemplateRuntime never sets variantId).

  it('per-case slots (passed to writeResultsFile) carry variantId per slice via caseRef', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [
        { id: 'case-1', input: { query: 'q1' }, evaluation: {} },
        { id: 'case-2', input: { query: 'q2' }, evaluation: {} },
      ],
      rowCount: 2,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });

    const input = baseInput();
    input.runMode = 'ab_compare';
    input.ab = {
      variants: [
        { variantId: 'A', label: 'a', overrides: {} },
        { variantId: 'B', label: 'b', overrides: {} },
      ],
      comparabilityChecks: [],
    };

    await AgentEvaluationWorkflow(wrap(input));

    // Stage-1 path-only payloads: variant identity travels on
    // `slot.caseRef.variantId`, not on the in-memory artifact (which is
    // materialized later from PVC by `writeResultsFile`).
    const callArg = mockWriteResultsFile.mock.calls[0][0] as {
      perCaseSlots: CaseRunSlot[];
    };
    const tagged = callArg.perCaseSlots.map((s) => ({
      caseId: s.caseRef.caseId,
      variantId: s.caseRef.variantId,
    }));
    expect(tagged).toHaveLength(4);
    expect(tagged.filter((t) => t.variantId === 'A')).toHaveLength(2);
    expect(tagged.filter((t) => t.variantId === 'B')).toHaveLength(2);
  });
});

describe('AgentEvaluationWorkflow — regression mode', () => {
  it('invokes compareToBaseline when regression.baselineJobId is set', async () => {
    mockCompareToBaseline.mockResolvedValue({
      baselineJobId: 'baseline-99',
      metrics: [
        {
          id: 'rag.groundedness',
          delta: 0.05,
          deltaPercent: 6.25,
          significant: true,
        },
      ],
    });

    const input = baseInput();
    input.runMode = 'regression';
    input.regression = { baselineJobId: 'baseline-99' };

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockCompareToBaseline).toHaveBeenCalledTimes(1);
    expect(mockCompareToBaseline).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'eval-42',
        baselineJobId: 'baseline-99',
      }),
    );
  });

  it('does not call findPreviousRun when a baselineJobId is pinned', async () => {
    const input = baseInput();
    input.runMode = 'regression';
    input.regression = { baselineJobId: 'baseline-99' };

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockFindPreviousRun).not.toHaveBeenCalled();
  });

  it('does not call findPreviousRun when inline expectations are set', async () => {
    const input = baseInput();
    input.runMode = 'regression';
    input.regression = {
      expectations: [{ id: 'rag.groundedness', value: 0.85 }],
    };

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockFindPreviousRun).not.toHaveBeenCalled();
    // compareToBaseline still fires because the inline-expectations source
    // is enough to drive a comparison.
    expect(mockCompareToBaseline).toHaveBeenCalledTimes(1);
  });

  it('attaches baselineComparison to updateJobResults', async () => {
    const cmp = {
      baselineJobId: 'baseline-99',
      metrics: [
        {
          id: 'response.helpfulness',
          delta: -0.02,
          deltaPercent: -2.4,
          significant: false,
        },
      ],
    };
    mockCompareToBaseline.mockResolvedValue(cmp);

    const input = baseInput();
    input.runMode = 'regression';
    input.regression = { baselineJobId: 'baseline-99' };

    await AgentEvaluationWorkflow(wrap(input));

    const lastResultsCall =
      mockUpdateJobResults.mock.calls[mockUpdateJobResults.mock.calls.length - 1];
    const sent = lastResultsCall[0] as { results: { baselineComparison?: unknown } };
    expect(sent.results.baselineComparison).toEqual(cmp);
  });
});

// ── Item 7: default-to-previous-run baseline + Phase c rich compare ───

describe('AgentEvaluationWorkflow — compare default-baseline lookup (item 7)', () => {
  it('falls back to findPreviousRun when no baseline is pinned and runs compareToBaseline against it', async () => {
    mockFindPreviousRun.mockResolvedValueOnce({ runId: 'prev-7' });
    mockCompareToBaseline.mockResolvedValue({
      baselineJobId: 'prev-7',
      metrics: [
        {
          id: 'rag.groundedness',
          delta: 0.01,
          deltaPercent: 1.2,
          significant: false,
        },
      ],
    });

    const input = baseInput();
    // Single mode — no `regression` block at all. The new default still
    // tries to find a prior run for the template.
    input.runMode = 'single';

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockFindPreviousRun).toHaveBeenCalledTimes(1);
    expect(mockFindPreviousRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p-1',
        templateId: 'tpl-test',
        currentRunId: 'eval-42',
      }),
    );
    expect(mockCompareToBaseline).toHaveBeenCalledTimes(1);
    expect(mockCompareToBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ baselineJobId: 'prev-7' }),
    );
  });

  it('skips compareToBaseline when no baseline is pinned and there is no previous run', async () => {
    mockFindPreviousRun.mockResolvedValueOnce({ runId: null });

    const input = baseInput();
    input.runMode = 'single';

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockFindPreviousRun).toHaveBeenCalledTimes(1);
    expect(mockCompareToBaseline).not.toHaveBeenCalled();
    expect(mockBuildCompareReport).not.toHaveBeenCalled();
  });

  it('skips compareToBaseline silently when findPreviousRun throws', async () => {
    mockFindPreviousRun.mockRejectedValueOnce(new Error('config-service 503'));

    const input = baseInput();
    input.runMode = 'single';

    await AgentEvaluationWorkflow(wrap(input));

    // The lookup error is swallowed — the run still completes without a
    // compare. `compareToBaseline` is NOT called because no baseline was
    // resolved.
    expect(mockCompareToBaseline).not.toHaveBeenCalled();
    expect(mockBuildCompareReport).not.toHaveBeenCalled();
  });

  it('invokes buildCompareReport in Phase c when a baseline was resolved (defaulted)', async () => {
    mockFindPreviousRun.mockResolvedValueOnce({ runId: 'prev-99' });
    mockCompareToBaseline.mockResolvedValue({
      baselineJobId: 'prev-99',
      metrics: [],
    });

    const input = baseInput();
    input.runMode = 'single';

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockBuildCompareReport).toHaveBeenCalledTimes(1);
    expect(mockBuildCompareReport).toHaveBeenCalledWith(
      expect.objectContaining({
        runIdA: 'eval-42',
        runIdB: 'prev-99',
      }),
    );
  });

  it('invokes buildCompareReport in Phase c when a baselineJobId is pinned', async () => {
    mockCompareToBaseline.mockResolvedValue({
      baselineJobId: 'pin-1',
      metrics: [],
    });

    const input = baseInput();
    input.runMode = 'regression';
    input.regression = { baselineJobId: 'pin-1' };

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockBuildCompareReport).toHaveBeenCalledTimes(1);
    expect(mockBuildCompareReport).toHaveBeenCalledWith(
      expect.objectContaining({
        runIdA: 'eval-42',
        runIdB: 'pin-1',
      }),
    );
  });

  it('does NOT invoke buildCompareReport when only inline expectations were the baseline source', async () => {
    // Inline expectations enable `compareToBaseline` (numeric headlines)
    // but there is no peer run to diff per-case rows against, so the rich
    // `buildCompareReport` (which reads the baseline run's results.json)
    // shouldn't fire.
    mockCompareToBaseline.mockResolvedValue({
      metrics: [],
    });
    const input = baseInput();
    input.runMode = 'regression';
    input.regression = {
      expectations: [{ id: 'rag.groundedness', value: 0.85 }],
    };

    await AgentEvaluationWorkflow(wrap(input));

    expect(mockBuildCompareReport).not.toHaveBeenCalled();
  });

  it('still finalizes the run when buildCompareReport fails', async () => {
    mockFindPreviousRun.mockResolvedValueOnce({ runId: 'prev-x' });
    mockCompareToBaseline.mockResolvedValue({
      baselineJobId: 'prev-x',
      metrics: [],
    });
    mockBuildCompareReport.mockRejectedValueOnce(new Error('compose failed'));

    const input = baseInput();
    input.runMode = 'single';

    // Phase c failures must not abort the workflow.
    await expect(AgentEvaluationWorkflow(wrap(input))).resolves.toBeDefined();
    const finalStatus = mockUpdateJobStatus.mock.calls
      .map((c) => (c[0] as { status: string }).status)
      .pop();
    expect(finalStatus).toBe('success');
  });
});

describe('AgentEvaluationWorkflow — repeats mode', () => {
  it('fans out across explicit seeds[]', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [{ id: 'case-1', input: { query: 'q' }, evaluation: {} }],
      rowCount: 1,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    input.repeats = { count: 3, seeds: [11, 22, 33] };

    await AgentEvaluationWorkflow(wrap(input));

    const seeds = mockRunCase.mock.calls
      .map((call) => (call[0] as { seed?: number }).seed)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(seeds).toEqual([11, 22, 33]);
  });

  it('generates 0..count-1 seeds when only count is provided', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [{ id: 'case-1', input: { query: 'q' }, evaluation: {} }],
      rowCount: 1,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    input.repeats = { count: 4 };

    await AgentEvaluationWorkflow(wrap(input));

    const seeds = mockRunCase.mock.calls
      .map((call) => (call[0] as { seed?: number }).seed)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(seeds).toEqual([0, 1, 2, 3]);
  });

  it('produces cases × seeds tuples (template models[] reserved for future tuning, not wired)', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [
        { id: 'case-1', input: { query: 'q1' }, evaluation: {} },
        { id: 'case-2', input: { query: 'q2' }, evaluation: {} },
      ],
      rowCount: 2,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    // `templateSnapshot.models[]` is reserved for a future tuning /
    // model-sweep feature. It is intentionally NOT wired into the
    // agent fan-out today. Even with two entries here the agent still
    // runs once per (case × seed) against its own configured model.
    input.models = ['gpt-4o', 'claude-sonnet'];
    input.repeats = { count: 3 };

    await AgentEvaluationWorkflow(wrap(input));

    // 2 cases × 3 seeds = 6 runCase invocations (models[] ignored).
    expect(mockRunCase).toHaveBeenCalledTimes(6);
  });
});

describe('AgentEvaluationWorkflow — combo ab_compare + repeats', () => {
  it('multiplies the variants × seeds axes', async () => {
    mockValidateTestCases.mockResolvedValue({
      cases: [{ id: 'case-1', input: { query: 'q' }, evaluation: {} }],
      rowCount: 1,
      datasetUri: 'posix:///x',
      inputCopyUri: 'posix:///y',
    });
    const input = baseInput();
    input.runMode = 'ab_compare';
    input.ab = {
      variants: [
        { variantId: 'A', label: 'a', overrides: {} },
        { variantId: 'B', label: 'b', overrides: {} },
      ],
      comparabilityChecks: [],
    };
    input.repeats = { count: 2, seeds: [7, 9] };

    await AgentEvaluationWorkflow(wrap(input));

    // 1 case × 1 model × 2 variants × 2 seeds = 4 runCase invocations
    expect(mockRunCase).toHaveBeenCalledTimes(4);
    const sigs = mockRunCase.mock.calls
      .map((call) => {
        const a = call[0] as { variantId?: string; seed?: number };
        return `${a.variantId}/${a.seed}`;
      })
      .sort();
    expect(sigs).toEqual(['A/7', 'A/9', 'B/7', 'B/9']);
  });
});

// ── Phase 6: audit + cancellation surfaces ────────────────────────────

describe('AgentEvaluationWorkflow — audit lifecycle', () => {
  it('drives status transitions queued → running → aggregating → success on a clean run', async () => {
    await AgentEvaluationWorkflow(wrap(baseInput()));

    const statusCalls = mockUpdateJobStatus.mock.calls.map(
      (c) => (c[0] as { status: string }).status,
    );
    expect(statusCalls).toEqual(['queued', 'running', 'aggregating', 'success']);
  });

  it('emits a terminal evaluation.completed audit event on success', async () => {
    await AgentEvaluationWorkflow(wrap(baseInput()));

    const actions = mockWriteAuditEvent.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(actions).toContain('evaluation.completed');
    const terminalEvent = mockWriteAuditEvent.mock.calls
      .map((c) => c[0] as { runId: string; action: string; actor: string })
      .find((e) => e.action === 'evaluation.completed');
    expect(terminalEvent?.runId).toBe('eval-42');
    expect(terminalEvent?.actor).toMatch(/^workflow:/);
  });

  it('emits evaluation.failed with the failure reason when preflight is blocked', async () => {
    mockRunPreflight.mockResolvedValueOnce({
      summary: 'blocked',
      nonPromotable: true,
      checks: [],
      ranAt: '2025-01-01T00:00:00Z',
    });

    await AgentEvaluationWorkflow(wrap(baseInput()));

    const failedAudit = mockWriteAuditEvent.mock.calls
      .map((c) => c[0] as { action: string; details?: Record<string, unknown> })
      .find((e) => e.action === 'evaluation.failed');
    expect(failedAudit).toBeDefined();
    expect(failedAudit?.details?.reason).toBe('preflight_blocked');
    // Final status patched accordingly.
    const finalStatus = mockUpdateJobStatus.mock.calls
      .map((c) => (c[0] as { status: string }).status)
      .pop();
    expect(finalStatus).toBe('failed');
  });
});

describe('AgentEvaluationWorkflow — cancellation surface', () => {
  it('catches a CancelledFailure from runCase and transitions to cancelled', async () => {
    // Re-import the mocked module so we can access the CancelledFailureMock class
    // to throw an instance of it from a per-case stub.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CancelledFailure } = require('@temporalio/workflow');
    mockRunCase.mockImplementationOnce(() => {
      throw new CancelledFailure('case cancelled');
    });
    // isCancellation must classify the thrown error as cancellation for the
    // workflow's catch branch to fire.
    mockIsCancellation.mockReturnValueOnce(true);

    await AgentEvaluationWorkflow(wrap(baseInput()));

    const finalStatus = mockUpdateJobStatus.mock.calls
      .map((c) => (c[0] as { status: string }).status)
      .pop();
    expect(finalStatus).toBe('cancelled');

    const stoppedAudit = mockWriteAuditEvent.mock.calls
      .map((c) => c[0] as { action: string; details?: Record<string, unknown> })
      .find((e) => e.action === 'evaluation.stopped');
    expect(stoppedAudit).toBeDefined();
    expect(stoppedAudit?.details?.reason).toBe('hard_cancel');
  });
});
