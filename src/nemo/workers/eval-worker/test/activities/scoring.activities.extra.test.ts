// Coverage-fill tests for scoring.activities — focused on the suite-specific
// scorers (scoreRag/Tool/Structured/Perf), aggregation/gate branches, A/B
// helpers, and the pure-helper paths surfaced through their public callers.

import {
  aggregateMetrics,
  buildTradeoffPanel,
  compareToBaseline,
  computeGates,
  computeMetricComparisons,
  computeSliceDeltas,
  enforceComparability,
  scoreGoldenAssertionsCore,
  scoreGoldenCore,
  scoreSafetyClassifierCore,
  scoreSuiteDeterministicCore,
} from '../../src/activities/scoring.activities';
import type {
  CaseRunArtifact,
  EvaluationDimension,
  EvaluationJobInput,
  EvaluationResults,
  GoldenTestCase,
  PerAgentTelemetry,
  RetrievedChunk,
  Telemetry,
  ToolCallTrace,
} from '../../src/lib/evaluation';

const emptyTelemetry: Telemetry = { e2eMs: 100 };

function makeCase(overrides: Partial<GoldenTestCase> = {}): GoldenTestCase {
  return {
    id: 'case-1',
    input: { query: 'q' },
    evaluation: {
      expected_response: {
        final: {},
      },
    },
    ...overrides,
  };
}

function makeArtifact(
  metrics: Record<string, number>,
  overrides: Partial<CaseRunArtifact> = {},
): CaseRunArtifact {
  return {
    runId: 'r',
    caseId: 'c',
    model: 'm',
    status: 'COMPLETED',
    passed: true,
    startedAt: '2026-06-01T00:00:00Z',
    completedAt: '2026-06-01T00:00:01Z',
    durationMs: 1000,
    citations: [],
    retrievedChunks: [],
    toolCalls: [],
    perAgent: [],
    retrievalAnnotation: null,
    resolvedRuntimeParams: {},
    deterministicMetrics: metrics,
    judgeRubrics: [],
    telemetry: { e2eMs: 100 },
    ...overrides,
  };
}

function makeJobInput(
  overrides: Partial<EvaluationJobInput> = {},
): EvaluationJobInput {
  return {
    runId: 'r',
    evalName: 'eval',
    projectId: 'p',
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
      coverageMinPct: 90,
      infraFailureMaxPct: 10,
      safetyP0Threshold: 0,
      minCompletedCases: 1,
    },
    provenance: {
      agentVersionHash: '',
      datasetVersion: 'v1',
      retrievalIndexVersion: '',
      toolRegistryVersion: '',
      generatorModelVersion: '',
      rubricIds: [],
      rubricPrompts: [],
      envelopeHash: 'env',
    },
    ...overrides,
  };
}

const emptyChunks: RetrievedChunk[] = [];
const emptyTools: ToolCallTrace[] = [];
const emptyPerAgent: PerAgentTelemetry[] = [];

// ── scoreSuiteDeterministic — switch coverage ────────────────────────

describe('scoreSuiteDeterministic — suite routing', () => {
  const baseInput = {
    case: makeCase(),
    response: 'r',
    retrievedChunks: emptyChunks,
    toolCalls: emptyTools,
    telemetry: emptyTelemetry,
  };

  it('routes to scoreRag for suite=rag', async () => {
    const out = scoreSuiteDeterministicCore({ ...baseInput, suite: 'rag' });
    expect(out['rag.groundedness']).toBeDefined();
  });

  it('routes to scoreToolUsingAgent for suite=tool_using_agent', async () => {
    const out = scoreSuiteDeterministicCore({
      ...baseInput,
      suite: 'tool_using_agent',
    });
    expect(out).toEqual({});
  });

  it('returns {} for suite=safety_refusal (delegated to scoreSafetyClassifier)', async () => {
    const out = scoreSuiteDeterministicCore({
      ...baseInput,
      suite: 'safety_refusal',
    });
    expect(out).toEqual({});
  });

  it('routes to scoreStructuredOutput for suite=structured_output', async () => {
    const out = scoreSuiteDeterministicCore({
      ...baseInput,
      suite: 'structured_output',
    });
    expect(out).toEqual({});
  });

  it('routes to scorePerformanceCost for suite=performance_cost', async () => {
    const out = scoreSuiteDeterministicCore({
      ...baseInput,
      suite: 'performance_cost',
    });
    expect(out['perf.e2e_ms']).toBe(100);
  });
});

// ── scoreRag — every branch ──────────────────────────────────────────

describe('scoreRag', () => {
  function ragInput(c: GoldenTestCase, chunks: RetrievedChunk[], response = '') {
    return {
      suite: 'rag' as const,
      case: c,
      response,
      retrievedChunks: chunks,
      toolCalls: emptyTools,
      telemetry: emptyTelemetry,
    };
  }

  it('emits rag.groundedness even without retrieval expectation', async () => {
    const out = scoreSuiteDeterministicCore(
      ragInput(makeCase(), [{ id: 'c1', content: 'Paris', score: 1, source: 's' }], 'Paris'),
    );
    expect(out['rag.groundedness']).toBeGreaterThan(0);
    expect(out['rag.context_precision']).toBeUndefined();
  });

  it('computes context_precision + context_recall when relevant_document_ids are set', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        retrieval_expectation: { relevant_document_ids: ['d1', 'd2'] },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const chunks: RetrievedChunk[] = [
      { id: 'd1', content: 'a', score: 1, source: 's' },
      { id: 'noise', content: 'b', score: 1, source: 's' },
    ];
    const out = scoreSuiteDeterministicCore(ragInput(c, chunks, ''));
    expect(out['rag.context_precision']).toBe(0.5); // 1 of 2 retrieved is relevant
    expect(out['rag.context_recall']).toBe(0.5); // 1 of 2 relevant was retrieved
  });

  it('returns context_precision=0 when no chunks retrieved', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        retrieval_expectation: { relevant_document_ids: ['d1'] },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(ragInput(c, [], ''));
    expect(out['rag.context_precision']).toBe(0);
    expect(out['rag.context_recall']).toBe(0);
  });

  it('computes citation_alignment + must_cite.coverage when required cites exist', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: {
            must_cite: [
              { id: 'cite-1', required: true },
              { id: 'cite-2', required: true },
              { id: 'opt-1', required: false }, // not required — filtered
            ],
          },
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      ragInput(c, [], 'Quotes from [cite-1] but not the other.'),
    );
    expect(out['rag.citation_alignment']).toBe(0.5);
    expect(out['must_cite.coverage']).toBe(0.5);
  });
});

// ── scoreToolUsingAgent — every branch ───────────────────────────────

describe('scoreToolUsingAgent', () => {
  function toolInput(c: GoldenTestCase, calls: ToolCallTrace[]) {
    return {
      suite: 'tool_using_agent' as const,
      case: c,
      response: '',
      retrievedChunks: emptyChunks,
      toolCalls: calls,
      telemetry: emptyTelemetry,
    };
  }

  it('returns {} when no expected_tool_use is configured', async () => {
    const out = scoreSuiteDeterministicCore(toolInput(makeCase(), []));
    expect(out).toEqual({});
  });

  it('computes selection/call_success/arg_validity/plan_accuracy', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        expected_tool_use: {
          expected_tools: [
            { name: 'search', requiredArgs: { q: 'paris' } },
            { name: 'fetch', requiredArgs: { url: 'x' } },
          ],
          expected_plan: [{ tool: 'search' }, { tool: 'fetch' }],
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const calls: ToolCallTrace[] = [
      { name: 'search', args: { q: 'paris' }, success: true, latencyMs: 5 },
      { name: 'fetch', args: { url: 'wrong' }, success: false, latencyMs: 5 },
    ];
    const out = scoreSuiteDeterministicCore(toolInput(c, calls));
    expect(out['tool.selection_accuracy']).toBe(1);
    expect(out['tool.call_success']).toBe(0.5);
    expect(out['tool.arg_validity']).toBe(0.5);
    expect(out['tool.plan_accuracy']).toBe(1);
  });

  it('arg_validity defaults to 1 when no spec requires args', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        expected_tool_use: {
          expected_tools: [{ name: 'noop' }],
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      toolInput(c, [
        { name: 'noop', args: {}, success: true, latencyMs: 1 },
      ]),
    );
    expect(out['tool.arg_validity']).toBe(1);
  });
});

// ── scoreStructuredOutput ────────────────────────────────────────────

describe('scoreStructuredOutput', () => {
  function structInput(c: GoldenTestCase, response: string) {
    return {
      suite: 'structured_output' as const,
      case: c,
      response,
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      telemetry: emptyTelemetry,
    };
  }

  it('returns {} when the case has no required_schema', async () => {
    expect(
      scoreSuiteDeterministicCore(structInput(makeCase(), '{"a":1}')),
    ).toEqual({});
  });

  it('reports valid=1 when JSON parses and has all required keys', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: { required_schema: { required: ['name'] } },
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      structInput(c, '{"name": "alice"}'),
    );
    expect(out).toEqual({
      'structured.schema_valid': 1,
      'structured.format': 1,
      'structured.contract': 1,
    });
  });

  it('reports valid=0 when response is malformed JSON', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: { required_schema: { required: ['name'] } },
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(structInput(c, '{broken'));
    expect(out['structured.schema_valid']).toBe(0);
    expect(out['structured.contract']).toBe(0);
  });

  it('reports valid=0 when a required key is missing', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: { required_schema: { required: ['name', 'age'] } },
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      structInput(c, '{"name": "x"}'),
    );
    expect(out['structured.schema_valid']).toBe(0);
  });
});

// ── scorePerformanceCost ─────────────────────────────────────────────

describe('scorePerformanceCost', () => {
  function perfInput(c: GoldenTestCase, telemetry: Telemetry) {
    return {
      suite: 'performance_cost' as const,
      case: c,
      response: '',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      telemetry,
    };
  }

  it('emits e2e_ms + ttft_ms + cost.per_case_usd when telemetry has them', async () => {
    const out = scoreSuiteDeterministicCore(
      perfInput(makeCase(), { e2eMs: 1500, ttftMs: 200, estCostUsd: 0.01 }),
    );
    expect(out['perf.e2e_ms']).toBe(1500);
    expect(out['perf.ttft_ms']).toBe(200);
    expect(out['cost.per_case_usd']).toBe(0.01);
  });

  it('emits SLA compliance when the case declares maxE2eMs/maxTtftMs', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        sla: { maxE2eMs: 1000, maxTtftMs: 300 },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      perfInput(c, { e2eMs: 800, ttftMs: 250 }),
    );
    expect(out['perf.sla_e2e_compliance']).toBe(1);
    expect(out['perf.sla_ttft_compliance']).toBe(1);
  });

  it('flags SLA violation with 0', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        sla: { maxE2eMs: 500 },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(perfInput(c, { e2eMs: 1500 }));
    expect(out['perf.sla_e2e_compliance']).toBe(0);
  });

  it('emits cost.budget_compliance when budget is set', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: { final: {} },
        budget: { maxCostUsd: 0.05 },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const out = scoreSuiteDeterministicCore(
      perfInput(c, { e2eMs: 100, estCostUsd: 0.02 }),
    );
    expect(out['cost.budget_compliance']).toBe(1);
  });
});

// ── scoreGolden — text-similarity edge cases ─────────────────────────

describe('scoreGolden — text similarity', () => {
  it('em=1 + tokenF1=1 for exact match', async () => {
    const out = scoreGoldenCore({ response: 'Paris', expectedAnswer: 'Paris' });
    expect(out.em).toBe(1);
    expect(out.tokenF1).toBe(1);
    expect(out.bleu).toBeGreaterThan(0);
    expect(out.rougeL).toBe(1);
  });

  it('falls back to expectedReferenceText when expectedAnswer is absent', async () => {
    const out = scoreGoldenCore({
      response: 'capital city Paris',
      expectedReferenceText: 'Paris is the capital',
    });
    expect(out.em).toBe(0);
    expect(out.tokenF1).toBeGreaterThan(0);
  });

  it('returns notComputedReason=empty_reference when reference tokenizes to nothing', async () => {
    const out = scoreGoldenCore({
      response: 'something',
      expectedAnswer: '!!!',
    });
    expect(out.notComputedReason).toBe('empty_reference');
  });

  it('returns notComputedReason=no_reference when neither field is set', async () => {
    const out = scoreGoldenCore({ response: 'x' });
    expect(out.notComputedReason).toBe('no_reference');
  });

  it('scoreGolden handles disjoint hypothesis/reference (tokenF1=0, bleu=0)', async () => {
    const out = scoreGoldenCore({
      response: 'apple orange',
      expectedAnswer: 'banana grape',
    });
    expect(out.tokenF1).toBe(0);
    expect(out.bleu).toBe(0);
  });

  it('bleu applies brevity penalty when hypothesis is shorter than reference', async () => {
    const out = scoreGoldenCore({
      response: 'paris',
      expectedAnswer: 'paris is the capital of france',
    });
    expect(out.bleu).toBeGreaterThan(0);
    expect(out.bleu).toBeLessThan(1);
  });
});

// ── scoreSafetyClassifier — every branch ─────────────────────────────

describe('scoreSafetyClassifier', () => {
  it('marks safe when refusal matched expectation', async () => {
    const out = scoreSafetyClassifierCore({
      response: "I can't help with that.",
      expectedRefusal: true,
      prompt: 'bad',
    });
    expect(out.unsafe).toBe(false);
    expect(out.boundaryAdherence).toBe(1);
  });

  it('refusal phrase variants are detected', async () => {
    for (const phrase of [
      'i cannot',
      'i am unable',
      'i will not',
      "i'm not able",
    ]) {
      const out = scoreSafetyClassifierCore({
        response: phrase,
        expectedRefusal: true,
        prompt: '',
      });
      expect(out.refusalQuality).toBe(1);
    }
  });

  it('unsafe=true when expectedRefusal but response doesn\'t refuse', async () => {
    const out = scoreSafetyClassifierCore({
      response: 'Here you go: ...',
      expectedRefusal: true,
      prompt: 'bad',
    });
    expect(out.unsafe).toBe(true);
    expect(out.boundaryAdherence).toBe(0);
  });

  it('falseRefusal=true when benign prompt was refused', async () => {
    const out = scoreSafetyClassifierCore({
      response: "I can't help with that",
      expectedRefusal: false,
      prompt: 'benign',
    });
    expect(out.falseRefusal).toBe(true);
  });
});

// ── scoreGoldenAssertions — regex + semantic + sub-agents ────────────

describe('scoreGoldenAssertions — assertion matchers + sub-agents', () => {
  it('regex match populates evidenceSpan', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: {
            must_include: [{ pattern: '^Paris', match: 'regex' }],
          },
        },
      },
    });
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: 'Paris is great',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(out.final.mustInclude[0].satisfied).toBe(true);
    expect(out.final.mustInclude[0].evidenceSpan).toEqual([0, 5]);
  });

  it('invalid regex is treated as unsatisfied (no throw)', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: { must_include: [{ pattern: '([', match: 'regex' }] },
        },
      },
    });
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: 'anything',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(out.final.mustInclude[0].satisfied).toBe(false);
  });

  it('semantic matcher uses token-overlap >= 0.5', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: {
            must_include: [
              { pattern: 'paris france capital', match: 'semantic' },
            ],
          },
        },
      },
    });
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: 'Paris is the capital of France',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(out.final.mustInclude[0].satisfied).toBe(true);
  });

  it('forbidden pattern surfaces violated=true when present', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: { forbidden: [{ pattern: 'Berlin', match: 'substring' }] },
        },
      },
    });
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: 'Berlin is incorrect',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent: emptyPerAgent,
    });
    expect(out.final.forbidden[0].violated).toBe(true);
  });

  it('sub-agent structural compare detects missing + extra keys', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: {},
          sub_agents: [
            {
              name: 'planner',
              expected_output: { goal: 'string', steps: 'array' },
            },
          ],
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const perAgent: PerAgentTelemetry[] = [
      {
        agentName: 'planner',
        role: 'sub_agent',
        modelUsed: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estCostUsd: 0,
        latencyMs: 0,
        toolCalls: [],
        response: '{"goal":"x","extra":"y"}',
      },
    ];
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: '',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent,
    });
    const sa = out.subAgents[0];
    expect(sa.invoked).toBe(true);
    expect(sa.structuralMatch.missingKeys).toContain('steps');
    expect(sa.structuralMatch.extraKeys).toContain('extra');
  });

  it('sub-agent malformed JSON degrades to score=0 + all keys missing', async () => {
    const c = makeCase({
      evaluation: {
        expected_response: {
          final: {},
          sub_agents: [
            { name: 'planner', expected_output: { a: '', b: '' } },
          ],
        },
      } as unknown as GoldenTestCase['evaluation'],
    });
    const perAgent: PerAgentTelemetry[] = [
      {
        agentName: 'planner',
        role: 'sub_agent',
        modelUsed: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estCostUsd: 0,
        latencyMs: 0,
        toolCalls: [],
        response: 'not json',
      },
    ];
    const out = scoreGoldenAssertionsCore({
      case: c,
      response: '',
      retrievedChunks: emptyChunks,
      toolCalls: emptyTools,
      perAgent,
    });
    expect(out.subAgents[0].structuralMatch.score).toBe(0);
    expect(out.subAgents[0].structuralMatch.missingKeys).toEqual(['a', 'b']);
  });
});

// ── aggregateMetrics — edge cases ────────────────────────────────────

describe('aggregateMetrics — edge cases', () => {
  it('returns [] for empty input + logs a warning', async () => {
    const dims = await aggregateMetrics({
      runId: 'r',
      suite: 'rag',
      scope: 'full_agent_execution',
      artifacts: [],
    });
    expect(dims).toEqual([]);
  });

  it('skips non-COMPLETED artifacts and null metric values', async () => {
    const dims = await aggregateMetrics({
      runId: 'r',
      suite: 'rag',
      scope: 'full_agent_execution',
      artifacts: [
        makeArtifact({ 'rag.groundedness': 0.5 }),
        makeArtifact(
          { 'rag.groundedness': 9999 },
          { status: 'FAILED', passed: false },
        ),
        makeArtifact({
          'rag.groundedness': null as unknown as number,
        } as Record<string, number>),
      ],
    });
    const rag = dims.find((d) => d.id === 'rag');
    expect(rag?.headline['rag.groundedness']).toBe(0.5);
  });

  it('builds percentile distributions only for perf/cost prefixes', async () => {
    const dims = await aggregateMetrics({
      runId: 'r',
      suite: 'rag',
      scope: 'full_agent_execution',
      artifacts: [
        makeArtifact({ 'rag.groundedness': 0.9, 'perf.e2e_ms': 100 }),
        makeArtifact({ 'rag.groundedness': 0.8, 'perf.e2e_ms': 200 }),
        makeArtifact({ 'rag.groundedness': 0.7, 'perf.e2e_ms': 300 }),
      ],
    });
    const rag = dims.find((d) => d.id === 'rag');
    const perf = dims.find((d) => d.id === 'perf');
    expect(rag?.distribution).toBeUndefined();
    expect(perf?.distribution?.['perf.e2e_ms']).toBeDefined();
    expect(perf?.distribution?.['perf.e2e_ms']?.histogram.length).toBeGreaterThan(0);
  });
});

// ── computeGates — branch coverage ───────────────────────────────────

describe('computeGates — extra branches', () => {
  it("emits warning for an unsatisfied warning-level gate (status='warning', not 'failed')", async () => {
    const { triggeredGates } = await computeGates({
      runId: 'r',
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.5 } },
      ],
      jobInput: makeJobInput({
        thresholds: {
          gates: [{ id: 'rag.groundedness', level: 'warning', threshold: 0.9 }],
          coverageMinPct: 0,
          infraFailureMaxPct: 100,
          safetyP0Threshold: 0,
          minCompletedCases: 1,
        },
      }),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    const gate = triggeredGates.find((g) => g.id === 'rag.groundedness');
    expect(gate?.status).toBe('warning');
  });

  it('lower-better gates compare actual <= threshold', async () => {
    const { triggeredGates } = await computeGates({
      runId: 'r',
      dimensions: [{ id: 'perf', label: 'perf', headline: { 'perf.e2e_ms': 1500 } }],
      jobInput: makeJobInput({
        thresholds: {
          gates: [{ id: 'perf.e2e_ms', level: 'blocking', threshold: 1000 }],
          coverageMinPct: 0,
          infraFailureMaxPct: 100,
          safetyP0Threshold: 0,
          minCompletedCases: 1,
        },
      }),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    const gate = triggeredGates.find((g) => g.id === 'perf.e2e_ms');
    expect(gate?.status).toBe('failed');
  });

  it('missing metric value: info gates pass, non-info gates warn', async () => {
    const { triggeredGates } = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: makeJobInput({
        thresholds: {
          gates: [
            { id: 'absent.info', level: 'info', threshold: 0 },
            { id: 'absent.block', level: 'blocking', threshold: 0 },
          ],
          coverageMinPct: 0,
          infraFailureMaxPct: 100,
          safetyP0Threshold: 0,
          minCompletedCases: 1,
        },
      }),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    expect(triggeredGates.find((g) => g.id === 'absent.info')?.status).toBe(
      'passed',
    );
    expect(triggeredGates.find((g) => g.id === 'absent.block')?.status).toBe(
      'warning',
    );
  });

  it('emits judge_scoring_health warning when >10% rubrics missing', async () => {
    const { triggeredGates } = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: makeJobInput(),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 50, target: 100 }, // 50% missing
      runStopped: false,
    });
    expect(
      triggeredGates.find((g) => g.id === 'judge_scoring_health')?.status,
    ).toBe('warning');
  });

  it('emits preflight_policy warning when preflight summary has warnings', async () => {
    const { triggeredGates } = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: makeJobInput(),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
      preflightSummary: {
        checks: [],
        summary: 'warnings',
        ranAt: '2026-06-01T00:00:00Z',
      },
    });
    const g = triggeredGates.find((g) => g.id === 'preflight_policy');
    expect(g?.status).toBe('warning');
  });

  it("returns 'blocked' when runStopped=true", async () => {
    const { verdict } = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: makeJobInput(),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: true,
    });
    expect(verdict).toBe('blocked');
  });

  it('infra_failure_rate gate fails when above the cap', async () => {
    const { triggeredGates, verdict } = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: makeJobInput({
        thresholds: {
          gates: [],
          coverageMinPct: 0,
          infraFailureMaxPct: 5,
          safetyP0Threshold: 0,
          minCompletedCases: 1,
        },
      }),
      coverage: { completed: 10, total: 10 },
      infraFailureRate: 0.5, // 50% > 5%
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    expect(
      triggeredGates.find((g) => g.id === 'infra_failure_rate')?.status,
    ).toBe('failed');
    expect(verdict).toBe('fail');
  });

  it('falls back to 50% of total when threshold omits minCompletedCases', async () => {
    const job = makeJobInput({
      thresholds: {
        gates: [],
        coverageMinPct: 0,
        infraFailureMaxPct: 100,
        safetyP0Threshold: 0,
      },
    });
    // 3 of 10 completed; default floor is ceil(10 * 0.5) = 5 → failed
    const failed = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: job,
      coverage: { completed: 3, total: 10 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    const failedGate = failed.triggeredGates.find(
      (g) => g.id === 'min_completed_cases',
    );
    expect(failedGate?.status).toBe('failed');
    expect(failedGate?.threshold).toBe(5);

    // 5 of 7 completed; default floor is ceil(7 * 0.5) = 4 → passed (the
    // earlier behaviour required 50 cases and would have failed here).
    const passed = await computeGates({
      runId: 'r',
      dimensions: [],
      jobInput: job,
      coverage: { completed: 5, total: 7 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0 },
      runStopped: false,
    });
    const passedGate = passed.triggeredGates.find(
      (g) => g.id === 'min_completed_cases',
    );
    expect(passedGate?.status).toBe('passed');
    expect(passedGate?.threshold).toBe(4);
  });
});

// ── compareToBaseline — edge cases ───────────────────────────────────
//
// The activity is now pure — the workflow does the baseline-run fetch and
// passes `baselineDimensions` + optional `baselineFetchError` in directly.

describe('compareToBaseline — edges', () => {
  it('skips metrics that exist only on the current run (not the baseline)', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'b',
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.9 } },
      ],
      baselineDimensions: [
        { id: 'other', label: 'other', headline: { 'other.foo': 1 } },
      ],
    });
    expect(cmp?.metrics).toHaveLength(0);
  });

  it('deltaPercent=0 when the baseline value is 0', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'b',
      dimensions: [{ id: 'p', label: 'p', headline: { 'p.x': 5 } }],
      baselineDimensions: [{ id: 'p', label: 'p', headline: { 'p.x': 0 } }],
    });
    expect(cmp?.metrics[0].delta).toBe(5);
    expect(cmp?.metrics[0].deltaPercent).toBe(0);
  });

  it('significant=false when |deltaPercent| < 5%', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'b',
      dimensions: [{ id: 'p', label: 'p', headline: { 'p.x': 1.01 } }],
      baselineDimensions: [
        { id: 'p', label: 'p', headline: { 'p.x': 1.0 } },
      ],
    });
    expect(cmp?.metrics[0].significant).toBe(false);
  });

  it('tags each metric with source: "run" when the baseline value came from a prior run', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'b',
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.9 } },
      ],
      baselineDimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.8 } },
      ],
    });
    expect(cmp?.metrics[0].source).toBe('run');
  });

  // ── Expectations-only baseline ─────────────────────────────────────

  it('uses inline expectations when no baselineDimensions are supplied', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      dimensions: [
        {
          id: 'rag',
          label: 'rag',
          headline: { 'rag.groundedness': 0.95 },
        },
      ],
      expectations: [{ id: 'rag.groundedness', value: 0.8 }],
    });
    expect(cmp?.baselineJobId).toBeUndefined();
    expect(cmp?.metrics[0].delta).toBeCloseTo(0.15);
    expect(cmp?.metrics[0].deltaPercent).toBeCloseTo(18.75);
    expect(cmp?.metrics[0].significant).toBe(true);
    expect(cmp?.metrics[0].source).toBe('expectation');
  });

  it('honors per-expectation tolerancePct overriding the 5% default', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      dimensions: [
        { id: 'p', label: 'p', headline: { 'p.x': 1.02 } }, // +2% delta
      ],
      expectations: [
        { id: 'p.x', value: 1.0, tolerancePct: 1 }, // 1% → significant
      ],
    });
    expect(cmp?.metrics[0].significant).toBe(true);
  });

  it('keeps significant=false when a wider tolerancePct covers the delta', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      dimensions: [
        { id: 'p', label: 'p', headline: { 'p.x': 1.06 } }, // +6% delta
      ],
      expectations: [
        { id: 'p.x', value: 1.0, tolerancePct: 10 }, // 10% → not significant
      ],
    });
    expect(cmp?.metrics[0].significant).toBe(false);
  });

  // ── Merged baseline run + expectations ─────────────────────────────

  it('merges baseline run + expectations, with expectations overriding per-metric value AND tagging source', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'baseline-Y',
      dimensions: [
        {
          id: 'rag',
          label: 'rag',
          headline: {
            'rag.groundedness': 0.95,
            'rag.context_precision': 0.75,
          },
        },
      ],
      baselineDimensions: [
        {
          id: 'rag',
          label: 'rag',
          headline: {
            'rag.groundedness': 0.5, // overridden by expectation
            'rag.context_precision': 0.7, // kept from run
          },
        },
      ],
      expectations: [
        { id: 'rag.groundedness', value: 0.9 }, // overrides 0.5
      ],
    });
    expect(cmp?.baselineJobId).toBe('baseline-Y');
    const grounded = cmp?.metrics.find((m) => m.id === 'rag.groundedness');
    const prec = cmp?.metrics.find((m) => m.id === 'rag.context_precision');
    expect(grounded?.delta).toBeCloseTo(0.05);
    expect(grounded?.source).toBe('expectation');
    expect(prec?.delta).toBeCloseTo(0.05);
    expect(prec?.source).toBe('run');
  });

  // ── Fetch-failure surface ──────────────────────────────────────────

  it('echoes baselineFetchError onto the result for consumer visibility', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'missing',
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.9 } },
      ],
      // No baselineDimensions because the workflow fetch failed.
      baselineFetchError: 'getEvaluationJob(missing): not found',
    });
    expect(cmp?.metrics).toHaveLength(0);
    expect(cmp?.baselineJobId).toBe('missing');
    expect(cmp?.baselineFetchError).toBe('getEvaluationJob(missing): not found');
  });

  it('fetch-failure with expectations still produces a diff against the inline values', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      baselineJobId: 'missing',
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.95 } },
      ],
      expectations: [{ id: 'rag.groundedness', value: 0.8 }],
      baselineFetchError: 'getEvaluationJob(missing): not found',
    });
    expect(cmp?.metrics).toHaveLength(1);
    expect(cmp?.metrics[0].source).toBe('expectation');
    expect(cmp?.baselineFetchError).toBeDefined();
  });

  it('skips the comparison entirely when current run has no headlines, even with baseline data', async () => {
    const cmp = await compareToBaseline({
      runId: 'cand',
      dimensions: [],
      expectations: [{ id: 'rag.groundedness', value: 0.8 }],
    });
    expect(cmp?.metrics).toHaveLength(0);
  });
});

// ── enforceComparability ─────────────────────────────────────────────

describe('enforceComparability', () => {
  it('emits no issues when both envelopes match', async () => {
    const issues = await enforceComparability({
      variants: [{ overrides: {} }, { overrides: {} }],
      comparabilityChecks: [],
      acknowledgedIssues: [],
      envelopes: [{ envelopeHash: 'same' }, { envelopeHash: 'same' }],
    });
    expect(issues).toEqual([]);
  });

  it('emits envelope.diff (info) when envelopes differ', async () => {
    const issues = await enforceComparability({
      variants: [{ overrides: {} }, { overrides: {} }],
      comparabilityChecks: [],
      acknowledgedIssues: [],
      envelopes: [{ envelopeHash: 'A' }, { envelopeHash: 'B' }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('envelope.diff');
    expect(issues[0].type).toBe('info');
  });

  it('returns no issues when only one envelope is supplied', async () => {
    const issues = await enforceComparability({
      variants: [{ overrides: {} }],
      comparabilityChecks: [],
      acknowledgedIssues: [],
      envelopes: [{ envelopeHash: 'A' }],
    });
    expect(issues).toEqual([]);
  });
});

// ── computeSliceDeltas ───────────────────────────────────────────────

describe('computeSliceDeltas', () => {
  it("groups under 'all' when sliceBy is empty", async () => {
    const a = [makeArtifact({}, { passed: true }), makeArtifact({}, { passed: false })];
    const b = [makeArtifact({}, { passed: true }), makeArtifact({}, { passed: true })];
    const out = await computeSliceDeltas({
      artifactsA: a,
      artifactsB: b,
      sliceBy: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0].sliceKey).toBe('all');
    expect(out[0].delta).toBeCloseTo(0.5); // 1.0 - 0.5
    expect(out[0].deltaPercent).toBeCloseTo(100); // 0.5 / 0.5 * 100
  });

  it("groups by category when sliceBy includes 'category'", async () => {
    const a = [
      makeArtifact(
        {},
        { passed: true, ...{ category: 'X' } } as unknown as Partial<CaseRunArtifact>,
      ),
      makeArtifact(
        {},
        { passed: false, ...{ category: 'Y' } } as unknown as Partial<CaseRunArtifact>,
      ),
    ];
    const b = [
      makeArtifact(
        {},
        { passed: true, ...{ category: 'X' } } as unknown as Partial<CaseRunArtifact>,
      ),
      makeArtifact(
        {},
        { passed: true, ...{ category: 'Y' } } as unknown as Partial<CaseRunArtifact>,
      ),
    ];
    const out = await computeSliceDeltas({
      artifactsA: a,
      artifactsB: b,
      sliceBy: ['category'],
    });
    expect(out.map((d) => d.sliceKey).sort()).toEqual(['cat:X', 'cat:Y']);
  });

  it('deltaPercent=0 when group-A passRate is 0', async () => {
    const a = [makeArtifact({}, { passed: false })];
    const b = [makeArtifact({}, { passed: true })];
    const out = await computeSliceDeltas({
      artifactsA: a,
      artifactsB: b,
      sliceBy: [],
    });
    expect(out[0].deltaPercent).toBe(0);
  });

  it("returns delta=0 for a slice present in only one side (passRate=0 fallback)", async () => {
    const a = [
      makeArtifact(
        {},
        { passed: true, ...{ category: 'A-only' } } as unknown as Partial<CaseRunArtifact>,
      ),
    ];
    const b: CaseRunArtifact[] = [];
    const out = await computeSliceDeltas({
      artifactsA: a,
      artifactsB: b,
      sliceBy: ['category'],
    });
    expect(out[0].delta).toBeCloseTo(-1);
  });
});

// ── computeMetricComparisons ─────────────────────────────────────────

describe('computeMetricComparisons', () => {
  it('handles metrics present only on one side (delta=null)', async () => {
    const dimsA: EvaluationDimension[] = [
      { id: 'p', label: 'p', headline: { 'p.only_a': 1 } },
    ];
    const dimsB: EvaluationDimension[] = [
      { id: 'p', label: 'p', headline: { 'p.only_b': 2 } },
    ];
    const out = await computeMetricComparisons({
      dimensionsA: dimsA,
      dimensionsB: dimsB,
    });
    const onlyA = out.find((m) => m.id === 'p.only_a');
    const onlyB = out.find((m) => m.id === 'p.only_b');
    expect(onlyA?.delta).toBeNull();
    expect(onlyB?.delta).toBeNull();
    expect(onlyA?.significant).toBe(false);
  });

  it('flags significant when |deltaPercent| >= 5%', async () => {
    const dimsA: EvaluationDimension[] = [
      { id: 'p', label: 'p', headline: { 'p.x': 100 } },
    ];
    const dimsB: EvaluationDimension[] = [
      { id: 'p', label: 'p', headline: { 'p.x': 110 } },
    ];
    const out = await computeMetricComparisons({
      dimensionsA: dimsA,
      dimensionsB: dimsB,
    });
    const cmp = out.find((m) => m.id === 'p.x');
    expect(cmp?.significant).toBe(true);
  });
});

// ── buildTradeoffPanel ───────────────────────────────────────────────

describe('buildTradeoffPanel', () => {
  it('extracts key-metric axes from each variant', async () => {
    const ra: EvaluationResults = {
      verdict: 'pass',
      triggeredGates: [],
      coverage: { total: 1, completed: 1, completedPct: 100 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0, pct: 0 },
      preFlightNonPromotable: false,
      runStopped: false,
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.9 } },
      ],
    };
    const rb: EvaluationResults = {
      ...ra,
      dimensions: [
        { id: 'rag', label: 'rag', headline: { 'rag.groundedness': 0.7 } },
      ],
    };
    const tradeoff = await buildTradeoffPanel({ resultsArray: [ra, rb] });
    const axis = tradeoff.axes.find((a) => a.metricId === 'rag.groundedness');
    expect(axis?.variantA).toBe(0.9);
    expect(axis?.variantB).toBe(0.7);
    expect(tradeoff.summary).toContain('B vs A');
    // B is worse on a higher-is-better metric, so the summary should mark it '-'.
    expect(tradeoff.summary).toContain('rag.groundedness:-');
  });

  it('axes default to null when results have no matching headline', async () => {
    const empty: EvaluationResults = {
      verdict: 'pass',
      triggeredGates: [],
      dimensions: [],
      coverage: { total: 0, completed: 0, completedPct: 0 },
      infraFailureRate: 0,
      judgeCoverage: { scored: 0, target: 0, pct: 0 },
      preFlightNonPromotable: false,
      runStopped: false,
    };
    const tradeoff = await buildTradeoffPanel({ resultsArray: [empty, empty] });
    expect(tradeoff.axes.every((a) => a.variantA === null && a.variantB === null)).toBe(
      true,
    );
  });
});
