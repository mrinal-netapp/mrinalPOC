import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BaseDeletionOperator, DeletionContext } from './DeletionOperator';

/**
 * Operator that cleans up PVs after PVC deletion
 */
export class PVCleanupOperator extends BaseDeletionOperator {
  constructor(
    private coreApi: k8s.CoreV1Api,
    private pvManager: {
      unbindPV(pvName: string): Promise<void>;
      deletePV(pvName: string): Promise<void>;
    }
  ) {
    super();
  }

  async execute(context: DeletionContext): Promise<boolean> {
    const pvName = context.boundPVName;
    if (!pvName) {
      // No PV to clean up
      await this.executeNext(context);
      return true;
    }

    // Wait a moment for PVC deletion to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      const pv = await this.coreApi.readPersistentVolume({ name: pvName });
      const reclaimPolicy = pv.spec?.persistentVolumeReclaimPolicy;

      // Only delete PV if reclaimPolicy is Delete
      if (reclaimPolicy === 'Delete') {
        // Check if PV is still bound to the deleted PVC
        const claimRef = pv.spec?.claimRef;
        if (
          claimRef &&
          claimRef.name === context.pvcName &&
          claimRef.namespace === context.namespace
        ) {
          // Unbind the PV first
          await this.pvManager.unbindPV(pvName);
        }

        // Delete the PV
        await this.pvManager.deletePV(pvName);
        logger.info(
          `[PVCleanupOperator] Manually deleted PV ${pvName} (static PV with Delete reclaimPolicy)`
        );
      } else {
        logger.debug(
          `[PVCleanupOperator] PV ${pvName} has reclaimPolicy '${reclaimPolicy}', ` +
          `skipping manual deletion (PV will be retained)`
        );
      }
    } catch (pvReadError: any) {
      // PV might have been deleted or not found - ignore
      logger.debug(
        `[PVCleanupOperator] Could not read PV ${pvName}: ${pvReadError.message}`
      );
    }

    await this.executeNext(context);
    return true;
  }
}

