// Proof: a flat CSV row's `expected_answer` value is reachable by the
// deterministic correctness scorer (`scoreGoldenCore`).
//
// What this test answers: "if I put `expected_answer` in a row of
// cases.csv, will the eval-worker actually use it to compute
// correctness.em / correctness.bleu / correctness.tokenF1 / correctness.rougeL,
// or does it get parsed and silently dropped on the floor?"
//
// The test walks the exact data path the runtime takes:
//   1. parseFlatCsv() — emits GoldenTestCase with
//      evaluation.expected_response.final.expected_answer set.
//   2. scoreGoldenCore() — receives that string and emits em/bleu/rougeL/tokenF1.
//
// If this test passes, the threading is correct. If a real eval run still
// shows no `correctness.*` keys, the cause is upstream of the worker (empty
// CSV cells, scorerToggles.golden=false, or the case never reached scoring).

import {
  scoreGoldenCore,
} from '../../src/activities/scoring.activities';
import { parseFlatCsv } from '../../src/lib/flat-csv';

describe('flat-csv → scoreGoldenCore threading', () => {
  it('exact-match response yields em=1 and high overlap scores', () => {
    const csv = [
      'id,query,expected_answer',
      'q-1,What is 2+2?,The answer is 4',
    ].join('\n');

    const { cases } = parseFlatCsv(csv);
    expect(cases).toHaveLength(1);

    // The expected_answer must be reachable at the documented JSON path.
    const expectedAnswer =
      cases[0].evaluation.expected_response.final.expected_answer;
    expect(expectedAnswer).toBe('The answer is 4');

    // Now feed the parsed case through the scorer with a perfect response.
    const result = scoreGoldenCore({
      response: 'The answer is 4',
      expectedAnswer,
    });

    if ('notComputedReason' in result) {
      throw new Error(
        `scoreGoldenCore returned notComputedReason=${result.notComputedReason}`,
      );
    }
    expect(result.em).toBe(1);
    expect(result.tokenF1).toBe(1);
    expect(result.bleu).toBeGreaterThan(0);
    expect(result.rougeL).toBeGreaterThan(0);
  });

  it('partial-match response yields em=0 but non-zero tokenF1', () => {
    const csv = 'q-2,What is 2+2?,The answer is 4';
    const { cases } = parseFlatCsv(csv);
    const expectedAnswer =
      cases[0].evaluation.expected_response.final.expected_answer;
    expect(expectedAnswer).toBe('The answer is 4');

    const result = scoreGoldenCore({
      response: '4', // correct fact, wrong wording
      expectedAnswer,
    });

    if ('notComputedReason' in result) {
      throw new Error(
        `scoreGoldenCore returned notComputedReason=${result.notComputedReason}`,
      );
    }
    // em is exact-string-after-normalize → "4" !== "the answer is 4"
    expect(result.em).toBe(0);
    // tokenF1 still positive because "4" overlaps with the expected tokens.
    expect(result.tokenF1).toBeGreaterThan(0);
  });

  it('totally-wrong response yields em=0 and tokenF1=0', () => {
    const csv = 'q-3,Q?,Apple banana cherry';
    const { cases } = parseFlatCsv(csv);
    const expectedAnswer =
      cases[0].evaluation.expected_response.final.expected_answer;
    expect(expectedAnswer).toBe('Apple banana cherry');

    const result = scoreGoldenCore({
      response: 'zebra xenon quartz',
      expectedAnswer,
    });

    if ('notComputedReason' in result) {
      throw new Error(
        `scoreGoldenCore returned notComputedReason=${result.notComputedReason}`,
      );
    }
    expect(result.em).toBe(0);
    expect(result.tokenF1).toBe(0);
  });

  it('empty expected_answer cell short-circuits with no_reference', () => {
    // The CSV layer treats "" as "no expected answer" — the GoldenTestCase
    // ends up with `final: {}` (no key) rather than `expected_answer: ""`.
    const csv = 'q-4,Q?,';
    const { cases } = parseFlatCsv(csv);
    expect(
      cases[0].evaluation.expected_response.final.expected_answer,
    ).toBeUndefined();

    const result = scoreGoldenCore({
      response: 'anything',
      expectedAnswer:
        cases[0].evaluation.expected_response.final.expected_answer,
    });
    expect(result).toEqual({ notComputedReason: 'no_reference' });
  });
});
