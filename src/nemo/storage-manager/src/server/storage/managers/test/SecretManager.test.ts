import * as k8s from '@kubernetes/client-node';
import { SecretManager } from '../SecretManager';
import { BucketStorageClassSpec } from '../../types';

describe('SecretManager', () => {
  let mockCoreApi: jest.Mocked<k8s.CoreV1Api>;
  let secretManager: SecretManager;

  const mockSpec: BucketStorageClassSpec = {
    project_id: 'p-123',
    bucket_name: 'bucket-abc',
    volume_info: {
      type: 'nfs',
      endpoint: 'nfs-server:/path',
    },
    auth_info: {
      type: 'basic',
      username: 'user',
      password_encrypted: 'encrypted-password',
    },
    protocol: 's3',
    role: 'primary',
  };

  beforeEach(() => {
    mockCoreApi = {
      readNamespacedSecret: jest.fn(),
      createNamespacedSecret: jest.fn(),
      replaceNamespacedSecret: jest.fn(),
      deleteNamespacedSecret: jest.fn(),
    } as any;

    secretManager = new SecretManager(mockCoreApi, 'test-namespace', 'info');
  });

  describe('createOrUpdateSecret', () => {
    it('should create new secret when it does not exist', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.readNamespacedSecret.mockRejectedValue(notFoundError);
      mockCoreApi.createNamespacedSecret.mockResolvedValue({ body: {} } as any);

      const result = await secretManager.createOrUpdateSecret(mockSpec);

      expect(result).toBeTruthy();
      expect(mockCoreApi.createNamespacedSecret).toHaveBeenCalled();
    });

    it('should update existing secret', async () => {
      mockCoreApi.readNamespacedSecret.mockResolvedValue({
        body: { metadata: { name: 'secret-name' } },
      } as any);
      mockCoreApi.replaceNamespacedSecret.mockResolvedValue({
        body: {},
      } as any);

      const result = await secretManager.createOrUpdateSecret(mockSpec);

      expect(result).toBeTruthy();
      expect(mockCoreApi.replaceNamespacedSecret).toHaveBeenCalled();
    });

    it('should return null when no auth info provided', async () => {
      const specWithoutAuth: BucketStorageClassSpec = {
        ...mockSpec,
        auth_info: {
          type: 'none',
        },
      };

      const result = await secretManager.createOrUpdateSecret(specWithoutAuth);

      expect(result).toBeNull();
      expect(mockCoreApi.createNamespacedSecret).not.toHaveBeenCalled();
    });

    it('should throw error on non-404 errors', async () => {
      const error: any = new Error('Permission denied');
      error.statusCode = 403;
      mockCoreApi.readNamespacedSecret.mockRejectedValue(error);

      await expect(
        secretManager.createOrUpdateSecret(mockSpec)
      ).rejects.toThrow();
    });

    it('should throw error when createNamespacedSecret fails (new secret creation failure)', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.readNamespacedSecret.mockRejectedValue(notFoundError);

      const createError: any = new Error('Permission denied');
      createError.statusCode = 403;
      mockCoreApi.createNamespacedSecret.mockRejectedValue(createError);

      await expect(
        secretManager.createOrUpdateSecret(mockSpec)
      ).rejects.toThrow();
    });
  });

  describe('deleteSecret', () => {
    it('should delete secret successfully', async () => {
      mockCoreApi.deleteNamespacedSecret.mockResolvedValue({ body: {} } as any);

      await secretManager.deleteSecret('ns-123', 'bucket-abc');

      expect(mockCoreApi.deleteNamespacedSecret).toHaveBeenCalled();
    });

    it('should handle 404 errors gracefully', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.deleteNamespacedSecret.mockRejectedValue(notFoundError);

      await expect(
        secretManager.deleteSecret('ns-123', 'bucket-abc')
      ).resolves.not.toThrow();
    });

    it('should log warning on non-404 delete errors but not throw', async () => {
      const serverError: any = new Error('server error');
      serverError.statusCode = 500;
      mockCoreApi.deleteNamespacedSecret.mockRejectedValue(serverError);

      await expect(
        secretManager.deleteSecret('ns-123', 'bucket-abc')
      ).resolves.not.toThrow();
    });
  });
});

