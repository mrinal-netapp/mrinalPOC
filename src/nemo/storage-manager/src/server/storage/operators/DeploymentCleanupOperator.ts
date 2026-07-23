import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { BaseDeletionOperator, DeletionContext } from './DeletionOperator';

/**
 * Operator that removes PVC from deployment before deletion
 */
export class DeploymentCleanupOperator extends BaseDeletionOperator {
  constructor(
    private deploymentManager: {
      removePVCFromDeployment(pvcName: string): Promise<void>;
    }
  ) {
    super();
  }

  async execute(context: DeletionContext): Promise<boolean> {
    try {
      await this.deploymentManager.removePVCFromDeployment(context.pvcName);
      await this.executeNext(context);
      return true;
    } catch (error: any) {
      logger.warn(
        `[DeploymentCleanupOperator] Failed to remove PVC ${context.pvcName} from deployment: ${error.message}`
      );
      // Continue with deletion even if deployment update fails
      await this.executeNext(context);
      return true;
    }
  }
}

