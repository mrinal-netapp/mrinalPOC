import 'reflect-metadata';
import { Router } from 'express';
import { get_logger } from '@agentstudio/observability-client-runtime';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import { AppDataSource } from '../db/postgres';
import { Project } from '../models/Project';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { PROJECT_INIT_STATUS_VALUES, ProjectInitStatus } from '../types/project';
import {
  ensureProjectGateway,
  teardownProjectGateway,
  listProjectsForVirtualKeyRotation,
  rotateProjectVirtualKey,
  deleteRetiredProjectVirtualKey,
  attachPlatformMcpServersToProjectVirtualKey,
  PreloadedProjectGateway,
} from '../services/bifrost/bifrostProjectGovernance';
import { getLLMGatewayClient } from '../services/gatewayClient';
import { BuiltinModelsService } from '../services/BuiltinModelsService';
import { safeLog } from '../utils/safeStrings';

const logger = get_logger();

/**
 * Internal admin endpoints for the project lifecycle.
 *
 * Called by Temporal workflows in the workflow-engine. Mounted at
 * `/api/v1/internal/projects` in `index.ts`. Auth is the same service-account
 * pattern used by the existing internal/mcp-servers and internal/reference-edges
 * routes; both rely on the per-request auth middleware applied at app level.
 *
 * Mirrors the thin-shim shape of other internal routes: a Go activity
 * POSTs here and we delegate to the existing in-process service.
 */
const router = Router();

/**
 * List project ids that have an active Bifrost virtual key (for the
 * scheduled VK rotation fan-out workflow).
 */
router.get('/gateway-rotation-targets', asyncHandler(async (_req, res) => {
  const projectIds = await listProjectsForVirtualKeyRotation();
  sendSuccess(res, { projectIds });
}));

/**
 * Record the terminal project-init status.
 *
 * Called by `ProjectInitWorkflow` (via ReportProjectInitStatusActivity) once
 * init finishes, so a failed init is visible on the project row instead of
 * living only in Temporal history. Body: `{ status: 'ready' | 'failed' |
 * 'provisioning', error?: string }`. Idempotent — writing the same status is a
 * no-op. 404 if the project row is gone (deleted mid-init).
 */
router.post('/:projectId/init-status', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const body = (req.body ?? {}) as { status?: string; error?: string };
  if (!body.status || !PROJECT_INIT_STATUS_VALUES.includes(body.status as ProjectInitStatus)) {
    return sendError(
      res,
      new Error(`status must be one of: ${PROJECT_INIT_STATUS_VALUES.join(', ')}`),
      400,
    );
  }

  const status = body.status as ProjectInitStatus;
  const repo = new ProjectRepository(AppDataSource);
  const updated = await repo.setInitStatus(
    projectId,
    status,
    status === ProjectInitStatus.Failed ? (body.error ?? null) : null,
  );
  if (!updated) {
    return sendError(res, new Error(`Project ${projectId} not found`), 404);
  }

  logger.info(`[internalProjectRoutes] init-status for project ${safeLog(projectId)} set to ${safeLog(body.status)}`);
  sendSuccess(res, { projectId, initStatus: body.status });
}));

/**
 * Ensure the Bifrost team + virtual key exist for this project.
 *
 * Delegates to `ensureProjectGateway`, which is fully idempotent: existing
 * team/VK get reused, and the call is a fast cache-hit no-op once the ids
 * are persisted on `project.metadata._gateway`. Safe to retry from Temporal.
 *
 * Used as a step of `ProjectInitWorkflow` so Bifrost setup happens after
 * the project endpoint has already returned 201 - no latency hit on the
 * caller, terminal failure surfaces through the workflow result.
 */
router.post('/:projectId/gateway-setup', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  // Reject early if the project row doesn't exist - the workflow shouldn't
  // be running against a deleted project.
  const repo = AppDataSource.getRepository(Project);
  const exists = await repo.findOne({ where: { id: projectId } });
  if (!exists) {
    return sendError(res, new Error(`Project ${projectId} not found`), 404);
  }

  const gateway = await ensureProjectGateway(projectId);
  if (!gateway) {
    return sendError(res, new Error('ensureProjectGateway returned null'), 500);
  }

  // Seed system-managed built-in embedding models for this project and
  // register them with Bifrost so the project's virtual key has explicit
  // allowed_models entries. Both calls are idempotent; the gateway
  // registration uses a custom openai-compatible provider per TEI service
  // (see BifrostGatewayClient.addBuiltinModel).
  //
  // Wrapped in try/catch so a seeding/registration failure does not break
  // gateway-setup: the project's gateway team/VK is the workflow's source
  // of truth, and the startup backfill will converge any partial state on
  // next restart.
  try {
    const builtins = new BuiltinModelsService(AppDataSource);
    await builtins.seedBuiltinsForProject(projectId);
    await builtins.registerBuiltinsWithGatewayForProject(projectId);
  } catch (err: any) {
    logger.warn(
      `[internalProjectRoutes] Built-in model setup for project ${safeLog(projectId)} failed: ${safeLog(err?.message || err)}`,
    );
  }

  // Attach the shared platform-managed MCP clients (artifact-store, analytics,
  // ...) to this project's virtual key. Platform MCP servers register their
  // Bifrost client with `allow_on_all_virtual_keys: false`, so without this the
  // project VK cannot reach their tools even though the agent read-shape
  // advertises them. Idempotent + best-effort: a failure here must not break
  // gateway setup (the team/VK is the workflow's source of truth), and the
  // attach re-runs on the next idempotent gateway-setup.
  try {
    await attachPlatformMcpServersToProjectVirtualKey(projectId);
  } catch (err: any) {
    logger.warn(
      `[internalProjectRoutes] Platform MCP attach for project ${safeLog(projectId)} failed: ${safeLog(err?.message || err)}`,
    );
  }

  sendSuccess(res, {
    projectId,
    teamId: gateway.teamId,
    teamName: gateway.teamName,
    virtualKeyId: gateway.virtualKeyId,
    virtualKeyName: gateway.virtualKeyName,
    // Never echo the VK bearer token in this response - the workflow has
    // no business holding it. It's already persisted on the project row.
  });
}));

/**
 * Tear down the Bifrost team + virtual key for this project.
 *
 * Mirror of `gateway-setup` above and the symmetric counterpart of
 * `ProjectInitWorkflow` Step 0 (`SetupProjectLLMGatewayActivity`). Called
 * by `ProjectDeleteWorkflow` Step 0 (`TeardownProjectLLMGatewayActivity`)
 * so the per-project team / VK / MCP-client / routing-rule cleanup runs
 * inside Temporal with retries + observable workflow history, instead of
 * inline in the DELETE-route handler.
 *
 * The DELETE handler captures `project.metadata._gateway` BEFORE kicking
 * the workflow off and forwards it here as the request body, because by
 * the time this activity executes the project row may already have been
 * dropped (the handler returns 204 immediately after starting the
 * workflow, then deletes the row inline so the UI list updates straight
 * away). Without the preloaded ids, `teardownProjectGateway` would have
 * no way to find the VK / team in Bifrost's `config_store`.
 *
 * Idempotent / 404-tolerant end-to-end: every Bifrost call inside
 * `teardownProjectGateway` treats already-deleted as success, so Temporal
 * is free to retry on transient failures.
 *
 * Deliberately does NOT 404 when the project row is gone -- the workflow
 * needs to be able to clean up Bifrost state for a deleted project.
 */
router.post('/:projectId/gateway-teardown', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const body = (req.body ?? {}) as PreloadedProjectGateway;
  const preloaded: PreloadedProjectGateway = {
    teamId: typeof body.teamId === 'string' ? body.teamId : null,
    teamName: typeof body.teamName === 'string' ? body.teamName : null,
    virtualKeyId: typeof body.virtualKeyId === 'string' ? body.virtualKeyId : null,
    virtualKeyName: typeof body.virtualKeyName === 'string' ? body.virtualKeyName : null,
  };

  const gateway = getLLMGatewayClient();
  const result = await teardownProjectGateway(projectId, gateway, preloaded);

  console.log(
    `[internalProjectRoutes] Bifrost teardown for project ${safeLog(projectId)}: ` +
      `models=${result.modelsRemoved}/${result.modelsFound} ` +
      `(${result.modelsFailed} failed), ` +
      `mcp_servers=${result.mcpServersRemoved}/${result.mcpServersFound} ` +
      `(${result.mcpServersFailed} failed), ` +
      `vk=${result.virtualKeyDeleted} team=${result.teamDeleted} ` +
      `secret=${result.tokenSecretDeleted}, ` +
      `sweep(mcp=${result.sweepMcpClientsRemoved}, model_cfg=${result.sweepModelConfigsRemoved}, ` +
      `provider=${result.sweepProviderBindingsRemoved}, vk=${result.sweepVirtualKeysRemoved}, ` +
      `team=${result.sweepTeamsRemoved})`,
  );

  sendSuccess(res, { projectId, ...result });
}));

/**
 * Rotate the project's Bifrost virtual key (`POST .../rotate` on v1.5.7+),
 * write the new bearer to K8s Secret `as-proj-{projectId}-vk`, set
 * vkRotationPending for the grace-period workflow step. Idempotent while
 * rotation is in flight (re-syncs K8s from Bifrost on retry).
 */
router.post('/:projectId/gateway-rotate', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const result = await rotateProjectVirtualKey(projectId);
  sendSuccess(res, result);
}));

/**
 * Finalize rotation after grace: `POST .../promote-secondary` (or legacy
 * delete of a replacement VK). Clears vkRotationPending from metadata.
 */
router.post('/:projectId/gateway-rotate-complete', asyncHandler(async (req, res) => {
  const { projectId } = req.params;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const result = await deleteRetiredProjectVirtualKey(projectId);
  sendSuccess(res, result);
}));

export default router;
