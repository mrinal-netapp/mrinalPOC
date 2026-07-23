import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BaseDeletionOperator, DeletionContext } from './DeletionOperator';

/**
 * Operator that deletes PVC and tracks bound PV
 */
export class PVCCleanupOperator extends BaseDeletionOperator {
  constructor(
    private coreApi: k8s.CoreV1Api,
    private pvcManager: {
      deletePVC(pvcName: string, waitForUnmount?: boolean): Promise<string | undefined>;
      getPVCName(storageClassName: string, bucketName: string): string;
    }
  ) {
    super();
  }

  async execute(context: DeletionContext): Promise<boolean> {
    try {
      // Get PVC to find bound PV before deleting
      let boundPVName: string | undefined;
      try {
        const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
          name: context.pvcName,
          namespace: context.namespace
        });
        boundPVName = pvc.spec?.volumeName;
        if (boundPVName) {
          logger.info(
            `[PVCCleanupOperator] PVC ${context.pvcName} is bound to PV ${boundPVName}, will delete PV after PVC deletion`
          );
        }
      } catch (error: any) {
        // Ignore 404 errors - PVC may have been deleted already
      }

      // Wait a moment for deployment update to propagate (pods may need to restart)
      // The deployment cleanup operator runs before this, but pods take time to terminate
      logger.info(
        `[PVCCleanupOperator] Waiting for pods to unmount PVC ${context.pvcName} before deletion...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Delete PVC (if it exists) - this will wait for unmount and retry if needed
      const deletedPVName = await this.pvcManager.deletePVC(context.pvcName, true);

      // Store PV name in context for next operator
      context.boundPVName = boundPVName || deletedPVName;

      await this.executeNext(context);
      return true;
    } catch (error: any) {
      logger.error(`[PVCCleanupOperator] Failed to delete PVC ${context.pvcName}: ${error.message}`);
      // Don't return false - continue with cleanup even if PVC deletion fails
      // The PVC may be deleted later by Kubernetes or manual intervention
      await this.executeNext(context);
      return true;
    }
  }
}

