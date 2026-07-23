import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { StorageClassBuilder } from '../builders/StorageClassBuilder';
import { ProvisioningStrategy } from './ProvisioningStrategy';

/**
 * Strategy for static provisioning (no-provisioner)
 */
export class StaticProvisioningStrategy implements ProvisioningStrategy {
  constructor(
    private secretManager: {
      createOrUpdateSecret(spec: BucketStorageClassSpec): Promise<string | null>;
    },
    private storageClassResourceManager: {
      createOrUpdateStorageClass(
        spec: BucketStorageClassSpec,
        secretName: string | null
      ): Promise<k8s.V1StorageClass>;
    }
  ) {}

  async createOrUpdateStorageClass(
    spec: BucketStorageClassSpec
  ): Promise<k8s.V1StorageClass> {
    StorageClassBuilder.validateStaticProvisioning(spec);
    // Create secret if auth is needed
    const secretName = await this.secretManager.createOrUpdateSecret(spec);
    // Create or update StorageClass
    return await this.storageClassResourceManager.createOrUpdateStorageClass(
      spec,
      secretName
    );
  }
}

