import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { SecretBuilder } from '../builders/SecretBuilder';
import { KubernetesErrorHandler, ErrorContext } from '../utils/KubernetesErrorHandler';
import { NameGenerator } from '../utils/NameGenerator';

/**
 * Manages Kubernetes Secret resources for bucket authentication
 */
export class SecretManager {
  constructor(
    private coreApi: k8s.CoreV1Api,
    private namespace: string,
    private logLevel: string = 'info'
  ) {}

  /**
   * Create or update Secret for bucket auth
   */
  async createOrUpdateSecret(spec: BucketStorageClassSpec): Promise<string | null> {
    const secretSpec = SecretBuilder.buildSecretSpec(spec, this.namespace);
    
    if (!secretSpec) {
      return null; // No auth needed
    }

    const secretName = secretSpec.metadata!.name!;
    const context: ErrorContext = {
      resourceType: 'SecretManager',
      resourceName: secretName,
      operation: 'create/update',
      namespace: this.namespace,
    };

    try {
      // Try to get existing secret
      await this.coreApi.readNamespacedSecret({ name: secretName, namespace: this.namespace });

      // Update existing secret
      await this.coreApi.replaceNamespacedSecret({
        name: secretName,
        namespace: this.namespace,
        body: secretSpec
      });
      logger.info(
        `[SecretManager] Updated Secret: ${secretName} for bucket: ${spec.project_id}/${spec.bucket_name}`
      );
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        // Create new secret
        try {
          await this.coreApi.createNamespacedSecret({ namespace: this.namespace, body: secretSpec });
          logger.info(
            `[SecretManager] Created Secret: ${secretName} for bucket: ${spec.project_id}/${spec.bucket_name}`
          );
        } catch (createError: any) {
          KubernetesErrorHandler.logError(context, createError, this.logLevel);
          throw KubernetesErrorHandler.createEnhancedError(createError, context);
        }
      } else {
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }

    return secretName;
  }

  /**
   * Delete Secret for bucket
   */
  async deleteSecret(projectId: string, bucketName: string): Promise<void> {
    const secretName = NameGenerator.getSecretName(projectId, bucketName);
    const context: ErrorContext = {
      resourceType: 'SecretManager',
      resourceName: secretName,
      operation: 'delete',
      namespace: this.namespace,
    };

    try {
      await this.coreApi.deleteNamespacedSecret({ name: secretName, namespace: this.namespace });
      logger.info(
        `[SecretManager] Deleted Secret: ${secretName} for bucket: ${bucketName}`
      );
    } catch (error: any) {
      if (!KubernetesErrorHandler.isNotFoundError(error)) {
        // Log but don't fail - secret might not exist
        logger.warn(
          `[SecretManager] Failed to delete Secret ${secretName}: ${error.message}`
        );
      }
    }
  }
}

