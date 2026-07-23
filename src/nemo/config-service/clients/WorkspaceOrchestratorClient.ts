import axios, { AxiosInstance } from 'axios';
import { WorkspaceTemplate } from '../models/WorkspaceTemplate';

export interface LaunchWorkspaceRequest {
  workspaceId: string;
  projectId: string;
  template: {
    type: string;
    environment?: {
      baseImage?: string;
      pythonVersion?: string;
      nodeVersion?: string;
      libraries?: Array<{
        name: string;
        version: string;
        packageManager?: 'pip' | 'conda' | 'npm';
      }>;
      environmentVariables?: Record<string, string>;
    };
    resources?: {
      cpu?: string;
      memory?: string;
      storage?: string;
      gpu?: boolean;
    };
  };
  s3Config?: {
    bucketName: string;
    accessKey: string;
    secretKey: string;
    endpoint?: string;
  };
}

export interface StopWorkspaceRequest {
  workspaceId: string;
  projectId: string;
  podName?: string;
  pvcName?: string;
  serviceName?: string;
  bucketName?: string;
}

export interface DeleteWorkspaceRequest {
  workspaceId: string;
  projectId: string;
  podName?: string;
  pvcName?: string;
  serviceName?: string;
  secretName?: string;
}

/**
 * Client for communicating with the workspace orchestrator service
 */
export class WorkspaceOrchestratorClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.WORKSPACE_ORCHESTRATOR_URL || 'http://workspace-orchestrator:8080';
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 300000, // 5 minutes for launch operations
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Launch a workspace
   */
  async launchWorkspace(request: LaunchWorkspaceRequest): Promise<void> {
    try {
      await this.client.post(`/api/v1/workspaces/${request.workspaceId}/launch`, request);
    } catch (error: any) {
      throw new Error(`Failed to launch workspace: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Stop a workspace
   */
  async stopWorkspace(request: StopWorkspaceRequest): Promise<void> {
    try {
      await this.client.post(`/api/v1/workspaces/${request.workspaceId}/stop`, request);
    } catch (error: any) {
      throw new Error(`Failed to stop workspace: ${error.response?.data?.error || error.message}`);
    }
  }

  /**
   * Delete workspace resources including PVC (called when workspace is deleted)
   */
  async deleteWorkspace(request: DeleteWorkspaceRequest): Promise<void> {
    try {
      await this.client.post(`/api/v1/workspaces/${request.workspaceId}/delete`, request);
    } catch (error: any) {
      throw new Error(`Failed to delete workspace resources: ${error.response?.data?.error || error.message}`);
    }
  }
}

