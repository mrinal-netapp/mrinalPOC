import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { BaseService } from './BaseService';
import { getProjectStorageRoot } from '../utils/defaultBucket';

/**
 * Service for orchestrating project deletion.
 *
 * The default bucket is shared across projects, so project deletion only
 * deletes objects under the project home_dir prefix and removes namespace/
 * metadata — it does NOT delete the bucket itself.
 */
export class ProjectDeleteService extends BaseService {
  private client: AxiosInstance;
  private executorServiceUrl: string;
  private serviceAccountClient: ServiceAccountClient | null = null;

  constructor() {
    super();
    this.executorServiceUrl = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    
    this.serviceAccountClient = createServiceAccountClientFromEnv();
    
    if (this.serviceAccountClient) {
      this.client = this.serviceAccountClient.createAuthenticatedClient(this.executorServiceUrl);
      logger.info(`[ProjectDeleteService] Initialized with executor URL: ${this.executorServiceUrl} (with service account authentication)`);
    } else {
      logger.warn('[ProjectDeleteService] Service account client not available, using unauthenticated client');
      this.client = axios.create({
        baseURL: this.executorServiceUrl,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });
      logger.info(`[ProjectDeleteService] Initialized with executor URL: ${this.executorServiceUrl} (unauthenticated)`);
    }
  }

  /**
   * Trigger async project deletion workflow.
   *
   * The Temporal workflow (`ProjectDeleteWorkflow`) will:
   *   0. Tear down the project's Bifrost team + virtual key (mirror of
   *      `ProjectInitWorkflow` Step 0 setup activity). Uses the
   *      `gateway` metadata captured here so it can still find the
   *      VK / team in Bifrost's `config_store` after the project row
   *      is dropped by the caller.
   *   1. Delete all objects under the project home_dir prefix (e.g. projects/<projectId>/)
   *   2. Delete the namespace [projectId] from Lakekeeper
   *   3. Remove project records from the DB
   *
   * It does NOT delete the default bucket — that is shared across projects.
   *
   * @param projectId  The project to delete
   * @param homeDir    Project home_dir (e.g. s3://default-nemo/projects/<projectId>)
   * @param gateway    Pre-loaded Bifrost team / VK ids captured from
   *                   `projects.metadata._gateway`. Optional; when omitted
   *                   (project never had governance set up) the Bifrost
   *                   teardown step still runs but only cleans up the
   *                   K8s Secret for the VK bearer.
   */
  async deleteProject(
    projectId: string,
    homeDir: string,
    gateway?: {
      teamId?: string;
      teamName?: string;
      virtualKeyId?: string;
      virtualKeyName?: string;
    },
  ): Promise<void> {
    try {
      logger.info(`[ProjectDeleteService] Triggering deletion for project: ${projectId}`);
      
      const { bucketName, pathPrefix } = getProjectStorageRoot({ home_dir: homeDir });
      const requestBody: Record<string, unknown> = { bucketName, pathPrefix };
      if (gateway && (gateway.teamId || gateway.virtualKeyId)) {
        requestBody.gateway = gateway;
      }

      logger.info(`[ProjectDeleteService] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await this.client.delete(
        `/api/v1/projects/${projectId}/delete`,
        { data: requestBody }
      );

      if (response.data?.workflowId) {
        logger.info(`[ProjectDeleteService] Project delete workflow started: ${response.data.workflowId}`);
      } else {
        logger.info(`[ProjectDeleteService] Project delete workflow started (no workflow ID in response)`);
      }
    } catch (error: any) {
      logger.error(`[ProjectDeleteService] Failed to trigger deletion workflow for project ${projectId}:`, error.message);
      // Don't throw - allow project deletion to proceed even if cleanup workflow fails
    }
  }
}
