import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import { ProjectServiceAccount } from '../models/ProjectServiceAccount';
import { BaseService } from './BaseService';
import { NotFoundError, ValidationError } from '../utils/errors';
import { KeycloakClientService } from './KeycloakClientService';

const projectServiceAccountRepo = () => AppDataSource.getRepository(ProjectServiceAccount);

// Removed CreateProjectServiceAccountRequest - create() now only needs projectId

export interface ProjectServiceAccountResponse {
  projectId: string;
  clientId: string;
  createdAt: Date;
}

export class ProjectServiceAccountService extends BaseService {
  /**
   * Simple encryption/decryption for client secrets
   * In production, use a proper encryption library with a key management system
   */
  private static encryptSecret(secret: string): string {
    // TODO: Implement proper encryption (e.g., using crypto with a key from environment)
    // For now, base64 encode (NOT secure, but allows storage)
    // In production, use: crypto.createCipheriv('aes-256-gcm', key, iv)
    return Buffer.from(secret).toString('base64');
  }

  private static decryptSecret(encrypted: string): string {
    // TODO: Implement proper decryption
    return Buffer.from(encrypted, 'base64').toString('utf-8');
  }

  /**
   * Create a new project service account
   * Creates Keycloak client and stores credentials in database
   */
  static async create(projectId: string): Promise<ProjectServiceAccountResponse> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    const repo = projectServiceAccountRepo();

    // Check if service account already exists
    const existing = await repo.findOne({ where: { project_id: projectId } });
    if (existing) {
      // Return existing service account
      return {
        projectId: existing.project_id,
        clientId: existing.client_id,
        createdAt: existing.created_at,
      };
    }

    // Create Keycloak client
    const keycloakService = new KeycloakClientService();
    const { clientId, clientSecret } = await keycloakService.createProjectServiceAccountClient(projectId);

    // Encrypt client secret
    const encryptedSecret = this.encryptSecret(clientSecret);

    // Create service account record
    const serviceAccount = repo.create({
      project_id: projectId,
      client_id: clientId,
      client_secret_encrypted: encryptedSecret,
    });

    const saved = await repo.save(serviceAccount);

    return {
      projectId: saved.project_id,
      clientId: saved.client_id,
      createdAt: saved.created_at,
    };
  }

  /**
   * Get project service account by project ID
   */
  static async getByProjectId(projectId: string): Promise<ProjectServiceAccountResponse & { clientSecret: string }> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    const repo = projectServiceAccountRepo();
    const serviceAccount = await repo.findOne({ where: { project_id: projectId } });

    if (!serviceAccount) {
      throw new NotFoundError(`Service account not found for project ${projectId}`);
    }

    return {
      projectId: serviceAccount.project_id,
      clientId: serviceAccount.client_id,
      clientSecret: this.decryptSecret(serviceAccount.client_secret_encrypted),
      createdAt: serviceAccount.created_at,
    };
  }

  /**
   * Delete project service account
   * Deletes both Keycloak client and database record
   */
  static async delete(projectId: string): Promise<boolean> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    // Delete Keycloak client
    try {
      const keycloakService = new KeycloakClientService();
      await keycloakService.deleteProjectServiceAccountClient(projectId);
    } catch (error: any) {
      logger.error(`[ProjectServiceAccountService] Error deleting Keycloak client: ${error.message}`);
      // Continue with database deletion even if Keycloak deletion fails
    }

    // Delete database record
    const repo = projectServiceAccountRepo();
    const result = await repo.delete({ project_id: projectId });

    return (result.affected || 0) > 0;
  }

  /**
   * Check if service account exists for project
   */
  static async exists(projectId: string): Promise<boolean> {
    if (!projectId) {
      return false;
    }

    const repo = projectServiceAccountRepo();
    const count = await repo.count({ where: { project_id: projectId } });
    return count > 0;
  }
}
