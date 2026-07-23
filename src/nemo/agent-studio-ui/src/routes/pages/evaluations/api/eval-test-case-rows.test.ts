import { describe, expect, it } from 'vitest';

import {
  joinCasesWithArtifacts,
  mapArtifactToRowMetrics,
} from './eval-test-case-rows';
import type { PerCaseArtifact } from './eval.types';

describe('eval-test-case-rows', () => {
  const artifact: PerCaseArtifact = {
    caseId: 'hello-001',
    status: 'COMPLETED',
    response: 'Hello! How can I help?',
    deterministicMetrics: {
      'rag.groundedness': 0,
      'correctness.em': 0,
      'correctness.bleu': 0.67,
      'correctness.rougeL': 0.83,
      'correctness.tokenF1': 0.83,
      'perf.e2e_ms': 956,
      'cost.total_tokens': 24,
    },
    judgeRubrics: [
      { rubricId: 'helpfulness', score: 0.7, errored: false },
      { rubricId: 'correctness', score: 0.4, errored: false },
      { rubricId: 'faithfulness_groundedness', errored: true, rationale: '403' },
    ],
    telemetry: { e2eMs: 956, inputTokens: 13, outputTokens: 11 },
  };

  it('[tag:eval] maps per-case artifact metrics to table values', () => {
    expect(mapArtifactToRowMetrics(artifact)).toMatchObject({
      actual: 'Hello! How can I help?',
      meanJudgeScore: '55%',
      helpfulness: '70%',
      correctness: '40%',
      faithfulnessGroundedness: '—',
      groundedness: '0%',
      exactMatch: '0%',
      bleu: '67%',
      rougeL: '83%',
      tokenF1: '83%',
      averageLatency: '956 ms',
      p95Latency: '—',
      p99Latency: '—',
      averageTokens: '—',
      maximumTokens: '—',
      totalTokens: '24',
      totalCost: '—',
      resultStatus: 'COMPLETED',
      hasResult: true,
    });
  });

  it('[tag:eval] joins cases with artifacts by caseId and keeps result-only rows', () => {
    const rows = joinCasesWithArtifacts(
      [
        {
          caseId: 'hello-001',
          query: 'Hi',
          expected: 'Hello! How can I help you today?',
        },
        {
          caseId: 'hello-002',
          query: 'How are you?',
          expected: 'Doing well.',
        },
      ],
      [
        artifact,
        {
          caseId: 'hello-005',
          status: 'FAILED',
          error: 'Activity task failed',
        },
      ],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0].actual).toBe('Hello! How can I help?');
    expect(rows[1].actual).toBe('—');
    expect(rows[2].caseId).toBe('hello-005');
    expect(rows[2].resultStatus).toContain('FAILED');
  });

  it('[tag:eval] uses ERROR fallback status when artifact has error but no status', () => {
    expect(mapArtifactToRowMetrics({
      caseId: 'hello-006',
      error: 'Activity task failed',
    })).toMatchObject({
      resultStatus: 'ERROR: Activity task failed',
      hasResult: true,
    });
  });
});
