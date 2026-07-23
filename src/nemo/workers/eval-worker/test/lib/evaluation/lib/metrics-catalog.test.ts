import {
  METRICS_REFERENCE_FREE,
  METRICS_GOLDEN_DEPENDENT,
  isReferenceFree,
  isGoldenDependent,
} from '../../../../src/lib/evaluation/lib/metrics-catalog';

describe('metrics-catalog', () => {
  it('reference-free and golden-dependent sets are disjoint', () => {
    const a = new Set(METRICS_REFERENCE_FREE);
    for (const m of METRICS_GOLDEN_DEPENDENT) {
      expect(a.has(m)).toBe(false);
    }
  });

  describe('isReferenceFree', () => {
    it.each([
      'perf.e2e_ms',
      'perf.ttft_ms',
      'cost.per_case_usd',
      'tool.call_success',
      'rag.groundedness',
      'safety.refusalQuality',
      'structured.schema_valid',
    ])('returns true for "%s"', (id) => {
      expect(isReferenceFree(id)).toBe(true);
    });

    it.each([
      'correctness.em',
      'correctness.bleu',
      'rag.context_precision',
      'tool.selection_accuracy',
      'safety.unsafe_rate',
    ])('returns false for golden-dependent metric "%s"', (id) => {
      expect(isReferenceFree(id)).toBe(false);
    });

    it('returns false for unknown / uncataloged ids', () => {
      expect(isReferenceFree('mystery.metric')).toBe(false);
    });
  });

  describe('isGoldenDependent', () => {
    it.each([
      'correctness.em',
      'correctness.bleu',
      'correctness.rougeL',
      'correctness.tokenF1',
      'rag.context_precision',
      'rag.context_recall',
      'rag.citation_alignment',
      'must_cite.coverage',
      'tool.selection_accuracy',
      'tool.arg_validity',
      'tool.plan_accuracy',
      'safety.unsafe_rate',
      'safety.false_refusal_rate',
      'safety.boundary',
    ])('returns true for "%s"', (id) => {
      expect(isGoldenDependent(id)).toBe(true);
    });

    it.each([
      'perf.e2e_ms',
      'rag.groundedness',
      'tool.call_success',
      'structured.schema_valid',
    ])('returns false for reference-free metric "%s"', (id) => {
      expect(isGoldenDependent(id)).toBe(false);
    });

    it('returns false for unknown ids', () => {
      expect(isGoldenDependent('mystery.metric')).toBe(false);
    });
  });
});
