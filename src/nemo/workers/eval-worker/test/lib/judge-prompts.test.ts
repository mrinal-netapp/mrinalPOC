import {
  RUBRIC_CRITERIA,
  getPairwiseRubricPrompts,
  getRubricPrompts,
  parseJudgeReply,
} from '../../src/lib/judge-prompts';

describe('judge-prompts', () => {
  describe('RUBRIC_CRITERIA registry', () => {
    it('exports a sub-criteria list for every built-in rubric', () => {
      const expected = [
        'helpfulness',
        'correctness',
        'completeness',
        'coherence',
        'following_instructions',
        'professional_style_tone',
        'faithfulness_groundedness',
        'safety_harmlessness',
        'refusal_quality',
      ];
      for (const id of expected) {
        expect(RUBRIC_CRITERIA[id]).toBeDefined();
        expect(RUBRIC_CRITERIA[id].length).toBeGreaterThan(0);
      }
    });

    it('matches what getRubricPrompts(id).criteria returns', () => {
      for (const [id, criteria] of Object.entries(RUBRIC_CRITERIA)) {
        expect(getRubricPrompts(id).criteria).toEqual(criteria);
      }
    });

    it('has no overlapping criterion names across rubrics that could collide', () => {
      // Not a hard rule — but documents the current shape so a future
      // editor notices if they introduce ambiguity.
      const all: string[] = [];
      for (const [, criteria] of Object.entries(RUBRIC_CRITERIA)) {
        all.push(...criteria);
      }
      const unique = new Set(all);
      expect(unique.size).toBe(all.length);
    });
  });

  describe('getRubricPrompts', () => {
    it.each([
      'helpfulness',
      'correctness',
      'completeness',
      'coherence',
      'following_instructions',
      'professional_style_tone',
      'faithfulness_groundedness',
      'safety_harmlessness',
      'refusal_quality',
    ])('returns a known prompt template for "%s" with sub-criteria', (rubricId) => {
      const prompts = getRubricPrompts(rubricId);
      expect(prompts.system).toContain('JSON');
      expect(prompts.criteria.length).toBeGreaterThan(0);
      // System prompt must list the criteria names for the model.
      for (const c of prompts.criteria) {
        expect(prompts.system).toContain(c);
      }
      const userMsg = prompts.user({
        query: 'q',
        response: 'r',
      });
      expect(userMsg).toContain('User query:');
      expect(userMsg).toContain('Response to evaluate:');
      // User message lists the criteria as a comma-separated guide.
      expect(userMsg).toContain(prompts.criteria.join(', '));
    });

    it('falls back to a generic template for an unknown rubric, interpolating the id', () => {
      const prompts = getRubricPrompts('made-up-rubric');
      expect(prompts.system).toContain('made-up-rubric');
      // Generic fallback has no canonical sub-criteria.
      expect(prompts.criteria).toEqual([]);
      // No criteria_scores instruction in the schema reminder.
      expect(prompts.system).not.toContain('criteria_scores');
      expect(prompts.user({ query: 'q', response: 'r' })).toContain(
        'made-up-rubric',
      );
    });

    it('includes reference and expected answer when provided', () => {
      const prompts = getRubricPrompts('correctness');
      const userMsg = prompts.user({
        query: 'q',
        response: 'r',
        reference: 'context-A',
        expectedAnswer: 'Paris',
      });
      expect(userMsg).toContain('Reference context:');
      expect(userMsg).toContain('context-A');
      expect(userMsg).toContain('Expected answer:');
      expect(userMsg).toContain('Paris');
    });

    it('omits the reference/expected sections when not provided', () => {
      const prompts = getRubricPrompts('correctness');
      const userMsg = prompts.user({ query: 'q', response: 'r' });
      expect(userMsg).not.toContain('Reference context:');
      expect(userMsg).not.toContain('Expected answer:');
    });
  });

  describe('getPairwiseRubricPrompts', () => {
    it('augments the base system prompt with pairwise framing + winner field', () => {
      const prompts = getPairwiseRubricPrompts('helpfulness');
      expect(prompts.system).toContain('TWO candidate responses');
      expect(prompts.system).toContain('winner');
    });

    it('renders the user prompt with Response A surfaced', () => {
      const prompts = getPairwiseRubricPrompts('helpfulness');
      const userMsg = prompts.user({ query: 'q', response: 'first-answer' });
      expect(userMsg).toContain('Compare the following two responses');
      expect(userMsg).toContain('Response A:');
      expect(userMsg).toContain('first-answer');
    });

    it('inherits sub-criteria from the underlying rubric for B-preference scoring', () => {
      const prompts = getPairwiseRubricPrompts('correctness');
      expect(prompts.criteria).toEqual([
        'factual_accuracy',
        'logical_consistency',
        'hallucination_absence',
      ]);
      // Pairwise framing instructs criteria_scores entries to express
      // B-over-A preference per sub-criterion.
      expect(prompts.system).toContain('factual_accuracy');
      expect(prompts.system).toContain('preference for B');
    });

    it('skips the criteria clause for the generic fallback', () => {
      const prompts = getPairwiseRubricPrompts('unknown');
      expect(prompts.criteria).toEqual([]);
      expect(prompts.system).not.toContain('preference for B');
    });
  });

  describe('parseJudgeReply', () => {
    it('parses a bare JSON object', () => {
      expect(parseJudgeReply('{"score": 0.7, "rationale": "ok"}')).toEqual({
        score: 0.7,
        rationale: 'ok',
        winner: undefined,
      });
    });

    it('strips code-fence wrapping', () => {
      expect(
        parseJudgeReply('```json\n{"score": 0.5, "rationale": "fenced"}\n```'),
      ).toEqual({ score: 0.5, rationale: 'fenced', winner: undefined });
    });

    it('strips generic code fences without a language tag', () => {
      expect(
        parseJudgeReply('```\n{"score": 0.9}\n```'),
      ).toEqual({ score: 0.9, rationale: undefined, winner: undefined });
    });

    it('extracts the JSON block when surrounded by prose', () => {
      const reply = 'Sure! Here is my judgement: {"score": 0.3, "rationale": "weak"} thanks';
      expect(parseJudgeReply(reply)).toEqual({
        score: 0.3,
        rationale: 'weak',
        winner: undefined,
      });
    });

    it('captures a valid pairwise winner', () => {
      expect(
        parseJudgeReply('{"score": 0.8, "winner": "B", "rationale": "B is better"}'),
      ).toEqual({ score: 0.8, rationale: 'B is better', winner: 'B' });
    });

    it('treats an unknown winner value as undefined', () => {
      expect(
        parseJudgeReply('{"score": 0.4, "winner": "C"}'),
      ).toEqual({ score: 0.4, rationale: undefined, winner: undefined });
    });

    it('clamps score into [0, 1]', () => {
      expect(parseJudgeReply('{"score": 1.7}')?.score).toBe(1);
      expect(parseJudgeReply('{"score": -0.3}')?.score).toBe(0);
    });

    it('returns null when there is no JSON object', () => {
      expect(parseJudgeReply('no json here')).toBeNull();
    });

    it('returns null when JSON is malformed', () => {
      expect(parseJudgeReply('{"score": 0.5,')).toBeNull();
    });

    it('returns null when score is missing or non-numeric', () => {
      expect(parseJudgeReply('{"rationale": "x"}')).toBeNull();
      expect(parseJudgeReply('{"score": "high"}')).toBeNull();
    });

    it('returns null for non-string input', () => {
      // The signature is `string`, but defensive against runtime drift.
      expect(parseJudgeReply(undefined as unknown as string)).toBeNull();
    });

    it('parses a criteria_scores array (snake_case) and clamps each entry', () => {
      const reply = JSON.stringify({
        score: 0.8,
        rationale: 'good',
        criteria_scores: [
          { name: 'factual_accuracy', score: 0.9 },
          { name: 'logical_consistency', score: 1.5 }, // clamp to 1
          { name: 'hallucination_absence', score: -0.2 }, // clamp to 0
        ],
      });
      const out = parseJudgeReply(reply);
      expect(out?.criteriaScores).toEqual([
        { name: 'factual_accuracy', score: 0.9 },
        { name: 'logical_consistency', score: 1 },
        { name: 'hallucination_absence', score: 0 },
      ]);
    });

    it('accepts the camelCase variant criteriaScores for defensive parsing', () => {
      const reply = JSON.stringify({
        score: 0.5,
        criteriaScores: [{ name: 'foo', score: 0.5 }],
      });
      expect(parseJudgeReply(reply)?.criteriaScores).toEqual([
        { name: 'foo', score: 0.5 },
      ]);
    });

    it('omits criteriaScores when the array is missing', () => {
      const out = parseJudgeReply('{"score": 0.7}');
      expect(out?.criteriaScores).toBeUndefined();
    });

    it('omits invalid entries (missing name or non-numeric score) but keeps the rest', () => {
      const reply = JSON.stringify({
        score: 0.7,
        criteria_scores: [
          { name: 'good', score: 0.6 },
          { name: 'missing-score' },
          { score: 0.9 }, // missing name
          'string-not-object',
          { name: 'bad-score', score: 'high' },
        ],
      });
      expect(parseJudgeReply(reply)?.criteriaScores).toEqual([
        { name: 'good', score: 0.6 },
      ]);
    });

    it('drops criteriaScores entirely when no entries survive validation', () => {
      const reply = JSON.stringify({
        score: 0.7,
        criteria_scores: [
          { score: 0.5 }, // no name
        ],
      });
      expect(parseJudgeReply(reply)?.criteriaScores).toBeUndefined();
    });
  });
});
