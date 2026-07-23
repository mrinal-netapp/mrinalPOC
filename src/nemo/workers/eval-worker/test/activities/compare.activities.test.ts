import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@temporalio/activity', () => ({
  ApplicationFailure: class extends Error {
    public type: string;
    public nonRetryable: boolean;
    constructor(message: string, type: string) {
      super(message);
      this.type = type;
      this.nonRetryable = true;
    }
    static nonRetryable(message: string, type: string) {
      return new this(message, type);
    }
  },
  heartbeat: jest.fn(),
}));
jest.mock('../../src/lib/got', () => {
  const actual =
    jest.requireActual('../../src/lib/got') as typeof import('../../src/lib/got');
  return { ...actual, gotGet: jest.fn() };
});
jest.mock('../../src/activities/judge.activities', () => ({
  invokePairwiseJudge: jest.fn(),
}));

import { gotGet } from '../../src/lib/got';
import { invokePairwiseJudge } from '../../src/activities/judge.activities';
import { buildCompareReport } from '../../src/activities/compare.activities';
import type {
  CaseRunArtifact,
  EvaluationDimension,
  EvaluationJob,
  EvaluationResults,
  JudgeRubricOutput,
  ProvenanceEnvelope,
} from '../../src/lib/evaluation';

const mockGotGet = gotGet as jest.MockedFunction<typeof gotGet>;
const mockInvokePairwiseJudge = invokePairwiseJudge as jest.MockedFunction<
  typeof invokePairwiseJudge
>;

function makeProvenance(extra: Partial<ProvenanceEnvelope> = {}): ProvenanceEnvelope {
  return {
    agentVersionHash: 'a-hash',
    datasetVersion: 'v1',
    retrievalIndexVersion: 'idx-1',
    toolRegistryVersion: 't-1',
    generatorModelVersion: 'g-1',
    rubricIds: [],
    rubricPrompts: [],
    envelopeHash: 'env-hash',
    ...extra,
  };
}

function makeArtifact(
  caseId: string,
  overrides: Partial<CaseRunArtifact> = {},
): CaseRunArtifact {
  const runId = overrides.runId ?? 'run-A';
  return {
    runId,
    caseId,
    model: 'gpt-4o',
    status: 'COMPLETED',
    passed: true,
    startedAt: '2026-06-01T00:00:00Z',
    completedAt: '2026-06-01T00:00:01Z',
    durationMs: 1000,
    response: 'response',
    citations: [],
    retrievedChunks: [],
    toolCalls: [],
    perAgent: [],
    retrievalAnnotation: null,
    resolvedRuntimeParams: { model: 'gpt-4o' },
    deterministicMetrics: {},
    judgeRubrics: [],
    telemetry: { e2eMs: 1000 },
    // Stage-1 path-only payloads: every COMPLETED row in results.json
    // carries a `capturePath`. The pairwise-judge composer reads this
    // field (not `response`) when deciding whether a pair is judgeable.
    capturePath: `posix:///projects/proj-1/evaluations/eval-x/runs/${runId}/cases/${caseId}/capture.json`,
    ...overrides,
  };
}

function makeResults(headline: Record<string, number>): EvaluationResults {
  const dimensions: EvaluationDimension[] = [
    { id: 'perf', label: 'Performance', headline },
  ];
  return {
    verdict: 'pass',
    triggeredGates: [],
    dimensions,
    coverage: { total: 2, completed: 2, completedPct: 100 },
    infraFailureRate: 0,
    judgeCoverage: { scored: 0, target: 0, pct: 0 },
    preFlightNonPromotable: false,
    runStopped: false,
  };
}

interface ResultsFileBody {
  runId: string;
  results: EvaluationResults;
  perCaseArtifacts: CaseRunArtifact[];
  provenance: ProvenanceEnvelope;
}

/**
 * Stage a results.json file on the PVC at the canonical POSIX key. Per
 * architecture v3 the path is fully derived from `(projectId, evalId, runId)`
 * via `runDirKey()`; nothing on the EvaluationRun row points at it.
 */
async function stageResultsFile(
  storeRoot: string,
  runId: string,
  body: ResultsFileBody,
  evalId = 'eval-x',
  projectId = 'proj-1',
): Promise<void> {
  const key = `projects/${projectId}/evaluations/${evalId}/runs/${runId}/results.json`;
  const abs = path.join(storeRoot, key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(body), 'utf8');
}

/**
 * Read the (possibly merge-mutated) results.json back from disk so a test
 * can assert that `buildCompareReport` embedded `compareReport` on the
 * runIdA body.
 */
async function readResultsFile(
  storeRoot: string,
  runId: string,
  evalId = 'eval-x',
  projectId = 'proj-1',
): Promise<ResultsFileBody & { compareReport?: unknown }> {
  const key = `projects/${projectId}/evaluations/${evalId}/runs/${runId}/results.json`;
  const text = await fs.readFile(path.join(storeRoot, key), 'utf8');
  return JSON.parse(text) as ResultsFileBody & { compareReport?: unknown };
}

function makeJob(
  runId: string,
  overrides: Partial<EvaluationJob['input']> = {},
): EvaluationJob {
  return {
    runId,
    status: 'success',
    input: {
      runId,
      evalName: 'eval-x',
      evalId: 'eval-x',
      projectId: 'proj-1',
      target: 'agent_version',
      agentTeam: 'team',
      evaluationScope: 'full_agent_execution',
      suite: 'rag',
      runMode: 'ab_compare',
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
        coverageMinPct: 0,
        infraFailureMaxPct: 100,
        safetyP0Threshold: 0,
      },
      provenance: makeProvenance(),
      ...overrides,
    } as EvaluationJob['input'],
    audit: [],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

describe('buildCompareReport', () => {
  const origEnv = { ...process.env };
  let storeRoot: string;

  beforeAll(async () => {
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'compare-test-'));
  });

  afterAll(async () => {
    await fs.rm(storeRoot, { recursive: true, force: true });
    process.env = origEnv;
  });

  beforeEach(() => {
    process.env['CONFIG_SERVICE_URL'] = 'http://config.test';
    process.env['NEMO_DEFAULT_STORE_ROOT'] = storeRoot;
    mockGotGet.mockReset();
    mockInvokePairwiseJudge.mockReset();
  });

  it('happy path: composes report and merges it into runIdA results.json (no separate file)', async () => {
    // Stage two results.json files on disk.
    const bodyA: ResultsFileBody = {
      runId: 'A',
      results: makeResults({ 'perf.e2e_ms': 1000 }),
      perCaseArtifacts: [makeArtifact('case-1')],
      provenance: makeProvenance({ envelopeHash: 'env-A' }),
    };
    const bodyB: ResultsFileBody = {
      runId: 'B',
      results: makeResults({ 'perf.e2e_ms': 1500 }),
      perCaseArtifacts: [makeArtifact('case-1', { runId: 'B' })],
      provenance: makeProvenance({ envelopeHash: 'env-B' }),
    };
    await stageResultsFile(storeRoot, 'A', bodyA);
    await stageResultsFile(storeRoot, 'B', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('A'))
      .mockResolvedValueOnce(makeJob('B'));

    const out = await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'A',
      runIdB: 'B',
      comparabilityChecks: [],
    });

    // Item 7: the activity returns observability counters only; the report
    // itself is merged into <runIdA>/results.json.
    expect(out.runIdA).toBe('A');
    expect(out.runIdB).toBe('B');
    expect(out.metricCount).toBeGreaterThanOrEqual(0);
    expect(out.sliceCount).toBeGreaterThanOrEqual(0);
    expect(out.pairwiseRan).toBe(false);

    // The current-run results.json now carries `compareReport` inline.
    const merged = await readResultsFile(storeRoot, 'A');
    expect(merged.runId).toBe('A');
    const cmp = merged.compareReport as {
      projectId: 'p-1',
      runIdA: string;
      runIdB: string;
      metricComparisons: unknown[];
      sliceDeltas: unknown[];
      tradeoff: unknown;
      pairwise?: unknown;
    };
    expect(cmp).toBeDefined();
    expect(cmp.runIdA).toBe('A');
    expect(cmp.runIdB).toBe('B');
    expect(cmp.metricComparisons).toEqual(expect.any(Array));
    expect(cmp.sliceDeltas).toEqual(expect.any(Array));
    expect(cmp.tradeoff).toEqual(expect.any(Object));
    expect(cmp.pairwise).toBeUndefined();

    // The legacy `compares/` cross-cutting directory must NOT be created.
    const legacyAbs = path.join(
      storeRoot,
      'projects/proj-1/evaluations/eval-x/compares/A_vs_B/compare_report.json',
    );
    await expect(fs.stat(legacyAbs)).rejects.toThrow();
  });

  it('emits a comparability info entry when the two provenance envelopes diverge', async () => {
    const bodyA: ResultsFileBody = {
      runId: 'cmp-A2',
      results: makeResults({}),
      perCaseArtifacts: [],
      provenance: makeProvenance({ envelopeHash: 'env-A' }),
    };
    const bodyB: ResultsFileBody = {
      runId: 'cmp-B2',
      results: makeResults({}),
      perCaseArtifacts: [],
      provenance: makeProvenance({ envelopeHash: 'env-B' }),
    };
    await stageResultsFile(storeRoot, 'cmp-A2', bodyA);
    await stageResultsFile(storeRoot, 'cmp-B2', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('cmp-A2'))
      .mockResolvedValueOnce(makeJob('cmp-B2'));

    await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'cmp-A2',
      runIdB: 'cmp-B2',
      comparabilityChecks: [],
    });

    const merged = await readResultsFile(storeRoot, 'cmp-A2');
    const cmp = merged.compareReport as {
      comparabilityIssues: Array<{ ruleId: string }>;
    };
    const ruleIds = cmp.comparabilityIssues.map((i) => i.ruleId);
    expect(ruleIds).toContain('envelope.diff');
  });

  it('throws NotFoundError when one of the EvaluationJob rows is missing', async () => {
    mockGotGet
      .mockResolvedValueOnce(makeJob('X'))
      .mockResolvedValueOnce(null as unknown as never);

    await expect(
      buildCompareReport({
        projectId: 'p-1',
        runIdA: 'X',
        runIdB: 'Y',
        comparabilityChecks: [],
      }),
    ).rejects.toMatchObject({ type: 'NotFoundError' });
  });

  it('throws NotFoundError when the results.json file is missing on disk', async () => {
    mockGotGet
      .mockResolvedValueOnce(makeJob('missing-A'))
      .mockResolvedValueOnce(makeJob('missing-B'));

    await expect(
      buildCompareReport({
        projectId: 'p-1',
        runIdA: 'missing-A',
        runIdB: 'missing-B',
        comparabilityChecks: [],
      }),
    ).rejects.toMatchObject({ type: 'NotFoundError' });
  });

  it('throws InvalidInputError when CONFIG_SERVICE_URL is unset', async () => {
    delete process.env['CONFIG_SERVICE_URL'];
    await expect(
      buildCompareReport({
        projectId: 'p-1',
        runIdA: 'A',
        runIdB: 'B',
        comparabilityChecks: [],
      }),
    ).rejects.toMatchObject({ type: 'InvalidInputError' });
  });

  // ── Pairwise judge composition ────────────────────────────────────

  it('runs pairwise judge per case × rubric, aggregates wins/ties/errored', async () => {
    const bodyA: ResultsFileBody = {
      runId: 'pw-A',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('c1', { response: 'A-c1' }),
        makeArtifact('c2', { response: 'A-c2' }),
      ],
      provenance: makeProvenance(),
    };
    const bodyB: ResultsFileBody = {
      runId: 'pw-B',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('c1', { runId: 'pw-B', response: 'B-c1' }),
        makeArtifact('c2', { runId: 'pw-B', response: 'B-c2' }),
      ],
      provenance: makeProvenance(),
    };
    await stageResultsFile(storeRoot, 'pw-A', bodyA);
    await stageResultsFile(storeRoot, 'pw-B', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('pw-A'))
      .mockResolvedValueOnce(makeJob('pw-B'));

    // Configure the judge mock to return A-wins for c1 and a tie for c2.
    function verdict(winner: 'A' | 'B' | 'tie'): JudgeRubricOutput {
      return {
        rubricId: 'helpfulness',
        judgeModelName: 'gpt-4o',
        judgeVersion: 'live',
        rubricPromptHash: 'hash',
        mode: 'pairwise',
        score: 0.8,
        winner,
      };
    }
    mockInvokePairwiseJudge.mockImplementation(async ({ case: c }) => {
      if ((c as { id: string }).id === 'c1') return verdict('A');
      return verdict('tie');
    });

    const out = await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'pw-A',
      runIdB: 'pw-B',
      comparabilityChecks: [],
      pairwiseRubrics: ['helpfulness'],
      evaluatorModel: 'gpt-4o',
      evaluatorVersion: 'live',
    });

    expect(out.pairwiseRan).toBe(true);
    const merged = await readResultsFile(storeRoot, 'pw-A');
    const cmp = merged.compareReport as {
      pairwise?: {
        perCase: Array<{ caseId: string }>;
        aggregate: { winsA: number; winsB: number; ties: number; errored: number };
      };
    };
    expect(cmp.pairwise).toBeDefined();
    const pw = cmp.pairwise!;
    expect(pw.perCase).toHaveLength(2);
    expect(pw.aggregate).toEqual({ winsA: 1, winsB: 0, ties: 1, errored: 0 });
    expect(mockInvokePairwiseJudge).toHaveBeenCalledTimes(2);
  });

  it('skips pairing when one side lacks a capture path, and counts judge throws as errored', async () => {
    const bodyA: ResultsFileBody = {
      runId: 'pw-A2',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('c-with', { response: 'A' }),
        // c-empty on side A had an infra failure during invokeAgent and
        // never wrote a capture file → no capturePath. Pair is unjudgeable.
        makeArtifact('c-empty', { response: '', capturePath: undefined }),
      ],
      provenance: makeProvenance(),
    };
    const bodyB: ResultsFileBody = {
      runId: 'pw-B2',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('c-with', { runId: 'pw-B2', response: 'B' }),
        makeArtifact('c-empty', { runId: 'pw-B2', response: 'B' }),
      ],
      provenance: makeProvenance(),
    };
    await stageResultsFile(storeRoot, 'pw-A2', bodyA);
    await stageResultsFile(storeRoot, 'pw-B2', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('pw-A2'))
      .mockResolvedValueOnce(makeJob('pw-B2'));

    // Judge throws — caller should record errored: true.
    mockInvokePairwiseJudge.mockRejectedValueOnce(new Error('gateway down'));

    await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'pw-A2',
      runIdB: 'pw-B2',
      comparabilityChecks: [],
      pairwiseRubrics: ['helpfulness'],
    });

    const merged = await readResultsFile(storeRoot, 'pw-A2');
    const cmp = merged.compareReport as {
      pairwise?: {
        perCase: Array<{ caseId: string }>;
        aggregate: { winsA: number; winsB: number; ties: number; errored: number };
      };
    };
    const pw = cmp.pairwise!;
    // c-empty was filtered out; only c-with was paired.
    expect(pw.perCase).toHaveLength(1);
    expect(pw.perCase[0].caseId).toBe('c-with');
    expect(pw.aggregate.errored).toBe(1);
  });

  it('skips pairs when caseId only appears on one side', async () => {
    const bodyA: ResultsFileBody = {
      runId: 'pw-A3',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('shared', { response: 'A' }),
        makeArtifact('a-only', { response: 'A' }),
      ],
      provenance: makeProvenance(),
    };
    const bodyB: ResultsFileBody = {
      runId: 'pw-B3',
      results: makeResults({}),
      perCaseArtifacts: [
        makeArtifact('shared', { runId: 'pw-B3', response: 'B' }),
        makeArtifact('b-only', { runId: 'pw-B3', response: 'B' }),
      ],
      provenance: makeProvenance(),
    };
    await stageResultsFile(storeRoot, 'pw-A3', bodyA);
    await stageResultsFile(storeRoot, 'pw-B3', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('pw-A3'))
      .mockResolvedValueOnce(makeJob('pw-B3'));

    mockInvokePairwiseJudge.mockResolvedValue({
      rubricId: 'helpfulness',
      judgeModelName: 'gpt-4o',
      judgeVersion: 'live',
      rubricPromptHash: 'hash',
      mode: 'pairwise',
      score: 0.5,
      winner: 'tie',
    });

    await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'pw-A3',
      runIdB: 'pw-B3',
      comparabilityChecks: [],
      pairwiseRubrics: ['helpfulness'],
    });

    const merged = await readResultsFile(storeRoot, 'pw-A3');
    const cmp = merged.compareReport as {
      pairwise?: { perCase: Array<{ caseId: string }> };
    };
    expect(cmp.pairwise!.perCase.map((p) => p.caseId)).toEqual(['shared']);
    expect(mockInvokePairwiseJudge).toHaveBeenCalledTimes(1);
  });

  it('preserves existing fields on results.json when merging compareReport', async () => {
    // Compare must NOT clobber `results`, `perCaseArtifacts`, or
    // `provenance` — only adds `compareReport` as a new field.
    const bodyA: ResultsFileBody = {
      runId: 'merge-A',
      results: makeResults({ 'perf.e2e_ms': 700 }),
      perCaseArtifacts: [makeArtifact('only-case')],
      provenance: makeProvenance({ envelopeHash: 'preserved' }),
    };
    const bodyB: ResultsFileBody = {
      runId: 'merge-B',
      results: makeResults({ 'perf.e2e_ms': 800 }),
      perCaseArtifacts: [makeArtifact('only-case', { runId: 'merge-B' })],
      provenance: makeProvenance(),
    };
    await stageResultsFile(storeRoot, 'merge-A', bodyA);
    await stageResultsFile(storeRoot, 'merge-B', bodyB);
    mockGotGet
      .mockResolvedValueOnce(makeJob('merge-A'))
      .mockResolvedValueOnce(makeJob('merge-B'));

    await buildCompareReport({
      projectId: 'p-1',
      runIdA: 'merge-A',
      runIdB: 'merge-B',
      comparabilityChecks: [],
    });

    const merged = await readResultsFile(storeRoot, 'merge-A');
    expect(merged.runId).toBe('merge-A');
    expect(merged.perCaseArtifacts).toHaveLength(1);
    expect(merged.perCaseArtifacts[0].caseId).toBe('only-case');
    expect(merged.provenance.envelopeHash).toBe('preserved');
    expect(merged.compareReport).toBeDefined();
  });
});
