import * as k8s from '@kubernetes/client-node';
import { PVBuilder } from '../PVBuilder';
import { BucketStorageClassSpec } from '../../types';
import { NfsEndpointInfo, SmbEndpointInfo } from '../../utils/EndpointParser';

describe('PVBuilder', () => {
  const mockStorageClass: k8s.V1StorageClass = {
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: {
      name: 'sc-ns-123-bucket-abc',
      labels: {
        'agentstudio.io/volume-type': 'nfs',
      },
      annotations: {
        'agentstudio.io/mount-options': 'noac,nfsvers=4',
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

  describe('buildNFSPVSpec', () => {
    it('should build NFS PV spec', () => {
      const endpointInfo: NfsEndpointInfo = {
        server: 'nfs-server',
        share: '/path/to/share',
      };
      const spec = PVBuilder.buildNFSPVSpec(
        endpointInfo,
        'noac,nfsvers=4',
        '10Gi',
        'sc-ns-123-bucket-abc'
      );

      expect(spec.capacity!.storage).toBe('10Gi');
      expect(spec.accessModes).toEqual(['ReadWriteMany']);
      expect(spec.persistentVolumeReclaimPolicy).toBe('Retain');
      expect(spec.storageClassName).toBe('sc-ns-123-bucket-abc');
      expect(spec.nfs!.server).toBe('nfs-server');
      expect(spec.nfs!.path).toBe('/path/to/share');
      expect(spec.mountOptions).toEqual([
        'noac',
        'nfsvers=4',
        'soft',
        'timeo=50',
        'retrans=3',
      ]);
    });

    it('should use default mount options when not provided', () => {
      const endpointInfo: NfsEndpointInfo = {
        server: 'nfs-server',
        share: '/path',
      };
      const spec = PVBuilder.buildNFSPVSpec(
        endpointInfo,
        '',
        '10Gi',
        'sc-ns-123-bucket-abc'
      );

      expect(spec.mountOptions).toEqual([
        'noac',
        'soft',
        'timeo=50',
        'retrans=3',
      ]);
    });

    it('should handle missing server', () => {
      const endpointInfo: NfsEndpointInfo = {
        share: '/path',
      };
      const spec = PVBuilder.buildNFSPVSpec(
        endpointInfo,
        '',
        '10Gi',
        'sc-ns-123-bucket-abc'
      );

      expect(spec.nfs!.server).toBe('');
      expect(spec.nfs!.path).toBe('/path');
    });

    it('should handle missing share', () => {
      const endpointInfo: NfsEndpointInfo = {
        server: 'nfs-server',
      };
      const spec = PVBuilder.buildNFSPVSpec(
        endpointInfo,
        '',
        '10Gi',
        'sc-ns-123-bucket-abc'
      );

      expect(spec.nfs!.server).toBe('nfs-server');
      expect(spec.nfs!.path).toBe('/');
    });
  });

  describe('buildSMBPVSpec', () => {
    it('should build SMB PV spec with secret', () => {
      const endpointInfo: SmbEndpointInfo = {
        source: '//smb-server/share',
      };
      const spec = PVBuilder.buildSMBPVSpec(
        endpointInfo,
        'uid=1000,gid=1000',
        '10Gi',
        'sc-ns-123-bucket-abc',
        'secret-name',
        'test-namespace',
        'smb-static-handle'
      );

      expect(spec.capacity!.storage).toBe('10Gi');
      expect(spec.accessModes).toEqual(['ReadWriteMany']);
      expect(spec.persistentVolumeReclaimPolicy).toBe('Retain');
      expect(spec.storageClassName).toBe('sc-ns-123-bucket-abc');
      expect(spec.csi!.driver).toBe('smb.csi.k8s.io');
      expect(spec.csi!.volumeHandle).toBe('smb-static-handle');
      expect(spec.csi!.volumeAttributes!.source).toBe('//smb-server/share');
      expect(spec.csi!.nodeStageSecretRef!.name).toBe('secret-name');
      expect(spec.csi!.nodeStageSecretRef!.namespace).toBe('test-namespace');
      expect(spec.mountOptions).toEqual(['uid=1000', 'gid=1000']);
    });

    it('should build SMB PV spec without secret', () => {
      const endpointInfo: SmbEndpointInfo = {
        source: '//smb-server/share',
      };
      const spec = PVBuilder.buildSMBPVSpec(
        endpointInfo,
        '',
        '10Gi',
        'sc-ns-123-bucket-abc',
        null,
        'test-namespace',
        'smb-static-handle'
      );

      expect(spec.csi!.nodeStageSecretRef).toBeUndefined();
    });

    it('should handle empty mount options', () => {
      const endpointInfo: SmbEndpointInfo = {
        source: '//smb-server/share',
      };
      const spec = PVBuilder.buildSMBPVSpec(
        endpointInfo,
        '',
        '10Gi',
        'sc-ns-123-bucket-abc',
        null,
        'test-namespace',
        'smb-static-handle'
      );

      expect(spec.mountOptions).toEqual([]);
    });
  });

  describe('buildPVMetadata', () => {
    it('should build PV metadata with labels', () => {
      const metadata = PVBuilder.buildPVMetadata(
        'pv-name',
        'sc-ns-123-bucket-abc',
        'bucket-abc',
        'ns-123'
      );

      expect(metadata.name).toBe('pv-name');
      expect(metadata.labels).toBeDefined();
      expect(metadata.labels!['agentstudio.io/storage-class']).toBe(
        'sc-ns-123-bucket-abc'
      );
      expect(metadata.labels!['agentstudio.io/bucket-name']).toBe('bucket-abc');
      expect(metadata.labels!['agentstudio.io/project-id']).toBe('ns-123');
      expect(metadata.labels!['agentstudio.io/managed-by']).toBe('storage-manager');
    });
  });

  describe('buildPVSpec', () => {
    it('should build complete NFS PV spec', () => {
      const endpointInfo: NfsEndpointInfo = {
        server: 'nfs-server',
        share: '/path',
      };
      const pv = PVBuilder.buildPVSpec(
        mockStorageClass,
        mockSpec,
        endpointInfo,
        null,
        'test-namespace',
        '10Gi',
        'pvc-name'
      );

      expect(pv.apiVersion).toBe('v1');
      expect(pv.kind).toBe('PersistentVolume');
      expect(pv.metadata!.name).toBeTruthy();
      expect(pv.spec!.nfs).toBeDefined();
      expect(pv.spec!.nfs!.server).toBe('nfs-server');
      expect(pv.spec!.nfs!.path).toBe('/path');
    });

    it('should build complete SMB PV spec', () => {
      const smbStorageClass: k8s.V1StorageClass = {
        ...mockStorageClass,
        metadata: {
          ...mockStorageClass.metadata,
          labels: {
            'agentstudio.io/volume-type': 'smb',
          },
        },
      };
      const smbSpec: BucketStorageClassSpec = {
        ...mockSpec,
        volume_info: {
          type: 'smb',
          endpoint: '//smb-server/share',
        },
      };
      const endpointInfo: SmbEndpointInfo = {
        source: '//smb-server/share',
      };
      const pv = PVBuilder.buildPVSpec(
        smbStorageClass,
        smbSpec,
        endpointInfo,
        'secret-name',
        'test-namespace',
        '10Gi',
        'pvc-name'
      );

      expect(pv.spec!.csi).toBeDefined();
      expect(pv.spec!.csi!.driver).toBe('smb.csi.k8s.io');
    });

    it('should throw error for unsupported volume type', () => {
      const unsupportedSpec: BucketStorageClassSpec = {
        ...mockSpec,
        volume_info: {
          type: 'unsupported',
          endpoint: 'endpoint',
        },
      };
      const endpointInfo: NfsEndpointInfo = {
        server: 'server',
        share: '/path',
      };

      expect(() => {
        PVBuilder.buildPVSpec(
          mockStorageClass,
          unsupportedSpec,
          endpointInfo,
          null,
          'test-namespace',
          '10Gi',
          'pvc-name'
        );
      }).toThrow('Unsupported volume type');
    });

    it('should throw error if StorageClass name is missing', () => {
      const storageClassWithoutName: k8s.V1StorageClass = {
        ...mockStorageClass,
        metadata: {},
      };
      const endpointInfo: NfsEndpointInfo = {
        server: 'nfs-server',
        share: '/path',
      };

      expect(() => {
        PVBuilder.buildPVSpec(
          storageClassWithoutName,
          mockSpec,
          endpointInfo,
          null,
          'test-namespace',
          '10Gi',
          'pvc-name'
        );
      }).toThrow('StorageClass name is missing');
    });
  });
});

