import { get_logger } from '@agentstudio/observability-client-runtime';
import { StorageClassBuilder } from '../StorageClassBuilder';
import { BucketStorageClassSpec } from '../../types';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));
const mockLogger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() };

const baseSpec: BucketStorageClassSpec = {
  project_id: 'proj-1',
  bucket_name: 'my-bucket',
  volume_info: { type: 'nfs', endpoint: 'nfs://10.0.0.1/share' },
  auth_info: { type: 'none' },
  protocol: 'nfs',
  role: 'primary',
};

describe('StorageClassBuilder', () => {
  describe('shouldCreateStorageClass', () => {
    it('returns true for static provisioning (default)', () => {
      expect(StorageClassBuilder.shouldCreateStorageClass(baseSpec)).toBe(true);
    });

    it('returns true when provisioning_mode is explicitly static', () => {
      expect(StorageClassBuilder.shouldCreateStorageClass({
        ...baseSpec,
        provisioning_mode: 'static',
      })).toBe(true);
    });

    it('returns false for dynamic provisioning', () => {
      expect(StorageClassBuilder.shouldCreateStorageClass({
        ...baseSpec,
        provisioning_mode: 'dynamic',
      })).toBe(false);
    });
  });

  describe('validateDynamicProvisioning', () => {
    it('does not throw when storage_class_name is provided', () => {
      expect(() =>
        StorageClassBuilder.validateDynamicProvisioning({
          ...baseSpec,
          provisioning_mode: 'dynamic',
          storage_class_name: 'standard',
        })
      ).not.toThrow();
    });

    it('throws when storage_class_name is missing for dynamic mode', () => {
      expect(() =>
        StorageClassBuilder.validateDynamicProvisioning({
          ...baseSpec,
          provisioning_mode: 'dynamic',
        })
      ).toThrow(/storage_class_name is required/);
    });

    it('does not throw for static mode even without storage_class_name', () => {
      expect(() =>
        StorageClassBuilder.validateDynamicProvisioning({ ...baseSpec, provisioning_mode: 'static' })
      ).not.toThrow();
    });
  });

  describe('validateStaticProvisioning', () => {
    it('does not throw when endpoint is provided', () => {
      expect(() => StorageClassBuilder.validateStaticProvisioning(baseSpec)).not.toThrow();
    });

    it('throws when endpoint is missing for static mode', () => {
      expect(() =>
        StorageClassBuilder.validateStaticProvisioning({
          ...baseSpec,
          volume_info: { type: 'nfs' }, // no endpoint
        })
      ).toThrow(/endpoint is required/);
    });

    it('does not throw for default (static) mode with endpoint', () => {
      const spec: BucketStorageClassSpec = {
        ...baseSpec,
        provisioning_mode: undefined, // defaults to static
      };
      expect(() => StorageClassBuilder.validateStaticProvisioning(spec)).not.toThrow();
    });
  });

  describe('buildStorageClassSpec', () => {
    it('builds valid StorageClass for NFS static provisioning', () => {
      const endpointInfo = { server: '10.0.0.1', share: '/data' };
      const sc = StorageClassBuilder.buildStorageClassSpec(
        'sc-proj-1-my-bucket',
        baseSpec,
        endpointInfo,
        null,
        'nemo'
      );

      expect(sc.apiVersion).toBe('storage.k8s.io/v1');
      expect(sc.kind).toBe('StorageClass');
      expect(sc.metadata?.name).toBe('sc-proj-1-my-bucket');
      expect(sc.provisioner).toBe('kubernetes.io/no-provisioner');
      expect(sc.reclaimPolicy).toBe('Retain');
      expect(sc.volumeBindingMode).toBe('Immediate');
    });

    it('builds StorageClass with SMB parameters including secret references', () => {
      const smbSpec: BucketStorageClassSpec = {
        ...baseSpec,
        volume_info: { type: 'smb', endpoint: '//server/share' },
        protocol: 'smb',
      };
      const endpointInfo = { source: '//server/share' };
      const sc = StorageClassBuilder.buildStorageClassSpec(
        'sc-proj-1-smb',
        smbSpec,
        endpointInfo,
        'my-secret',
        'nemo'
      );

      expect(sc).toBeDefined();
      expect(sc.metadata?.name).toBe('sc-proj-1-smb');
    });
  });

  describe('buildStorageClassParameters', () => {
    it('builds NFS parameters with server and share', () => {
      const endpointInfo = { server: '10.0.0.1', share: '/exports/data' };
      const params = StorageClassBuilder.buildStorageClassParameters('nfs', endpointInfo, null, 'nemo');
      expect(params['server']).toBe('10.0.0.1');
      expect(params['share']).toBe('/exports/data');
    });

    it('builds SMB parameters with source and secret references', () => {
      const endpointInfo = { source: '//nas/share' };
      const params = StorageClassBuilder.buildStorageClassParameters('smb', endpointInfo, 'my-secret', 'nemo');
      expect(params['source']).toBe('//nas/share');
      expect(params['csi.storage.k8s.io/provisioner-secret-name']).toBe('my-secret');
      expect(params['csi.storage.k8s.io/provisioner-secret-namespace']).toBe('nemo');
    });

    it('builds CIFS parameters (same as SMB)', () => {
      const endpointInfo = { source: '//server/cifs' };
      const params = StorageClassBuilder.buildStorageClassParameters('cifs', endpointInfo, null, 'nemo');
      expect(params['source']).toBe('//server/cifs');
    });

    it('returns empty parameters for unknown volume type', () => {
      const params = StorageClassBuilder.buildStorageClassParameters('glusterfs', {}, null, 'nemo');
      expect(Object.keys(params).length).toBe(0);
    });
  });
});
