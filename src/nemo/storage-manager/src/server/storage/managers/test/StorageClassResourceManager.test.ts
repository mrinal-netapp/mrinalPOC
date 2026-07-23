import { get_logger } from '@agentstudio/observability-client-runtime';
import { StorageClassResourceManager } from '../StorageClassResourceManager';
import * as k8s from '@kubernetes/client-node';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));
const mockLogger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() };

const baseSpec = {
  project_id: 'proj-1',
  bucket_name: 'my-bucket',
  volume_info: { type: 'nfs', endpoint: 'nfs://10.0.0.1/share' },
  auth_info: { type: 'none' },
  protocol: 'nfs',
  role: 'primary' as const,
};

const existingSC: k8s.V1StorageClass = {
  metadata: {
    name: 'sc-proj-1-my-bucket',
    resourceVersion: '12345',
    labels: {},
    annotations: {},
  },
  provisioner: 'kubernetes.io/no-provisioner',
  parameters: {},
  reclaimPolicy: 'Retain',
  volumeBindingMode: 'Immediate',
};

function mockStorageApi(overrides: Partial<Record<string, jest.Mock>> = {}): k8s.StorageV1Api {
  return {
    readStorageClass: jest.fn(),
    createStorageClass: jest.fn(),
    replaceStorageClass: jest.fn(),
    deleteStorageClass: jest.fn(),
    listStorageClass: jest.fn(),
    ...overrides,
  } as unknown as k8s.StorageV1Api;
}

describe('StorageClassResourceManager', () => {
  describe('validateStorageClass', () => {
    it('returns StorageClass when it exists', async () => {
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockResolvedValue(existingSC),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.validateStorageClass('sc-proj-1-my-bucket');
      expect(result).toBe(existingSC);
    });

    it('throws descriptive error when StorageClass not found (404)', async () => {
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue({ statusCode: 404 }),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.validateStorageClass('nonexistent-sc')).rejects.toThrow(
        /not found/i
      );
    });
  });

  describe('createOrUpdateStorageClass', () => {
    it('creates new StorageClass when it does not exist (404)', async () => {
      const createdSC: k8s.V1StorageClass = { ...existingSC };
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue({ statusCode: 404 }),
        createStorageClass: jest.fn().mockResolvedValue(createdSC),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.createOrUpdateStorageClass(baseSpec, null);
      expect((api.createStorageClass as jest.Mock)).toHaveBeenCalled();
      expect(result).toBe(createdSC);
    });

    it('updates mutable fields when StorageClass exists with same parameters', async () => {
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockResolvedValue(existingSC),
        replaceStorageClass: jest.fn().mockResolvedValue(existingSC),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await manager.createOrUpdateStorageClass(baseSpec, null);
      expect((api.replaceStorageClass as jest.Mock)).toHaveBeenCalled();
    });

    it('returns existing SC without update when immutable fields differ', async () => {
      const scWithDifferentParams: k8s.V1StorageClass = {
        ...existingSC,
        parameters: { server: 'different-server' },
      };
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockResolvedValue(scWithDifferentParams),
        replaceStorageClass: jest.fn(),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.createOrUpdateStorageClass(baseSpec, null);
      expect((api.replaceStorageClass as jest.Mock)).not.toHaveBeenCalled();
      expect(result).toBe(scWithDifferentParams);
    });

    it('validates and returns existing SC for dynamic provisioning', async () => {
      const dynamicSpec = {
        ...baseSpec,
        provisioning_mode: 'dynamic' as const,
        storage_class_name: 'standard',
      };
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockResolvedValue(existingSC),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.createOrUpdateStorageClass(dynamicSpec, null);
      expect(result).toBe(existingSC);
    });

    it('throws when dynamic provisioning has no storage_class_name', async () => {
      const dynamicSpec = {
        ...baseSpec,
        provisioning_mode: 'dynamic' as const,
        storage_class_name: undefined,
      };
      const api = mockStorageApi();
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.createOrUpdateStorageClass(dynamicSpec, null)).rejects.toThrow(
        /storage_class_name is required/
      );
    });
  });

  describe('deleteStorageClass', () => {
    it('deletes StorageClass by name', async () => {
      const api = mockStorageApi({
        deleteStorageClass: jest.fn().mockResolvedValue({}),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await manager.deleteStorageClass('proj-1', 'my-bucket');
      expect((api.deleteStorageClass as jest.Mock)).toHaveBeenCalled();
    });

    it('silently ignores 404 when deleting (idempotent)', async () => {
      const api = mockStorageApi({
        deleteStorageClass: jest.fn().mockRejectedValue({ statusCode: 404 }),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.deleteStorageClass('proj-1', 'my-bucket')).resolves.toBeUndefined();
    });

    it('throws for non-404 errors during delete', async () => {
      const api = mockStorageApi({
        deleteStorageClass: jest.fn().mockRejectedValue({ statusCode: 500, message: 'server error' }),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.deleteStorageClass('proj-1', 'my-bucket')).rejects.toThrow();
    });
  });

  describe('listStorageClasses', () => {
    it('returns StorageClass items', async () => {
      const api = mockStorageApi({
        listStorageClass: jest.fn().mockResolvedValue({ items: [existingSC] }),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.listStorageClasses();
      expect(result).toHaveLength(1);
    });

    it('returns empty array on error', async () => {
      const api = mockStorageApi({
        listStorageClass: jest.fn().mockRejectedValue(new Error('list failed')),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      const result = await manager.listStorageClasses();
      expect(result).toEqual([]);
    });
  });

  describe('getStorageClassName', () => {
    it('returns correct storage class name format', () => {
      const api = mockStorageApi();
      const manager = new StorageClassResourceManager(api, 'nemo');
      const name = manager.getStorageClassName('proj-1', 'my-bucket');
      expect(name).toContain('proj-1');
    });
  });

  describe('validateStorageClass - additional error cases', () => {
    it('throws enhanced error when readStorageClass fails with non-404 error', async () => {
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue(
          Object.assign(new Error('server error'), { statusCode: 500 })
        ),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.validateStorageClass('sc-name')).rejects.toThrow();
    });
  });

  describe('createOrUpdateStorageClass - additional cases', () => {
    it('logs debug when StorageClass not found during update (debug mode)', async () => {
      const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue(notFound),
        createStorageClass: jest.fn().mockResolvedValue({ metadata: { name: 'sc-proj-1-my-bucket' } }),
      });
      const manager = new StorageClassResourceManager(api, 'nemo', 'debug');
      const result = await manager.createOrUpdateStorageClass(baseSpec as any, null);
      expect(result).toBeDefined();
    });

    it('throws when createStorageClass fails after 404 on read', async () => {
      const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
      const createErr = Object.assign(new Error('create failed'), { statusCode: 500 });
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue(notFound),
        createStorageClass: jest.fn().mockRejectedValue(createErr),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.createOrUpdateStorageClass(baseSpec as any, null)).rejects.toThrow();
    });

    it('throws on non-404 error from readStorageClass during update', async () => {
      const serverErr = Object.assign(new Error('server error'), { statusCode: 500 });
      const api = mockStorageApi({
        readStorageClass: jest.fn().mockRejectedValue(serverErr),
      });
      const manager = new StorageClassResourceManager(api, 'nemo');
      await expect(manager.createOrUpdateStorageClass(baseSpec as any, null)).rejects.toThrow();
    });
  });
});
