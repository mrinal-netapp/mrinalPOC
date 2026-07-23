import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { BaseDeletionOperator, DeletionContext } from './DeletionOperator';

/**
 * Operator that deletes Secret associated with bucket
 */
export class SecretCleanupOperator extends BaseDeletionOperator {
  constructor(
    private secretManager: {
      deleteSecret(projectId: string, bucketName: string): Promise<void>;
    }
  ) {
    super();
  }

  async execute(context: DeletionContext): Promise<boolean> {
    try {
      await this.secretManager.deleteSecret(context.projectId, context.bucketName);
      await this.executeNext(context);
      return true;
    } catch (error: any) {
      logger.error(
        `[SecretCleanupOperator] Failed to delete Secret: ${error.message}`
      );
      return false;
    }
  }
}

