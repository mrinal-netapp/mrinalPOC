import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { StorageClassBuilder } from '../builders/StorageClassBuilder';
import { EndpointParser } from '../utils/EndpointParser';
import { KubernetesErrorHandler, ErrorContext } from '../utils/KubernetesErrorHandler';
import { NameGenerator } from '../utils/NameGenerator';

/**
 * Manages Kubernetes StorageClass resources
 */
export class StorageClassResourceManager {
  constructor(
    private storageApi: k8s.StorageV1Api,
    private namespace: string,
    private logLevel: string = 'info'
  ) {}

  /**
   * Validate that a StorageClass exists (for dynamic provisioning)
   */
  async validateStorageClass(storageClassName: string): Promise<k8s.V1StorageClass> {
    const context: ErrorContext = {
      resourceType: 'StorageClassResourceManager',
      resourceName: storageClassName,
      operation: 'validate',
    };

    try {
      const storageClass = await this.storageApi.readStorageClass({ name: storageClassName });
      logger.info(
        `[StorageClassResourceManager] Validated StorageClass exists: ${storageClassName} ` +
        `(provisioner: ${storageClass.provisioner})`
      );
      return storageClass;
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        throw new Error(
          `StorageClass '${storageClassName}' not found. ` +
          `Ensure the StorageClass exists before using dynamic provisioning.`
        );
      }
      KubernetesErrorHandler.logError(context, error, this.logLevel);
      throw KubernetesErrorHandler.createEnhancedError(error, context);
    }
  }

  /**
   * Create or update StorageClass for a bucket
   */
  async createOrUpdateStorageClass(
    spec: BucketStorageClassSpec,
    secretName: string | null
  ): Promise<k8s.V1StorageClass> {
    // Check if StorageClass should be created (only for static provisioning)
    if (!StorageClassBuilder.shouldCreateStorageClass(spec)) {
      // For dynamic provisioning, validate StorageClass exists and return it
      if (!spec.storage_class_name) {
        throw new Error(
          `storage_class_name is required for dynamic provisioning mode. ` +
          `Bucket: ${spec.project_id}/${spec.bucket_name}`
        );
      }
      return await this.validateStorageClass(spec.storage_class_name);
    }

    // Static provisioning: create StorageClass as before
    const scName = NameGenerator.getStorageClassName(
      spec.project_id,
      spec.bucket_name
    );
    const volumeType = spec.volume_info.type.toLowerCase();
    const endpointInfo = EndpointParser.parseEndpoint(
      volumeType,
      spec.volume_info.endpoint || ''
    );

    const storageClass = StorageClassBuilder.buildStorageClassSpec(
      scName,
      spec,
      endpointInfo,
      secretName,
      this.namespace
    );

    const context: ErrorContext = {
      resourceType: 'StorageClassResourceManager',
      resourceName: scName,
      operation: 'create/update',
    };

    try {
      // Try to get existing StorageClass
      const existingSC = await this.storageApi.readStorageClass({ name: scName });

      // Kubernetes doesn't allow updating parameters on existing StorageClass
      // Check if parameters differ - if so, skip update entirely
      const existingParams = existingSC.parameters || {};
      const newParams = storageClass.parameters || {};

      const paramsMatch =
        JSON.stringify(existingParams) === JSON.stringify(newParams);
      const provisionerMatch = existingSC.provisioner === storageClass.provisioner;

      // If parameters or provisioner differ, we cannot update them (they are immutable)
      if (!paramsMatch || !provisionerMatch) {
        logger.warn(
          `[StorageClassResourceManager] StorageClass ${scName} exists with different immutable fields. ` +
          `Kubernetes doesn't allow updating parameters or provisioner. Skipping update. ` +
          `Existing params: ${JSON.stringify(existingParams)}, Requested: ${JSON.stringify(newParams)}. ` +
          `Existing provisioner: ${existingSC.provisioner}, Requested: ${storageClass.provisioner}`
        );
        // Return existing StorageClass since we cannot update immutable fields
        return existingSC;
      }

      // Parameters and provisioner match - safe to update mutable fields
      // Only update mutable fields: metadata (labels, annotations), allowVolumeExpansion, 
      // volumeBindingMode, reclaimPolicy
      // Preserve resourceVersion for update operation
      const updatedSC: k8s.V1StorageClass = {
        ...existingSC,
        metadata: {
          ...existingSC.metadata,
          resourceVersion: existingSC.metadata?.resourceVersion,
          labels: storageClass.metadata?.labels || existingSC.metadata?.labels,
          annotations: storageClass.metadata?.annotations || existingSC.metadata?.annotations,
        },
        allowVolumeExpansion: storageClass.allowVolumeExpansion ?? existingSC.allowVolumeExpansion,
        volumeBindingMode: storageClass.volumeBindingMode || existingSC.volumeBindingMode,
        reclaimPolicy: storageClass.reclaimPolicy || existingSC.reclaimPolicy,
      };

      // Update StorageClass with only mutable fields
      await this.storageApi.replaceStorageClass({ name: scName, body: updatedSC });

      logger.info(
        `[StorageClassResourceManager] Updated StorageClass: ${scName} ` +
        `for bucket: ${spec.project_id}/${spec.bucket_name} ` +
        `(updated mutable fields only, preserved immutable parameters and provisioner)`
      );
      
      return updatedSC;
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        // StorageClass doesn't exist - create it
        // This is expected when creating a new StorageClass, so don't log as error
        if (this.logLevel === 'debug') {
          logger.debug(
            `[StorageClassResourceManager] StorageClass ${scName} not found, creating new one`
          );
        }
        
        try {
          const createdSC = await this.storageApi.createStorageClass({ body: storageClass });
          logger.info(
            `[StorageClassResourceManager] Created StorageClass: ${scName} ` +
            `for bucket: ${spec.project_id}/${spec.bucket_name} ` +
            `(static provisioning, endpoint: ${spec.volume_info.endpoint})`
          );
          return createdSC;
        } catch (createError: any) {
          // Only log create errors, not the expected 404 from read
          KubernetesErrorHandler.logError(context, createError, this.logLevel);
          throw KubernetesErrorHandler.createEnhancedError(createError, context);
        }
      } else {
        // Unexpected error (not 404) - log and rethrow
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }
  }

  /**
   * Delete StorageClass
   */
  async deleteStorageClass(
    projectId: string,
    bucketName: string
  ): Promise<void> {
    const scName = NameGenerator.getStorageClassName(projectId, bucketName);
    const context: ErrorContext = {
      resourceType: 'StorageClassResourceManager',
      resourceName: scName,
      operation: 'delete',
    };

    try {
      await this.storageApi.deleteStorageClass({ name: scName });
      logger.info(
        `[StorageClassResourceManager] Deleted StorageClass: ${scName} for bucket: ${bucketName}`
      );
    } catch (error: any) {
      if (!KubernetesErrorHandler.isNotFoundError(error)) {
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }
  }

  /**
   * List all StorageClasses created by storage-manager
   */
  async listStorageClasses(): Promise<k8s.V1StorageClass[]> {
    try {
      const result = await this.storageApi.listStorageClass({
        labelSelector: 'agentstudio.io/managed-by=storage-manager'
      });
      return result.items || [];
    } catch (error: any) {
      logger.error('[StorageClassResourceManager] Failed to list StorageClasses:', error);
      return [];
    }
  }

  /**
   * Get StorageClass name from namespace and bucket
   */
  getStorageClassName(projectId: string, bucketName: string): string {
    return NameGenerator.getStorageClassName(projectId, bucketName);
  }
}

