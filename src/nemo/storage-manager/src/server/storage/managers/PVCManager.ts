import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { PVCBuilder } from '../builders/PVCBuilder';
import { KubernetesErrorHandler, ErrorContext } from '../utils/KubernetesErrorHandler';
import { NameGenerator } from '../utils/NameGenerator';
import { AccessModeResolver } from '../utils/AccessModeResolver';
import { EndpointParser, NfsEndpointInfo, SmbEndpointInfo } from '../utils/EndpointParser';

export type CreatePVCallback = (
  storageClass: k8s.V1StorageClass,
  spec: BucketStorageClassSpec,
  pvcName: string,
  pvOpts?: { pvNameOverride?: string; claimRef?: k8s.V1ObjectReference }
) => Promise<string | undefined>;

/**
 * Manages Kubernetes PersistentVolumeClaim resources
 */
export class PVCManager {
  constructor(
    private coreApi: k8s.CoreV1Api,
    private storageApi: k8s.StorageV1Api,
    private namespace: string,
    private defaultStorageSize: string,
    private logLevel: string = 'info'
  ) {}

  /**
   * Verify StorageClass exists and validate access modes before creating PVC
   */
  private async verifyStorageClass(
    storageClassName: string,
    requestedAccessModes?: string[]
  ): Promise<k8s.V1StorageClass> {
    try {
      const storageClass = await this.storageApi.readStorageClass({ name: storageClassName });
      
      // Validate access modes if requested
      if (requestedAccessModes && requestedAccessModes.length > 0) {
        const validation = AccessModeResolver.validateAccessModes(storageClass, requestedAccessModes);
        if (!validation.valid) {
          throw new Error(
            `StorageClass '${storageClassName}' (provisioner: ${storageClass.provisioner}) ` +
            `does not support requested access modes: ${validation.unsupported.join(', ')}. ` +
            `Supported access modes: ${validation.supported.join(', ')}. ` +
            `Consider using a different StorageClass or adjusting access modes.`
          );
        }
      }
      
      return storageClass;
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        throw new Error(
          `StorageClass ${storageClassName} does not exist. Cannot create PVC without StorageClass.`
        );
      }
      // Re-throw validation errors as-is
      if (error.message && error.message.includes('does not support requested access modes')) {
        throw error;
      }
      throw new Error(
        `Failed to verify StorageClass ${storageClassName}: ${error.message}`
      );
    }
  }

  /**
   * Check if PVC annotations need update
   */
  private annotationsNeedUpdate(
    existing: Record<string, string> | undefined,
    desired: Record<string, string>
  ): boolean {
    return JSON.stringify(existing || {}) !== JSON.stringify(desired);
  }

  /**
   * Update PVC annotations
   */
  private async updatePVCAnnotations(
    pvcName: string,
    existingPVC: k8s.V1PersistentVolumeClaim,
    newAnnotations: Record<string, string>
  ): Promise<void> {
    const updatePvc = {
      ...existingPVC,
      metadata: {
        ...existingPVC.metadata,
        annotations: newAnnotations,
      },
    };

    await this.coreApi.replaceNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace: this.namespace,
      body: updatePvc
    });
    logger.info(`[PVCManager] Updated PVC annotations: ${pvcName}`);
  }

  /**
   * Bind PVC to PV
   */
  async bindPVCToPV(
    pvcName: string,
    pvName: string
  ): Promise<void> {
    try {
      const existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: this.namespace
      });

      // Create a copy of the existing PVC and update only the volumeName
      // Preserve the existing name, metadata, and spec
      const pvc: k8s.V1PersistentVolumeClaim = {
        ...existing,
        metadata: {
          ...existing.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        },
        spec: {
          ...existing.spec,
          volumeName: pvName,
        },
      };

      await this.coreApi.replaceNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: this.namespace,
        body: pvc
      });

      logger.info(
        `[PVCManager] Bound PVC ${pvcName} to PV ${pvName}`
      );
    } catch (error: any) {
      const context: ErrorContext = {
        resourceType: 'PVCManager',
        resourceName: pvcName,
        operation: 'bind',
        namespace: this.namespace,
      };
      KubernetesErrorHandler.logError(context, error, this.logLevel);
      throw KubernetesErrorHandler.createEnhancedError(error, context);
    }
  }

  /**
   * Handle existing PVC that is already bound
   */
  private async handleBoundPVC(
    pvcName: string,
    existingPVC: k8s.V1PersistentVolumeClaim,
    desiredAnnotations: Record<string, string>,
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec | undefined,
    createPVCallback?: CreatePVCallback
  ): Promise<string> {
    const existingVolumeName = existingPVC.spec?.volumeName;
    const scName = storageClass.metadata?.name || '';

    logger.debug(
      `[PVCManager] PVC ${pvcName} already bound to PV ${existingVolumeName}, ` +
      `evaluating endpoint drift`
    );

    let endpointDrift = false;
    if (
      spec?.volume_info?.endpoint &&
      createPVCallback &&
      existingVolumeName &&
      (spec.provisioning_mode || 'static') === 'static'
    ) {
      try {
        const pv = await this.coreApi.readPersistentVolume({ name: existingVolumeName });
        const vt = spec.volume_info.type.toLowerCase();
        const want = EndpointParser.parseEndpoint(vt, spec.volume_info.endpoint);
        if (vt === 'nfs') {
          const w = want as NfsEndpointInfo;
          const ps = pv.spec?.nfs?.server;
          const pp = pv.spec?.nfs?.path || '/';
          const share = w.share || '/';
          if (w.server !== ps || share !== pp) {
            endpointDrift = true;
          }
        } else if (vt === 'cifs' || vt === 'smb') {
          const w = want as SmbEndpointInfo;
          const src = pv.spec?.csi?.volumeAttributes?.source;
          if (w.source !== src) {
            endpointDrift = true;
          }
        }
      } catch (e: any) {
        logger.warn(
          `[PVCManager] Drift check skipped (could not read PV ${existingVolumeName}): ${e.message}`
        );
      }
    }

    if (endpointDrift && createPVCallback && spec) {
      const inUse = await this.isPVCInUse(pvcName);
      if (inUse) {
        logger.warn(
          `[PVCManager] Endpoint drift detected for ${pvcName} (StorageClass ${scName}) ` +
          `but PVC is in use — repair_pending_pod_restart. Old PV kept.`
        );
      } else {
        const oldPvName = existingVolumeName as string;
        logger.info(
          `[PVCManager] Endpoint drift detected for ${pvcName} ${scName}: old=${oldPvName}, replacing PV`
        );
        try {
          await this.coreApi.deletePersistentVolume({ name: oldPvName });
        } catch (e: any) {
          logger.warn(`[PVCManager] Delete old PV ${oldPvName}: ${e.message}`);
        }

        const fresh = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace: this.namespace!,
        });
        const cleared: k8s.V1PersistentVolumeClaim = {
          ...fresh,
          metadata: {
            ...fresh.metadata,
            resourceVersion: fresh.metadata?.resourceVersion,
          },
          spec: {
            ...fresh.spec,
            volumeName: undefined,
          },
        };
        try {
          await this.coreApi.replaceNamespacedPersistentVolumeClaim({
            name: pvcName,
            namespace: this.namespace!,
            body: cleared,
          });
        } catch (e: any) {
          logger.warn(`[PVCManager] Could not clear PVC volumeName: ${e.message}`);
        }

        const pvcUid = fresh.metadata?.uid;
        const newPvName = NameGenerator.getPVNameWithGeneration(scName, pvcName);
        const claimRef: k8s.V1ObjectReference = {
          apiVersion: 'v1',
          kind: 'PersistentVolumeClaim',
          name: fresh.metadata?.name || pvcName,
          namespace: fresh.metadata?.namespace || this.namespace,
          uid: pvcUid,
        };

        return await this.handlePendingPVC(pvcName, storageClass, spec, createPVCallback, {
          pvNameOverride: newPvName,
          claimRef,
        });
      }
    }

    // Still update annotations if needed
    if (this.annotationsNeedUpdate(existingPVC.metadata?.annotations, desiredAnnotations)) {
      await this.updatePVCAnnotations(pvcName, existingPVC, desiredAnnotations);
    } else {
      logger.debug(`[PVCManager] PVC ${pvcName} already exists and is up to date`);
    }

    return pvcName;
  }

  /**
   * Handle pending PVC by creating PV on-demand
   */
  private async handlePendingPVC(
    pvcName: string,
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec,
    createPVCallback: CreatePVCallback,
    pvOpts?: { pvNameOverride?: string; claimRef?: k8s.V1ObjectReference }
  ): Promise<string> {
    const scName = storageClass.metadata?.name!;
    logger.info(
      `[PVCManager] PVC ${pvcName} is pending, creating PV on-demand for StorageClass: ${scName}`
    );

    const pvName = await createPVCallback(storageClass, spec, pvcName, pvOpts);
    if (!pvName) {
      throw new Error(`Failed to create PV for PVC ${pvcName}`);
    }
    await this.bindPVCToPV(pvcName, pvName);

    logger.info(
      `[PVCManager] Created PV ${pvName} on-demand and bound to PVC: ${pvcName}`
    );

    return pvcName;
  }

  /**
   * Check if StorageClass uses dynamic provisioning
   */
  private isDynamicProvisioning(
    storageClass: k8s.V1StorageClass,
    spec?: BucketStorageClassSpec
  ): boolean {
    if (spec?.provisioning_mode === 'dynamic') {
      return true;
    }
    return storageClass.provisioner !== 'kubernetes.io/no-provisioner';
  }

  /**
   * Create or update PVC for a StorageClass
   * For static provisioning, creates PVs on-demand when PVC is pending
   * For dynamic provisioning, lets Kubernetes provision PV automatically
   */
  async createOrUpdatePVC(
    storageClass: k8s.V1StorageClass,
    bucketName: string,
    spec: BucketStorageClassSpec | undefined,
    createPVCallback?: CreatePVCallback
  ): Promise<string> {
    const scName = storageClass.metadata?.name;
    if (!scName) {
      throw new Error('StorageClass name is missing');
    }

    // Verify StorageClass exists and validate access modes
    const storageClassForValidation = await this.verifyStorageClass(
      scName,
      spec?.access_modes
    );
    
    // Log access mode information for debugging
    const resolvedModes = AccessModeResolver.resolveAccessModes(
      storageClassForValidation,
      spec?.access_modes
    );
    const supportedModes = AccessModeResolver.getSupportedAccessModes(storageClassForValidation);
    
    logger.info(
      `[PVCManager] Creating PVC for StorageClass: ${scName} ` +
      `(provisioner: ${storageClassForValidation.provisioner}, ` +
      `supported modes: ${supportedModes.join(', ')}, ` +
      `using modes: ${resolvedModes.join(', ')})`
    );

    // Validate namespace
    if (!this.namespace) {
      const pvcName = NameGenerator.getPVCName(scName, bucketName);
      throw new Error(
        `Namespace is not set. Cannot create PVC ${pvcName} without namespace.`
      );
    }

    const isDynamicProvisioning = this.isDynamicProvisioning(storageClass, spec);

    // For dynamic provisioning, skip PV creation callback
    if (isDynamicProvisioning && createPVCallback) {
      logger.info(
        `[PVCManager] Dynamic provisioning detected (provisioner: ${storageClass.provisioner}), ` +
        `skipping PV creation callback. Kubernetes will provision volume automatically.`
      );
      createPVCallback = undefined;
    }

    const pvcName = NameGenerator.getPVCName(scName, bucketName);
    const pvcSpec = PVCBuilder.buildPVCSpec(
      storageClass,
      bucketName,
      this.defaultStorageSize,
      this.namespace,
      spec // Pass spec for storage size override
    );
    const desiredAnnotations = pvcSpec.metadata!.annotations!;

    const context: ErrorContext = {
      resourceType: 'PVCManager',
      resourceName: pvcName,
      operation: 'create/update',
      namespace: this.namespace,
    };

    try {
      // Try to get existing PVC
      const existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: this.namespace
      });

      // PVC exists, verify it's using the correct StorageClass
      const existingSC = existing.spec?.storageClassName;
      if (existingSC !== scName) {
        logger.warn(
          `[PVCManager] PVC ${pvcName} exists but uses StorageClass ${existingSC}, ` +
          `expected ${scName}. This may cause issues.`
        );
      }

      const existingVolumeName = existing.spec?.volumeName;
      const pvcPhase = existing.status?.phase;

      // If PVC is already bound to a PV, don't change it
      if (existingVolumeName) {
        return await this.handleBoundPVC(
          pvcName,
          existing,
          desiredAnnotations,
          storageClass,
          spec,
          createPVCallback
        );
      }

      // PVC exists but not bound - check if it's pending
      if (pvcPhase === 'Pending' && spec && createPVCallback) {
        // Only create PV if callback is provided (static provisioning)
        return await this.handlePendingPVC(
          pvcName,
          storageClass,
          spec,
          createPVCallback
        );
      } else if (pvcPhase === 'Pending' && isDynamicProvisioning) {
        logger.info(
          `[PVCManager] PVC ${pvcName} is pending for dynamic provisioning. ` +
          `Waiting for Kubernetes provisioner to create PV automatically.`
        );
        // Return PVC name, Kubernetes will handle provisioning
        return pvcName;
      }

      // PVC exists but not bound and not pending - update annotations if needed
      if (this.annotationsNeedUpdate(existing.metadata?.annotations, desiredAnnotations)) {
        pvcSpec.metadata!.resourceVersion = existing.metadata?.resourceVersion;
        await this.coreApi.replaceNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace: this.namespace,
          body: pvcSpec
        });
        logger.info(`[PVCManager] Updated PVC annotations: ${pvcName}`);
      } else {
        logger.debug(`[PVCManager] PVC ${pvcName} already exists and is up to date`);
      }

      return pvcName;
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        // Create new PVC
        return await this.createNewPVC(
          pvcName,
          pvcSpec,
          storageClass,
          bucketName,
          scName,
          spec,
          createPVCallback || (async () => undefined),
          context
        );
      } else {
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }
  }

  /**
   * Create new PVC and handle PV binding if needed
   */
  private async createNewPVC(
    pvcName: string,
    pvcSpec: k8s.V1PersistentVolumeClaim,
    storageClass: k8s.V1StorageClass,
    bucketName: string,
    scName: string,
    spec: BucketStorageClassSpec | undefined,
    createPVCallback: CreatePVCallback,
    context: ErrorContext
  ): Promise<string> {
    const isDynamicProvisioning = this.isDynamicProvisioning(storageClass, spec);
    const storageSize = spec?.storage_size || this.defaultStorageSize;

    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim({
        namespace: this.namespace,
        body: pvcSpec
      });
      logger.info(
        `[PVCManager] Created PVC: ${pvcName} for StorageClass: ${scName} ` +
        `(bucket: ${bucketName}, size: ${storageSize}, ` +
        `${isDynamicProvisioning ? 'dynamic provisioning - Kubernetes will create PV automatically' : 'will create PV on-demand when pending'})`
      );

      // For dynamic provisioning, skip PV creation - Kubernetes will handle it
      if (isDynamicProvisioning) {
        return pvcName;
      }

      // Check if PVC is pending and create PV on-demand (static provisioning only)
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for PVC status update

      try {
        const createdPVC = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace: this.namespace
        });
        const pvcPhase = createdPVC.status?.phase;

        if (pvcPhase === 'Pending' && spec && createPVCallback) {
          logger.info(
            `[PVCManager] PVC ${pvcName} is pending, creating PV on-demand for StorageClass: ${scName}`
          );
          const pvName = await createPVCallback(storageClass, spec, pvcName);
          if (!pvName) {
            throw new Error(`Failed to create PV for PVC ${pvcName}`);
          }
          await this.bindPVCToPV(pvcName, pvName);
          logger.info(
            `[PVCManager] Created PV ${pvName} on-demand and bound to PVC: ${pvcName}`
          );
        } else if (pvcPhase === 'Bound') {
          logger.info(
            `[PVCManager] PVC ${pvcName} was bound automatically (likely by existing PV)`
          );
        }
      } catch (checkError: any) {
        logger.warn(
          `[PVCManager] Could not check PVC status after creation: ${checkError.message}. ` +
          `PVC was created but PV binding may need to be retried on next sync cycle.`
        );
      }

      return pvcName;
    } catch (createError: any) {
      if (KubernetesErrorHandler.isConflictError(createError)) {
        // PVC was created concurrently, read it
        logger.debug(`[PVCManager] PVC ${pvcName} was created concurrently`);
        const existing = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name: pvcName,
          namespace: this.namespace
        });
        return existing.metadata?.name || pvcName;
      }

      KubernetesErrorHandler.logError(context, createError, this.logLevel);
      throw KubernetesErrorHandler.createEnhancedError(createError, context);
    }
  }

  /**
   * Check if PVC is still in use by any pods
   */
  async isPVCInUse(pvcName: string): Promise<boolean> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: this.namespace
      });
      for (const pod of pods.items || []) {
        const volumes = pod.spec?.volumes || [];
        for (const volume of volumes) {
          if (volume.persistentVolumeClaim?.claimName === pvcName) {
            // Check if pod is still running
            const phase = pod.status?.phase;
            if (phase === 'Running' || phase === 'Pending') {
              // Check if pod is terminating - if so, it's safe to proceed
              if (pod.metadata?.deletionTimestamp) {
                logger.debug(
                  `[PVCManager] Pod ${pod.metadata.name} using PVC ${pvcName} is terminating, will be unmounted soon`
                );
                continue; // Don't count terminating pods as blocking
              }
              return true;
            }
          }
        }
      }
      return false;
    } catch (error: any) {
      logger.warn(`[PVCManager] Failed to check if PVC ${pvcName} is in use: ${error.message}`);
      // Assume it's in use if we can't check (safer to wait)
      return true;
    }
  }

  /**
   * Wait for PVC to be unmounted from all pods
   * @param pvcName Name of the PVC
   * @param maxWaitMs Maximum time to wait in milliseconds (default: 60 seconds)
   * @param checkIntervalMs Interval between checks in milliseconds (default: 2 seconds)
   */
  async waitForPVCUnmount(
    pvcName: string,
    maxWaitMs: number = 60000,
    checkIntervalMs: number = 2000
  ): Promise<void> {
    const startTime = Date.now();
    let lastLogTime = 0;
    const logInterval = 10000; // Log every 10 seconds
    
    while (Date.now() - startTime < maxWaitMs) {
      const inUse = await this.isPVCInUse(pvcName);
      if (!inUse) {
        logger.info(`[PVCManager] PVC ${pvcName} is no longer in use by any pods`);
        return;
      }
      
      const elapsed = Date.now() - startTime;
      // Log periodically to show progress
      if (elapsed - lastLogTime >= logInterval) {
        logger.info(
          `[PVCManager] Waiting for PVC ${pvcName} to be unmounted from pods... ` +
          `(${Math.round(elapsed / 1000)}s elapsed, max wait: ${maxWaitMs / 1000}s)`
        );
        lastLogTime = elapsed;
      }
      
      await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
    }
    
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    logger.warn(
      `[PVCManager] Timeout (${elapsedSeconds}s) waiting for PVC ${pvcName} to be unmounted. ` +
      `Proceeding with deletion anyway. If deletion fails, pods using this PVC may need to be terminated manually.`
    );
  }

  /**
   * Delete PVC with retry logic
   */
  async deletePVC(pvcName: string, waitForUnmount: boolean = true): Promise<string | undefined> {
    const context: ErrorContext = {
      resourceType: 'PVCManager',
      resourceName: pvcName,
      operation: 'delete',
      namespace: this.namespace,
    };

    try {
      // Get PVC to find bound PV before deleting
      const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: this.namespace
      });
      const boundPVName = pvc.spec?.volumeName;

      // Wait for PVC to be unmounted if requested
      if (waitForUnmount) {
        await this.waitForPVCUnmount(pvcName);
      }

      // Attempt deletion with retry
      const maxRetries = 3;
      let lastError: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.coreApi.deleteNamespacedPersistentVolumeClaim({
            name: pvcName,
            namespace: this.namespace
          });
          logger.info(`[PVCManager] Deleted PVC: ${pvcName}`);
          return boundPVName;
        } catch (error: any) {
          lastError = error;
          
          // If PVC is not found, it's already deleted
          if (KubernetesErrorHandler.isNotFoundError(error)) {
            logger.debug(`[PVCManager] PVC ${pvcName} not found (may have been deleted already)`);
            return boundPVName;
          }

          // Check if error is due to PVC still being in use
          const errorMessage = error.body?.message || error.message || '';
          if (errorMessage.includes('in use') || errorMessage.includes('bound to') || 
              errorMessage.includes('still attached') || errorMessage.includes('still mounted')) {
            if (attempt < maxRetries) {
              const waitTime = 15000; // Wait 15s between retries for deployment rollout
              logger.info(
                `[PVCManager] PVC ${pvcName} still in use, waiting ${waitTime/1000}s before retry ` +
                `(attempt ${attempt}/${maxRetries})...`
              );
              await this.waitForPVCUnmount(pvcName, waitTime, 2000);
              continue;
            } else {
              // After max retries, log warning but don't throw - let Kubernetes handle it
              logger.warn(
                `[PVCManager] PVC ${pvcName} still in use after ${maxRetries} attempts. ` +
                `PVC will remain and may be cleaned up on next reconciliation cycle or when pods terminate.`
              );
              // Return bound PV name even if deletion failed - next cycle will retry
              return boundPVName;
            }
          }

          // For other errors, throw immediately
          throw error;
        }
      }

      // Should not reach here, but handle it just in case
      throw lastError || new Error(`Failed to delete PVC ${pvcName} after ${maxRetries} attempts`);
    } catch (error: any) {
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        // PVC already deleted, return undefined for bound PV
        return undefined;
      }
      
      KubernetesErrorHandler.logError(context, error, this.logLevel);
      throw KubernetesErrorHandler.createEnhancedError(error, context);
    }
  }

  /**
   * Get PVC name from StorageClass and bucket name
   */
  getPVCName(storageClassName: string, bucketName: string): string {
    return NameGenerator.getPVCName(storageClassName, bucketName);
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
    const pvcMap = new Map<string, {
      pvc: k8s.V1PersistentVolumeClaim;
      status: 'bound' | 'pending' | 'lost' | 'failed' | 'unknown';
      statusMessage: string;
    }>();

    try {
      // List all PVCs in the namespace
      const response = await this.coreApi.listNamespacedPersistentVolumeClaim({
        namespace: this.namespace
      });
      const allPVCs = response.items || [];
      
      if (this.logLevel === 'debug') {
        logger.debug(`[PVCManager] Found ${allPVCs.length} total PVC(s) in namespace ${this.namespace}`);
      }

      const managedPVCs = allPVCs.filter(
        (pvc: k8s.V1PersistentVolumeClaim) => pvc.metadata?.labels?.['agentstudio.io/managed-by'] === 'storage-manager'
      );

      if (this.logLevel === 'debug') {
        logger.debug(`[PVCManager] Found ${managedPVCs.length} storage-manager PVC(s)`);
      }

      for (const pvc of managedPVCs) {
        const bucketName = pvc.metadata?.labels?.['agentstudio.io/bucket-name'];
        let projectId = pvc.metadata?.labels?.['agentstudio.io/project-id'];
        const pvcName = pvc.metadata?.name || 'unknown';

        // Fallback: Try to get project_id from annotations if missing from labels
        // This handles PVCs created before the fix for dynamic provisioning
        if (!projectId) {
          projectId = pvc.metadata?.annotations?.['agentstudio.io/project-id'];
          if (projectId) {
            logger.info(
              `[PVCManager] PVC ${pvcName} missing project-id in labels, ` +
              `using annotation value: ${projectId}`
            );
          }
        }

        // Skip if we still can't determine bucket key
        if (!bucketName || !projectId) {
          logger.warn(
            `[PVCManager] PVC ${pvcName} is missing required labels/annotations: ` +
            `bucket-name=${bucketName || 'MISSING'}, ` +
            `project-id=${projectId || 'MISSING'}. ` +
            `Skipping this PVC in health reports.`
          );
          continue;
        }

        const bucketKey = `${projectId}:${bucketName}`;
        const phase = pvc.status?.phase?.toLowerCase() || 'unknown';
        
        let status: 'bound' | 'pending' | 'lost' | 'failed' | 'unknown';
        let statusMessage: string;

        switch (phase) {
          case 'bound':
            status = 'bound';
            statusMessage = `PVC bound to PV ${pvc.spec?.volumeName || 'unknown'}`;
            break;
          case 'pending':
            status = 'pending';
            // Check if it's dynamic provisioning (waiting for provisioner)
            const storageClassName = pvc.spec?.storageClassName;
            if (storageClassName) {
              try {
                const sc = await this.storageApi.readStorageClass({ name: storageClassName });
                const isDynamic = sc.provisioner !== 'kubernetes.io/no-provisioner';
                statusMessage = isDynamic
                  ? 'PVC pending - waiting for dynamic provisioner'
                  : 'PVC pending - waiting for PV';
              } catch {
                statusMessage = 'PVC pending';
              }
            } else {
              statusMessage = 'PVC pending';
            }
            break;
          case 'lost':
            status = 'lost';
            statusMessage = 'PVC lost - volume is no longer available';
            break;
          case 'failed':
            status = 'failed';
            statusMessage = 'PVC failed - check events for details';
            break;
          default:
            status = 'unknown';
            statusMessage = `PVC phase: ${phase}`;
        }

        pvcMap.set(bucketKey, { pvc, status, statusMessage });
        
        if (this.logLevel === 'debug') {
          logger.debug(
            `[PVCManager] Mapped bucket ${bucketKey} to PVC ${pvc.metadata?.name} ` +
            `(status: ${status}, phase: ${pvc.status?.phase})`
          );
        }
      }
      
      if (this.logLevel === 'debug') {
        logger.debug(`[PVCManager] Successfully mapped ${pvcMap.size} bucket(s) to PVC status`);
      }
    } catch (error: any) {
      logger.error(`[PVCManager] Failed to list storage-manager PVCs: ${error.message}`);
      if (this.logLevel === 'debug' && error.stack) {
        logger.debug(`[PVCManager] Error stack: ${error.stack}`);
      }
      // Return empty map on error
    }

    return pvcMap;
  }
}

