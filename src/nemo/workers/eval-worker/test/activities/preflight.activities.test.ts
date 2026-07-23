jest.mock('../../src/lib/got', () => {
  const actual =
    jest.requireActual('../../src/lib/got') as typeof import('../../src/lib/got');
  return {
    ...actual,
    gotGet: jest.fn(),
  };
});

import { gotGet } from '../../src/lib/got';
import { runPreflight } from '../../src/activities/preflight.activities';
import type { EvaluationJobInput } from '../../src/lib/evaluation';

const mockGotGet = gotGet as jest.MockedFunction<typeof gotGet>;

function baseJob(
  overrides: Partial<EvaluationJobInput> = {},
): EvaluationJobInput {
  return {
    runId: 'run-1',
    evalName: 'preflight-test',
    projectId: 'proj-1',
    target: 'agent_version',
    agentTeam: 'team',
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
      coverageMinPct: 0,
      infraFailureMaxPct: 100,
      safetyP0Threshold: 0,
    },
    provenance: {
      agentVersionHash: '',
      datasetVersion: 'snapshot',
      retrievalIndexVersion: 'idx-v1',
      toolRegistryVersion: '',
      generatorModelVersion: '',
      rubricIds: [],
      rubricPrompts: [],
      envelopeHash: '',
    },
    concurrency: 4,
    ...overrides,
  };
}

function httpError(statusCode: number): Error & { response: { statusCode: number } } {
  const err = new Error(`HTTP ${statusCode}`) as Error & {
    response: { statusCode: number };
  };
  err.response = { statusCode };
  const got = jest.requireActual('got') as { HTTPError: new (...args: never[]) => Error };
  Object.setPrototypeOf(err, got.HTTPError.prototype);
  return err;
}

function findCheck(
  summary: { checks: Array<{ id: string }> },
  id: string,
): { id: string; status: string } & Record<string, unknown> {
  const c = summary.checks.find((c) => c.id === id);
  if (!c) throw new Error(`expected preflight check '${id}' in summary`);
  return c as unknown as { id: string; status: string } & Record<string, unknown>;
}

describe('runPreflight', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['RETRIEVAL_SERVICE_URL'];
    delete process.env['TOOL_SERVICE_URL'];
    delete process.env['LLM_GATEWAY_URL'];
    delete process.env['EVAL_QUOTA_USD'];
    mockGotGet.mockReset();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  // ── Aggregate behavior ────────────────────────────────────────────

  it('emits all 5 checks + runtimeEstimate', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    const ids = summary.checks.map((c) => c.id).sort();
    expect(ids).toEqual([
      'dataset_schema',
      'evaluator_availability',
      'retrieval_index',
      'runtime_estimate',
      'tool_connectivity',
    ]);
    expect(summary.runtimeEstimate).toBeDefined();
    expect(summary.runtimeEstimate?.estTotalCostUsd).toBeGreaterThan(0);
    expect(summary.ranAt).toEqual(expect.any(String));
  });

  it("summary='ready' when all checks pass", async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(summary.summary).toBe('ready');
  });

  // ── checkDatasetSchema ────────────────────────────────────────────

  it('dataset_schema is always passed (validation happens at insertion time)', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'dataset_schema').status).toBe('passed');
  });

  // ── checkRetrievalIndex ───────────────────────────────────────────

  it('retrieval_index: passed when RETRIEVAL_SERVICE_URL is unset', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'retrieval_index').status).toBe('passed');
  });

  it('retrieval_index: passed when health response matches the run provenance version', async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockResolvedValueOnce({ indexVersion: 'idx-v1', healthy: true });
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'retrieval_index').status).toBe('passed');
  });

  it('retrieval_index: failed when retrieval-service reports unhealthy', async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockResolvedValueOnce({ indexVersion: 'idx-v1', healthy: false });
    const summary = await runPreflight({ jobInput: baseJob() });
    const check = findCheck(summary, 'retrieval_index');
    expect(check.status).toBe('failed');
    expect(check.errorMessage).toContain('unhealthy');
  });

  it('retrieval_index: warning + override actions on index version drift', async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockResolvedValueOnce({ indexVersion: 'idx-v2', healthy: true });
    const summary = await runPreflight({ jobInput: baseJob() });
    const check = findCheck(summary, 'retrieval_index');
    expect(check.status).toBe('warning');
    expect(check.warningMessage).toContain('idx-v1 → idx-v2');
    expect(check.impact).toBe('promotion_blocked');
    const intents = (check.warningActions as Array<{ intent: string }>).map(
      (a) => a.intent,
    );
    expect(intents).toEqual(
      expect.arrayContaining([
        'use_latest_index',
        'retrieval_only_eval',
        'refresh_index',
        'continue_non_promotable',
      ]),
    );
  });

  it('retrieval_index: failed on 4xx (treat as caller-side error)', async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockRejectedValueOnce(httpError(404));
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'retrieval_index').status).toBe('failed');
  });

  it('retrieval_index: warning on 5xx (transient upstream)', async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockRejectedValueOnce(httpError(503));
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'retrieval_index').status).toBe('warning');
  });

  // ── checkToolConnectivity ─────────────────────────────────────────

  it('tool_connectivity: passed when TOOL_SERVICE_URL is unset', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'tool_connectivity').status).toBe('passed');
  });

  it('tool_connectivity: passed when all tools healthy', async () => {
    process.env['TOOL_SERVICE_URL'] = 'http://tools.test';
    mockGotGet.mockResolvedValueOnce({ registryVersion: 'r1', failing: [] });
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'tool_connectivity').status).toBe('passed');
  });

  it('tool_connectivity: failed when tools failing and no override', async () => {
    process.env['TOOL_SERVICE_URL'] = 'http://tools.test';
    mockGotGet.mockResolvedValueOnce({
      registryVersion: 'r1',
      failing: ['toolA', 'toolB'],
    });
    const summary = await runPreflight({ jobInput: baseJob() });
    const check = findCheck(summary, 'tool_connectivity');
    expect(check.status).toBe('failed');
    expect(check.errorMessage).toContain('toolA');
    expect(check.errorMessage).toContain('toolB');
  });

  it('tool_connectivity: warning when failing tools but enable_mock_tools override is accepted', async () => {
    process.env['TOOL_SERVICE_URL'] = 'http://tools.test';
    mockGotGet.mockResolvedValueOnce({
      registryVersion: 'r1',
      failing: ['toolA'],
    });
    const summary = await runPreflight({
      jobInput: baseJob({ overrideIntents: ['enable_mock_tools'] }),
    });
    const check = findCheck(summary, 'tool_connectivity');
    expect(check.status).toBe('warning');
    expect(check.warningMessage).toContain('mock tools');
  });

  // ── checkEvaluatorAvailability ────────────────────────────────────

  it('evaluator_availability: passed when judge is disabled (deterministic strategy)', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(findCheck(summary, 'evaluator_availability').status).toBe('passed');
    // No gateway probe should be issued in deterministic-only mode.
    expect(mockGotGet).not.toHaveBeenCalled();
  });

  it('evaluator_availability: passed when LLM_GATEWAY_URL is unset', async () => {
    const summary = await runPreflight({
      jobInput: baseJob({
        evaluators: {
          ...baseJob().evaluators,
          strategy: 'llm_judge',
          enabledRubric: ['helpfulness'],
          evaluatorModel: 'gpt-4o',
        },
      }),
    });
    expect(findCheck(summary, 'evaluator_availability').status).toBe('passed');
  });

  it('evaluator_availability: passed when evaluatorModel is not set', async () => {
    process.env['LLM_GATEWAY_URL'] = 'http://gw.test';
    const summary = await runPreflight({
      jobInput: baseJob({
        evaluators: {
          ...baseJob().evaluators,
          strategy: 'llm_judge',
          enabledRubric: ['helpfulness'],
        },
      }),
    });
    expect(findCheck(summary, 'evaluator_availability').status).toBe('passed');
  });

  it('evaluator_availability: passed when the gateway responds (any HTTP)', async () => {
    process.env['LLM_GATEWAY_URL'] = 'http://gw.test/';
    mockGotGet.mockResolvedValueOnce({ data: [] });
    const summary = await runPreflight({
      jobInput: baseJob({
        evaluators: {
          ...baseJob().evaluators,
          strategy: 'llm_judge',
          enabledRubric: ['helpfulness'],
          evaluatorModel: 'gpt-4o',
        },
      }),
    });
    expect(findCheck(summary, 'evaluator_availability').status).toBe('passed');
    // Trailing slash should be stripped before /v1/models is appended.
    expect(mockGotGet).toHaveBeenCalledWith(
      'http://gw.test/v1/models',
      expect.objectContaining({ throwHttpErrors: false }),
    );
  });

  it('evaluator_availability: warning when gateway transport error (DNS/refused)', async () => {
    process.env['LLM_GATEWAY_URL'] = 'http://gw.test';
    mockGotGet.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const summary = await runPreflight({
      jobInput: baseJob({
        evaluators: {
          ...baseJob().evaluators,
          strategy: 'llm_judge',
          enabledRubric: ['helpfulness'],
          evaluatorModel: 'gpt-4o',
        },
      }),
    });
    const check = findCheck(summary, 'evaluator_availability');
    expect(check.status).toBe('warning');
    expect(check.warningMessage).toContain('unreachable');
  });

  // ── checkRuntimeEstimate ──────────────────────────────────────────

  it('runtime_estimate: passed under default quota', async () => {
    const summary = await runPreflight({ jobInput: baseJob() });
    const check = findCheck(summary, 'runtime_estimate');
    expect(check.status).toBe('passed');
    expect(check.detailNote).toMatch(/cases/);
  });

  it('runtime_estimate: failed when projected cost exceeds EVAL_QUOTA_USD', async () => {
    process.env['EVAL_QUOTA_USD'] = '0.01';
    const summary = await runPreflight({ jobInput: baseJob() });
    const check = findCheck(summary, 'runtime_estimate');
    expect(check.status).toBe('failed');
    expect(check.errorMessage).toContain('exceeds quota');
    expect(summary.runtimeEstimate?.withinOrgQuota).toBe(false);
  });

  // ── Summary aggregation ───────────────────────────────────────────

  it("summary='blocked' when any check is failed", async () => {
    process.env['EVAL_QUOTA_USD'] = '0.01';
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(summary.summary).toBe('blocked');
  });

  it("summary='warnings' when checks are mixed pass/warning (no failures)", async () => {
    process.env['RETRIEVAL_SERVICE_URL'] = 'http://retrieval.test';
    mockGotGet.mockResolvedValueOnce({ indexVersion: 'idx-v2', healthy: true });
    const summary = await runPreflight({ jobInput: baseJob() });
    expect(summary.summary).toBe('warnings');
  });

  it('estimate counts scale with model count', async () => {
    const oneModel = await runPreflight({ jobInput: baseJob() });
    const twoModels = await runPreflight({
      jobInput: baseJob({ models: ['gpt-4o', 'claude-3-5-sonnet'] }),
    });
    expect(twoModels.runtimeEstimate!.estInputTokens).toBeGreaterThan(
      oneModel.runtimeEstimate!.estInputTokens,
    );
  });
});
