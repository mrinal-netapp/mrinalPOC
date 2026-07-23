import { Request, Response } from 'express';
import { AppDataSource } from '../db/postgres';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { ProjectServiceAccountService } from '../services/ProjectServiceAccountService';
import { sendError } from './routeHandler';

const projectRepo = () => new ProjectRepository(AppDataSource);

/**
 * Reject create-shaped requests on a project whose init workflow hasn't
 * finished provisioning its dependencies. Used by POST routes that depend
 * on the project's Bifrost virtual key, the per-project Keycloak client,
 * and the seeded built-in catalog rows (e.g., `POST /projects/:pid/models`
 * for embeddings) so a user can't race the init workflow.
 *
 * Signals checked, in workflow order:
 *
 *   1. Bifrost gateway — `project.metadata._gateway.virtualKeyId` is the
 *      first piece of state that `ensureProjectGateway` (called by
 *      `SetupProjectLLMGatewayActivity`) persists. See
 *      `bifrostProjectGovernance.persistProjectGateway`.
 *
 *   2. Keycloak per-project client — a `ProjectServiceAccount` row exists
 *      once `KeycloakClientService.createProjectServiceAccountClient` has
 *      returned. Without it, downstream flows that mint per-project tokens
 *      (agent-service, MCP servers) cannot authenticate.
 *
 * Returns true when the caller should proceed; returns false and has
 * already written the response (400/404/409) when the caller should bail.
 *
 * Usage:
 *   router.post('/...', async (req, res) => {
 *     if (!await requireProjectInitForCreate(req, res)) return;
 *     // ... handler ...
 *   });
 */
export async function requireProjectInitForCreate(
  req: Request,
  res: Response,
): Promise<boolean> {
  const projectId = req.params.projectId;
  if (!projectId) {
    sendError(res, new Error('projectId is required'), 400);
    return false;
  }

  const project = await projectRepo().getById(projectId);
  if (!project) {
    sendError(res, new Error(`Project ${projectId} not found`), 404);
    return false;
  }

  const gateway = project.metadata?._gateway as
    | { virtualKeyId?: string; teamId?: string }
    | undefined;
  if (!gateway?.virtualKeyId) {
    sendError(
      res,
      new Error(
        `Project ${projectId} gateway setup is not complete yet — retry once the project-init workflow has finished its gateway-setup step`,
      ),
      409,
    );
    return false;
  }

  const keycloakReady = await ProjectServiceAccountService.exists(projectId);
  if (!keycloakReady) {
    sendError(
      res,
      new Error(
        `Project ${projectId} Keycloak client is not provisioned yet — retry once the project-init workflow has finished its identity-setup step`,
      ),
      409,
    );
    return false;
  }

  return true;
}
