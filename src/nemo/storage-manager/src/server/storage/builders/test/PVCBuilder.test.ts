import * as k8s from '@kubernetes/client-node';
import { PVCBuilder } from '../PVCBuilder';

describe('PVCBuilder', () => {
  const mockStorageClass: k8s.V1StorageClass = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: 'sc-ns-123-bucket-abc',
      labels: {
        'agentstudio.io/project-id': 'p-123',
        'agentstudio.io/volume-type': 'nfs',
      },
      annotations: {
        'agentstudio.io/mount-options': 'noac',
        'agentstudio.io/volume-endpoint': 'nfs-server:/path',
      },
    },
    provisioner: 'kubernetes.io/no-provisioner',
  };

  describe('buildPVCSpec', () => {
    it('should build complete PVC spec', () => {
      const pvc = PVCBuilder.buildPVCSpec(
        mockStorageClass,
        'bucket-abc',
        '10Gi',
        'test-namespace'
      );

      expect(pvc.apiVersion).toBe('v1');
      expect(pvc.kind).toBe('PersistentVolumeClaim');
      expect(pvc.metadata!.namespace).toBe('test-namespace');
      expect(pvc.metadata!.name).toBeTruthy();
      expect(pvc.spec!.accessModes).toEqual(['ReadWriteMany']);
      expect(pvc.spec!.storageClassName).toBe('sc-ns-123-bucket-abc');
      expect(pvc.spec!.resources!.requests!.storage).toBe('10Gi');
    });

    it('should include correct labels', () => {
      const pvc = PVCBuilder.buildPVCSpec(
        mockStorageClass,
        'bucket-abc',
        '10Gi',
        'test-namespace'
      );

      expect(pvc.metadata!.labels).toBeDefined();
      expect(pvc.metadata!.labels!['agentstudio.io/bucket-name']).toBe(
        'bucket-abc'
      );
      expect(pvc.metadata!.labels!['agentstudio.io/project-id']).toBe(
        'p-123'
      );
      expect(pvc.metadata!.labels!['agentstudio.io/storage-class']).toBe(
        'sc-ns-123-bucket-abc'
      );
      expect(pvc.metadata!.labels!['agentstudio.io/managed-by']).toBe('storage-manager');
    });

    it('should include NFS mount options in annotations', () => {
      const pvc = PVCBuilder.buildPVCSpec(
        mockStorageClass,
        'bucket-abc',
        '10Gi',
        'test-namespace'
      );

      expect(pvc.metadata!.annotations).toBeDefined();
      expect(
        pvc.metadata!.annotations!['nfs.csi.k8s.io/mountOptions']
      ).toBe('noac');
    });

    it('should include SMB mount options in annotations', () => {
      const smbStorageClass: k8s.V1StorageClass = {
        ...mockStorageClass,
        metadata: {
          ...mockStorageClass.metadata,
          labels: {
            'agentstudio.io/project-id': 'p-123',
            'agentstudio.io/volume-type': 'smb',
          },
          annotations: {
            'agentstudio.io/mount-options': 'uid=1000',
          },
        },
      };
      const pvc = PVCBuilder.buildPVCSpec(
        smbStorageClass,
        'bucket-abc',
        '10Gi',
        'test-namespace'
      );

      expect(
        pvc.metadata!.annotations!['smb.csi.k8s.io/mountOptions']
      ).toBe('uid=1000');
    });

    it('should include NFS server and share annotations', () => {
      const pvc = PVCBuilder.buildPVCSpec(
        mockStorageClass,
        'bucket-abc',
        '10Gi',
        'test-namespace'
      );

      expect(pvc.metadata!.annotations!['nfs.csi.k8s.io/server']).toBe(
        'nfs-server'
      );
      expect(pvc.metadata!.annotations!['nfs.csi.k8s.io/share']).toBe('/path');
    });

    it('should throw error if StorageClass name is missing', () => {
      const storageClassWithoutName: k8s.V1StorageClass = {
        ...mockStorageClass,
        metadata: {},
      };

      expect(() => {
        PVCBuilder.buildPVCSpec(
          storageClassWithoutName,
          'bucket-abc',
          '10Gi',
          'test-namespace'
        );
      }).toThrow('StorageClass name is missing');
    });
  });

  describe('getPVCName', () => {
    it('should return PVC name', () => {
      const pvcName = PVCBuilder.getPVCName('sc-ns-123-bucket', 'bucket-abc');
      expect(pvcName).toMatch(/^pvc-[a-z0-9]{1,8}-bucket-abc$/);
    });
  });
});

