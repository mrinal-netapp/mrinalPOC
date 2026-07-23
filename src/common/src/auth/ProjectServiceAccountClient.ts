import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient } from './ServiceAccountClient';

/**
 * Project Service Account Client
 * Retrieves project service account credentials from config-service and uses them for authentication
 * Used by processing jobs to authenticate with project-level credentials
 */
export class ProjectServiceAccountClient {
  private configServiceUrl: string;
  private projectId: string;
  private serviceAccountClient: ServiceAccountClient | null = null;
  private credentialsCache: {
    clientId: string;
    clientSecret: string;
    expiresAt: number;
  } | null = null;

  constructor(projectId: string, configServiceUrl?: string) {
    this.projectId = projectId;
    this.configServiceUrl = configServiceUrl || process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
  }

  /**
   * Get project service account credentials from config-service
   */
  private async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
    // Check cache (credentials don't expire, but cache for 1 hour to avoid repeated calls)
    if (this.credentialsCache && Date.now() < this.credentialsCache.expiresAt) {
      return {
        clientId: this.credentialsCache.clientId,
        clientSecret: this.credentialsCache.clientSecret,
      };
    }

    try {
      const response = await axios.get(
        `${this.configServiceUrl}/api/v1/projects/${this.projectId}/service-account`,
        {
          timeout: 10000,
          // Note: This call itself may need authentication if config-service requires it
          // For now, assume internal service-to-service calls don't require auth
        }
      );

      const { clientId, clientSecret } = response.data;
      if (!clientId || !clientSecret) {
        throw new Error('Invalid service account response: missing clientId or clientSecret');
      }

      // Cache credentials for 1 hour
      this.credentialsCache = {
        clientId,
        clientSecret,
        expiresAt: Date.now() + 3600000, // 1 hour
      };

      return { clientId, clientSecret };
    } catch (error: any) {
      const errorDetails = error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      console.error(`[ProjectServiceAccountClient] Failed to get credentials for project ${this.projectId}: ${errorDetails}`);
      throw new Error(`Failed to get project service account credentials: ${errorDetails}`);
    }
  }

  /**
   * Get ServiceAccountClient instance for this project
   * Creates or returns cached instance
   */
  async getServiceAccountClient(): Promise<ServiceAccountClient> {
    if (this.serviceAccountClient) {
      return this.serviceAccountClient;
    }

    const { clientId, clientSecret } = await this.getCredentials();
    const issuer = process.env.KEYCLOAK_INTERNAL_ISSUER || 'http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo';

    this.serviceAccountClient = new ServiceAccountClient(issuer, clientId, clientSecret);
    return this.serviceAccountClient;
  }

  /**
   * Create an authenticated HTTP client for making API calls
   * Automatically adds Authorization header with project service account token
   */
  async createAuthenticatedClient(baseURL: string, forwardUserHeaders: boolean = false): Promise<AxiosInstance> {
    const serviceAccountClient = await this.getServiceAccountClient();
    return serviceAccountClient.createAuthenticatedClient(baseURL, forwardUserHeaders);
  }

  /**
   * Get access token directly (for use in custom HTTP clients)
   */
  async getAccessToken(): Promise<string> {
    const serviceAccountClient = await this.getServiceAccountClient();
    return serviceAccountClient.getAccessToken();
  }
}

/**
 * Create ProjectServiceAccountClient from environment variables
 * Requires PROJECT_ID to be set
 */
export function createProjectServiceAccountClientFromEnv(): ProjectServiceAccountClient | null {
  const projectId = process.env.PROJECT_ID;
  if (!projectId) {
    console.warn('[ProjectServiceAccountClient] PROJECT_ID not set, cannot create client');
    return null;
  }

  const configServiceUrl = process.env.CONFIG_SERVICE_URL || 'http://config-service:3000';
  return new ProjectServiceAccountClient(projectId, configServiceUrl);
}
