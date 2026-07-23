import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { BaseDeletionOperator, DeletionContext } from './DeletionOperator';

/**
 * Operator that deletes StorageClass and cleans up unbound PVs
 */
export class StorageClassCleanupOperator extends BaseDeletionOperator {
  constructor(
    private storageClassResourceManager: {
      deleteStorageClass(projectId: string, bucketName: string): Promise<void>;
    },
    private pvManager: {
      deleteUnboundPVs(storageClassName: string): Promise<number>;
    }
  ) {
    super();
  }

  async execute(context: DeletionContext): Promise<boolean> {
    try {
      // Delete StorageClass
      await this.storageClassResourceManager.deleteStorageClass(
        context.projectId,
        context.bucketName
      );

      // Clean up unbound PVs for this StorageClass
      await this.pvManager.deleteUnboundPVs(context.storageClassName);

      await this.executeNext(context);
      return true;
    } catch (error: any) {
      logger.error(
        `[StorageClassCleanupOperator] Failed to delete StorageClass: ${error.message}`
      );
      return false;
    }
  }
}

