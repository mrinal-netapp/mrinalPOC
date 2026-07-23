import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { LakekeeperCatalogService } from './LakekeeperCatalogService';
import { DeploymentEndpointService } from './DeploymentEndpointService';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { AppDataSource } from '../db/postgres';
import { NotFoundError, ValidationError } from '../utils/errors';
import { IcebergSchema, CreateTableRequest } from './LakekeeperCatalogService';
import { DEFAULT_WAREHOUSE_NAME, getProjectStorageRoot, isDefaultBucket } from '../utils/defaultBucket';

const catalogService = new LakekeeperCatalogService();

/**
 * Orchestrator for catalog operations related to datasets.
 * Handles warehouse, namespace, and table setup.
 *
 * With the home_dir convention:
 *   - Warehouse name is always "nemo" (static).
 *   - Namespace is [projectId] (one per project).
 *   - Routing uses the *bucket name* (e.g. default-nemo) for
 *     getPrimaryDeploymentEndpoint.
 */
export class DataSetCatalogOrchestrator {
  /**
   * Verify the default warehouse "nemo" exists and return its ID + S3 endpoint.
   *
   * For routing we use the *bucket name* (from dataset or project home_dir);
   * for Lakekeeper lookups we use the static warehouse name "nemo".
   */
  static async ensureWarehouse(
    projectId: string,
    bucketName: string
  ): Promise<{ warehouseId: string; s3Endpoint: string }> {
    const warehouseName = DEFAULT_WAREHOUSE_NAME; // always "nemo"

    // Get deployment HTTP endpoint for routing (uses the actual bucket name)
    logger.info(`[DataSetCatalogOrchestrator] Getting deployment HTTP endpoint for bucket: ${bucketName}`);
    const deploymentEndpoint = await DeploymentEndpointService.getPrimaryDeploymentEndpoint(
      projectId,
      bucketName,
      'http'
    );
    if (!deploymentEndpoint) {
      throw new ValidationError(
        `No deployment endpoint found for bucket '${bucketName}'. ` +
        `Please ensure the default storage deployment is available.`
      );
    }
    logger.info(`[DataSetCatalogOrchestrator] Deployment HTTP endpoint retrieved: ${deploymentEndpoint}`);

    // Format S3 endpoint
    const s3Endpoint = DeploymentEndpointService.formatS3Endpoint(deploymentEndpoint);
    logger.info(`[DataSetCatalogOrchestrator] S3 endpoint formatted: ${s3Endpoint}`);

    // Get warehouse ID from project metadata (stored during project initialization)
    const projectRepo = new ProjectRepository(AppDataSource);
    const project = await projectRepo.getById(projectId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    let warehouseId = project.metadata?.warehouseId as string | undefined;
    if (!warehouseId) {
      // Fallback: look up warehouse by name
      logger.info(`[DataSetCatalogOrchestrator] Warehouse ID not in project metadata, looking up warehouse by name: ${warehouseName}`);
      try {
        const warehouse = await catalogService.getWarehouse(warehouseName);
        warehouseId = (warehouse as any).warehouseId;
        if (!warehouseId) {
          throw new ValidationError(
            `Warehouse ID not found for warehouse '${warehouseName}'. ` +
            `Was the default-setup completed at install time?`
          );
        }
        // Cache in project metadata
        await projectRepo.update(projectId, {
          metadata: { ...project.metadata, warehouseId },
        });
      } catch (error: any) {
        if (error.message.includes('not found')) {
          throw new ValidationError(
            `Warehouse '${warehouseName}' does not exist in Lakekeeper. ` +
            `Please check that default-setup completed correctly at install time.`
          );
        }
        throw error;
      }
    } else {
      // Verify warehouse exists
      logger.info(`[DataSetCatalogOrchestrator] Verifying warehouse '${warehouseName}' exists in Lakekeeper`);
      try {
        await catalogService.getWarehouse(warehouseName);
      } catch (error: any) {
        if (error.message.includes('not found')) {
          throw new ValidationError(
            `Warehouse '${warehouseName}' does not exist in Lakekeeper. ` +
            `Please check that default-setup completed correctly at install time.`
          );
        }
        throw error;
      }
    }
    logger.info(`[DataSetCatalogOrchestrator] Warehouse ID: ${warehouseId}`);

    return { warehouseId, s3Endpoint };
  }

  /**
   * Ensure namespace exists.
   * Namespace is [projectId] in warehouse "nemo".
   */
  static async ensureNamespace(
    namespace: string[],
    warehouseId: string
  ): Promise<void> {
    const warehouseName = DEFAULT_WAREHOUSE_NAME;
    logger.info(`[DataSetCatalogOrchestrator] Ensuring namespace exists: ${namespace.join('.')} with warehouse ID: ${warehouseId}`);
    await catalogService.ensureNamespace(namespace, warehouseName, warehouseId);
    logger.info(`[DataSetCatalogOrchestrator] Namespace ensured successfully: ${namespace.join('.')}`);
  }

  /**
   * Create Iceberg table in catalog.
   */
  static async createTable(request: CreateTableRequest): Promise<any> {
    logger.info(
      `[DataSetCatalogOrchestrator] Creating Iceberg table: ${request.name} ` +
      `in namespace: ${request.namespace.join('.')} with warehouse ID: ${request.warehouseId}`
    );
    const catalogTable = await catalogService.createTable(request);
    logger.info(`[DataSetCatalogOrchestrator] Iceberg table created successfully: ${catalogTable.name || request.name}`);
    return catalogTable;
  }
}
