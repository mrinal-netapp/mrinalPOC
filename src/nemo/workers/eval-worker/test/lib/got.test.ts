jest.mock('got', () => {
  const mock = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
  };
  // Re-expose the real HTTPError so `isHTTPError` still works under jest.
  const actual = jest.requireActual('got') as { HTTPError: unknown };
  return {
    __esModule: true,
    default: mock,
    HTTPError: actual.HTTPError,
  };
});

import got from 'got';
import {
  gotGet,
  gotPatch,
  gotPost,
  gotPut,
  isHTTPError,
} from '../../src/lib/got';

const mockGot = got as unknown as {
  get: jest.Mock;
  post: jest.Mock;
  put: jest.Mock;
  patch: jest.Mock;
};

describe('lib/got wrappers', () => {
  beforeEach(() => {
    mockGot.get.mockReset();
    mockGot.post.mockReset();
    mockGot.put.mockReset();
    mockGot.patch.mockReset();
  });

  it('gotGet returns the parsed body and uses JSON response type', async () => {
    mockGot.get.mockResolvedValueOnce({ body: { ok: true } });
    const out = await gotGet<{ ok: boolean }>('http://x.test');
    expect(out).toEqual({ ok: true });
    const opts = mockGot.get.mock.calls[0][1] as { responseType: string };
    expect(opts.responseType).toBe('json');
  });

  it('gotPost serializes body as JSON and returns parsed response', async () => {
    mockGot.post.mockResolvedValueOnce({ body: { created: 1 } });
    const out = await gotPost('http://x.test', { name: 'a' });
    expect(out).toEqual({ created: 1 });
    const opts = mockGot.post.mock.calls[0][1] as { json: unknown };
    expect(opts.json).toEqual({ name: 'a' });
  });

  it('gotPut + gotPatch dispatch to the right HTTP verb', async () => {
    mockGot.put.mockResolvedValueOnce({ body: { put: true } });
    mockGot.patch.mockResolvedValueOnce({ body: { patched: true } });
    await expect(gotPut('http://x.test', { v: 1 })).resolves.toEqual({ put: true });
    await expect(gotPatch('http://x.test', { v: 2 })).resolves.toEqual({
      patched: true,
    });
    expect(mockGot.put).toHaveBeenCalledTimes(1);
    expect(mockGot.patch).toHaveBeenCalledTimes(1);
  });

  it('caller options override the wrapper defaults', async () => {
    mockGot.get.mockResolvedValueOnce({ body: null });
    await gotGet('http://x.test', { throwHttpErrors: false, timeout: { request: 5 } });
    const opts = mockGot.get.mock.calls[0][1] as {
      throwHttpErrors: boolean;
      timeout: { request: number };
    };
    expect(opts.throwHttpErrors).toBe(false);
    expect(opts.timeout.request).toBe(5);
  });

  it('isHTTPError returns true only for got.HTTPError instances', () => {
    const realHttpError = jest.requireActual('got') as {
      HTTPError: new (...args: never[]) => Error;
    };
    const err = Object.create(realHttpError.HTTPError.prototype) as Error;
    expect(isHTTPError(err)).toBe(true);
    expect(isHTTPError(new Error('plain'))).toBe(false);
  });
});
