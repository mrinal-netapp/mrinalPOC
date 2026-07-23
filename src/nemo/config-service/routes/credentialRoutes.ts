import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Router, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { getCredentialService } from '../services/CredentialService';
import { getProviderRegistry } from '../providers/registry';
import {
  createCredentialValidator,
  updateCredentialValidator,
  rotateCredentialValidator,
} from '../validators/credentialValidator';
import {
  hasDependents,
  summaryForTargets,
  listDependents,
  removeForSource,
} from '../services/ReferenceEdgeService';
import { sendErrorResponse } from '../utils/errorHandler';

const router = Router({ mergeParams: true });

const toCredentialResponse = (credential: any) => ({
  id: credential.id,
  projectId: credential.projectId,
  name: credential.name,
  description: credential.description,
  provider: credential.provider,
  metadata: credential.metadata,
  labels: credential.labels,
  expiresAt: credential.expiresAt,
  lastRotatedAt: credential.lastRotatedAt,
  rotationVersion: credential.rotationVersion,
  createdAt: credential.createdAt,
  updatedAt: credential.updatedAt,
});

/**
 * POST /api/v1/projects/:projectId/credentials
 * Create a new credential (stores secret in K8s, metadata in DB).
 */
router.post('/', createCredentialValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId } = req.params;
    const { name, description, provider, metadata, labels, expiresAt, secretData } = req.body;

    const service = getCredentialService();
    const credential = await service.create({
      projectId,
      name,
      description,
      provider,
      metadata,
      labels,
      expiresAt,
      secretData,
    });

    // Return without secret data
    res.status(201).json(toCredentialResponse(credential));
  } catch (err: unknown) {
    logger.error('[credentialRoutes] Create error:', err instanceof Error ? err.message : err);
    sendErrorResponse(res, err instanceof Error ? err : new Error(String(err)));
  }
});

/**
 * GET /api/v1/projects/:projectId/credentials
 * List credentials for a project. Query params: ?provider=...&labels=tag1,tag2
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const provider = req.query.provider as string | undefined;
    const labelsParam = req.query.labels as string | undefined;
    const labels = labelsParam ? labelsParam.split(',').map(l => l.trim()).filter(Boolean) : undefined;

    const service = getCredentialService();
    const credentials = await service.list({ projectId, provider, labels });

    // Never return secret data
    const result = credentials.map((c) => toCredentialResponse(c));

    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary || result.length === 0) {
      return res.json(result);
    }
    const summary = await summaryForTargets('credential', projectId, result.map((c) => c.id));
    res.json(result.map((c) => ({
      ...c,
      dependentsSummary: summary.get(c.id) ?? { total: 0, byKind: {} },
    })));
  } catch (err: any) {
    logger.error('[credentialRoutes] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/projects/:projectId/credentials/:id
 * Get a single credential.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const service = getCredentialService();
    const credential = await service.getById(projectId, id);
    if (!credential) return res.status(404).json({ error: 'Credential not found' });

    res.json(toCredentialResponse(credential));
  } catch (err: any) {
    logger.error('[credentialRoutes] Get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/v1/projects/:projectId/credentials/:id
 * Update credential name, metadata, or labels. Does not update the secret.
 */
router.patch('/:id', updateCredentialValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, id } = req.params;
    const { name, description, metadata, labels, expiresAt } = req.body;

    const service = getCredentialService();
    const updated = await service.update(projectId, id, { name, description, metadata, labels, expiresAt });
    if (!updated) return res.status(404).json({ error: 'Credential not found' });

    res.json(toCredentialResponse(updated));
  } catch (err: unknown) {
    logger.error('[credentialRoutes] Update error:', err instanceof Error ? err.message : err);
    sendErrorResponse(res, err instanceof Error ? err : new Error(String(err)));
  }
});

/**
 * DELETE /api/v1/projects/:projectId/credentials/:id
 * Delete a credential and its K8s Secret.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;

    if (await hasDependents('credential', projectId, id)) {
      const page = await listDependents('credential', projectId, id, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this credential because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }

    const service = getCredentialService();
    const deleted = await service.delete(projectId, id);
    if (!deleted) return res.status(404).json({ error: 'Credential not found' });
    await removeForSource(undefined, 'credential', projectId, id);
    res.status(204).send();
  } catch (err: any) {
    logger.error('[credentialRoutes] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/projects/:projectId/credentials/:id/dependents
 * Paginated dependents for a credential (used by delete dialog and the
 * "Used by" popover).
 */
router.get('/:id/dependents', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const service = getCredentialService();
    const credential = await service.getById(projectId, id);
    if (!credential) return res.status(404).json({ error: 'Credential not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('credential', projectId, id, { limit, cursor, kind });
    res.json(page);
  } catch (err: any) {
    logger.error('[credentialRoutes] Dependents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/projects/:projectId/credentials/:id/secret-data
 * Returns the raw secret data for a credential.
 * Restricted to service-account JWTs (connector-worker / workflow-engine).
 */
router.post('/:id/secret-data', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;

    // TODO: Restrict to service-account JWT by checking client_id claim
    // For now, any authenticated request is accepted; tighten before production.

    const service = getCredentialService();
    const secretData = await service.readSecretData(projectId, id);
    if (!secretData) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    res.json(secretData);
  } catch (err: any) {
    logger.error('[credentialRoutes] Secret-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/projects/:projectId/credentials/validate
 * Dry-run: validate raw credentials against the live provider WITHOUT
 * persisting anything. Used by the "validate before save" flow so a bad or
 * unreachable credential never gets stored. Body: { provider, secretData, metadata? }.
 */
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { provider, secretData, metadata } = req.body || {};
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (!secretData || typeof secretData !== 'object' || Array.isArray(secretData)) {
      return res.status(400).json({ error: 'secretData object is required' });
    }

    const service = getCredentialService();
    const registry = getProviderRegistry();

    const result = await service.validateDraft(
      provider,
      secretData,
      metadata,
      (p, credentials, m) => registry.validate(p, credentials, m)
    );

    res.json(result);
  } catch (err: any) {
    logger.error('[credentialRoutes] Draft validate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/projects/:projectId/credentials/:id/validate
 * Validate that the credential is valid and the provider is reachable.
 */
router.post('/:id/validate', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const service = getCredentialService();
    const registry = getProviderRegistry();

    const result = await service.validate(
      projectId,
      id,
      (provider, credentials, metadata) => registry.validate(provider, credentials, metadata)
    );

    res.json(result);
  } catch (err: any) {
    logger.error('[credentialRoutes] Validate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/projects/:projectId/credentials/:id/rotate
 * Rotate a credential's secret while preserving credential id/references.
 */
router.post('/:id/rotate', rotateCredentialValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, id } = req.params;
    const { secretData, expiresAt } = req.body;

    const service = getCredentialService();
    const updated = await service.rotateSecret(projectId, id, secretData, expiresAt);
    if (!updated) return res.status(404).json({ error: 'Credential not found' });

    res.json(toCredentialResponse(updated));
  } catch (err: any) {
    logger.error('[credentialRoutes] Rotate error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

export default router;
