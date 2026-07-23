import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { StorageClassBuilder } from '../builders/StorageClassBuilder';
import { ProvisioningStrategy } from './ProvisioningStrategy';

/**
 * Strategy for dynamic provisioning (uses existing StorageClass)
 */
export class DynamicProvisioningStrategy implements ProvisioningStrategy {
  constructor(
    private storageClassResourceManager: {
      validateStorageClass(storageClassName: string): Promise<k8s.V1StorageClass>;
    }
  ) {}

  async createOrUpdateStorageClass(
    spec: BucketStorageClassSpec
  ): Promise<k8s.V1StorageClass> {
    StorageClassBuilder.validateDynamicProvisioning(spec);
    // Validate StorageClass exists
    return await this.storageClassResourceManager.validateStorageClass(
      spec.storage_class_name!
    );
  }
}

