import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { PVBuilder } from '../builders/PVBuilder';
import { EndpointParser, EndpointInfo } from '../utils/EndpointParser';
import { KubernetesErrorHandler, ErrorContext } from '../utils/KubernetesErrorHandler';
import { NameGenerator } from '../utils/NameGenerator';

/**
 * Manages Kubernetes PersistentVolume resources
 */
export class PVManager {
  constructor(
    private coreApi: k8s.CoreV1Api,
    private namespace: string,
    private defaultStorageSize: string,
    private logLevel: string = 'info'
  ) {}

  /**
   * Create PV on-demand for a pending PVC
   */
  async createPVOnDemand(
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec,
    pvcName: string
  ): Promise<string> {
    const scName = storageClass.metadata?.name;
    if (!scName) {
      throw new Error('StorageClass name is missing');
    }

    const volumeType = spec.volume_info.type.toLowerCase();
    if (!spec.volume_info.endpoint) {
      throw new Error(`volume_info.endpoint is required for static provisioning. Bucket: ${spec.project_id}/${spec.bucket_name}`);
    }
    const endpointInfo = EndpointParser.parseEndpoint(
      volumeType,
      spec.volume_info.endpoint
    );
    const mountOptions =
      storageClass.metadata?.annotations?.['agentstudio.io/mount-options'] || '';

    // Generate PV name
    const pvName = NameGenerator.getPVName(scName, pvcName);

    // Check if PV already exists (race condition)
    let pvExists = false;
    try {
      const existingPV = await this.coreApi.readPersistentVolume({ name: pvName });
      if (
        existingPV.status?.phase === 'Available' &&
        !existingPV.spec?.claimRef
      ) {
        logger.debug(
          `[PVManager] PV ${pvName} already exists and is available, reusing`
        );
        return pvName;
      }
      pvExists = true;
    } catch (error: any) {
      if (!KubernetesErrorHandler.isNotFoundError(error)) {
        throw error;
      }
    }

    if (pvExists) {
      // PV exists but might be bound - try to find another available PV
      const availablePV = await this.findAvailablePV(scName);
      if (availablePV?.metadata?.name) {
        logger.info(
          `[PVManager] Reusing existing available PV: ${availablePV.metadata.name} for PVC: ${pvcName}`
        );
        return availablePV.metadata.name;
      }
      throw new Error(
        `PV ${pvName} already exists but is not available for binding`
      );
    }

    // Build PV spec
    // Note: We need secretName for SMB, but it's not available here
    // This will be handled by the orchestrator
    const pv = PVBuilder.buildPVSpec(
      storageClass,
      spec,
      endpointInfo,
      null, // secretName will be set by orchestrator
      this.namespace,
      this.defaultStorageSize,
      pvcName
    );

    const context: ErrorContext = {
      resourceType: 'PVManager',
      resourceName: pvName,
      operation: 'create',
    };

    try {
      await this.coreApi.createPersistentVolume({ body: pv });
      logger.info(
        `[PVManager] Created PV on-demand: ${pvName} for PVC: ${pvcName} ` +
        `(mountable by s3gateway pods: ReadWriteMany, no nodeAffinity restrictions)`
      );

      // Verify PV was created successfully
      await this.verifyPVCreation(pvName);

      return pvName;
    } catch (error: any) {
      if (KubernetesErrorHandler.isConflictError(error)) {
        // PV already exists (race condition), try to find available PV
        logger.debug(`[PVManager] PV ${pvName} already exists (race condition)`);
        const availablePV = await this.findAvailablePV(scName);
        if (availablePV?.metadata?.name) {
          return availablePV.metadata.name;
        }
        throw new Error(
          `PV ${pvName} already exists but is not available for binding`
        );
      } else {
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }
  }

  /**
   * Create PV with secret name (for SMB volumes)
   */
  async createPVOnDemandWithSecret(
    storageClass: k8s.V1StorageClass,
    spec: BucketStorageClassSpec,
    pvcName: string,
    secretName: string | null,
    pvOptions?: {
      pvNameOverride?: string;
      claimRef?: k8s.V1ObjectReference;
    }
  ): Promise<string> {
    const scName = storageClass.metadata?.name;
    if (!scName) {
      throw new Error('StorageClass name is missing');
    }

    const volumeType = spec.volume_info.type.toLowerCase();
    if (!spec.volume_info.endpoint) {
      throw new Error(`volume_info.endpoint is required for static provisioning. Bucket: ${spec.project_id}/${spec.bucket_name}`);
    }
    const endpointInfo = EndpointParser.parseEndpoint(
      volumeType,
      spec.volume_info.endpoint
    );

    const pv = PVBuilder.buildPVSpec(
      storageClass,
      spec,
      endpointInfo,
      secretName,
      this.namespace,
      this.defaultStorageSize,
      pvcName,
      pvOptions
    );

    const pvName = pv.metadata!.name!;
    const context: ErrorContext = {
      resourceType: 'PVManager',
      resourceName: pvName,
      operation: 'create',
    };

    try {
      await this.coreApi.createPersistentVolume({ body: pv });
      logger.info(
        `[PVManager] Created PV on-demand: ${pvName} for PVC: ${pvcName} ` +
        `(mountable by s3gateway pods: ReadWriteMany, no nodeAffinity restrictions)`
      );

      await this.verifyPVCreation(pvName);
      return pvName;
    } catch (error: any) {
      if (KubernetesErrorHandler.isConflictError(error)) {
        logger.debug(`[PVManager] PV ${pvName} already exists (race condition)`);
        const availablePV = await this.findAvailablePV(scName);
        if (availablePV?.metadata?.name) {
          return availablePV.metadata.name;
        }
        throw new Error(
          `PV ${pvName} already exists but is not available for binding`
        );
      } else {
        KubernetesErrorHandler.logError(context, error, this.logLevel);
        throw KubernetesErrorHandler.createEnhancedError(error, context);
      }
    }
  }

  /**
   * Verify PV was created successfully
   */
  private async verifyPVCreation(pvName: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const createdPV = await this.coreApi.readPersistentVolume({ name: pvName });
      const phase = createdPV.status?.phase;
      const accessModes = createdPV.spec?.accessModes || [];
      const nodeAffinity = createdPV.spec?.nodeAffinity;

      if (
        phase === 'Available' &&
        accessModes.includes('ReadWriteMany') &&
        !nodeAffinity
      ) {
        logger.debug(
          `[PVManager] ✓ PV ${pvName} verified as mountable ` +
          `(phase: ${phase}, accessModes: ${accessModes.join(',')}, no nodeAffinity)`
        );
      } else {
        logger.warn(
          `[PVManager] PV ${pvName} created but may not be immediately mountable: ` +
          `phase=${phase}, accessModes=${accessModes.join(',')}, nodeAffinity=${nodeAffinity ? 'present' : 'none'}`
        );
      }
    } catch (verifyError: any) {
      // Log but don't fail - PV was created, verification is best effort
      logger.debug(
        `[PVManager] Could not verify PV ${pvName} status: ${verifyError.message}`
      );
    }
  }

  /**
   * List PVs for a StorageClass
   */
  async listPVsForStorageClass(
    storageClassName: string
  ): Promise<k8s.V1PersistentVolume[]> {
    try {
      const result = await this.coreApi.listPersistentVolume({
        labelSelector: `agentstudio.io/storage-class=${storageClassName}`
      });
      return result.items || [];
    } catch (error: any) {
      logger.error(
        `[PVManager] Failed to list PVs for StorageClass ${storageClassName}:`,
        error
      );
      return [];
    }
  }

  /**
   * Find an available PV for a StorageClass
   */
  async findAvailablePV(
    storageClassName: string
  ): Promise<k8s.V1PersistentVolume | null> {
    const pvs = await this.listPVsForStorageClass(storageClassName);

    for (const pv of pvs) {
      const phase = pv.status?.phase;
      const claimRef = pv.spec?.claimRef;
      const accessModes = pv.spec?.accessModes || [];
      const hasReadWriteMany = accessModes.includes('ReadWriteMany');
      const pvStorageClass = pv.spec?.storageClassName;
      const nodeAffinity = pv.spec?.nodeAffinity;

      // PV is available and mountable if:
      // 1. Phase is Available
      // 2. Not bound to any claim
      // 3. Has ReadWriteMany access mode
      // 4. StorageClassName matches
      // 5. No nodeAffinity restrictions
      if (
        phase === 'Available' &&
        !claimRef &&
        hasReadWriteMany &&
        pvStorageClass === storageClassName &&
        !nodeAffinity
      ) {
        return pv;
      }

      // Log why PV is not available (for debugging)
      if (phase !== 'Available') {
        logger.debug(
          `[PVManager] PV ${pv.metadata?.name} not available: phase=${phase}`
        );
      } else if (claimRef) {
        logger.debug(
          `[PVManager] PV ${pv.metadata?.name} already bound to claim: ${claimRef.name}`
        );
      } else if (!hasReadWriteMany) {
        logger.debug(
          `[PVManager] PV ${pv.metadata?.name} does not have ReadWriteMany access mode`
        );
      } else if (pvStorageClass !== storageClassName) {
        logger.debug(
          `[PVManager] PV ${pv.metadata?.name} storageClass mismatch: ${pvStorageClass} != ${storageClassName}`
        );
      } else if (nodeAffinity) {
        logger.debug(
          `[PVManager] PV ${pv.metadata?.name} has nodeAffinity restrictions that may prevent mounting`
        );
      }
    }

    return null; // No available PV found
  }

  /**
   * Delete PV
   */
  async deletePV(pvName: string): Promise<void> {
    const context: ErrorContext = {
      resourceType: 'PVManager',
      resourceName: pvName,
      operation: 'delete',
    };

    try {
      await this.coreApi.deletePersistentVolume({ name: pvName });
      logger.info(`[PVManager] Deleted PV: ${pvName}`);
    } catch (error: any) {
      if (!KubernetesErrorHandler.isNotFoundError(error)) {
        logger.warn(`[PVManager] Failed to delete PV ${pvName}: ${error.message}`);
      }
    }
  }

  /**
   * Unbind PV from PVC
   * Note: After PVC deletion, Kubernetes usually unbinds the PV automatically.
   * This method is only needed if we need to manually unbind before deletion.
   */
  async unbindPV(pvName: string): Promise<void> {
    const context: ErrorContext = {
      resourceType: 'PVManager',
      resourceName: pvName,
      operation: 'unbind',
    };

    try {
      // Read the current PV to get its full spec
      const pv = await this.coreApi.readPersistentVolume({ name: pvName });
      
      // Create updated PV with claimRef removed
      const updatedPV: k8s.V1PersistentVolume = {
        ...pv,
        spec: {
          ...pv.spec,
          claimRef: undefined, // Remove claimRef
        },
      };

      // Use replace instead of patch to avoid JSON patch format issues
      await this.coreApi.replacePersistentVolume({
        name: pvName,
        body: updatedPV
      });

      logger.info(`[PVManager] Unbound PV ${pvName}`);
      // Wait a moment for PV to become Available
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      // If PVC is already deleted, Kubernetes may have already unbound the PV
      // or the PV might be in a state where unbinding isn't needed
      if (KubernetesErrorHandler.isNotFoundError(error)) {
        logger.debug(`[PVManager] PV ${pvName} not found, may have been deleted`);
      } else {
        logger.warn(`[PVManager] Failed to unbind PV ${pvName}: ${error.message}`);
        // Log full error in debug mode
        if (this.logLevel === 'debug') {
          logger.debug(`[PVManager] Unbind error details:`, error);
        }
      }
    }
  }

  /**
   * Delete unbound PVs for a StorageClass
   */
  async deleteUnboundPVs(storageClassName: string): Promise<number> {
    const pvs = await this.listPVsForStorageClass(storageClassName);
    let deletedCount = 0;

    for (const pv of pvs) {
      const phase = pv.status?.phase;
      const claimRef = pv.spec?.claimRef;

      // Only delete PVs that are Available and not bound to any claim
      if (phase === 'Available' && !claimRef) {
        try {
          await this.deletePV(pv.metadata?.name || '');
          deletedCount++;
          logger.info(
            `[PVManager] Deleted unbound PV: ${pv.metadata?.name} for StorageClass: ${storageClassName}`
          );
        } catch (error: any) {
          // Already logged in deletePV
        }
      } else {
        logger.debug(
          `[PVManager] Skipping PV ${pv.metadata?.name} deletion: ` +
          `phase=${phase}, claimRef=${claimRef ? 'bound' : 'none'}`
        );
      }
    }

    if (deletedCount > 0) {
      logger.info(
        `[PVManager] Cleaned up ${deletedCount} unbound PV(s) for StorageClass: ${storageClassName}`
      );
    }

    return deletedCount;
  }
}

