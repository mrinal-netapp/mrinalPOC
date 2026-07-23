import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { BaseService } from './BaseService';

/**
 * Service for orchestrating project initialization.
 *
 * The HTTP call to workflow-engine **must carry the originating user's
 * Authorization header**, not a service-account token. workflow-engine derives
 * the project owner from `claims.sub` on this request and writes a Keycloak
 * user-policy `usr-{ownerSub}-proj-{projectId}-admin`. If we authenticated as
 * the config-service service account, the SA's user UUID would land in that
 * policy, leaving the real human creator with no admin grant. See
 * docs/design/keycloak-per-project-authorization.md §5.
 */
export class ProjectInitService extends BaseService {
  private executorServiceUrl: string;

  constructor() {
    super();
    this.executorServiceUrl = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    logger.info(`[ProjectInitService] Initialized with workflow-engine URL: ${this.executorServiceUrl}`);
  }

  /**
   * Trigger async project initialization workflow.
   *
   * @param projectId The project to initialize.
   * @param userAuthHeader The verbatim `Authorization` header from the user
   *   request (e.g. `Bearer eyJ...`). Required — workflow-engine rejects
   *   service-account or missing tokens on `/projects/:id/init`.
   */
  async initializeProject(projectId: string, userAuthHeader: string): Promise<void> {
    if (!userAuthHeader) {
      throw new Error('initializeProject requires the caller\'s Authorization header');
    }

    const client: AxiosInstance = axios.create({
      baseURL: this.executorServiceUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: userAuthHeader,
      },
    });

    try {
      logger.info(`[ProjectInitService] Triggering initialization for project: ${projectId}`);

      const requestBody = {
        region: process.env.REGION || 'us-east-1',
      };

      logger.info(`[ProjectInitService] Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await client.post(
        `/api/v1/projects/${projectId}/init`,
        requestBody
      );

      logger.info(`[ProjectInitService] HTTP response status: ${response.status}`);

      if (response.data?.workflowId) {
        logger.info(`[ProjectInitService] Project init workflow started: ${response.data.workflowId}`);
      } else {
        logger.info(`[ProjectInitService] Project init workflow started (no workflow ID in response)`);
      }
    } catch (error: any) {
      const statusCode = error.response?.status;
      const errorMessage = error.response?.data?.error || error.message;
      logger.error(`[ProjectInitService] ERROR: Failed to trigger initialization for project ${projectId}: status=${statusCode || 'N/A'} message=${errorMessage}`);
      throw error;
    }
  }
}
