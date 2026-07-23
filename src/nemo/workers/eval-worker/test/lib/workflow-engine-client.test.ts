jest.mock('got', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
  };
  const actual = jest.requireActual('got') as { HTTPError: unknown };
  return {
    __esModule: true,
    default: mock,
    HTTPError: actual.HTTPError,
  };
});

import got from 'got';
import {
  awaitWorkflowResultViaEngine,
  queryWorkflowViaEngine,
  startWorkflowViaEngine,
} from '../../src/lib/workflow-engine-client';

const mockGot = got as unknown as { get: jest.Mock; post: jest.Mock };

function httpErrorWithStatus(statusCode: number): Error {
  const realHttpError = jest.requireActual('got') as {
    HTTPError: new (...args: never[]) => Error;
  };
  const err = new Error(`HTTP ${statusCode}`) as Error & {
    response: { statusCode: number };
  };
  err.response = { statusCode };
  Object.setPrototypeOf(err, realHttpError.HTTPError.prototype);
  return err;
}

describe('workflow-engine-client', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env['WORKFLOW_ENGINE_URL'] = 'http://engine.test';
    delete process.env['WORKFLOW_ENGINE_TOKEN'];
    mockGot.get.mockReset();
    mockGot.post.mockReset();
  });

  afterAll(() => {
    process.env = origEnv;
  });

  // ── startWorkflowViaEngine ────────────────────────────────────────

  describe('startWorkflowViaEngine', () => {
    it('POSTs to /api/v1/workflows with the input as JSON body', async () => {
      mockGot.post.mockResolvedValueOnce({
        body: { workflowId: 'wf-1', runId: 'run-1' },
      });
      const out = await startWorkflowViaEngine({
        workflowName: 'TheWorkflow',
        workflowId: 'wf-1',
        taskQueue: 'q',
        args: [{ x: 1 }],
      });
      expect(out).toEqual({ workflowId: 'wf-1', runId: 'run-1' });
      const [url, opts] = mockGot.post.mock.calls[0];
      expect(url).toBe('http://engine.test/api/v1/workflows');
      const json = (opts as { json: { workflowName: string } }).json;
      expect(json.workflowName).toBe('TheWorkflow');
    });

    it('uses the default base URL when WORKFLOW_ENGINE_URL is unset', async () => {
      delete process.env['WORKFLOW_ENGINE_URL'];
      mockGot.post.mockResolvedValueOnce({ body: { workflowId: 'w', runId: 'r' } });
      await startWorkflowViaEngine({
        workflowName: 'W',
        workflowId: 'w',
        taskQueue: 'q',
        args: [],
      });
      expect(mockGot.post.mock.calls[0][0]).toBe(
        'http://workflow-engine:8080/api/v1/workflows',
      );
    });

    it('forwards WORKFLOW_ENGINE_TOKEN as a bearer header', async () => {
      process.env['WORKFLOW_ENGINE_TOKEN'] = 'tok-123';
      mockGot.post.mockResolvedValueOnce({ body: { workflowId: 'w', runId: 'r' } });
      await startWorkflowViaEngine({
        workflowName: 'W',
        workflowId: 'w',
        taskQueue: 'q',
        args: [],
      });
      const opts = mockGot.post.mock.calls[0][1] as {
        headers?: Record<string, string>;
      };
      expect(opts.headers?.['authorization']).toBe('Bearer tok-123');
    });

    it('omits the auth header when no token is set', async () => {
      mockGot.post.mockResolvedValueOnce({ body: { workflowId: 'w', runId: 'r' } });
      await startWorkflowViaEngine({
        workflowName: 'W',
        workflowId: 'w',
        taskQueue: 'q',
        args: [],
      });
      const opts = mockGot.post.mock.calls[0][1] as {
        headers?: Record<string, string>;
      };
      expect(opts.headers).toBeUndefined();
    });
  });

  // ── queryWorkflowViaEngine ────────────────────────────────────────

  describe('queryWorkflowViaEngine', () => {
    it('URL-encodes workflowId + queryName in the request path', async () => {
      mockGot.post.mockResolvedValueOnce({ body: { result: 42 } });
      await queryWorkflowViaEngine({
        workflowId: 'wf with spaces/and-slash',
        queryName: 'evaluation.results',
      });
      expect(mockGot.post.mock.calls[0][0]).toBe(
        'http://engine.test/api/v1/workflows/wf%20with%20spaces%2Fand-slash/query/evaluation.results',
      );
    });

    it('forwards optional args as JSON body', async () => {
      mockGot.post.mockResolvedValueOnce({ body: 'ok' });
      await queryWorkflowViaEngine({
        workflowId: 'wf',
        queryName: 'foo',
        args: [1, 'two'],
      });
      const opts = mockGot.post.mock.calls[0][1] as { json: { args: unknown[] } };
      expect(opts.json.args).toEqual([1, 'two']);
    });

    it('defaults args to [] when not supplied', async () => {
      mockGot.post.mockResolvedValueOnce({ body: 'ok' });
      await queryWorkflowViaEngine({ workflowId: 'wf', queryName: 'foo' });
      const opts = mockGot.post.mock.calls[0][1] as { json: { args: unknown[] } };
      expect(opts.json.args).toEqual([]);
    });
  });

  // ── awaitWorkflowResultViaEngine ──────────────────────────────────

  describe('awaitWorkflowResultViaEngine', () => {
    it('returns the body directly when the engine answers 200', async () => {
      mockGot.get.mockResolvedValueOnce({ body: { runId: 'r', status: 'completed' } });
      const out = await awaitWorkflowResultViaEngine({ workflowId: 'wf' });
      expect(out).toEqual({ runId: 'r', status: 'completed' });
      expect(mockGot.get.mock.calls[0][0]).toBe(
        'http://engine.test/api/v1/workflows/wf/result',
      );
    });

    it('retries on HTTP 409 (still running) and returns once the engine responds 200', async () => {
      mockGot.get
        .mockRejectedValueOnce(httpErrorWithStatus(409))
        .mockRejectedValueOnce(httpErrorWithStatus(409))
        .mockResolvedValueOnce({ body: { runId: 'r' } });
      const out = await awaitWorkflowResultViaEngine({
        workflowId: 'wf',
        pollIntervalMs: 1,
      });
      expect(out).toEqual({ runId: 'r' });
      expect(mockGot.get).toHaveBeenCalledTimes(3);
    });

    it('re-throws HTTP errors that are not 409', async () => {
      mockGot.get.mockRejectedValueOnce(httpErrorWithStatus(500));
      await expect(
        awaitWorkflowResultViaEngine({ workflowId: 'wf', pollIntervalMs: 1 }),
      ).rejects.toThrow('HTTP 500');
    });

    it('re-throws non-HTTP errors (transport failures) immediately', async () => {
      mockGot.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(
        awaitWorkflowResultViaEngine({ workflowId: 'wf' }),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('respects the caller timeoutMs by bailing once the deadline passes', async () => {
      mockGot.get.mockRejectedValue(httpErrorWithStatus(409));
      await expect(
        awaitWorkflowResultViaEngine({
          workflowId: 'wf',
          timeoutMs: 5,
          pollIntervalMs: 50,
        }),
      ).rejects.toThrow('HTTP 409');
    });
  });
});
