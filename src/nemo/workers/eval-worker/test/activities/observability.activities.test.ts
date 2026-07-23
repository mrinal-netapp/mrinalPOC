/* eslint-disable @typescript-eslint/no-explicit-any */

const mockReadCaptureFile = jest.fn();

jest.mock('../../src/lib/got', () => {
  const actual =
    jest.requireActual('../../src/lib/got') as typeof import('../../src/lib/got');
  return { ...actual, gotPost: jest.fn() };
});
jest.mock('../../src/lib/capture-file', () => ({
  readCaptureFile: (...a: any[]) => mockReadCaptureFile(...a),
}));

import { gotPost } from '../../src/lib/got';
import { sendObservabilityTrace } from '../../src/activities/observability.activities';
import type {
  AgentInvocationResult,
  CaptureFile,
  CaseRef,
} from '../../src/lib/evaluation';

const mockGotPost = gotPost as jest.MockedFunction<typeof gotPost>;

function makeCaseRef(overrides: Partial<CaseRef> = {}): CaseRef {
  return {
    projectId: 'p',
    evalId: 'eval-1',
    runId: 'r-1',
    caseId: 'c-1',
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

describe('sendObservabilityTrace', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['OBSERVABILITY_SERVICE_URL'];
    mockGotPost.mockReset();
    mockReadCaptureFile.mockReset();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  it('returns a local synthetic traceRef when OBSERVABILITY_SERVICE_URL is unset', async () => {
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///c.json',
    });
    expect(out.traceRef).toBe('local:r-1:c-1');
    expect(mockGotPost).not.toHaveBeenCalled();
    // No PVC read happens on the no-URL fast path.
    expect(mockReadCaptureFile).not.toHaveBeenCalled();
  });

  it('reads the trace from capture.json and POSTs it to <URL>/traces', async () => {
    process.env['OBSERVABILITY_SERVICE_URL'] = 'http://obs.test';
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ trace: { phase: 'capture' } }),
    );
    mockGotPost.mockResolvedValueOnce({ traceRef: 'trace-abc' });
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef(),
      capturePath: 'posix:///c.json',
    });
    expect(out).toEqual({ traceRef: 'trace-abc' });
    expect(mockReadCaptureFile).toHaveBeenCalledWith('posix:///c.json');
    const [url, body] = mockGotPost.mock.calls[0];
    expect(url).toBe('http://obs.test/traces');
    expect(body).toEqual({
      runId: 'r-1',
      caseId: 'c-1',
      trace: { phase: 'capture' },
    });
  });

  it('falls back to a "missing" traceRef when the response lacks one', async () => {
    process.env['OBSERVABILITY_SERVICE_URL'] = 'http://obs.test';
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ trace: { ok: true } }),
    );
    mockGotPost.mockResolvedValueOnce({} as { traceRef: string });
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef({ runId: 'r-2', caseId: 'c-2' }),
      capturePath: 'posix:///c.json',
    });
    expect(out.traceRef).toBe('missing:r-2:c-2');
  });

  it('returns "missing" when capture has no trace populated', async () => {
    process.env['OBSERVABILITY_SERVICE_URL'] = 'http://obs.test';
    mockReadCaptureFile.mockResolvedValueOnce(makeCaptureFile({}));
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef({ runId: 'r-empty', caseId: 'c-empty' }),
      capturePath: 'posix:///c.json',
    });
    expect(out.traceRef).toBe('missing:r-empty:c-empty');
    expect(mockGotPost).not.toHaveBeenCalled();
  });

  it('returns "missing" when the capture file is unreadable', async () => {
    process.env['OBSERVABILITY_SERVICE_URL'] = 'http://obs.test';
    mockReadCaptureFile.mockRejectedValueOnce(new Error('ENOENT'));
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef({ runId: 'r-missing', caseId: 'c-missing' }),
      capturePath: 'posix:///does-not-exist.json',
    });
    expect(out.traceRef).toBe('missing:r-missing:c-missing');
    expect(mockGotPost).not.toHaveBeenCalled();
  });

  it('swallows POST errors and returns an "error" traceRef (best-effort semantics)', async () => {
    process.env['OBSERVABILITY_SERVICE_URL'] = 'http://obs.test';
    mockReadCaptureFile.mockResolvedValueOnce(
      makeCaptureFile({ trace: { ok: true } }),
    );
    mockGotPost.mockRejectedValueOnce(new Error('connection refused'));
    const out = await sendObservabilityTrace({
      caseRef: makeCaseRef({ runId: 'r-3', caseId: 'c-3' }),
      capturePath: 'posix:///c.json',
    });
    expect(out.traceRef).toBe('error:r-3:c-3');
  });
});
