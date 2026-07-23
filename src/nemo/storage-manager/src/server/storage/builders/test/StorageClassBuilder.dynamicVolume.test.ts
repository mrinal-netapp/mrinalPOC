import { StorageClassBuilder } from '../StorageClassBuilder';
import { BucketStorageClassSpec } from '../../types';

/**
 * Parity with config-service dynamic volume payloads (volume_info.provisioning_mode: dynamic).
 * Static NFS/SMB cases live in StorageClassBuilder.test.ts.
 */
describe('StorageClassBuilder dynamic volume (config-service parity)', () => {
  const dynamicSpec: BucketStorageClassSpec = {
    project_id: 'proj-1',
    bucket_name: 'dynamic-nfs-vol',
    provisioning_mode: 'dynamic',
    storage_class_name: 'ontap-nas',
    storage_size: '100Gi',
    volume_info: {
      type: 'nfs',
    },
    auth_info: { type: 'none' },
    protocol: 'nfs',
    role: 'primary',
  };

  it('does not create a StorageClass for dynamic provisioning', () => {
    expect(StorageClassBuilder.shouldCreateStorageClass(dynamicSpec)).toBe(false);
  });

  it('validateDynamicProvisioning requires storage_class_name', () => {
    expect(() =>
      StorageClassBuilder.validateDynamicProvisioning({
        ...dynamicSpec,
        storage_class_name: undefined,
      }),
    ).toThrow(/storage_class_name is required/);
  });

  it('validateDynamicProvisioning accepts config-service-shaped dynamic NFS', () => {
    expect(() => StorageClassBuilder.validateDynamicProvisioning(dynamicSpec)).not.toThrow();
  });

  it('validateStaticProvisioning allows missing endpoint when mode is dynamic', () => {
    expect(() => StorageClassBuilder.validateStaticProvisioning(dynamicSpec)).not.toThrow();
  });
});
