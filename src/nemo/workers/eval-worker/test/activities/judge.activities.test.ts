import { ApplicationFailure } from '@temporalio/activity';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockReadCaptureFile = jest.fn();

jest.mock('../../src/lib/got', () => {
  const actual =
    jest.requireActual('../../src/lib/got') as typeof import('../../src/lib/got');
  return {
    ...actual,
    gotPost: jest.fn(),
  };
});
jest.mock('../../src/lib/auth', () => ({
  getServiceAccountToken: jest.fn(),
  getAuthHeaders: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/lib/capture-file', () => ({
  readCaptureFile: (...a: any[]) => mockReadCaptureFile(...a),
}));

import { gotPost } from '../../src/lib/got';
import { getServiceAccountToken } from '../../src/lib/auth';
import { invokeJudge, invokePairwiseJudge } from '../../src/activities/judge.activities';
import type {
  AgentInvocationResult,
  CaptureFile,
  CaseRef,
  GoldenTestCase,
  InvokeJudgeInput,
  InvokePairwiseJudgeInput,
} from '../../src/lib/evaluation';

const mockGotPost = gotPost as jest.MockedFunction<typeof gotPost>;
const mockGetServiceAccountToken = getServiceAccountToken as jest.MockedFunction<
  typeof getServiceAccountToken
>;

function makeCaseRef(overrides: Partial<CaseRef> = {}): CaseRef {
  return {
    projectId: 'p',
    evalId: 'eval-1',
    runId: 'run-1',
    caseId: 'case-1',
    model: 'gpt-4o',
    ...overrides,
  };
}

function makeCaptureFile(
  capture: Partial<AgentInvocationResult> = {},
): CaptureFile {
  return {
    schemaVersion: 1,
    caseRef: makeCaseRef(),
    envelopeHash: 'env',
    capturedAt: new Date().toISOString(),
    capture: {
      response: '',
      citations: [],
      retrievedChunks: [],
      toolCalls: [],
      perAgent: [],
      telemetry: { e2eMs: 100 },
      retrievalAnnotation: null,
      resolvedRuntimeParams: {},
      ...capture,
    },
  };
}

function chatReply(body: unknown): { choices: Array<{ message: { content: string } }> } {
  return {
    choices: [{ message: { content: JSON.stringify(body) } }],
  };
}

const baseCase: GoldenTestCase = {
  id: 'case-1',
  input: { query: 'What is 2+2?' },
  evaluation: {
    expected_response: { final: { expected_answer: '4' } },
  },
};

function pointwiseInput(
  overrides: Partial<InvokeJudgeInput> = {},
): InvokeJudgeInput {
  return {
    caseRef: makeCaseRef(),
    capturePath: 'posix:///c.json',
    rubricId: 'correctness',
    evaluatorModel: 'gpt-4o',
    evaluatorVersion: 'live',
    rubricPromptHash: 'hash-correctness',
    case: baseCase,
    mode: 'pointwise',
    ...overrides,
  };
}

function pairwiseInput(
  overrides: Partial<InvokePairwiseJudgeInput> = {},
): InvokePairwiseJudgeInput {
  return {
    caseRef: makeCaseRef(),
    capturePathA: 'posix:///a.json',
    capturePathB: 'posix:///b.json',
    rubricId: 'helpfulness',
    evaluatorModel: 'gpt-4o',
    evaluatorVersion: 'live',
    case: baseCase,
    ...overrides,
  };
}

function httpError(statusCode: number): Error & { response: { statusCode: number } } {
  const err = new Error(`HTTP ${statusCode}`) as Error & {
    response: { statusCode: number };
  };
  err.response = { statusCode };
  // The activity's isHTTPError check uses `instanceof HTTPError`, but the
  // module re-exports the class. Stub the prototype chain so `isHTTPError`
  // returns true for our fake.
  const got = jest.requireActual('got') as { HTTPError: new (...args: never[]) => Error };
  Object.setPrototypeOf(err, got.HTTPError.prototype);
  return err;
}

describe('judge.activities', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env['LLM_GATEWAY_URL'] = 'http://gw.test';
    delete process.env['LLM_GATEWAY_TOKEN'];
    mockGotPost.mockReset();
    mockGetServiceAccountToken.mockReset();
    mockGetServiceAccountToken.mockResolvedValue(null);
    // Default capture file used by both pointwise + pairwise tests. Per-test
    // overrides are layered on by calling mockReadCaptureFile.mockImplementation
    // directly.
    mockReadCaptureFile.mockReset();
    mockReadCaptureFile.mockImplementation(async (capturePath: string) => {
      // Pairwise A vs B captures get distinct response strings so message
      // assertions can verify both are forwarded.
      if (capturePath.endsWith('/a.json')) {
        return makeCaptureFile({ response: 'AAA' });
      }
      if (capturePath.endsWith('/b.json')) {
        return makeCaptureFile({ response: 'BBB' });
      }
      return makeCaptureFile({ response: '4' });
    });
  });

  afterAll(() => {
    process.env = origEnv;
  });

  // ── invokeJudge ────────────────────────────────────────────────────

  describe('invokeJudge', () => {
    it('posts an OpenAI-shape request to the configured gateway and parses the score', async () => {
      mockGotPost.mockResolvedValueOnce(
        chatReply({ score: 0.9, rationale: 'spot on' }),
      );
      const out = await invokeJudge(pointwiseInput());

      expect(out).toMatchObject({
        rubricId: 'correctness',
        judgeModelName: 'gpt-4o',
        judgeVersion: 'live',
        rubricPromptHash: 'hash-correctness',
        score: 0.9,
        outOf: 1,
        rationale: 'spot on',
        mode: 'pointwise',
      });
      expect(mockGotPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockGotPost.mock.calls[0];
      expect(url).toBe('http://gw.test/v1/chat/completions');
      const reqBody = body as {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
      };
      expect(reqBody.model).toBe('gpt-4o');
      expect(reqBody.temperature).toBe(0);
      expect(reqBody.messages[0].role).toBe('system');
      expect(reqBody.messages[1].role).toBe('user');
      expect(reqBody.messages[1].content).toContain('What is 2+2?');
    });

    it('strips the trailing slash from LLM_GATEWAY_URL', async () => {
      process.env['LLM_GATEWAY_URL'] = 'http://gw.test/';
      mockGotPost.mockResolvedValueOnce(chatReply({ score: 0.5 }));
      await invokeJudge(pointwiseInput());
      const [url] = mockGotPost.mock.calls[0];
      expect(url).toBe('http://gw.test/v1/chat/completions');
    });

    it('throws InvalidInputError when LLM_GATEWAY_URL is unset', async () => {
      delete process.env['LLM_GATEWAY_URL'];
      await expect(invokeJudge(pointwiseInput())).rejects.toMatchObject({
        type: 'InvalidInputError',
      });
    });

    it('forwards LLM_GATEWAY_TOKEN as a static bearer auth header', async () => {
      process.env['LLM_GATEWAY_TOKEN'] = 'static-tok';
      mockGotPost.mockResolvedValueOnce(chatReply({ score: 0.5 }));
      await invokeJudge(pointwiseInput());
      const opts = mockGotPost.mock.calls[0][2] as {
        headers?: Record<string, string>;
      };
      expect(opts.headers?.['authorization']).toBe('Bearer static-tok');
    });

    it('falls back to a service-account JWT when no static token is set', async () => {
      mockGetServiceAccountToken.mockResolvedValueOnce('sa-jwt');
      mockGotPost.mockResolvedValueOnce(chatReply({ score: 0.5 }));
      await invokeJudge(pointwiseInput());
      const opts = mockGotPost.mock.calls[0][2] as {
        headers?: Record<string, string>;
      };
      expect(opts.headers?.['authorization']).toBe('Bearer sa-jwt');
    });

    it('omits auth headers entirely when neither source is configured', async () => {
      mockGotPost.mockResolvedValueOnce(chatReply({ score: 0.5 }));
      await invokeJudge(pointwiseInput());
      const opts = mockGotPost.mock.calls[0][2] as {
        headers?: Record<string, string>;
      };
      expect(opts.headers).toBeUndefined();
    });

    it('retries once on malformed content and uses the second reply', async () => {
      mockGotPost
        .mockResolvedValueOnce(chatReply({ /* missing score */ rationale: 'oops' }))
        .mockResolvedValueOnce(chatReply({ score: 0.8, rationale: 'good' }));
      const out = await invokeJudge(pointwiseInput());
      expect(mockGotPost).toHaveBeenCalledTimes(2);
      expect(out.score).toBe(0.8);
      expect(out.rationale).toBe('good');
    });

    it('returns errored=true after two unparseable replies', async () => {
      mockGotPost
        .mockResolvedValueOnce(chatReply({ rationale: 'no score' }))
        .mockResolvedValueOnce(chatReply({ rationale: 'still no score' }));
      const out = await invokeJudge(pointwiseInput());
      expect(out.errored).toBe(true);
      expect(out.rationale).toBe('malformed_response');
      expect(out.rubricPromptHash).toBe('hash-correctness');
    });

    it('soft-fails on 4xx responses (errored=true, no throw)', async () => {
      mockGotPost.mockRejectedValueOnce(httpError(404));
      const out = await invokeJudge(pointwiseInput());
      expect(out.errored).toBe(true);
      expect(out.rationale).toContain('HTTP 404');
    });

    it('re-throws on 5xx (Temporal handles retry)', async () => {
      mockGotPost.mockRejectedValueOnce(httpError(503));
      await expect(invokeJudge(pointwiseInput())).rejects.toThrow('HTTP 503');
    });

    it('re-throws non-HTTP errors (network failure)', async () => {
      mockGotPost.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(invokeJudge(pointwiseInput())).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('re-throws InvalidInputError directly even after dispatch', async () => {
      mockGotPost.mockImplementationOnce(() => {
        throw ApplicationFailure.nonRetryable('bad input', 'InvalidInputError');
      });
      await expect(invokeJudge(pointwiseInput())).rejects.toMatchObject({
        type: 'InvalidInputError',
      });
    });

    it('surfaces criteriaScores on the output when the model returns them', async () => {
      mockGotPost.mockResolvedValueOnce(
        chatReply({
          score: 0.85,
          rationale: 'spot on',
          criteria_scores: [
            { name: 'factual_accuracy', score: 0.9 },
            { name: 'logical_consistency', score: 0.8 },
            { name: 'hallucination_absence', score: 1.0 },
          ],
        }),
      );
      const out = await invokeJudge(pointwiseInput());
      expect(out.criteriaScores).toEqual([
        { name: 'factual_accuracy', score: 0.9 },
        { name: 'logical_consistency', score: 0.8 },
        { name: 'hallucination_absence', score: 1.0 },
      ]);
    });

    it('omits criteriaScores when the model reply has none (backward-compatible)', async () => {
      mockGotPost.mockResolvedValueOnce(
        chatReply({ score: 0.5, rationale: 'mid' }),
      );
      const out = await invokeJudge(pointwiseInput());
      expect(out.criteriaScores).toBeUndefined();
    });
  });

  // ── invokePairwiseJudge ────────────────────────────────────────────

  describe('invokePairwiseJudge', () => {
    it('returns a pairwise verdict with winner + computed rubricPromptHash', async () => {
      mockGotPost.mockResolvedValueOnce(
        chatReply({ score: 0.7, winner: 'B', rationale: 'B is clearer' }),
      );
      const out = await invokePairwiseJudge(pairwiseInput());
      expect(out.mode).toBe('pairwise');
      expect(out.winner).toBe('B');
      expect(out.score).toBe(0.7);
      expect(out.rationale).toBe('B is clearer');
      expect(out.rubricPromptHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces the same rubricPromptHash for the same rubricId across calls', async () => {
      mockGotPost
        .mockResolvedValueOnce(chatReply({ score: 0.5, winner: 'A' }))
        .mockResolvedValueOnce(chatReply({ score: 0.5, winner: 'B' }));
      const first = await invokePairwiseJudge(pairwiseInput());
      const second = await invokePairwiseJudge(pairwiseInput());
      expect(first.rubricPromptHash).toBe(second.rubricPromptHash);
    });

    it('produces different rubricPromptHash for different rubricIds', async () => {
      mockGotPost
        .mockResolvedValueOnce(chatReply({ score: 0.5, winner: 'A' }))
        .mockResolvedValueOnce(chatReply({ score: 0.5, winner: 'A' }));
      const a = await invokePairwiseJudge(pairwiseInput({ rubricId: 'helpfulness' }));
      const b = await invokePairwiseJudge(pairwiseInput({ rubricId: 'correctness' }));
      expect(a.rubricPromptHash).not.toBe(b.rubricPromptHash);
    });

    it('appends Response B to the user message', async () => {
      // Default mockReadCaptureFile returns 'AAA' for capturePathA and 'BBB'
      // for capturePathB; the activity should embed both verbatim.
      mockGotPost.mockResolvedValueOnce(chatReply({ score: 0.5, winner: 'tie' }));
      await invokePairwiseJudge(pairwiseInput());
      const body = mockGotPost.mock.calls[0][1] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMsg = body.messages[1].content;
      expect(userMsg).toContain('Response A:');
      expect(userMsg).toContain('AAA');
      expect(userMsg).toContain('Response B:');
      expect(userMsg).toContain('BBB');
    });

    it('soft-fails (no retry) on malformed reply', async () => {
      mockGotPost.mockResolvedValueOnce(chatReply({ rationale: 'no score' }));
      const out = await invokePairwiseJudge(pairwiseInput());
      expect(out.errored).toBe(true);
      expect(out.rationale).toBe('malformed_response');
      expect(mockGotPost).toHaveBeenCalledTimes(1);
    });

    it('soft-fails on 4xx', async () => {
      mockGotPost.mockRejectedValueOnce(httpError(400));
      const out = await invokePairwiseJudge(pairwiseInput());
      expect(out.errored).toBe(true);
      expect(out.rationale).toContain('HTTP 400');
    });

    it('re-throws on 5xx', async () => {
      mockGotPost.mockRejectedValueOnce(httpError(502));
      await expect(invokePairwiseJudge(pairwiseInput())).rejects.toThrow(
        'HTTP 502',
      );
    });

    it('re-throws non-HTTP errors', async () => {
      mockGotPost.mockRejectedValueOnce(new Error('boom'));
      await expect(invokePairwiseJudge(pairwiseInput())).rejects.toThrow('boom');
    });

    it('surfaces criteriaScores on pairwise output when the model returns per-criterion preferences', async () => {
      mockGotPost.mockResolvedValueOnce(
        chatReply({
          score: 0.7,
          winner: 'B',
          rationale: 'B is sharper',
          criteria_scores: [
            { name: 'addresses_query', score: 0.6 },
            { name: 'actionability', score: 0.8 },
            { name: 'relevance', score: 0.5 },
          ],
        }),
      );
      const out = await invokePairwiseJudge(pairwiseInput());
      expect(out.winner).toBe('B');
      expect(out.criteriaScores).toEqual([
        { name: 'addresses_query', score: 0.6 },
        { name: 'actionability', score: 0.8 },
        { name: 'relevance', score: 0.5 },
      ]);
    });
  });
});
