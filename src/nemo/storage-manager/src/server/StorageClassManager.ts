import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';

// Import managers
import { SecretManager } from './storage/managers/SecretManager';
import { StorageClassResourceManager } from './storage/managers/StorageClassResourceManager';
import { PVManager } from './storage/managers/PVManager';
import { PVCManager } from './storage/managers/PVCManager';
import { DeploymentManager } from './storage/managers/DeploymentManager';

// Import utilities
import { NameGenerator } from './storage/utils/NameGenerator';

// Import shared types
import { BucketStorageClassSpec } from './storage/types';

// Import operators
import {
  DeploymentCleanupOperator,
  PVCCleanupOperator,
  PVCleanupOperator,
  StorageClassCleanupOperator,
  SecretCleanupOperator,
  DeletionContext
} from './storage/operators';

// Import strategies
import {
  ProvisioningStrategy,
  StaticProvisioningStrategy,
  DynamicProvisioningStrategy
} from './storage/strategies';

// Import factories
import { KubernetesClientFactory } from './storage/factories/KubernetesClientFactory';

export interface StorageClassManagerConfig {
  kubeconfigPath?: string;
  logLevel?: string;
}

// Re-export for backward compatibility
export type { BucketStorageClassSpec };

/**
 * Main orchestrator for StorageClass and related Kubernetes resources
 * Coordinates between specialized managers for StorageClass, Secret, PV, PVC, and Deployment resources
 * 
 * Refactored to use:
 * - Strategy pattern for provisioning modes (static vs dynamic)
 * - Chain of responsibility pattern for deletion operations
 * - Factory pattern for Kubernetes client initialization
 */
export class StorageClassManager {
  private storageApi: k8s.StorageV1Api;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private namespace: string;
  private defaultStorageSize: string;
  private config: StorageClassManagerConfig;

  // Managers
  private secretManager: SecretManager;
  private storageClassResourceManager: StorageClassResourceManager;
  private pvManager: PVManager;
  private pvcManager: PVCManager;
  private deploymentManager: DeploymentManager;

  // Provisioning strategies
  private staticProvisioningStrategy: ProvisioningStrategy;
  private dynamicProvisioningStrategy: ProvisioningStrategy;

  // Deletion operator chain
  private deletionChain!: DeploymentCleanupOperator;

  constructor(config: StorageClassManagerConfig = {}) {
    this.config = config;
    
    // Initialize Kubernetes clients using factory
    const clients = KubernetesClientFactory.createClients(config.kubeconfigPath);
    this.storageApi = clients.storageApi;
    this.coreApi = clients.coreApi;
    this.appsApi = clients.appsApi;
    this.namespace = clients.namespace;
    
    this.defaultStorageSize = process.env.DEFAULT_STORAGE_SIZE || '10Gi';
    const logLevel = config.logLevel || process.env.LOG_LEVEL || 'info';

    // Initialize managers
    this.secretManager = new SecretManager(
      this.coreApi,
      this.namespace,
      logLevel
    );
    this.storageClassResourceManager = new StorageClassResourceManager(
      this.storageApi,
      this.namespace,
      logLevel
    );
    this.pvManager = new PVManager(
      this.coreApi,
      this.namespace,
      this.defaultStorageSize,
      logLevel
    );
    this.pvcManager = new PVCManager(
      this.coreApi,
      this.storageApi,
      this.namespace,
      this.defaultStorageSize,
      logLevel
    );
    this.deploymentManager = new DeploymentManager(
      this.appsApi,
      this.coreApi,
      this.namespace,
      logLevel
    );

    // Initialize provisioning strategies
    this.staticProvisioningStrategy = new StaticProvisioningStrategy(
      this.secretManager,
      this.storageClassResourceManager
    );
    this.dynamicProvisioningStrategy = new DynamicProvisioningStrategy(
      this.storageClassResourceManager
    );

    // Build deletion operator chain
    this.buildDeletionChain();

    logger.info(
      `[StorageClassManager] Initialized with namespace: ${this.namespace}, ` +
      `default storage size: ${this.defaultStorageSize}, PVs will be created on-demand`
    );
  }

  /**
   * Build the deletion operator chain using chain of responsibility pattern
   * Order: Deployment -> PVC -> PV -> StorageClass -> Secret
   */
  private buildDeletionChain(): void {
    const deploymentOp = new DeploymentCleanupOperator(this.deploymentManager);
    const pvcOp = new PVCCleanupOperator(this.coreApi, this.pvcManager);
    const pvOp = new PVCleanupOperator(this.coreApi, this.pvManager);
    const storageClassOp = new StorageClassCleanupOperator(
      this.storageClassResourceManager,
      this.pvManager
    );
    const secretOp = new SecretCleanupOperator(this.secretManager);

    // Chain: Deployment -> PVC -> PV -> StorageClass -> Secret
    deploymentOp
      .setNext(pvcOp)
      .setNext(pvOp)
      .setNext(storageClassOp)
      .setNext(secretOp);

    this.deletionChain = deploymentOp;
  }

  /**
   * Create or update StorageClass for a bucket
   * Uses strategy pattern to handle static vs dynamic provisioning
   */
  async createOrUpdateStorageClass(
    spec: BucketStorageClassSpec
  ): Promise<k8s.V1StorageClass> {
    const strategy = this.getProvisioningStrategy(spec);
    return await strategy.createOrUpdateStorageClass(spec);
  }

  /**
   * Get the appropriate provisioning strategy based on spec
   */
  private getProvisioningStrategy(spec: BucketStorageClassSpec): ProvisioningStrategy {
    return spec.provisioning_mode === 'dynamic'
      ? this.dynamicProvisioningStrategy
      : this.staticProvisioningStrategy;
  }

  /**
   * Create PV on-demand for a pending PVC
   * Creates a single PV that can be bound to the specified PVC
   */
  async createPVOnDemand(
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec,
    pvcName: string,
    pvOptions?: {
      pvNameOverride?: string;
      claimRef?: k8s.V1ObjectReference;
    }
  ): Promise<string> {
    // Get secret name for SMB volumes
    const secretName = await this.secretManager.createOrUpdateSecret(spec);

    // Create PV with secret
    return await this.pvManager.createPVOnDemandWithSecret(
      storageClass,
      spec,
      pvcName,
      secretName,
      pvOptions
    );
  }

  /**
   * DEPRECATED: This method is no longer used. PVs are now created on-demand.
   * Kept for backward compatibility but does nothing.
   */
  async ensurePVPool(
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec
  ): Promise<void> {
    // No-op: PVs are now created on-demand when PVCs are pending
    logger.debug(
      `[StorageClassManager] ensurePVPool called but PVs are now created on-demand`
    );
  }

  /**
   * List PVs for a StorageClass
   */
  async listPVsForStorageClass(
    storageClassName: string
  ): Promise<k8s.V1PersistentVolume[]> {
    return await this.pvManager.listPVsForStorageClass(storageClassName);
  }

  /**
   * Find an available PV for a StorageClass
   */
  async findAvailablePV(
    storageClassName: string
  ): Promise<k8s.V1PersistentVolume | null> {
    return await this.pvManager.findAvailablePV(storageClassName);
  }

  /**
   * Delete StorageClass for a bucket
   * Uses chain of responsibility pattern to execute deletion operators in sequence
   */
  async deleteStorageClass(
    projectId: string,
    bucketName: string
  ): Promise<void> {
    const scName = this.storageClassResourceManager.getStorageClassName(
      projectId,
      bucketName
    );
    const pvcName = this.pvcManager.getPVCName(scName, bucketName);

    // Create deletion context
    const context: DeletionContext = {
      projectId,
      bucketName,
      storageClassName: scName,
      pvcName,
      namespace: this.namespace
    };

    // Execute deletion chain
    await this.deletionChain.execute(context);
  }

  /**
   * Create or update PVC for a StorageClass
   * For static provisioning, creates PVs on-demand when PVC is pending
   * For dynamic provisioning, lets Kubernetes provision PV automatically
   */
  async createOrUpdatePVC(
    storageClass: k8s.V1StorageClass,
    bucketName: string,
    spec?: BucketStorageClassSpec
  ): Promise<string> {
    const isDynamicProvisioning = 
      spec?.provisioning_mode === 'dynamic' ||
      storageClass.provisioner !== 'kubernetes.io/no-provisioner';

    // Create PV callback only for static provisioning
    const createPVCallback = isDynamicProvisioning
      ? undefined // No PV creation for dynamic provisioning
      : async (
          sc: k8s.V1StorageClass,
          s: BucketStorageClassSpec,
          pvc: string,
          pvOpts?: { pvNameOverride?: string; claimRef?: k8s.V1ObjectReference }
        ) => {
          return await this.createPVOnDemand(sc, s, pvc, pvOpts);
        };

    const pvcName = await this.pvcManager.createOrUpdatePVC(
      storageClass,
      bucketName,
      spec,
      createPVCallback
    );

    // When using VolumeMountSet CR, the controller owns deployment volume updates
    if (!process.env.USE_VOLUME_MOUNT_SET_CR) {
      // After creating PVC, update deployment to mount it
      await this.deploymentManager.updateDeploymentWithPVC(pvcName);
    }

    return pvcName;
  }

  /**
   * List all StorageClasses created by storage-manager
   */
  async listStorageClasses(): Promise<k8s.V1StorageClass[]> {
    return await this.storageClassResourceManager.listStorageClasses();
  }

  /**
   * List all available storage classes in the cluster (for dynamic provisioning)
   * This includes all storage classes, not just the ones created by storage-manager
   */
  async listAllAvailableStorageClasses(): Promise<string[]> {
    try {
      const result = await this.storageApi.listStorageClass({});
      const storageClasses = result.items || [];
      
      // Filter out storage classes that are not suitable for dynamic provisioning
      // Exclude storage classes with no-provisioner (static provisioning only)
      const availableStorageClasses = storageClasses
        .filter((sc: k8s.V1StorageClass) => {
          const provisioner = sc.provisioner || '';
          // Exclude no-provisioner (static provisioning) and empty provisioners
          return provisioner !== '' && provisioner !== 'kubernetes.io/no-provisioner';
        })
        .map((sc: k8s.V1StorageClass) => sc.metadata?.name || '')
        .filter((name: string) => name !== '')
        .sort();
      
      if (this.config.logLevel === 'debug') {
        logger.debug(
          `[StorageClassManager] Found ${availableStorageClasses.length} available storage classes: ` +
          availableStorageClasses.join(', ')
        );
      }
      
      return availableStorageClasses;
    } catch (error: any) {
      logger.error(`[StorageClassManager] Failed to list available storage classes: ${error.message}`);
      return [];
    }
  }

  /**
   * Get StorageClass name for a bucket
   */
  private getStorageClassName(projectId: string, bucketName: string): string {
    return NameGenerator.getStorageClassName(projectId, bucketName);
  }

  /**
   * Get PVC name for a StorageClass and bucket
   */
  private getPVCName(storageClassName: string, bucketName: string): string {
    return NameGenerator.getPVCName(storageClassName, bucketName);
  }

  /**
   * Get all valid PVC names for buckets in the registry
   * Used for deployment reconciliation
   * @param registry Map of bucket keys to bucket configs with full volume_info
   */
  getValidPVCNames(registry: Map<string, { 
    project_id: string; 
    bucket_name: string;
    volume_info?: {
      provisioning_mode?: 'static' | 'dynamic';
      storage_class_name?: string;
    };
  }>): Set<string> {
    const validPVCNames = new Set<string>();
    
    for (const [key, bucket] of registry.entries()) {
      try {
        // Determine the actual StorageClass name based on provisioning mode
        let scName: string;
        const provisioningMode = bucket.volume_info?.provisioning_mode || 'static';
        
        if (provisioningMode === 'dynamic') {
          // For dynamic provisioning, use the user-provided storage_class_name
          if (!bucket.volume_info?.storage_class_name) {
            logger.warn(
              `[StorageClassManager] Dynamic bucket ${key} missing storage_class_name, skipping`
            );
            continue;
          }
          scName = bucket.volume_info.storage_class_name;
        } else {
          // For static provisioning, generate StorageClass name
          scName = this.getStorageClassName(bucket.project_id, bucket.bucket_name);
        }
        
        const pvcName = this.getPVCName(scName, bucket.bucket_name);
        validPVCNames.add(pvcName);
      } catch (error: any) {
        logger.warn(
          `[StorageClassManager] Failed to generate PVC name for bucket ${key}: ${error.message}`
        );
      }
    }
    
    return validPVCNames;
  }

  /**
   * Reconcile deployment: Remove orphaned PVC mounts
   * @param validPVCNames Set of valid PVC names that should be mounted
   * @param newlyCreatedPVCNames Set of PVC names that were just created in this sync cycle (should not be removed)
   */
  async reconcileDeployment(validPVCNames: Set<string>, newlyCreatedPVCNames?: Set<string>): Promise<void> {
    await this.deploymentManager.reconcileDeployment(validPVCNames, newlyCreatedPVCNames);
  }

  /**
   * List all PVCs created by storage-manager (with agentstudio.io/managed-by=storage-manager label)
   * Returns a map of bucketKey (project_id:bucket_name) to PVC status
   */
  async listVersitygwPVCs(): Promise<Map<string, {
    pvc: k8s.V1PersistentVolumeClaim;
    status: 'bound' | 'pending' | 'lost' | 'failed' | 'unknown';
    statusMessage: string;
  }>> {
    return await this.pvcManager.listVersitygwPVCs();
  }

  /**
   * Reconcile orphaned PVCs - clean up PVCs that don't have associated buckets
   * Specifically focuses on dynamic buckets as they may have PVCs allocated without proper tracking
   * @param registry Current bucket registry to check against
   */
  async reconcileOrphanedPVCs(
    registry: Map<string, {
      project_id: string;
      bucket_name: string;
      volume_info?: {
        provisioning_mode?: 'static' | 'dynamic';
        storage_class_name?: string;
      };
    }>
  ): Promise<number> {
    try {
      // Get all PVCs managed by storage-manager
      const pvcMap = await this.listVersitygwPVCs();
      const registryKeys = new Set(registry.keys());
      
      let orphanedCount = 0;
      const orphanedPVCs: Array<{
        pvcName: string;
        projectId: string;
        bucketName: string;
        bucketKey: string;
        isDynamic: boolean;
      }> = [];

      // Find PVCs that don't have corresponding buckets in registry
      for (const [bucketKey, pvcInfo] of pvcMap.entries()) {
        if (!registryKeys.has(bucketKey)) {
          const pvc = pvcInfo.pvc;
          const pvcName = pvc.metadata?.name || 'unknown';

          // Skip PVCs managed by Helm — these are not storage-manager's responsibility
          const managedBy = pvc.metadata?.labels?.['agentstudio.io/managed-by'] ||
                           pvc.metadata?.annotations?.['agentstudio.io/managed-by'] || '';
          if (managedBy === 'helm') {
            logger.info(
              `[PVC Reconciliation] Skipping Helm-managed PVC: ${pvcName} ` +
              `for bucket ${bucketKey} (agentstudio.io/managed-by=helm)`
            );
            continue;
          }

          const bucketName = pvc.metadata?.labels?.['agentstudio.io/bucket-name'] || 
                            pvc.metadata?.annotations?.['agentstudio.io/bucket-name'] || '';
          const projectId = pvc.metadata?.labels?.['agentstudio.io/project-id'] || 
                           pvc.metadata?.annotations?.['agentstudio.io/project-id'] || '';
          
          // Determine if this is a dynamic PVC by checking StorageClass
          const storageClassName = pvc.spec?.storageClassName || '';
          let isDynamic = false;
          if (storageClassName) {
            try {
              isDynamic = await this.isDynamicStorageClass(storageClassName);
            } catch (error: any) {
              // If we can't determine, assume static (safer - won't delete unless sure)
              logger.debug(
                `[PVC Reconciliation] Could not determine if PVC ${pvcName} is dynamic: ${error.message}`
              );
            }
          }

          // Focus on dynamic buckets as requested, but also clean up static ones
          orphanedPVCs.push({
            pvcName,
            projectId,
            bucketName,
            bucketKey,
            isDynamic
          });
        }
      }

      // Sort to prioritize dynamic buckets
      orphanedPVCs.sort((a, b) => {
        if (a.isDynamic && !b.isDynamic) return -1;
        if (!a.isDynamic && b.isDynamic) return 1;
        return 0;
      });

      // Clean up orphaned PVCs
      for (const orphaned of orphanedPVCs) {
        try {
          logger.info(
            `[PVC Reconciliation] Found orphaned PVC: ${orphaned.pvcName} ` +
            `for bucket ${orphaned.bucketKey} ` +
            `(${orphaned.isDynamic ? 'dynamic' : 'static'} provisioning) - cleaning up`
          );

          // Use the deletion chain to properly clean up PVC and associated resources
          // For dynamic buckets, this will attempt to delete the StorageClass (which may not exist)
          // but will still clean up the PVC, Secret, and deployment mounts
          await this.deleteStorageClass(orphaned.projectId, orphaned.bucketName);
          
          orphanedCount++;
          logger.info(
            `[PVC Reconciliation] Successfully cleaned up orphaned PVC: ${orphaned.pvcName} ` +
            `for bucket ${orphaned.bucketKey}`
          );
        } catch (error: any) {
          logger.error(
            `[PVC Reconciliation] Failed to clean up orphaned PVC ${orphaned.pvcName} ` +
            `for bucket ${orphaned.bucketKey}: ${error.message}`
          );
          // Continue with other PVCs even if one fails
        }
      }

      if (orphanedCount > 0) {
        logger.info(
          `[PVC Reconciliation] Cleaned up ${orphanedCount} orphaned PVC(s) ` +
          `that didn't match bucket registry (${orphanedPVCs.filter(p => p.isDynamic).length} dynamic, ` +
          `${orphanedPVCs.filter(p => !p.isDynamic).length} static)`
        );
      } else if (pvcMap.size > 0) {
        logger.info(
          `[PVC Reconciliation] All ${pvcMap.size} PVC(s) match bucket registry`
        );
      }

      return orphanedCount;
    } catch (error: any) {
      logger.error(`[PVC Reconciliation] Failed to reconcile orphaned PVCs:`, error.message);
      // Don't throw - reconciliation failure shouldn't break sync
      return 0;
    }
  }

  /**
   * Check if a StorageClass is for dynamic provisioning
   * Dynamic StorageClasses have a provisioner that is not 'kubernetes.io/no-provisioner'
   */
  private async isDynamicStorageClass(storageClassName: string): Promise<boolean> {
    if (!storageClassName) {
      return false;
    }

    try {
      const storageClass = await this.storageApi.readStorageClass({ name: storageClassName });
      const provisioner = storageClass.provisioner || '';
      // Dynamic provisioning uses actual provisioners, static uses no-provisioner
      return provisioner !== '' && provisioner !== 'kubernetes.io/no-provisioner';
    } catch (error: any) {
      // If we can't read the StorageClass, assume it's not dynamic (safer)
      logger.debug(
        `[StorageClassManager] Could not determine if StorageClass ${storageClassName} is dynamic: ${error.message}`
      );
      return false;
    }
  }
}
