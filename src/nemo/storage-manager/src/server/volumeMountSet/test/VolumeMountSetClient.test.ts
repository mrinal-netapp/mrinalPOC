import { VolumeMountSetClient } from '../VolumeMountSetClient';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

function buildClient(logLevel = 'info') {
  const mockApi = {
    getNamespacedCustomObject: jest.fn(),
    replaceNamespacedCustomObject: jest.fn(),
    createNamespacedCustomObject: jest.fn(),
  } as any;

  const client = new VolumeMountSetClient({
    customObjectsApi: mockApi,
    namespace: 'test-ns',
    crName: 'test-vms',
    targetDeploymentName: 'test-deploy',
    mountPathBase: '/mnt/test',
    logLevel,
  });

  return { client, mockApi };
}

describe('VolumeMountSetClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOrUpdate', () => {
    it('updates existing CR when it already exists', async () => {
      const { client, mockApi } = buildClient();
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: { spec: {} } });
      mockApi.replaceNamespacedCustomObject.mockResolvedValue({});

      await client.createOrUpdate({ desiredPvcNames: ['pvc-1', 'pvc-2'] });

      expect(mockApi.getNamespacedCustomObject).toHaveBeenCalled();
      expect(mockApi.replaceNamespacedCustomObject).toHaveBeenCalled();
      expect(mockApi.createNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('creates new CR when it does not exist (404 statusCode)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);
      mockApi.createNamespacedCustomObject.mockResolvedValue({});

      await client.createOrUpdate({ desiredPvcNames: ['pvc-1'] });

      expect(mockApi.createNamespacedCustomObject).toHaveBeenCalled();
      expect(mockApi.replaceNamespacedCustomObject).not.toHaveBeenCalled();
    });

    it('creates new CR when it does not exist (body.code 404)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { body: { code: 404 } });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);
      mockApi.createNamespacedCustomObject.mockResolvedValue({});

      await client.createOrUpdate({ desiredPvcNames: [] });

      expect(mockApi.createNamespacedCustomObject).toHaveBeenCalled();
    });

    it('throws on non-404 get errors', async () => {
      const { client, mockApi } = buildClient();
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: {} });
      const replaceError = Object.assign(new Error('Server Error'), { statusCode: 500 });
      mockApi.replaceNamespacedCustomObject.mockRejectedValue(replaceError);

      await expect(client.createOrUpdate({ desiredPvcNames: [] })).rejects.toThrow('Server Error');
    });

    it('logs debug message when logLevel is debug', async () => {
      const { client, mockApi } = buildClient('debug');
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: { spec: {} } });
      mockApi.replaceNamespacedCustomObject.mockResolvedValue({});

      await client.createOrUpdate({ desiredPvcNames: ['pvc-1'] });

      expect(mockApi.replaceNamespacedCustomObject).toHaveBeenCalled();
    });

    it('uses provided mountPathBase override', async () => {
      const { client, mockApi } = buildClient();
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: { spec: {} } });
      mockApi.replaceNamespacedCustomObject.mockResolvedValue({});

      await client.createOrUpdate({ desiredPvcNames: [], mountPathBase: '/custom/path' });

      const callArgs = mockApi.replaceNamespacedCustomObject.mock.calls[0][0];
      expect(callArgs.body.spec.mountPathBase).toBe('/custom/path');
    });
  });

  describe('getStatus', () => {
    it('returns status when CR exists', async () => {
      const { client, mockApi } = buildClient();
      mockApi.getNamespacedCustomObject.mockResolvedValue({
        body: {
          status: { evictedPvcNames: ['pvc-old'], pvcConditions: [] },
        },
      });

      const status = await client.getStatus();

      expect(status).toEqual({ evictedPvcNames: ['pvc-old'], pvcConditions: [] });
    });

    it('returns null when CR does not exist (statusCode 404)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      const status = await client.getStatus();

      expect(status).toBeNull();
    });

    it('returns null when CR does not exist (body.code 404)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { body: { code: 404 } });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      const status = await client.getStatus();

      expect(status).toBeNull();
    });

    it('returns null when CR status is missing', async () => {
      const { client, mockApi } = buildClient();
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: {} });

      const status = await client.getStatus();

      expect(status).toBeNull();
    });

    it('throws on non-404 errors', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      await expect(client.getStatus()).rejects.toThrow('Forbidden');
    });
  });

  describe('get', () => {
    it('returns the full CR when it exists', async () => {
      const { client, mockApi } = buildClient();
      const cr = {
        apiVersion: 'agentstudio.io/v1',
        kind: 'VolumeMountSet',
        metadata: { name: 'test-vms', namespace: 'test-ns' },
        spec: { desiredPvcNames: ['pvc-1'] },
        status: {},
      };
      mockApi.getNamespacedCustomObject.mockResolvedValue({ body: cr });

      const result = await client.get();

      expect(result).toEqual(cr);
    });

    it('returns null when CR does not exist (statusCode 404)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      const result = await client.get();

      expect(result).toBeNull();
    });

    it('returns null when CR does not exist (body.code 404)', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Not Found'), { body: { code: 404 } });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      const result = await client.get();

      expect(result).toBeNull();
    });

    it('throws on non-404 errors', async () => {
      const { client, mockApi } = buildClient();
      const error = Object.assign(new Error('Internal Error'), { statusCode: 500 });
      mockApi.getNamespacedCustomObject.mockRejectedValue(error);

      await expect(client.get()).rejects.toThrow('Internal Error');
    });
  });
});
