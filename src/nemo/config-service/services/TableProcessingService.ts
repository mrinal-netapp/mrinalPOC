import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { BaseService } from './BaseService';

/**
 * Service for triggering table processing workflows
 * Triggers async Temporal workflow via workflow-engine for table processing
 */
export class TableProcessingService extends BaseService {
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
      logger.info(`[TableProcessingService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (with service account authentication)`);
    } else {
      // Fallback to unauthenticated client (will fail if auth is required)
      logger.warn('[TableProcessingService] Service account client not available, using unauthenticated client');
      this.client = axios.create({
        baseURL: this.executorServiceUrl,
        timeout: 30000, // 30 seconds
        headers: {
          'Content-Type': 'application/json',
        },
      });
      logger.info(`[TableProcessingService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (unauthenticated)`);
    }
  }

  /**
   * Trigger async table processing workflow
   * This calls workflow-engine which starts a Temporal workflow that will:
   * 1. Get table metadata from lakekeeper catalog
   * 2. Create Kubernetes Job for processing
   * 3. Wait for job completion
   * 4. Update dataset status
   */
  async startTableProcessing(
    projectId: string,
    datasetId: string,
    tableName: string,
    namespace: string,
    warehouseId?: string
  ): Promise<string | null> {
    try {
      logger.info(`[TableProcessingService] Triggering table processing for dataset: ${datasetId}, table: ${tableName}`);
      logger.info(`[TableProcessingService] Calling workflow-engine at: ${this.executorServiceUrl}/api/v1/projects/${projectId}/datasets/${datasetId}/process`);
      
      const requestBody = {
        dataSetId: datasetId,
        tableName,
        namespace,
        warehouseId,
      };

      logger.info(`[TableProcessingService] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await this.client.post(
        `/api/v1/projects/${projectId}/datasets/${datasetId}/process`,
        requestBody
      );

      logger.info(`[TableProcessingService] HTTP response status: ${response.status}`);
      logger.info(`[TableProcessingService] Response body:`, JSON.stringify(response.data, null, 2));

      if (response.data?.workflowId) {
        logger.info(`[TableProcessingService] Table processing workflow started successfully for dataset: ${datasetId}, workflowID: ${response.data.workflowId}`);
        return response.data.workflowId;
      } else {
        logger.info(`[TableProcessingService] Table processing workflow started for dataset: ${datasetId} (no workflow ID in response)`);
        return null;
      }
    } catch (error: any) {
      // Log full error details but don't throw - dataset creation should succeed even if processing fails
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error || error.message;
      const responseBody = error.response?.data ? JSON.stringify(error.response.data, null, 2) : 'N/A';
      
      logger.error(`[TableProcessingService] ERROR: Failed to trigger table processing workflow for dataset ${datasetId}:`);
      logger.error(`[TableProcessingService] ERROR: Status code: ${statusCode || 'N/A'}`);
      logger.error(`[TableProcessingService] ERROR: Error message: ${errorMessage}`);
      logger.error(`[TableProcessingService] ERROR: Response body: ${responseBody}`);
      logger.error(`[TableProcessingService] ERROR: Full error:`, error.stack || error);
      
      // Don't throw - dataset creation should succeed even if processing workflow creation fails
      // The workflow can be retried manually if needed
      return null;
    }
  }
}
