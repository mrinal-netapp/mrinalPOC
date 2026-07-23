import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import { Credential } from '../models/Credential';
import { MCPServer } from '../models/MCPServer';
import { getK8sSecretService } from './K8sSecretService';
import { v4 as uuidv4 } from 'uuid';
import { ArrayContains, In, Not } from 'typeorm';
import { ConflictError } from '../utils/errors';
import { isPostgresUniqueViolation } from '../utils/pgErrors';

export interface CreateCredentialInput {
  projectId: string;
  name: string;
  description?: string;
  provider: string;
  metadata?: Record<string, any>;
  labels?: string[];
  expiresAt?: string;
  secretData: Record<string, string>;
}

export interface UpdateCredentialInput {
  name?: string;
  description?: string;
  metadata?: Record<string, any>;
  labels?: string[];
  expiresAt?: string;
}

export interface CredentialListFilter {
  projectId: string;
  provider?: string;
  labels?: string[];
}

export class CredentialService {
  private get repo() {
    return AppDataSource.getRepository(Credential);
  }

  /**
   * Create a new credential: K8s Secret first, then DB row.
   */
  async create(input: CreateCredentialInput): Promise<Credential> {
    const { projectId, name, description, provider, metadata, labels, expiresAt, secretData } = input;
    const trimmedName = String(name ?? '').trim();
    const nameTaken = await this.repo.findOne({ where: { projectId, name: trimmedName } });
    if (nameTaken) {
      throw new ConflictError(
        `Credential with name "${trimmedName}" already exists in this project`
      );
    }

    const shortId = uuidv4().split('-')[0];
    const sanitizedProvider = provider.replace(/[^a-z0-9.-]/g, '-');
    const secretName = `cred-${projectId}-${sanitizedProvider}-${shortId}`;

    const k8s = getK8sSecretService();
    await k8s.createSecret(projectId, secretName, secretData);

    try {
      const credential = this.repo.create({
        projectId,
        name: trimmedName,
        description,
        provider,
        secretName,
        metadata,
        labels,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        rotationVersion: 1,
      });
      return await this.repo.save(credential);
    } catch (dbErr) {
      // Rollback: delete the K8s Secret if DB insert fails
      try {
        await k8s.deleteSecret(secretName);
      } catch (cleanupErr) {
        logger.error('[CredentialService] Failed to cleanup K8s Secret after DB error:', cleanupErr);
      }
      if (isPostgresUniqueViolation(dbErr)) {
        throw new ConflictError(
          `Credential with name "${trimmedName}" already exists in this project`
        );
      }
      throw dbErr;
    }
  }

  /**
   * List credentials for a project with optional provider and label filters.
   */
  async list(filter: CredentialListFilter): Promise<Credential[]> {
    const { projectId, provider, labels } = filter;
    const qb = this.repo.createQueryBuilder('c')
      .where('c.projectId = :projectId', { projectId });

    if (provider) {
      qb.andWhere('c.provider = :provider', { provider });
    }

    if (labels && labels.length > 0) {
      // Match credentials that have ANY of the given labels
      // labels is stored as a comma-separated string by TypeORM simple-array
      const labelConditions = labels.map((label, i) => {
        const param = `label${i}`;
        return `c.labels LIKE :${param}`;
      });
      const labelParams: Record<string, string> = {};
      labels.forEach((label, i) => {
        labelParams[`label${i}`] = `%${label}%`;
      });
      qb.andWhere(`(${labelConditions.join(' OR ')})`, labelParams);
    }

    return qb.orderBy('c.createdAt', 'DESC').getMany();
  }

  /**
   * Get a single credential by id within a project.
   */
  async getById(projectId: string, id: string): Promise<Credential | null> {
    return this.repo.findOne({ where: { id, projectId } });
  }

  /**
   * Update credential metadata, labels, or name. Does not touch the K8s Secret.
   */
  async update(projectId: string, id: string, input: UpdateCredentialInput): Promise<Credential | null> {
    const credential = await this.repo.findOne({ where: { id, projectId } });
    if (!credential) return null;

    if (input.name !== undefined) {
      const next = String(input.name).trim();
      const taken = await this.repo.findOne({
        where: { projectId, name: next, id: Not(id) },
      });
      if (taken) {
        throw new ConflictError(
          `Credential with name "${next}" already exists in this project`
        );
      }
      credential.name = next;
    }
    if (input.description !== undefined) credential.description = input.description;
    if (input.metadata !== undefined) credential.metadata = input.metadata;
    if (input.labels !== undefined) credential.labels = input.labels;
    if (input.expiresAt !== undefined) credential.expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;

    try {
      return await this.repo.save(credential);
    } catch (saveErr) {
      if (isPostgresUniqueViolation(saveErr)) {
        const conflictingName = credential.name;
        throw new ConflictError(
          `Credential with name "${conflictingName}" already exists in this project`
        );
      }
      throw saveErr;
    }
  }

  /**
   * Rotate credential secret while keeping the same credential id/reference.
   */
  async rotateSecret(
    projectId: string,
    id: string,
    secretData: Record<string, string>,
    expiresAt?: string
  ): Promise<Credential | null> {
    const credential = await this.repo.findOne({ where: { id, projectId } });
    if (!credential) return null;

    const entries = Object.entries(secretData || {}).filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim());
    if (entries.length === 0) {
      throw new Error('secretData must include at least one non-empty key/value');
    }

    const normalizedSecretData = Object.fromEntries(entries);
    const k8s = getK8sSecretService();
    await k8s.updateSecret(projectId, credential.secretName, normalizedSecretData);

    credential.lastRotatedAt = new Date();
    credential.rotationVersion = (credential.rotationVersion || 1) + 1;
    if (expiresAt !== undefined) {
      credential.expiresAt = expiresAt ? new Date(expiresAt) : undefined;
    }

    const saved = await this.repo.save(credential);

    // Fan out to managed MCP servers that mirror this credential into a per-pod
    // Secret. Best-effort: rotation succeeds even if downstream sync fails, so
    // operators can retry via the MCP server "redeploy" action. Dynamic import
    // avoids a CredentialService <-> MCPRuntimeManager require cycle.
    void this.fanOutToManagedMcps(projectId, id).catch((err) => {
      logger.error(`[CredentialService] runtime-credential fan-out failed for ${id}:`, err.message);
    });

    return saved;
  }

  private async fanOutToManagedMcps(projectId: string, credentialId: string): Promise<void> {
    const mcpRepo = AppDataSource.getRepository(MCPServer);
    const dependents = await mcpRepo.find({
      where: { projectId, runtimeCredentialId: credentialId, deploymentType: 'managed' as const },
    });
    if (dependents.length === 0) return;

    const [{ getMCPRuntimeManager }, { getCatalogEntry }] = await Promise.all([
      import('./MCPRuntimeManager'),
      import('../catalog/mcpServerCatalog'),
    ]);
    const runtime = getMCPRuntimeManager();

    await Promise.all(dependents.map(async (server) => {
      try {
        if (!server.catalogId) return;
        const entry = getCatalogEntry(server.catalogId);
        if (!entry) return;
        await runtime.syncRuntimeSecret(server, entry);
      } catch (err: any) {
        logger.error(`[CredentialService] syncRuntimeSecret failed for server ${server.id}:`, err.message);
      }
    }));
  }

  /**
   * Delete credential: DB row first, then K8s Secret.
   */
  async delete(projectId: string, id: string): Promise<boolean> {
    const credential = await this.repo.findOne({ where: { id, projectId } });
    if (!credential) return false;

    await this.repo.remove(credential);

    try {
      const k8s = getK8sSecretService();
      await k8s.deleteSecret(credential.secretName);
    } catch (err) {
      logger.error(`[CredentialService] Failed to delete K8s Secret ${credential.secretName}:`, err);
    }

    return true;
  }

  /**
   * Read the raw secret data for a credential (used internally for validation/provider calls).
   * Never expose this to the API response.
   */
  async readSecretData(projectId: string, credentialId: string): Promise<Record<string, string> | null> {
    const credential = await this.repo.findOne({ where: { id: credentialId, projectId } });
    if (!credential) return null;

    const k8s = getK8sSecretService();
    return k8s.readSecret(credential.secretName);
  }

  /**
   * Run a provider adapter's validate with a hard timeout and map any failure
   * to a human-readable reason. A timeout or unreachable provider is NOT a bad
   * key, so the message lets the UI tell the user whether to fix the key or
   * just retry the connection.
   */
  private async runAdapterValidate(
    provider: string,
    secretData: Record<string, string>,
    metadata: Record<string, any> | undefined,
    providerAdapterValidate: (provider: string, credentials: Record<string, string>, metadata?: Record<string, any>) => Promise<boolean>,
    logContext: string
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const timeoutMs = 15_000;
      const result = await Promise.race([
        providerAdapterValidate(provider, secretData, metadata),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Validation timed out')), timeoutMs)
        ),
      ]);
      return { valid: result };
    } catch (err: any) {
      logger.error(`[CredentialService] Validation failed for ${logContext}:`, err.message);
      const status = err?.response?.status;
      let error: string;
      if (status === 401 || status === 403) {
        error = 'Invalid credentials — the provider rejected the key';
      } else if (err?.message === 'Validation timed out' || err?.code === 'ECONNABORTED') {
        error = 'Validation timed out — the provider did not respond in time';
      } else if (err?.code) {
        error = `Could not reach the provider (${err.code})`;
      } else {
        // Surface the adapter's own message verbatim (e.g. ONTAP's
        // "requires either (username + password) or (client_cert_pem + client_key_pem)")
        // instead of a generic string, so the user can tell what is wrong.
        error = err?.message || 'Validation failed';
      }
      return { valid: false, error };
    }
  }

  /**
   * Validate a stored credential by reading its secret and using the
   * appropriate provider adapter. Returns { valid: true } or
   * { valid: false, error: string }.
   */
  async validate(
    projectId: string,
    id: string,
    providerAdapterValidate: (provider: string, credentials: Record<string, string>, metadata?: Record<string, any>) => Promise<boolean>
  ): Promise<{ valid: boolean; error?: string }> {
    const credential = await this.repo.findOne({ where: { id, projectId } });
    if (!credential) {
      return { valid: false, error: 'Credential not found' };
    }

    let secretData: Record<string, string>;
    try {
      const k8s = getK8sSecretService();
      secretData = await k8s.readSecret(credential.secretName);
    } catch (err: any) {
      logger.error(`[CredentialService] Could not read secret for credential ${id}:`, err.message);
      return { valid: false, error: 'Could not read the stored credential secret' };
    }

    return this.runAdapterValidate(
      credential.provider,
      secretData,
      credential.metadata || undefined,
      providerAdapterValidate,
      `credential ${id}`
    );
  }

  /**
   * Validate raw, not-yet-persisted credentials against the live provider.
   * Used by the "validate before save" flow so a bad/unreachable credential is
   * never stored. Nothing is read from or written to the database.
   */
  async validateDraft(
    provider: string,
    secretData: Record<string, string>,
    metadata: Record<string, any> | undefined,
    providerAdapterValidate: (provider: string, credentials: Record<string, string>, metadata?: Record<string, any>) => Promise<boolean>
  ): Promise<{ valid: boolean; error?: string }> {
    return this.runAdapterValidate(
      provider,
      secretData,
      metadata,
      providerAdapterValidate,
      `draft ${provider} credential`
    );
  }
}

/** Singleton instance */
let instance: CredentialService | null = null;

export function getCredentialService(): CredentialService {
  if (!instance) {
    instance = new CredentialService();
  }
  return instance;
}
