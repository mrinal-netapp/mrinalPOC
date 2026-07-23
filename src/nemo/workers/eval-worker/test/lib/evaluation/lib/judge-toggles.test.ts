import {
  normalizeStrategy,
  resolveJudgeToggles,
} from '../../../../src/lib/evaluation/lib/judge-toggles';
import type { EvaluationJobInput } from '../../../../src/lib/evaluation';

describe('normalizeStrategy', () => {
  it.each([
    ['deterministic_only', 'deterministic'],
    ['deterministic_judge', 'deterministic_plus_llm_judge'],
    ['both', 'deterministic_plus_llm_judge'],
  ] as const)('maps legacy spelling "%s" → "%s"', (input, expected) => {
    expect(normalizeStrategy(input)).toBe(expected);
  });

  it('maps undefined → deterministic_plus_llm_judge (lenient default)', () => {
    expect(normalizeStrategy(undefined)).toBe('deterministic_plus_llm_judge');
  });

  it('returns canonical values unchanged', () => {
    expect(normalizeStrategy('deterministic')).toBe('deterministic');
    expect(normalizeStrategy('llm_judge')).toBe('llm_judge');
    expect(normalizeStrategy('deterministic_plus_llm_judge')).toBe(
      'deterministic_plus_llm_judge',
    );
  });

  it('passes unknown strings through (callers validate)', () => {
    expect(normalizeStrategy('made-up' as unknown as string)).toBe('made-up');
  });
});

describe('resolveJudgeToggles', () => {
  function evaluators(
    over: Partial<EvaluationJobInput['evaluators']> = {},
  ): EvaluationJobInput['evaluators'] {
    return {
      strategy: 'deterministic',
      rubricPreset: 'none',
      enabledRubric: [],
      judgeEvalMode: 'pointwise',
      judgeSamplingMode: 'all',
      judgeStratifiedSlices: false,
      judgeGateWhenSampled: 'informational',
      ...over,
    };
  }

  it('deterministic strategy: judge disabled, deterministic enabled, no rubrics', () => {
    const t = resolveJudgeToggles(evaluators({ strategy: 'deterministic' }));
    expect(t).toEqual({
      strategy: 'deterministic',
      deterministicEnabled: true,
      judgeEnabled: false,
      rubrics: [],
    });
  });

  it('llm_judge: only judge enabled, rubrics flow through', () => {
    const t = resolveJudgeToggles(
      evaluators({
        strategy: 'llm_judge',
        enabledRubric: ['helpfulness', 'correctness'],
      }),
    );
    expect(t.deterministicEnabled).toBe(false);
    expect(t.judgeEnabled).toBe(true);
    expect(t.rubrics).toEqual(['helpfulness', 'correctness']);
  });

  it('deterministic_plus_llm_judge: both enabled', () => {
    const t = resolveJudgeToggles(
      evaluators({
        strategy: 'deterministic_plus_llm_judge',
        enabledRubric: ['r1'],
      }),
    );
    expect(t.deterministicEnabled).toBe(true);
    expect(t.judgeEnabled).toBe(true);
    expect(t.rubrics).toEqual(['r1']);
  });

  it('legacy "deterministic_judge" spelling is normalized', () => {
    const t = resolveJudgeToggles(
      evaluators({
        strategy: 'deterministic_judge' as unknown as 'deterministic_plus_llm_judge',
        enabledRubric: ['r1'],
      }),
    );
    expect(t.strategy).toBe('deterministic_plus_llm_judge');
    expect(t.judgeEnabled).toBe(true);
    expect(t.deterministicEnabled).toBe(true);
  });

  it('returns lenient defaults when evaluators is undefined', () => {
    const t = resolveJudgeToggles(undefined);
    expect(t.strategy).toBe('deterministic_plus_llm_judge');
    expect(t.judgeEnabled).toBe(true);
    expect(t.deterministicEnabled).toBe(true);
    expect(t.rubrics).toEqual([]);
  });

  it('judgeEnabled but no rubrics configured → rubrics=[]', () => {
    const t = resolveJudgeToggles(
      evaluators({ strategy: 'llm_judge', enabledRubric: [] }),
    );
    expect(t.judgeEnabled).toBe(true);
    expect(t.rubrics).toEqual([]);
  });
});
