import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../db/postgres';
import { DataSet } from '../models/DataSet';
import { DataSetManifest } from '../models/DataSetManifest';
import { DataSetManifestFile } from '../models/DataSetManifestFile';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { CreateProjectRequest, UpdateProjectRequest, ErrorResponse, ProjectInitStatus } from '../types/project';
import { ProjectIdGenerator } from '../utils/ProjectIdGenerator';
import { ProjectInitService } from '../services/ProjectInitService';
import { ProjectDeleteService } from '../services/ProjectDeleteService';
import { ProjectServiceAccountService } from '../services/ProjectServiceAccountService';
import { WorkspaceTemplateService } from '../services/WorkspaceTemplateService';
import { getDefaultBucketName } from '../utils/defaultBucket';
import { removeForProject } from '../services/ReferenceEdgeService';
import { FacetService } from '../services/FacetService';
import { getRouteKeycloakAuthzClient, parsePolicyName, KeycloakAuthzClient } from '../services/KeycloakAuthzClient';
import { teardownProjectGateway } from '../services/bifrost/bifrostProjectGovernance';
import { getLLMGatewayClient } from '../services/gatewayClient';
import { safeLog } from '../utils/safeStrings';

const router = Router();

function getRepositories() {
  if (!AppDataSource.isInitialized) {
    throw new Error('Database not initialized');
  }
  return {
    projectRepo: new ProjectRepository(AppDataSource),
  };
}

// Project API endpoints
router.post('/api/v1/projects', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();

    const requestBody = req.body as CreateProjectRequest;

    if (!requestBody.name) {
      res.status(400).json({
        error: 'name is required',
        code: 'INVALID_REQUEST'
      } as ErrorResponse);
      return;
    }

    // Project init must run as the originating human user so that the
    // resulting Keycloak admin policy is bound to the creator's sub, not the
    // config-service service account. authMiddleware already validated this
    // header; we forward it verbatim to workflow-engine.
    const userAuthHeader = req.headers.authorization;
    if (!userAuthHeader || !req.user?.sub) {
      res.status(401).json({
        error: 'authentication required to create a project',
        code: 'UNAUTHENTICATED'
      } as ErrorResponse);
      return;
    }

    const projectId = ProjectIdGenerator.generate();
    const homeDir = `s3://${getDefaultBucketName()}/projects/${projectId}`;
    const project = await projectRepo.create(requestBody, projectId, homeDir);

    // Seed default workspace templates (JupyterLab, etc.).
    // Runs synchronously before responding so templates are available immediately.
    try {
      await WorkspaceTemplateService.seedDefaultTemplates(projectId);
    } catch (error: any) {
      logger.error(
        `[Project Creation] Failed to seed workspace templates for project ${safeLog(projectId)}: ${safeLog(
          error?.message || error,
        )}`,
      );
    }

    // Trigger async project initialization (Bifrost team/VK, Lakekeeper warehouse
    // + namespace, per-project service account, Keycloak per-project authz).
    // Runs in background and doesn't block the response, but errors are surfaced
    // in logs. The call must carry the originating user's Authorization header.
    try {
      const initService = new ProjectInitService();
      initService.initializeProject(projectId, userAuthHeader).catch((error) => {
        logger.error(
          `[Project Creation] Failed to trigger initialization for project ${safeLog(projectId)}: ${safeLog(
            error?.message || error,
          )}`,
        );
        logger.error(
          `[Project Creation] Error details: ${safeLog(error?.stack || error?.message || error)}`,
        );
      });
    } catch (error: any) {
      logger.error(
        `[Project Creation] Failed to create ProjectInitService for project ${safeLog(projectId)}: ${safeLog(
          error?.message || error,
        )}`,
      );
      logger.error(
        `[Project Creation] Error details: ${safeLog(error?.stack || error?.message || error)}`,
      );
    }

    res.status(201).json(project);
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to create project',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

/**
 * Retry a failed project initialization.
 *
 * Project init runs asynchronously after `POST /projects` returns 201; if the
 * workflow fails, the row is left `init_status='failed'`. This endpoint lets a
 * project admin re-drive the (idempotent) init workflow. Gated to:
 *   - authenticated user (forwards their token so the workflow keeps the owner),
 *   - caller holds admin on the project (the creator is granted admin before
 *     the failure-prone infra steps, so the common failure case is retryable),
 *   - project is currently in `failed` state (rejects `provisioning` and
 *     `ready`, so concurrent retries are not started).
 */
router.post('/api/v1/projects/:projectId/reinitialize', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();
    const projectId = req.params.projectId;

    const callerSub = req.user?.sub;
    const userAuthHeader = req.headers.authorization;
    if (!callerSub || !userAuthHeader) {
      res.status(401).json({ error: 'authentication required', code: 'UNAUTHENTICATED' } as ErrorResponse);
      return;
    }

    const project = await projectRepo.getById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' } as ErrorResponse);
      return;
    }

    if (project.init_status !== ProjectInitStatus.Failed) {
      res.status(409).json({
        error: `project init_status is '${project.init_status}'; only a 'failed' project can be reinitialized`,
        code: 'CONFLICT',
      } as ErrorResponse);
      return;
    }

    // Authorize: caller must hold admin on this project.
    let kc: KeycloakAuthzClient;
    try {
      kc = getRouteKeycloakAuthzClient();
    } catch (err: any) {
      logger.error(`[Project Reinitialize] Failed to initialize Keycloak authz client: ${safeLog(err?.message)}`);
      res.status(500).json({ error: 'internal configuration error', code: 'INTERNAL_ERROR' } as ErrorResponse);
      return;
    }
    let policies;
    try {
      policies = await kc.listPolicies(`usr-${callerSub}-proj-${projectId}-`, 50);
    } catch (err: any) {
      logger.error(`[Project Reinitialize] Keycloak listPolicies query failed: ${safeLog(err?.message)}`);
      res.status(500).json({ error: 'failed to verify authorization', code: 'INTERNAL_ERROR' } as ErrorResponse);
      return;
    }
    const isAdmin = policies.some((p) => {
      const parsed = parsePolicyName(p.name);
      return parsed && parsed.userId === callerSub && parsed.projectId === projectId && parsed.role === 'admin';
    });
    if (!isAdmin) {
      res.status(403).json({ error: 'admin scope required on this project', code: 'FORBIDDEN' } as ErrorResponse);
      return;
    }

    // Reset to provisioning and re-trigger the (idempotent) init workflow with
    // the caller's token so the owner grant is preserved.
    const previousError = project.init_error ?? null;
    await projectRepo.setInitStatus(projectId, ProjectInitStatus.Provisioning, null);
    try {
      const initService = new ProjectInitService();
      await initService.initializeProject(projectId, userAuthHeader);
    } catch (error: any) {
      await projectRepo.setInitStatus(
        projectId,
        ProjectInitStatus.Failed,
        previousError ?? 'failed to trigger reinitialization',
      );
      logger.error(
        `[Project Reinitialize] Failed to trigger reinitialization for project ${safeLog(projectId)}: ${safeLog(error?.message || error)}`,
      );
      res.status(502).json({
        error: 'failed to trigger reinitialization',
        code: 'UPSTREAM_ERROR',
      } as ErrorResponse);
      return;
    }

    res.status(202).json({ projectId, status: ProjectInitStatus.Provisioning });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to reinitialize project',
      code: 'INTERNAL_ERROR',
    } as ErrorResponse);
  }
});

router.get('/api/v1/projects/:projectId', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();

    const projectId = req.params.projectId;
    const project = await projectRepo.getById(projectId);
    
    if (!project) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    res.json(project);
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get project',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

router.put('/api/v1/projects/:projectId', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();

    const projectId = req.params.projectId;
    
    if (!await projectRepo.exists(projectId)) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    const requestBody = req.body as UpdateProjectRequest;
    const project = await projectRepo.update(projectId, requestBody);
    res.json(project);
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to update project',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

router.delete('/api/v1/projects/:projectId', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();

    const projectId = req.params.projectId;
    
    const project = await projectRepo.getById(projectId);
    if (!project) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    // Capture the cached Bifrost team / VK ids BEFORE the project row is
    // dropped, so the async `ProjectDeleteWorkflow` Step 0
    // (`TeardownProjectLLMGatewayActivity`) can still find them in
    // Bifrost's `config_store` to drop. The workflow runs after the
    // handler returns 204 -- by then the row is gone, and the legacy
    // DB-read fallback in `teardownProjectGateway` would have nothing
    // to work with. The VK bearer TOKEN deliberately stays out of this
    // payload (it lives only in the K8s Secret; the gateway-teardown
    // endpoint doesn't need it to drop the VK).
    const cachedGateway = (project.metadata as Record<string, unknown> | undefined)?._gateway as
      | { teamId?: string; teamName?: string; virtualKeyId?: string; virtualKeyName?: string }
      | undefined;
    const gatewayMeta = cachedGateway && (cachedGateway.teamId || cachedGateway.virtualKeyId)
      ? {
          teamId: cachedGateway.teamId,
          teamName: cachedGateway.teamName,
          virtualKeyId: cachedGateway.virtualKeyId,
          virtualKeyName: cachedGateway.virtualKeyName,
        }
      : undefined;

    // Tear down Bifrost team / VK / models / MCP clients synchronously while
    // the project row and its child models/MCP servers are still in Postgres.
    // The async ProjectDeleteWorkflow Step 0 re-runs the same teardown
    // idempotently (404-tolerant) as a retry path; doing it here first means
    // Bifrost cleanup does not depend solely on Temporal succeeding.
    try {
      const gateway = getLLMGatewayClient();
      const teardown = await teardownProjectGateway(projectId, gateway, gatewayMeta);
      logger.info(
        `[Project Deletion] Bifrost teardown for project ${safeLog(projectId)}: ` +
          `models=${teardown.modelsRemoved}/${teardown.modelsFound}, ` +
          `mcp=${teardown.mcpServersRemoved}/${teardown.mcpServersFound}, ` +
          `vk=${teardown.virtualKeyDeleted}, team=${teardown.teamDeleted}, ` +
          `sweep(mcp=${teardown.sweepMcpClientsRemoved}, vk=${teardown.sweepVirtualKeysRemoved})`,
      );
    } catch (error: any) {
      logger.warn(
        `[Project Deletion] Bifrost teardown failed for project ${safeLog(projectId)}: ${safeLog(error?.message || error)} (workflow Step 0 will retry)`,
      );
    }

    // Trigger async ProjectDeleteWorkflow. It now owns BOTH the
    // Bifrost team / VK teardown (Step 0, symmetric counterpart of
    // `ProjectInitWorkflow`'s `SetupProjectLLMGatewayActivity`) AND
    // the existing Iceberg / S3 / per-credential-secret cleanup
    // (Steps 1-7). Fire-and-forget: the handler returns 204 once the
    // row is dropped so the UI list updates immediately; the workflow
    // retries each step independently on transient failure.
    // NOTE: each console.* below is intentionally called with a SINGLE
    // string argument (no trailing printf args). Node treats the first
    // arg of console.* as a printf-style format string only when
    // additional args are present, so collapsing the message into one
    // concatenated string removes the format-string interpretation
    // path entirely (CodeQL js/tainted-format-string).
    try {
      const deleteService = new ProjectDeleteService();
      deleteService.deleteProject(projectId, project.home_dir, gatewayMeta).catch((error) => {
        logger.error(
          `[Project Deletion] Failed to trigger deletion workflow for project ${safeLog(projectId)}: ${safeLog(error?.message || error)}`,
        );
        // Error is logged but doesn't affect project deletion from database
      });
    } catch (error: any) {
      logger.error(
        `[Project Deletion] Failed to create ProjectDeleteService for project ${safeLog(projectId)}: ${safeLog(error?.message || error)}`,
      );
      // Continue with project deletion even if cleanup service fails
    }

    // Drop reference edges scoped to this project. The edge table has no
    // FK to entity tables (by design) so it must be cleaned up explicitly.
    try {
      const removed = await removeForProject(undefined, projectId);
      if (removed > 0) {
        logger.log(`[Project Deletion] Removed ${removed} reference edges for project ${safeLog(projectId)}`);
      }
    } catch (error: any) {
      logger.warn(
        `[Project Deletion] Failed to clean reference edges for project ${safeLog(projectId)}: ${safeLog(error?.message || error)}`,
      );
    }

    // Drop facets scoped to this project (lineage, future project-level facets).
    try {
      const removedFacets = await FacetService.deleteForProject(projectId);
      if (removedFacets > 0) {
        logger.log(`[Project Deletion] Removed ${removedFacets} facets for project ${safeLog(projectId)}`);
      }
    } catch (error: any) {
      logger.warn(
        `[Project Deletion] Failed to clean facets for project ${safeLog(projectId)}: ${safeLog(error?.message || error)}`,
      );
    }

    // Bifrost team / VK teardown runs synchronously in this handler (while
    // models/MCP rows still exist) and is retried by `ProjectDeleteWorkflow`
    // Step 0 (`TeardownProjectLLMGatewayActivity`) for idempotent recovery.
    // The `gatewayMeta` captured above is forwarded into the workflow input so
    // Step 0 can still find the VK / team to drop even after the project row
    // is gone.

    await projectRepo.delete(projectId);
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to delete project',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

router.get('/api/v1/projects', async (req: Request, res: Response) => {
  // Caller-scoped: list only the projects the authenticated user is a member
  // of. Keycloak Authorization Services is the source of truth for membership
  // (the `usr-{userId}-proj-{projectId}-{role}` policy convention); this handler
  // joins those project ids back onto config-service's project metadata and
  // annotates each entry with the caller's role.
  const callerSub = req.user?.sub;
  if (!callerSub) {
    return res.status(401).json({
      error: 'authentication required',
      code: 'UNAUTHENTICATED',
    } as ErrorResponse);
  }

  let kc: KeycloakAuthzClient;
  try {
    kc = getRouteKeycloakAuthzClient();
  } catch (err: any) {
    // Log the underlying cause server-side (often a missing env var) but
    // return a stable, non-leaky message to the caller.
    logger.error(`[Projects List] Failed to initialize Keycloak authz client: ${safeLog(err?.message)}`);
    return res.status(500).json({
      error: 'internal configuration error',
      code: 'INTERNAL_ERROR',
    } as ErrorResponse);
  }

  // Narrow the server-side query to this caller's policies only so we don't
  // scan every user policy in the realm.
  const prefix = `usr-${callerSub}-proj-`;
  let policies;
  try {
    policies = await kc.listPolicies(prefix, 500);
  } catch (err: any) {
    // listPolicies embeds Keycloak status/body details in its error text;
    // log it server-side and return a stable message so we don't leak
    // internal Keycloak information to clients.
    logger.error(`[Projects List] Keycloak listPolicies query failed: ${safeLog(err?.message)}`);
    return res.status(500).json({
      error: 'failed to query user projects',
      code: 'INTERNAL_ERROR',
    } as ErrorResponse);
  }

  // Map projectId -> role for this caller. parsePolicyName enforces the exact
  // shape; the userId check is a defensive belt-and-brace against substring
  // matches the prefix search might let through.
  const roleByProjectId = new Map<string, string>();
  for (const p of policies) {
    const parsed = parsePolicyName(p.name);
    if (parsed && parsed.userId === callerSub) {
      roleByProjectId.set(parsed.projectId, parsed.role);
    }
  }

  try {
    const { projectRepo } = getRepositories();
    const projectIds = [...roleByProjectId.keys()];
    const projects = await projectRepo.listByIds(projectIds);
    const withRole = projects.map((project) => ({
      ...project,
      role: roleByProjectId.get(project.id),
    }));
    res.json({ projects: withRole });
  } catch (error: any) {
    logger.error(`[Projects List] Failed to load project metadata: ${safeLog(error?.message)}`);
    res.status(500).json({
      error: 'failed to list projects',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

// Project membership endpoints have moved.
//
// Reads (`GET /api/v1/projects/:projectId/members`) are now served by
// `projectMembershipRoutes.ts` and back onto Keycloak Authorization Services
// policies — see PR #31 and docs/design/keycloak-per-project-authorization.md.
// The caller's own project list is served by `GET /api/v1/projects` above,
// which joins the caller's Keycloak memberships onto project metadata.
//
// Writes (`POST/DELETE/PUT` on /projects/:projectId/members*) live in
// workflow-engine because they start Temporal workflows
// (StartProjectAddUser / StartProjectRemoveUser / StartProjectChangeRole) that
// transactionally update Keycloak.
//
// The previous DB-backed implementations here were placeholder stubs (every
// authenticated user was treated as a project member; admin checks were
// no-ops) and have been removed to avoid two competing membership stores.
// Create project service account
router.post('/api/v1/projects/:projectId/service-account', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();
    const projectId = req.params.projectId;

    // Check if project exists
    if (!await projectRepo.exists(projectId)) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    // Create service account (idempotent - returns existing if already created)
    const serviceAccount = await ProjectServiceAccountService.create(projectId);
    
    res.status(201).json(serviceAccount);
  } catch (error: any) {
    // If service account already exists, return 200 with existing account
    if (error.message?.includes('already exists')) {
      try {
        const serviceAccount = await ProjectServiceAccountService.getByProjectId(req.params.projectId);
        res.status(200).json({
          projectId: serviceAccount.projectId,
          clientId: serviceAccount.clientId,
          createdAt: serviceAccount.createdAt,
        });
        return;
      } catch (getError: any) {
        // Fall through to error handling
      }
    }
    
    res.status(500).json({
      error: error.message || 'Failed to create project service account',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

// Get project service account
router.get('/api/v1/projects/:projectId/service-account', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();
    const projectId = req.params.projectId;

    // Check if project exists
    if (!await projectRepo.exists(projectId)) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    // Get service account (includes client secret)
    const serviceAccount = await ProjectServiceAccountService.getByProjectId(projectId);
    
    res.json({
      projectId: serviceAccount.projectId,
      clientId: serviceAccount.clientId,
      clientSecret: serviceAccount.clientSecret,
      createdAt: serviceAccount.createdAt,
    });
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      res.status(404).json({
        error: error.message || 'Service account not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }
    
    res.status(500).json({
      error: error.message || 'Failed to get project service account',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

/**
 * Aggregated dataset metrics for project overview (no per-dataset round trips).
 */
router.get('/api/v1/projects/:projectId/overview-dataset-metrics', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();
    const projectId = req.params.projectId;

    if (!await projectRepo.exists(projectId)) {
      res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND'
      } as ErrorResponse);
      return;
    }

    const dsRepo = AppDataSource.getRepository(DataSet);
    const structured = await dsRepo.count({ where: { projectId, kind: 'structured' } });
    const unstructured = await dsRepo.count({ where: { projectId, kind: 'unstructured' } });

    const manifestRepo = AppDataSource.getRepository(DataSetManifest);
    const manifestVersions = await manifestRepo
      .createQueryBuilder('m')
      .innerJoin(DataSet, 'd', 'd.id = m.dataSetId')
      .where('d.projectId = :projectId', { projectId })
      .getCount();

    const fileRepo = AppDataSource.getRepository(DataSetManifestFile);
    const filesInManifests = await fileRepo
      .createQueryBuilder('f')
      .innerJoin(DataSetManifest, 'm', 'm.id = f.manifestId')
      .innerJoin(DataSet, 'd', 'd.id = m.dataSetId')
      .where('d.projectId = :projectId', { projectId })
      .getCount();

    res.json({
      structured,
      unstructured,
      datasetsTotal: structured + unstructured,
      manifestVersions,
      filesInManifests,
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to load dataset metrics',
      code: 'INTERNAL_ERROR'
    } as ErrorResponse);
  }
});

// ─── Project-level facet routes ─────────────────────────────────────────────

router.get('/api/v1/projects/:projectId/facets/:facetType', async (req: Request, res: Response) => {
  try {
    const { projectRepo } = getRepositories();
    const { projectId, facetType } = req.params;

    if (!await projectRepo.exists(projectId)) {
      res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' } as ErrorResponse);
      return;
    }

    const facet = await FacetService.getFacet(projectId, 'project', projectId, facetType);
    if (!facet) {
      res.status(404).json({ error: `Facet '${facetType}' not found for this project`, code: 'NOT_FOUND' } as ErrorResponse);
      return;
    }

    res.json({ data: facet });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get project facet', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

export default router;
