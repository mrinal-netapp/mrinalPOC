import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';

/**
 * Strategy interface for different provisioning modes
 */
export interface ProvisioningStrategy {
  /**
   * Create or update StorageClass based on provisioning mode
   */
  createOrUpdateStorageClass(spec: BucketStorageClassSpec): Promise<k8s.V1StorageClass>;
}

