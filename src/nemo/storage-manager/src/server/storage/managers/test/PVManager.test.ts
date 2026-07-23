import * as k8s from '@kubernetes/client-node';
import { PVManager } from '../PVManager';
import { BucketStorageClassSpec } from '../../types';

describe('PVManager', () => {
  let mockCoreApi: jest.Mocked<k8s.CoreV1Api>;
  let pvManager: PVManager;

  const mockStorageClass: k8s.V1StorageClass = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: 'sc-ns-123-bucket-abc',
      labels: {
        'agentstudio.io/volume-type': 'nfs',
      },
      annotations: {
        'agentstudio.io/mount-options': 'noac',
      },
    },
    provisioner: 'kubernetes.io/no-provisioner',
  };

  const mockSpec: BucketStorageClassSpec = {
    project_id: 'p-123',
    bucket_name: 'bucket-abc',
    volume_info: {
      type: 'nfs',
      endpoint: 'nfs-server:/path',
    },
    auth_info: {
      type: 'none',
    },
    protocol: 's3',
    role: 'primary',
  };

  beforeEach(() => {
    mockCoreApi = {
      readPersistentVolume: jest.fn(),
      createPersistentVolume: jest.fn(),
      listPersistentVolume: jest.fn(),
      deletePersistentVolume: jest.fn(),
      patchPersistentVolume: jest.fn(),
    } as any;

    pvManager = new PVManager(mockCoreApi, 'test-namespace', '10Gi', 'info');
  });

  describe('createPVOnDemand', () => {
    it('should create PV successfully', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.readPersistentVolume.mockRejectedValue(notFoundError);
      mockCoreApi.createPersistentVolume.mockResolvedValue({
        metadata: { name: 'pv-name' },
        status: { phase: 'Available' },
        spec: {
          accessModes: ['ReadWriteMany'],
        },
      } as any);

      const result = await pvManager.createPVOnDemand(
        mockStorageClass,
        mockSpec,
        'pvc-name'
      );

      expect(result).toBeTruthy();
      expect(mockCoreApi.createPersistentVolume).toHaveBeenCalled();
    });

    it('should reuse existing available PV', async () => {
      mockCoreApi.readPersistentVolume.mockResolvedValue({
        status: { phase: 'Available' },
        spec: {
          claimRef: undefined,
        },
      } as any);

      const result = await pvManager.createPVOnDemand(
        mockStorageClass,
        mockSpec,
        'pvc-name'
      );

      expect(result).toMatch(/^pv-sc-ns-123-bucket-abc-[a-z0-9]{1,8}$/);
      expect(mockCoreApi.createPersistentVolume).not.toHaveBeenCalled();
    });

    it('should handle conflict errors by finding available PV', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.readPersistentVolume.mockRejectedValue(notFoundError);

      const conflictError: any = new Error('Conflict');
      conflictError.statusCode = 409;
      mockCoreApi.createPersistentVolume.mockRejectedValue(conflictError);

      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'available-pv' },
            status: { phase: 'Available' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-ns-123-bucket-abc',
              claimRef: undefined,
            },
          },
        ],
      } as any);

      const result = await pvManager.createPVOnDemand(
        mockStorageClass,
        mockSpec,
        'pvc-name'
      );

      expect(result).toBe('available-pv');
    });
  });

  describe('findAvailablePV', () => {
    it('should find available PV', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'available-pv' },
            status: { phase: 'Available' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-ns-123-bucket-abc',
              claimRef: undefined,
            },
          },
          {
            metadata: { name: 'bound-pv' },
            status: { phase: 'Bound' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-ns-123-bucket-abc',
              claimRef: { name: 'pvc-name' },
            },
          },
        ],
      } as any);

      const result = await pvManager.findAvailablePV('sc-ns-123-bucket-abc');

      expect(result).not.toBeNull();
      expect(result!.metadata!.name).toBe('available-pv');
    });

    it('should return null when no available PV found', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'bound-pv' },
            status: { phase: 'Bound' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-ns-123-bucket-abc',
              claimRef: { name: 'pvc-name' },
            },
          },
        ],
      } as any);

      const result = await pvManager.findAvailablePV('sc-ns-123-bucket-abc');

      expect(result).toBeNull();
    });
  });

  describe('deletePV', () => {
    it('should delete PV successfully', async () => {
      mockCoreApi.deletePersistentVolume.mockResolvedValue({} as any);

      await pvManager.deletePV('pv-name');

      expect(mockCoreApi.deletePersistentVolume).toHaveBeenCalledWith({
        name: 'pv-name',
      });
    });

    it('should handle 404 errors gracefully', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.deletePersistentVolume.mockRejectedValue(notFoundError);

      await expect(pvManager.deletePV('pv-name')).resolves.not.toThrow();
    });

    it('logs warning for non-404 delete errors', async () => {
      const err: any = new Error('server error');
      err.statusCode = 500;
      mockCoreApi.deletePersistentVolume.mockRejectedValue(err);

      await expect(pvManager.deletePV('pv-name')).resolves.not.toThrow();
    });
  });

  describe('createPVOnDemandWithSecret', () => {
    it('creates PV successfully with secretName', async () => {
      mockCoreApi.createPersistentVolume.mockResolvedValue({
        metadata: { name: 'pv-test' },
        status: { phase: 'Available' },
        spec: { accessModes: ['ReadWriteMany'] },
      } as any);
      mockCoreApi.readPersistentVolume.mockResolvedValue({
        status: { phase: 'Available' },
        spec: { accessModes: ['ReadWriteMany'] },
      } as any);

      const spec: BucketStorageClassSpec = {
        project_id: 'p-1',
        bucket_name: 'bucket',
        volume_info: { type: 'smb', endpoint: '//server/share' },
        auth_info: { type: 'none' },
        protocol: 's3',
        role: 'primary',
      };

      const result = await pvManager.createPVOnDemandWithSecret(
        mockStorageClass,
        spec,
        'pvc-1',
        'my-secret'
      );

      expect(result).toBeTruthy();
      expect(mockCoreApi.createPersistentVolume).toHaveBeenCalled();
    });

    it('throws when storage class name is missing', async () => {
      const scWithoutName = { ...mockStorageClass, metadata: {} };
      const spec: BucketStorageClassSpec = {
        project_id: 'p-1',
        bucket_name: 'bucket',
        volume_info: { type: 'nfs', endpoint: 'nfs-server:/path' },
        auth_info: { type: 'none' },
        protocol: 's3',
        role: 'primary',
      };

      await expect(
        pvManager.createPVOnDemandWithSecret(scWithoutName as any, spec, 'pvc-1', null)
      ).rejects.toThrow('StorageClass name is missing');
    });

    it('throws when endpoint is missing for static provisioning', async () => {
      const spec: BucketStorageClassSpec = {
        project_id: 'p-1',
        bucket_name: 'bucket',
        volume_info: { type: 'nfs' }, // no endpoint
        auth_info: { type: 'none' },
        protocol: 's3',
        role: 'primary',
      };

      await expect(
        pvManager.createPVOnDemandWithSecret(mockStorageClass, spec, 'pvc-1', null)
      ).rejects.toThrow(/endpoint is required/);
    });

    it('handles conflict error during creation by returning available PV', async () => {
      const conflictErr: any = new Error('Conflict');
      conflictErr.statusCode = 409;
      mockCoreApi.createPersistentVolume.mockRejectedValue(conflictErr);

      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-existing' },
            status: { phase: 'Available' },
            spec: { accessModes: ['ReadWriteMany'], storageClassName: 'sc-ns-123-bucket-abc', claimRef: undefined },
          },
        ],
      } as any);

      const result = await pvManager.createPVOnDemandWithSecret(
        mockStorageClass,
        mockSpec,
        'pvc-1',
        null
      );

      expect(result).toBe('pv-existing');
    });

    it('throws when conflict and no available PV found', async () => {
      const conflictErr: any = new Error('Conflict');
      conflictErr.statusCode = 409;
      mockCoreApi.createPersistentVolume.mockRejectedValue(conflictErr);
      mockCoreApi.listPersistentVolume.mockResolvedValue({ items: [] } as any);

      await expect(
        pvManager.createPVOnDemandWithSecret(mockStorageClass, mockSpec, 'pvc-1', null)
      ).rejects.toThrow(/not available for binding/);
    });
  });

  describe('unbindPV', () => {
    it('unbinds PV by removing claimRef', async () => {
      mockCoreApi.readPersistentVolume.mockResolvedValue({
        metadata: { name: 'pv-1' },
        spec: { claimRef: { name: 'pvc-1' }, accessModes: ['ReadWriteMany'] },
      } as any);
      mockCoreApi.replacePersistentVolume = jest.fn().mockResolvedValue({});

      await pvManager.unbindPV('pv-1');

      expect(mockCoreApi.replacePersistentVolume).toHaveBeenCalled();
    });

    it('handles 404 when PV not found during unbind', async () => {
      const notFoundErr: any = new Error('not found');
      notFoundErr.statusCode = 404;
      mockCoreApi.readPersistentVolume.mockRejectedValue(notFoundErr);

      await expect(pvManager.unbindPV('pv-missing')).resolves.not.toThrow();
    });

    it('logs warning for non-404 unbind errors', async () => {
      const serverErr: any = new Error('server error');
      serverErr.statusCode = 500;
      mockCoreApi.readPersistentVolume.mockRejectedValue(serverErr);

      await expect(pvManager.unbindPV('pv-err')).resolves.not.toThrow();
    });
  });

  describe('deleteUnboundPVs', () => {
    it('deletes unbound available PVs', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-available' },
            status: { phase: 'Available' },
            spec: { claimRef: undefined },
          },
          {
            metadata: { name: 'pv-bound' },
            status: { phase: 'Bound' },
            spec: { claimRef: { name: 'pvc-1' } },
          },
        ],
      } as any);
      mockCoreApi.deletePersistentVolume.mockResolvedValue({} as any);

      const count = await pvManager.deleteUnboundPVs('sc-test');

      expect(count).toBe(1);
      expect(mockCoreApi.deletePersistentVolume).toHaveBeenCalledTimes(1);
    });

    it('returns 0 when no unbound PVs found', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          { metadata: { name: 'pv-bound' }, status: { phase: 'Bound' }, spec: { claimRef: { name: 'pvc' } } },
        ],
      } as any);

      const count = await pvManager.deleteUnboundPVs('sc-test');
      expect(count).toBe(0);
    });

    it('handles errors during individual PV deletion (counts as attempted)', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          { metadata: { name: 'pv-available' }, status: { phase: 'Available' }, spec: { claimRef: undefined } },
        ],
      } as any);
      const err: any = new Error('forbidden');
      err.statusCode = 403;
      mockCoreApi.deletePersistentVolume.mockRejectedValue(err);

      // deletePV catches the error internally - deleteUnboundPVs still increments count
      const count = await pvManager.deleteUnboundPVs('sc-test');
      expect(count).toBe(1);
    });
  });

  describe('listPVsForStorageClass', () => {
    it('returns PVs matching the storage class label', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [{ metadata: { name: 'pv-1' } }],
      } as any);

      const pvs = await pvManager.listPVsForStorageClass('sc-test');
      expect(pvs).toHaveLength(1);
    });

    it('returns empty array on error', async () => {
      mockCoreApi.listPersistentVolume.mockRejectedValue(new Error('forbidden'));

      const pvs = await pvManager.listPVsForStorageClass('sc-test');
      expect(pvs).toEqual([]);
    });
  });

  describe('findAvailablePV additional cases', () => {
    it('skips PV without ReadWriteMany', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-rwo' },
            status: { phase: 'Available' },
            spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'sc-test', claimRef: undefined },
          },
        ],
      } as any);

      const pv = await pvManager.findAvailablePV('sc-test');
      expect(pv).toBeNull();
    });

    it('skips PV with nodeAffinity', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-affinity' },
            status: { phase: 'Available' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-test',
              claimRef: undefined,
              nodeAffinity: { required: {} },
            },
          },
        ],
      } as any);

      const pv = await pvManager.findAvailablePV('sc-test');
      expect(pv).toBeNull();
    });

    it('skips PV with mismatched storageClass', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-wrong-sc' },
            status: { phase: 'Available' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'different-sc',
              claimRef: undefined,
            },
          },
        ],
      } as any);

      const pv = await pvManager.findAvailablePV('sc-test');
      expect(pv).toBeNull();
    });

    it('logs debug for Available PV with claimRef (already bound)', async () => {
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-bound-available' },
            status: { phase: 'Available' },
            spec: {
              accessModes: ['ReadWriteMany'],
              storageClassName: 'sc-test',
              claimRef: { name: 'some-pvc' },
            },
          },
        ],
      } as any);

      const pv = await pvManager.findAvailablePV('sc-test');
      expect(pv).toBeNull();
    });
  });

  describe('createPVOnDemand — additional branches', () => {
    it('throws when storageClass name is missing', async () => {
      const scWithoutName = { metadata: {} } as any;
      await expect(
        pvManager.createPVOnDemand(scWithoutName, mockSpec, 'pvc-1')
      ).rejects.toThrow('StorageClass name is missing');
    });

    it('throws when volume_info.endpoint is missing', async () => {
      const specNoEndpoint: any = { ...mockSpec, volume_info: { type: 'nfs' } };
      await expect(
        pvManager.createPVOnDemand(mockStorageClass, specNoEndpoint, 'pvc-1')
      ).rejects.toThrow(/endpoint is required/);
    });

    it('sets pvExists=true when PV exists but is not Available', async () => {
      // First read returns PV with Bound phase (pvExists = true)
      mockCoreApi.readPersistentVolume.mockResolvedValueOnce({
        status: { phase: 'Bound' },
        spec: { claimRef: { name: 'pvc-other' } },
      } as any);
      // findAvailablePV list returns an available PV
      mockCoreApi.listPersistentVolume.mockResolvedValue({
        items: [
          {
            metadata: { name: 'pv-avail' },
            status: { phase: 'Available' },
            spec: { accessModes: ['ReadWriteMany'], storageClassName: 'sc-ns-123-bucket-abc', claimRef: undefined },
          },
        ],
      } as any);

      const result = await pvManager.createPVOnDemand(mockStorageClass, mockSpec, 'pvc-1');
      expect(result).toBe('pv-avail');
    });

    it('throws when PV exists but no available PV can be found', async () => {
      // readPersistentVolume returns existing bound PV
      mockCoreApi.readPersistentVolume.mockResolvedValueOnce({
        status: { phase: 'Bound' },
        spec: { claimRef: { name: 'pvc-other' } },
      } as any);
      // No available PVs
      mockCoreApi.listPersistentVolume.mockResolvedValue({ items: [] } as any);

      await expect(
        pvManager.createPVOnDemand(mockStorageClass, mockSpec, 'pvc-1')
      ).rejects.toThrow(/not available for binding/);
    });

    it('throws when non-404 error during PV read', async () => {
      const forbiddenErr: any = new Error('Forbidden');
      forbiddenErr.statusCode = 403;
      mockCoreApi.readPersistentVolume.mockRejectedValue(forbiddenErr);

      await expect(
        pvManager.createPVOnDemand(mockStorageClass, mockSpec, 'pvc-1')
      ).rejects.toThrow(/Forbidden/);
    });

    it('throws enhanced error when create fails with non-conflict error', async () => {
      const notFoundError: any = new Error('Not found');
      notFoundError.statusCode = 404;
      mockCoreApi.readPersistentVolume.mockRejectedValue(notFoundError);

      const serverError: any = new Error('Internal Server Error');
      serverError.statusCode = 500;
      mockCoreApi.createPersistentVolume.mockRejectedValue(serverError);

      await expect(
        pvManager.createPVOnDemand(mockStorageClass, mockSpec, 'pvc-1')
      ).rejects.toThrow();
    });
  });

  describe('createPVOnDemandWithSecret — additional branches', () => {
    it('throws enhanced error when create fails with non-conflict error', async () => {
      const serverError: any = new Error('Server Error');
      serverError.statusCode = 500;
      mockCoreApi.createPersistentVolume.mockRejectedValue(serverError);

      await expect(
        pvManager.createPVOnDemandWithSecret(mockStorageClass, mockSpec, 'pvc-1', null)
      ).rejects.toThrow();
    });

    it('logs warn when verifyPVCreation finds PV not immediately mountable', async () => {
      // createPersistentVolume succeeds
      mockCoreApi.createPersistentVolume.mockResolvedValue({} as any);
      // verifyPVCreation reads PV with non-Available phase
      mockCoreApi.readPersistentVolume.mockResolvedValue({
        status: { phase: 'Pending' },
        spec: { accessModes: ['ReadWriteOnce'] },
      } as any);

      // This should not throw but trigger the warn branch in verifyPVCreation
      await expect(
        pvManager.createPVOnDemandWithSecret(mockStorageClass, mockSpec, 'pvc-1', null)
      ).resolves.toBeTruthy();
    });
  });

  describe('unbindPV — debug mode', () => {
    it('logs debug error details when unbind fails and logLevel is debug', async () => {
      const debugManager = new PVManager(mockCoreApi, 'test-namespace', '10Gi', 'debug');
      const serverErr: any = new Error('Server Error');
      serverErr.statusCode = 500;
      mockCoreApi.readPersistentVolume.mockRejectedValue(serverErr);

      await expect(debugManager.unbindPV('pv-err')).resolves.not.toThrow();
    });
  });
});

