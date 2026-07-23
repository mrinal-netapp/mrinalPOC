import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { BaseService } from './BaseService';

/**
 * Service for triggering dataset import workflows
 * Triggers async Temporal workflow via workflow-engine for dataset import processing
 * - For structured data: converts files to Parquet, infers schema, registers with Lakekeeper catalog
 * - For unstructured data: creates metadata table with file info, registers with Lakekeeper catalog
 */
export class DatasetImportService extends BaseService {
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
      logger.info(`[DatasetImportService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (with service account authentication)`);
    } else {
      // Fallback to unauthenticated client (will fail if auth is required)
      logger.warn('[DatasetImportService] Service account client not available, using unauthenticated client');
      this.client = axios.create({
        baseURL: this.executorServiceUrl,
        timeout: 30000, // 30 seconds
        headers: {
          'Content-Type': 'application/json',
        },
      });
      logger.info(`[DatasetImportService] Initialized with workflow-engine URL: ${this.executorServiceUrl} (unauthenticated)`);
    }
  }

  /**
   * Trigger async dataset import workflow
   * This calls workflow-engine which starts a Temporal workflow that will:
   * 1. Create Kubernetes Job with job-dataset-import
   * 2. Processor: converts files to Parquet and registers with Lakekeeper catalog
   * 3. Wait for job completion
   * 4. Update dataset status to 'ready' or 'errored'
   */
  async startDatasetImport(
    projectId: string,
    datasetId: string,
    datasetName: string,
    datasetKind: 'structured' | 'unstructured',
    bucketName: string,
    namespace: string = 'default',
    warehouseId?: string,
    pathPrefix?: string,
    enablePiiAnalysis?: boolean,
    piiAnalysisImageOnly?: boolean,
    reprocessPiiOnly?: boolean,
    datasetType?: 'manual' | 'acquired',
  ): Promise<string | null> {
    try {
      logger.info(`[DatasetImportService] Triggering dataset import for dataset: ${datasetId} (${datasetKind})${reprocessPiiOnly ? ' [PII reprocess only]' : ''}`);
      
      const requestBody: Record<string, any> = {
        datasetName,
        datasetKind,
        bucketName,
        namespace,
        warehouseId: warehouseId || 'nemo', // warehouse NAME (not UUID) — Lakekeeper /config expects the name
      };
      if (pathPrefix) {
        requestBody.pathPrefix = pathPrefix;
      }
      if (enablePiiAnalysis) {
        requestBody.enablePiiAnalysis = true;
      }
      if (piiAnalysisImageOnly) {
        requestBody.piiAnalysisImageOnly = true;
      }
      if (reprocessPiiOnly) {
        requestBody.reprocessPiiOnly = true;
      }
      if (datasetType) {
        requestBody.datasetType = datasetType;
      }

      logger.info(`[DatasetImportService] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await this.client.post(
        `/api/v1/projects/${projectId}/datasets/${datasetId}/import`,
        requestBody
      );

      logger.info(`[DatasetImportService] HTTP response status: ${response.status}`);
      logger.info(`[DatasetImportService] Response body:`, JSON.stringify(response.data, null, 2));

      if (response.data?.workflowId) {
        logger.info(`[DatasetImportService] Dataset import workflow started successfully for dataset: ${datasetId}, workflowID: ${response.data.workflowId}`);
        return response.data.workflowId;
      } else {
        logger.info(`[DatasetImportService] Dataset import workflow started for dataset: ${datasetId} (no workflow ID in response)`);
        return null;
      }
    } catch (error: any) {
      // Log full error details but don't throw - the caller can decide how to handle
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error || error.message;
      const responseBody = error.response?.data ? JSON.stringify(error.response.data, null, 2) : 'N/A';
      
      logger.error(`[DatasetImportService] ERROR: Failed to trigger dataset import workflow for dataset ${datasetId}:`);
      logger.error(`[DatasetImportService] ERROR: Status code: ${statusCode || 'N/A'}`);
      logger.error(`[DatasetImportService] ERROR: Error message: ${errorMessage}`);
      logger.error(`[DatasetImportService] ERROR: Response body: ${responseBody}`);
      logger.error(`[DatasetImportService] ERROR: Full error:`, error.stack || error);
      
      // Don't throw - the import can be retried manually if needed
      return null;
    }
  }
}
