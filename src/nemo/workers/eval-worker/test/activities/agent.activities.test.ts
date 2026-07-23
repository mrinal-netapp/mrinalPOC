/**
 * Unit tests for agent.activities.ts.
 *
 * Covers:
 *   - URL routing based on `agentId` presence (per §14.1 of the design spec)
 *   - InvokeRequest body shape (metadata.eval envelope, configOverrides
 *     mapping, context.toolsHint, attachments)
 *   - InvokeResponse → capture file synthesis (asserted via the
 *     `writeCaptureFile` mock — stage 1, path-only Temporal payloads)
 *   - InvokeAgentOutput shape (capturePath + telemetry headline)
 *   - Error mapping (404, 422 content_filter, 4xx, 5xx)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGotPost = jest.fn();
const mockWriteCaptureFile = jest.fn();

jest.mock('../../src/lib/got', () => ({
  gotPost: (...a: any[]) => mockGotPost(...a),
  isHTTPError: (err: any) => err && err.__isHttpError === true,
}));

jest.mock('../../src/lib/capture-file', () => ({
  writeCaptureFile: (...a: any[]) => mockWriteCaptureFile(...a),
}));

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
  activityInfo: () => ({ attempt: 1 }),
}));

import {
  buildAgentInvokeEndpoint,
  invokeAgent,
} from '../../src/activities/agent.activities';
import type {
  AgentInvocationResult,
  CaseRef,
  InvokeAgentInput,
} from '../../src/lib/evaluation';

function baseCaseRef(overrides: Partial<CaseRef> = {}): CaseRef {
  return {
    projectId: 'proj-1',
    evalId: 'eval-1',
    runId: 'run-1',
    caseId: 'case-1',
    model: 'gpt-4o',
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<InvokeAgentInput> = {},
): InvokeAgentInput {
  const { caseRef: refOverride, ...rest } = overrides;
  return {
    caseRef: { ...baseCaseRef(), ...(refOverride ?? {}) },
    agentTeam: 'team-1',
    envelopeHash: 'envelope-abc',
    overrides: { model: 'gpt-4o' },
    input: { query: 'What is the capital of France?' },
    ...rest,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env['AGENT_SERVICE_URL'] = 'http://agent-service:8000';
  mockWriteCaptureFile.mockResolvedValue(
    'posix:///projects/proj-1/evaluations/eval-1/runs/run-1/cases/case-1/single/gpt-4o/0/capture.json',
  );
});

afterEach(() => {
  delete process.env['AGENT_SERVICE_URL'];
  delete process.env['AGENT_SERVICE_TOKEN'];
});

/** Read the synthesized AgentInvocationResult from the writeCaptureFile mock. */
function lastCapture(): AgentInvocationResult {
  const args = mockWriteCaptureFile.mock.calls.at(-1);
  if (!args) throw new Error('writeCaptureFile not called');
  return args[1].capture as AgentInvocationResult;
}

// ── URL routing (§14.1) ──────────────────────────────────────────────

describe('buildAgentInvokeEndpoint', () => {
  it('routes to /api/v1/projects/{id}/agents/{agentId}/invoke when agentId is set', () => {
    const url = buildAgentInvokeEndpoint(
      baseInput({ agentId: 'router-bot', agentTeam: 'ignored-team' }),
    );
    expect(url).toBe(
      'http://agent-service:8000/api/v1/projects/proj-1/agents/router-bot/invoke',
    );
  });

  it('routes to /api/v1/projects/{id}/agent-teams/{team}/invoke when agentId is absent', () => {
    const url = buildAgentInvokeEndpoint(baseInput({ agentTeam: 'support-team' }));
    expect(url).toBe(
      'http://agent-service:8000/api/v1/projects/proj-1/agent-teams/support-team/invoke',
    );
  });

  it('URL-encodes projectId, agentId, and agentTeam', () => {
    const url1 = buildAgentInvokeEndpoint(
      baseInput({
        caseRef: baseCaseRef({ projectId: 'proj with space' }),
        agentId: 'agent/slash',
      }),
    );
    expect(url1).toBe(
      'http://agent-service:8000/api/v1/projects/proj%20with%20space/agents/agent%2Fslash/invoke',
    );
    const url2 = buildAgentInvokeEndpoint(
      baseInput({ agentTeam: 'team:colon' }),
    );
    expect(url2).toBe(
      'http://agent-service:8000/api/v1/projects/proj-1/agent-teams/team%3Acolon/invoke',
    );
  });

  it('throws when AGENT_SERVICE_URL is unset', () => {
    delete process.env['AGENT_SERVICE_URL'];
    expect(() => buildAgentInvokeEndpoint(baseInput())).toThrow(
      /AGENT_SERVICE_URL is not configured/,
    );
  });
});

// ── Request body shape (§14.2) ───────────────────────────────────────

describe('invokeAgent — request body', () => {
  // Matches MAF agent-service InvokeResponse shape:
  //   { agentId, output, durationMs, sessionId, citations?, usage?, ... }
  function happyResponse(extra: Record<string, unknown> = {}) {
    return {
      agentId: 'a-1',
      output: 'Paris',
      durationMs: 100,
      sessionId: 's-1',
      ...extra,
    };
  }

  it("places the test case query into the top-level `input` field", async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(
      baseInput({ input: { query: 'specific question' } }),
    );
    const body = mockGotPost.mock.calls[0][1] as { input: string };
    expect(body.input).toBe('specific question');
  });

  it('does not set sessionId (eval has no conversation continuity)', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(baseInput());
    const body = mockGotPost.mock.calls[0][1] as { sessionId?: string };
    expect(body.sessionId).toBeUndefined();
  });

  it('carries eval IDs in top-level metadata.eval (passthrough envelope)', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(
      baseInput({
        caseRef: baseCaseRef({
          runId: 'run-7',
          caseId: 'case-9',
          variantId: 'B',
          seed: 42,
        }),
        envelopeHash: 'env-hash-xyz',
      }),
    );
    const body = mockGotPost.mock.calls[0][1] as {
      metadata?: { eval?: Record<string, unknown> };
    };
    expect(body.metadata?.eval).toMatchObject({
      runId: 'run-7',
      testCaseId: 'case-9',
      variantId: 'B',
      envelopeHash: 'env-hash-xyz',
      seed: 42,
    });
    expect(body.metadata?.eval?.matrixSlice).toMatch(/case-case-9/);
    expect(body.metadata?.eval?.matrixSlice).toMatch(/variant-B/);
    expect(body.metadata?.eval?.matrixSlice).toMatch(/seed-42/);
  });

  it('maps overrides → configOverrides (camelCase, MAF allowlist)', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(
      baseInput({
        overrides: {
          model: 'claude-sonnet',
          temperature: 0.7,
          maxTokens: 1024,
          // eval-specific knobs MAF doesn't recognise — silently dropped.
          topKRetrieval: 5,
          rerank: true,
        },
      }),
    );
    const body = mockGotPost.mock.calls[0][1] as {
      configOverrides?: Record<string, unknown>;
    };
    expect(body.configOverrides).toEqual({
      model: 'claude-sonnet',
      temperature: 0.7,
      maxTokens: 1024,
    });
  });

  it('omits configOverrides when no MAF-recognised fields are set', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(
      baseInput({ overrides: { topKRetrieval: 5, rerank: true } }),
    );
    const body = mockGotPost.mock.calls[0][1] as { configOverrides?: unknown };
    expect(body.configOverrides).toBeUndefined();
  });

  it('places context_hints under context.toolsHint when present', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(
      baseInput({
        input: {
          query: 'q',
          context_hints: ['hint-a', 'hint-b'],
        },
      }),
    );
    const body = mockGotPost.mock.calls[0][1] as {
      context?: { toolsHint?: string[] };
    };
    expect(body.context?.toolsHint).toEqual(['hint-a', 'hint-b']);
  });

  it('passes attachments through when present', async () => {
    mockGotPost.mockResolvedValueOnce(happyResponse());
    const att = [
      { filename: 'x.png', mimeType: 'image/png', content: 'base64-...' },
    ];
    await invokeAgent(baseInput({ input: { query: 'q', attachments: att } }));
    const body = mockGotPost.mock.calls[0][1] as { attachments?: unknown[] };
    expect(body.attachments).toEqual(att);
  });

  it('adds Bearer token header when AGENT_SERVICE_TOKEN is set', async () => {
    process.env['AGENT_SERVICE_TOKEN'] = 'sa-token';
    mockGotPost.mockResolvedValueOnce(happyResponse());
    await invokeAgent(baseInput());
    const opts = mockGotPost.mock.calls[0][2] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(opts?.headers?.authorization).toBe('Bearer sa-token');
  });
});

// ── Response synthesis → capture file (§14.3 + §14.6) ────────────────

describe('invokeAgent — capture synthesis', () => {
  // Matches MAF agent-service InvokeResponse shape: structured citations
  // envelope with respondingAgent / kbCitations / agentTrace sub-objects.

  it('persists capture.json to PVC and returns its posix URI', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'Paris',
      durationMs: 320,
      sessionId: 's-1',
    });
    const result = await invokeAgent(baseInput());
    expect(mockWriteCaptureFile).toHaveBeenCalledTimes(1);
    expect(result.capturePath).toMatch(/^posix:\/\/\//);
    expect(result.telemetry.e2eMs).toBe(320);
  });

  it('maps output → capture.response and durationMs → capture.telemetry.e2eMs', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'Paris',
      durationMs: 320,
      sessionId: 's-1',
    });
    await invokeAgent(baseInput());
    const capture = lastCapture();
    expect(capture.response).toBe('Paris');
    expect(capture.telemetry.e2eMs).toBe(320);
  });

  it('maps citations.kbCitations → capture.retrievedChunks (defensive shape pluck)', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'answer',
      durationMs: 100,
      sessionId: 's',
      citations: {
        kbCitations: [
          {
            id: 'chunk-1',
            content: 'paris is the capital of france',
            score: 0.92,
            source: 's3://wiki/paris.txt',
          },
          { content: 'no id here', score: 0.1 },
          { chunkId: 'chunk-2', content: 'second', score: 0.7, sourceUri: 's3://wiki/other.txt' },
        ],
      },
    });
    await invokeAgent(baseInput());
    const capture = lastCapture();
    expect(capture.retrievedChunks).toHaveLength(2);
    expect(capture.retrievedChunks[0]).toMatchObject({
      id: 'chunk-1',
      content: 'paris is the capital of france',
      score: 0.92,
      source: 's3://wiki/paris.txt',
    });
    expect(capture.retrievedChunks[1].id).toBe('chunk-2');
    expect(capture.retrievedChunks[1].source).toBe('s3://wiki/other.txt');
  });

  it('parses citations.agentTrace into capture.toolCalls (best-effort)', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'answer',
      durationMs: 100,
      sessionId: 's',
      citations: {
        agentTrace: [
          { tool: 'search', args: { q: 'paris' }, success: true, latencyMs: 80 },
          { name: 'fetch_doc', args: { id: 'doc-1' }, result: { ok: true }, latencyMs: 40 },
          { kind: 'planner', message: 'not a tool call' },
          { name: 'flaky_api', args: {}, error: 'timeout', success: false, latencyMs: 5000 },
        ],
      },
    });
    await invokeAgent(baseInput());
    const capture = lastCapture();
    expect(capture.toolCalls).toHaveLength(3);
    expect(capture.toolCalls[0]).toMatchObject({
      name: 'search',
      args: { q: 'paris' },
      success: true,
      latencyMs: 80,
    });
    expect(capture.toolCalls[2]).toMatchObject({
      name: 'flaky_api',
      success: false,
      error: 'timeout',
    });
  });

  it('synthesizes a perAgent entry from citations.respondingAgent', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'router-bot',
      output: 'a',
      durationMs: 100,
      sessionId: 's',
      usage: { promptTokens: 120, completionTokens: 30 },
      citations: {
        respondingAgent: {
          name: 'router-bot',
          model: 'claude-sonnet',
          temperature: 0.7,
        },
      },
    });
    const result = await invokeAgent(
      baseInput({ overrides: { model: 'gpt-4o' } }),
    );
    const capture = lastCapture();
    expect(capture.perAgent).toHaveLength(1);
    expect(capture.perAgent[0]).toMatchObject({
      agentName: 'router-bot',
      role: 'root',
      modelUsed: 'claude-sonnet',
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    });
    expect(result.resolvedRuntimeParams.model).toBe('claude-sonnet');
    expect(result.resolvedRuntimeParams.temperature).toBe(0.7);
  });

  it("flags retrievalAnnotation as 'zero_hits' when kbCitations is empty/absent", async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'answer',
      durationMs: 50,
      sessionId: 's',
      citations: null,
    });
    const result = await invokeAgent(baseInput());
    expect(result.retrievalAnnotation).toBe('zero_hits');
    expect(lastCapture().retrievedChunks).toEqual([]);
  });

  it('preserves parsedOutput / artifacts / traceId via raw + trace', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: '{"a":1}',
      parsedOutput: { a: 1 },
      artifacts: [{ filename: 'plot.png' }],
      durationMs: 100,
      sessionId: 's',
      traceId: 'phoenix-abc',
    });
    await invokeAgent(baseInput());
    const capture = lastCapture();
    expect(capture.trace).toBe('phoenix-abc');
    expect((capture.raw as any).parsedOutput).toEqual({ a: 1 });
    expect((capture.raw as any).artifacts).toEqual([{ filename: 'plot.png' }]);
  });

  it('survives a fully-null citations envelope', async () => {
    mockGotPost.mockResolvedValueOnce({
      agentId: 'a-1',
      output: 'answer',
      durationMs: 100,
      sessionId: 's',
      citations: null,
      usage: null,
    });
    await invokeAgent(baseInput());
    const capture = lastCapture();
    expect(capture.response).toBe('answer');
    expect(capture.retrievedChunks).toEqual([]);
    expect(capture.toolCalls).toEqual([]);
    expect(capture.perAgent).toEqual([]);
    expect(capture.telemetry.inputTokens).toBeUndefined();
  });
});

// ── Error mapping ────────────────────────────────────────────────────

describe('invokeAgent — error mapping', () => {
  it('maps 404 to non-retryable AgentNotFoundError', async () => {
    mockGotPost.mockRejectedValueOnce({
      __isHttpError: true,
      message: 'not found',
      response: { statusCode: 404, body: '' },
    });
    await expect(invokeAgent(baseInput())).rejects.toMatchObject({
      type: 'AgentNotFoundError',
      nonRetryable: true,
    });
  });

  it("maps 422 with body containing 'content_filter' to ContentFilteredError", async () => {
    mockGotPost.mockRejectedValueOnce({
      __isHttpError: true,
      message: 'blocked',
      response: {
        statusCode: 422,
        body: '{"error":"content_filter triggered"}',
      },
    });
    await expect(invokeAgent(baseInput())).rejects.toMatchObject({
      type: 'ContentFilteredError',
      nonRetryable: true,
    });
  });

  it('maps generic 4xx to non-retryable InvalidInputError', async () => {
    mockGotPost.mockRejectedValueOnce({
      __isHttpError: true,
      message: 'bad request',
      response: { statusCode: 400, body: '' },
    });
    await expect(invokeAgent(baseInput())).rejects.toMatchObject({
      type: 'InvalidInputError',
      nonRetryable: true,
    });
  });

  it('lets 5xx errors propagate as retryable', async () => {
    const err = Object.assign(new Error('upstream 503'), {
      __isHttpError: true,
      response: { statusCode: 503, body: '' },
    });
    mockGotPost.mockRejectedValueOnce(err);
    await expect(invokeAgent(baseInput())).rejects.toThrow(/upstream 503/);
  });

  it('throws when agent-service returns null/undefined body', async () => {
    mockGotPost.mockResolvedValueOnce(null);
    await expect(invokeAgent(baseInput())).rejects.toMatchObject({
      type: 'InvalidInputError',
    });
  });

  it('does not write capture.json when the agent call fails', async () => {
    mockGotPost.mockRejectedValueOnce({
      __isHttpError: true,
      message: 'not found',
      response: { statusCode: 404, body: '' },
    });
    await expect(invokeAgent(baseInput())).rejects.toMatchObject({
      type: 'AgentNotFoundError',
    });
    expect(mockWriteCaptureFile).not.toHaveBeenCalled();
  });
});
