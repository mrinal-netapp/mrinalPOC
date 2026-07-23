import { HttpClient } from '../HttpClient';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

jest.mock('@agentstudio/common', () => ({
  createServiceAccountClientFromEnv: jest.fn().mockReturnValue(null),
  ServiceAccountClient: jest.fn(),
}));

const mockHttpRequestFn = jest.fn();
const mockHttpsRequestFn = jest.fn();

jest.mock('http', () => ({
  request: (...args: any[]) => mockHttpRequestFn(...args),
}));

jest.mock('https', () => ({
  request: (...args: any[]) => mockHttpsRequestFn(...args),
}));

function buildMockReqRes(
  statusCode: number,
  responseData: string,
  useHttps = false
) {
  const mockReq = {
    on: jest.fn().mockReturnThis(),
    write: jest.fn(),
    end: jest.fn(),
  };
  const mockRes = {
    statusCode,
    headers: {},
    on: jest.fn().mockImplementation((event: string, handler: Function) => {
      if (event === 'data') handler(responseData);
      if (event === 'end') handler();
    }),
  };
  const target = useHttps ? mockHttpsRequestFn : mockHttpRequestFn;
  target.mockImplementation((_opts: any, callback?: Function) => {
    if (callback) callback(mockRes);
    return mockReq;
  });
  return { mockReq, mockRes };
}

describe('HttpClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates HttpClient without service account', () => {
      const client = new HttpClient({ useServiceAccount: false });
      expect(client).toBeDefined();
    });

    it('creates HttpClient with service account when useServiceAccount is true', () => {
      const { createServiceAccountClientFromEnv } = require('@agentstudio/common');
      (createServiceAccountClientFromEnv as jest.Mock).mockReturnValue(null);
      const client = new HttpClient({ useServiceAccount: true });
      expect(client).toBeDefined();
    });
  });

  describe('request', () => {
    it('resolves with parsed JSON on successful response', async () => {
      buildMockReqRes(200, '{"result":"ok"}');

      const client = new HttpClient({ useServiceAccount: false });
      const result = await client.request<{ result: string }>('http://localhost:8080/api');
      expect(result).toEqual({ result: 'ok' });
      expect(mockHttpRequestFn).toHaveBeenCalled();
    });

    it('rejects with error on non-2xx response', async () => {
      buildMockReqRes(500, 'Internal Server Error');

      const client = new HttpClient({ useServiceAccount: false });
      await expect(client.request('http://localhost:8080/fail')).rejects.toThrow(/HTTP 500/);
    });

    it('rejects when JSON parsing fails on 200 response', async () => {
      buildMockReqRes(200, 'not-json');

      const client = new HttpClient({ useServiceAccount: false });
      await expect(client.request('http://localhost:8080/bad-json')).rejects.toThrow(
        /Failed to parse response/
      );
    });

    it('rejects on network error', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event: string, handler: Function) => {
          if (event === 'error') handler(new Error('connection refused'));
          return mockReq;
        }),
        write: jest.fn(),
        end: jest.fn(),
      };
      mockHttpRequestFn.mockReturnValue(mockReq);

      const client = new HttpClient({ useServiceAccount: false });
      await expect(client.request('http://localhost:9999/unreachable')).rejects.toThrow(
        'connection refused'
      );
    });

    it('uses https module for HTTPS URLs', async () => {
      buildMockReqRes(200, '{}', true);

      const client = new HttpClient({ useServiceAccount: false });
      await client.request('https://secure.example.com/api');
      expect(mockHttpsRequestFn).toHaveBeenCalled();
    });

    it('sends request with body for POST requests', async () => {
      const { mockReq } = buildMockReqRes(200, '{"created":true}');

      const client = new HttpClient({ useServiceAccount: false });
      await client.request('http://localhost/api', 'POST', { name: 'test' });
      expect(mockReq.write).toHaveBeenCalledWith(expect.stringContaining('test'));
    });

    it('logs debug info when logLevel is debug', async () => {
      buildMockReqRes(200, '{"ok":true}');

      const client = new HttpClient({ useServiceAccount: false, logLevel: 'debug' });
      const result = await client.request('http://localhost/debug', 'POST', { data: 'test' });
      expect(result).toEqual({ ok: true });
    });

    it('logs debug info on request error when logLevel is debug', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event: string, handler: Function) => {
          if (event === 'error') handler(new Error('debug error'));
          return mockReq;
        }),
        write: jest.fn(),
        end: jest.fn(),
      };
      mockHttpRequestFn.mockReturnValue(mockReq);

      const client = new HttpClient({ useServiceAccount: false, logLevel: 'debug' });
      await expect(client.request('http://localhost/debug-err')).rejects.toThrow('debug error');
    });

    it('logs debug on 200 response when logLevel is debug', async () => {
      buildMockReqRes(200, '{"response":"data"}');

      const client = new HttpClient({ useServiceAccount: false, logLevel: 'debug' });
      await client.request('http://localhost/debug-response');
    });
  });

  describe('constructor with service account', () => {
    it('creates HttpClient with valid service account client', () => {
      const { createServiceAccountClientFromEnv } = require('@agentstudio/common');
      const mockSAClient = { getAccessToken: jest.fn() };
      (createServiceAccountClientFromEnv as jest.Mock).mockReturnValue(mockSAClient);
      const client = new HttpClient({ useServiceAccount: true });
      expect(client).toBeDefined();
    });

    it('makes request with service account token', async () => {
      const { createServiceAccountClientFromEnv } = require('@agentstudio/common');
      const mockSAClient = { getAccessToken: jest.fn().mockResolvedValue('mock-token-xyz') };
      (createServiceAccountClientFromEnv as jest.Mock).mockReturnValue(mockSAClient);

      buildMockReqRes(200, '{"ok":true}');

      const client = new HttpClient({ useServiceAccount: true });
      await client.request('http://localhost/sa');
      expect(mockSAClient.getAccessToken).toHaveBeenCalled();
    });

    it('makes request with service account token in debug mode', async () => {
      const { createServiceAccountClientFromEnv } = require('@agentstudio/common');
      const mockSAClient = { getAccessToken: jest.fn().mockResolvedValue('mock-token-for-debug') };
      (createServiceAccountClientFromEnv as jest.Mock).mockReturnValue(mockSAClient);

      buildMockReqRes(200, '{}');

      const client = new HttpClient({ useServiceAccount: true, logLevel: 'debug' });
      await client.request('http://localhost/sa-debug');
      expect(mockSAClient.getAccessToken).toHaveBeenCalled();
    });

    it('throws when service account token fetch fails', async () => {
      const { createServiceAccountClientFromEnv } = require('@agentstudio/common');
      const mockSAClient = { getAccessToken: jest.fn().mockRejectedValue(new Error('token error')) };
      (createServiceAccountClientFromEnv as jest.Mock).mockReturnValue(mockSAClient);

      buildMockReqRes(200, '{}');

      const client = new HttpClient({ useServiceAccount: true });
      await expect(client.request('http://localhost/sa-fail')).rejects.toThrow('Failed to get service account token');
    });
  });
});
