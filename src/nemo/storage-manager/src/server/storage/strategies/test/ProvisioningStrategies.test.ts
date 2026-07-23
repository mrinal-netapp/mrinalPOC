import { get_logger } from '@agentstudio/observability-client-runtime';
import { StaticProvisioningStrategy } from '../StaticProvisioningStrategy';
import { DynamicProvisioningStrategy } from '../DynamicProvisioningStrategy';
import { BucketStorageClassSpec } from '../../types';
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

const staticSpec: BucketStorageClassSpec = {
  project_id: 'proj-1',
  bucket_name: 'my-bucket',
  provisioning_mode: 'static',
  volume_info: { type: 'nfs', endpoint: 'nfs://10.0.0.1/share' },
  auth_info: { type: 'none' },
  protocol: 'nfs',
  role: 'primary',
};

const dynamicSpec: BucketStorageClassSpec = {
  project_id: 'proj-1',
  bucket_name: 'my-bucket',
  provisioning_mode: 'dynamic',
  storage_class_name: 'standard',
  volume_info: { type: 'nfs' },
  auth_info: { type: 'none' },
  protocol: 'nfs',
  role: 'primary',
};

const mockStorageClass: k8s.V1StorageClass = {
  metadata: { name: 'standard' },
  provisioner: 'nfs.csi.k8s.io',
};

describe('StaticProvisioningStrategy', () => {
  it('creates StorageClass using secret and resource manager', async () => {
    const secretMgr = { createOrUpdateSecret: jest.fn().mockResolvedValue('secret-1') };
    const scMgr = { createOrUpdateStorageClass: jest.fn().mockResolvedValue(mockStorageClass) };

    const strategy = new StaticProvisioningStrategy(secretMgr, scMgr);
    const result = await strategy.createOrUpdateStorageClass(staticSpec);

    expect(secretMgr.createOrUpdateSecret).toHaveBeenCalledWith(staticSpec);
    expect(scMgr.createOrUpdateStorageClass).toHaveBeenCalledWith(staticSpec, 'secret-1');
    expect(result).toBe(mockStorageClass);
  });

  it('creates StorageClass with null secretName when no auth needed', async () => {
    const secretMgr = { createOrUpdateSecret: jest.fn().mockResolvedValue(null) };
    const scMgr = { createOrUpdateStorageClass: jest.fn().mockResolvedValue(mockStorageClass) };

    const strategy = new StaticProvisioningStrategy(secretMgr, scMgr);
    await strategy.createOrUpdateStorageClass(staticSpec);

    expect(scMgr.createOrUpdateStorageClass).toHaveBeenCalledWith(staticSpec, null);
  });

  it('throws when endpoint is missing for static provisioning', async () => {
    const secretMgr = { createOrUpdateSecret: jest.fn() };
    const scMgr = { createOrUpdateStorageClass: jest.fn() };

    const strategy = new StaticProvisioningStrategy(secretMgr, scMgr);
    const specNoEndpoint: BucketStorageClassSpec = {
      ...staticSpec,
      volume_info: { type: 'nfs' }, // no endpoint
    };

    await expect(strategy.createOrUpdateStorageClass(specNoEndpoint)).rejects.toThrow(
      /endpoint is required/
    );
    expect(secretMgr.createOrUpdateSecret).not.toHaveBeenCalled();
  });

  it('propagates errors from secret manager', async () => {
    const secretMgr = {
      createOrUpdateSecret: jest.fn().mockRejectedValue(new Error('vault error')),
    };
    const scMgr = { createOrUpdateStorageClass: jest.fn() };

    const strategy = new StaticProvisioningStrategy(secretMgr, scMgr);
    await expect(strategy.createOrUpdateStorageClass(staticSpec)).rejects.toThrow('vault error');
  });

  it('propagates errors from resource manager', async () => {
    const secretMgr = { createOrUpdateSecret: jest.fn().mockResolvedValue('secret') };
    const scMgr = {
      createOrUpdateStorageClass: jest.fn().mockRejectedValue(new Error('k8s error')),
    };

    const strategy = new StaticProvisioningStrategy(secretMgr, scMgr);
    await expect(strategy.createOrUpdateStorageClass(staticSpec)).rejects.toThrow('k8s error');
  });
});

describe('DynamicProvisioningStrategy', () => {
  it('validates StorageClass using the resource manager', async () => {
    const scMgr = { validateStorageClass: jest.fn().mockResolvedValue(mockStorageClass) };
    const strategy = new DynamicProvisioningStrategy(scMgr);

    const result = await strategy.createOrUpdateStorageClass(dynamicSpec);
    expect(scMgr.validateStorageClass).toHaveBeenCalledWith('standard');
    expect(result).toBe(mockStorageClass);
  });

  it('throws when storage_class_name is missing for dynamic provisioning', async () => {
    const scMgr = { validateStorageClass: jest.fn() };
    const strategy = new DynamicProvisioningStrategy(scMgr);

    const specNoSCName: BucketStorageClassSpec = {
      ...dynamicSpec,
      storage_class_name: undefined,
    };

    await expect(strategy.createOrUpdateStorageClass(specNoSCName)).rejects.toThrow(
      /storage_class_name is required/
    );
    expect(scMgr.validateStorageClass).not.toHaveBeenCalled();
  });

  it('propagates errors from validateStorageClass', async () => {
    const scMgr = {
      validateStorageClass: jest.fn().mockRejectedValue(new Error('StorageClass not found')),
    };
    const strategy = new DynamicProvisioningStrategy(scMgr);

    await expect(strategy.createOrUpdateStorageClass(dynamicSpec)).rejects.toThrow(
      'StorageClass not found'
    );
  });

  it('does not create StorageClass for dynamic mode (validates existing)', async () => {
    const scMgr = { validateStorageClass: jest.fn().mockResolvedValue(mockStorageClass) };
    const strategy = new DynamicProvisioningStrategy(scMgr);
    await strategy.createOrUpdateStorageClass(dynamicSpec);
    // Only validateStorageClass is called, no creation
    expect(scMgr.validateStorageClass).toHaveBeenCalledTimes(1);
  });
});
