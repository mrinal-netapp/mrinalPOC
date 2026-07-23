import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { BaseService } from './BaseService';

/**
 * Service for triggering dataset deletion workflows
 * Triggers async Temporal workflow via workflow-engine for dataset deletion
 */
export class DatasetDeleteService extends BaseService {
  private client: AxiosInstance;
  private executorServiceUrl: string;
  private serviceAccountClient: ServiceAccountClient | null = null;

  constructor() {
    super();
    this.executorServiceUrl = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    
    // Initialize service account client for service-to-service authentication
    this.serviceAccountClient = createServiceAccountClientFromEnv();
    
    if (this.serviceAccountClient) {
      // Use authenticated client that automatically adds Authorization header
      this.client = this.serviceAccountClient.createAuthenticatedClient(this.executorServiceUrl);
      logger.info(`[DatasetDeleteService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (with service account authentication)`);
    } else {
      // Fallback to unauthenticated client (will fail if auth is required)
      logger.warn('[DatasetDeleteService] Service account client not available, using unauthenticated client');
      this.client = axios.create({
        baseURL: this.executorServiceUrl,
        timeout: 30000, // 30 seconds
        headers: {
          'Content-Type': 'application/json',
        },
      });
      logger.info(`[DatasetDeleteService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (unauthenticated)`);
    }
  }

  /**
   * Terminate all running workflows associated with a dataset (acquisition, import, PII facet)
   * and delete the acquisition schedule. Best-effort: errors are logged but not thrown.
   */
  async terminateDatasetWorkflows(projectId: string, datasetId: string): Promise<string[]> {
    try {
      logger.info(`[DatasetDeleteService] Terminating workflows for dataset: ${datasetId}, project: ${projectId}`);
      const response = await this.client.post(
        `/api/v1/projects/${projectId}/datasets/${datasetId}/terminate`
      );
      const cancelled: string[] = response.data?.cancelled || [];
      logger.info(`[DatasetDeleteService] Terminated ${cancelled.length} workflows for dataset ${datasetId}: ${cancelled.join(', ')}`);
      return cancelled;
    } catch (error: any) {
      logger.warn(`[DatasetDeleteService] Failed to terminate workflows for dataset ${datasetId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Trigger async dataset deletion workflow
   * This calls workflow-engine which starts a Temporal workflow that will:
   * 1. Delete table from Lakekeeper catalog
   * 2. Delete dataset files from S3
   */
  async startDatasetDeletion(
    projectId: string,
    datasetId: string,
    tableName: string,
    namespace: string,
    warehouseId?: string,
    bucketName?: string,
    pathPrefix?: string
  ): Promise<string | null> {
    try {
      logger.info(`[DatasetDeleteService] Triggering dataset deletion for dataset: ${datasetId}, table: ${tableName}`);
      
      const requestBody: Record<string, any> = {
        tableName,
        namespace,
        warehouseId: warehouseId || projectId,
        bucketName: bucketName || projectId,
      };
      if (pathPrefix) {
        requestBody.pathPrefix = pathPrefix;
      }

      logger.info(`[DatasetDeleteService] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await this.client.delete(
        `/api/v1/projects/${projectId}/datasets/${datasetId}`,
        { data: requestBody }
      );

      logger.info(`[DatasetDeleteService] HTTP response status: ${response.status}`);
      logger.info(`[DatasetDeleteService] Response body:`, JSON.stringify(response.data, null, 2));

      if (response.data?.workflowId) {
        logger.info(`[DatasetDeleteService] Dataset deletion workflow started successfully for dataset: ${datasetId}, workflowID: ${response.data.workflowId}`);
        return response.data.workflowId;
      } else {
        logger.info(`[DatasetDeleteService] Dataset deletion workflow started for dataset: ${datasetId} (no workflow ID in response)`);
        return null;
      }
    } catch (error: any) {
      // Log full error details
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error || error.message;
      const responseBody = error.response?.data ? JSON.stringify(error.response.data, null, 2) : 'N/A';
      
      logger.error(`[DatasetDeleteService] ERROR: Failed to trigger dataset deletion workflow for dataset ${datasetId}:`);
      logger.error(`[DatasetDeleteService] ERROR: Status code: ${statusCode || 'N/A'}`);
      logger.error(`[DatasetDeleteService] ERROR: Error message: ${errorMessage}`);
      logger.error(`[DatasetDeleteService] ERROR: Response body: ${responseBody}`);
      logger.error(`[DatasetDeleteService] ERROR: Full error:`, error.stack || error);
      
      throw new Error(`Failed to start dataset deletion workflow: ${errorMessage}`);
    }
  }
}
