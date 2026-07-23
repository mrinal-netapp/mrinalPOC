import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router } from 'express';
import { IsNull, Not } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { MCPServer } from '../models/MCPServer';
import { getLLMGatewayClient } from '../services/gatewayClient';
import { asyncHandler, sendError, sendSuccess } from '../utils/routeHandler';
import {
  buildGatewayServerConfig,
  resolveCredentialData,
} from './mcpServerRoutes';
import { safeLog } from '../utils/safeStrings';

const router = Router();

/**
 * Parse a positive-integer env var, falling back to `fallback` when the
 * value is missing, non-numeric, NaN, infinite, or non-positive. The
 * naive `Number(process.env.X ?? '3')` returns NaN for non-numeric env
 * values and silently breaks downstream comparisons (e.g. a NaN budget
 * means the budget check never fires); this guard makes the failure
 * mode "use the default" instead of "silently disabled".
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      `[internalMcpHealthRoutes] Invalid ${name}=${JSON.stringify(raw)}; ` +
        `falling back to ${fallback}`,
    );
    return fallback;
  }
  return n;
}

const CIRCUIT_BREAKER_THRESHOLD = intFromEnv('MCP_CIRCUIT_BREAKER_THRESHOLD', 3);
/**
 * Wallclock cap on the lazy-re-registration work this endpoint performs
 * before returning the eligibility list. The workflow-engine's HTTP
 * client to config-service has a 30s timeout; we want to finish well
 * inside that even when many servers need re-registration, so we stop
 * starting new batches once this budget elapses. Anything not registered
 * in this cycle stays non-synced and will be retried next cycle.
 */
const REREGISTER_BUDGET_MS = intFromEnv('MCP_HEALTH_REREGISTER_BUDGET_MS', 20000);

/**
 * /health-eligible returns every MCP row the workflow-engine should probe
 * this cycle.
 *
 * Eligibility rules:
 *   - Has a llmproxyGatewayServerName (required for the Bifrost-routed probe).
 *   - runtimeStatus is not 'provisioning' or 'deleting' (managed-MCP
 *     lifecycle states where probing would race the runtime manager).
 *
 * We intentionally do NOT exclude servers with non-`synced` syncStatus.
 * Doing so used to cause an unrecoverable loop: a server that tripped the
 * consecutive-failure circuit breaker was set to `syncStatus='suspended'`,
 * removed from the gateway, and from then on dropped from this list — so
 * it could never be probed again, and the auto-recovery path in
 * PATCH /:id/status (suspended→synced on connected probe) never ran.
 *
 * For any row whose `syncStatus` is not `'synced'`, we attempt an
 * idempotent (re-)registration with the Bifrost gateway before returning
 * the list. If the gateway accepts the server, the row is updated to
 * `syncStatus='synced'` + the new `llmproxyGatewayServerId`. If the gateway
 * rejects it, we still include the row in the result so the probe
 * failure is visible in the cycle's counts; the failure will simply
 * route back through PATCH /:id/status just like any other unhealthy
 * server.
 */
router.get('/health-eligible', asyncHandler(async (_req, res) => {
  const repo = AppDataSource.getRepository(MCPServer);
  // We load the FULL MCPServer entity (not a narrow projection) so
  // lazy re-registration via buildGatewayServerConfig has access to
  // staticHeaders / queryParams / headerParams / authConfig /
  // credentialId / command / args / env / allowedTools / disallowedTools.
  // Without those, a server originally registered with credentials or
  // resolved headers would be re-added with an incomplete config and
  // the probe would keep failing.
  const items = await repo.find({
    where: {
      llmproxyGatewayServerName: Not(IsNull()),
    },
  });

  const eligible = items.filter((server) => (
    server.runtimeStatus !== 'provisioning' && server.runtimeStatus !== 'deleting'
  ));

  // Lazily (re-)register any non-synced rows so the probe has something
  // to hit. Best-effort: failures don't drop the row from the result.
  //
  // Concurrency cap mirrors the workflow-engine probe's concurrency
  // (mcpHealthConcurrency=5) so this endpoint stays predictable under
  // load even when many MCPs are non-synced at once. Sequential batches
  // of REGISTER_CONCURRENCY at a time keep the gateway/DB call rate
  // bounded without serialising the whole list.
  //
  // A wallclock budget (REREGISTER_BUDGET_MS) caps total time spent
  // here so we always return before the workflow-engine's 30s HTTP
  // timeout. Rows not reached this cycle stay non-synced and will be
  // retried next cycle.
  const REGISTER_CONCURRENCY = 5;
  const gateway = getLLMGatewayClient();
  const startedAt = Date.now();
  let registeredCount = 0;
  let skippedForBudget = 0;
  if (gateway.isEnabled()) {
    const toRegister = eligible.filter(
      (s) => !(s.syncStatus === 'synced' && s.llmproxyGatewayServerId),
    );
    for (let i = 0; i < toRegister.length; i += REGISTER_CONCURRENCY) {
      if (Date.now() - startedAt >= REREGISTER_BUDGET_MS) {
        skippedForBudget = toRegister.length - i;
        logger.warn(
          `[MCPHealthEligible] Re-registration budget exhausted ` +
          `(${REREGISTER_BUDGET_MS}ms); skipping ${skippedForBudget} server(s) ` +
          `for this cycle. Will retry next health-check cycle.`,
        );
        break;
      }
      const batch = toRegister.slice(i, i + REGISTER_CONCURRENCY);
      const results = await Promise.all(batch.map((s) => reregisterServer(s)));
      registeredCount += results.filter((ok) => ok).length;
    }
  }
  if (registeredCount > 0 || skippedForBudget > 0) {
    logger.info(
      `[MCPHealthEligible] Re-registration summary: registered=${registeredCount} ` +
      `skippedForBudget=${skippedForBudget} elapsedMs=${Date.now() - startedAt}`,
    );
  }

  async function reregisterServer(server: MCPServer): Promise<boolean> {
    if (!server.llmproxyGatewayServerName) {
      return false;
    }
    // Lazy re-registration covers URL and stdio modes — the original
    // registration flow in mcpServerRoutes.ts uses buildGatewayServerConfig
    // for both. If a server is stdio without a command (corrupt row), the
    // builder will produce an invalid payload; we let the gateway reject
    // it and log so operators see why.
    if (!server.url && server.transport !== 'stdio') {
      logger.warn(
        `[MCPHealthEligible] Skipping re-registration for id=${server.id} ` +
        `name=${server.llmproxyGatewayServerName} transport=${server.transport ?? 'unset'}: ` +
        `no url and not stdio — cannot build gateway config`,
      );
      return false;
    }
    const prevSync = server.syncStatus;
    try {
      const credentialData = await resolveCredentialData(server.projectId, server.credentialId);
      // buildGatewayServerConfig handles transport normalisation
      // (streamable-http -> http, sse stays sse, stdio stays stdio),
      // builds the credentials block from authType + credentialData,
      // resolves query/header params + auth secrets via the credential
      // cache, and forwards staticHeaders + allowed/disallowed tools.
      const config = await buildGatewayServerConfig(
        server.projectId,
        server,
        credentialData,
      );
      // projectId + alias mirror the original registration call in
      // mcpServerRoutes.ts (POST /:projectId/mcp-servers). projectId is
      // still forwarded for parity even though the VK `mcp_configs`
      // write was removed -- the gateway uses it for logging /
      // namespacing of the client name (e.g. `<projectId>_<server>`).
      // alias is the user-facing name. Per-agent tool scoping is
      // enforced by the agent runtime via `x-bf-mcp-include-tools`.
      const resp = await gateway.addMCPServer({
        server_name: server.llmproxyGatewayServerName,
        alias: server.name,
        projectId: server.projectId,
        ...config,
        // extra_headers is a forward-list (header names), independent of
        // static_headers (header name->value) the builder may emit.
        ...(server.extraHeaders?.length ? { extra_headers: server.extraHeaders } : {}),
      });
      await repo.update(server.id, {
        llmproxyGatewayServerId: resp.server_id,
        syncStatus: 'synced',
      });
      server.llmproxyGatewayServerId = resp.server_id;
      server.syncStatus = 'synced';
      logger.info(
        `[MCPHealthEligible] Re-registered server id=${server.id} ` +
        `name=${server.llmproxyGatewayServerName} prevSync=${prevSync} ` +
        `gatewayServerId=${resp.server_id}`,
      );
      return true;
    } catch (err: any) {
      // Gateway rejected the registration — still include the row so
      // the cycle's metrics show the unhealthy state. The probe will
      // 404 through Bifrost and PATCH /:id/status will record it.
      logger.warn(
        `[MCPHealthEligible] Re-registration deferred for id=${server.id} ` +
        `name=${server.llmproxyGatewayServerName} prevSync=${prevSync}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  // Strip the extra fields the workflow-engine doesn't consume so we keep
  // the response shape backwards-compatible.
  const out = eligible.map((s) => ({
    id: s.id,
    llmproxyGatewayServerName: s.llmproxyGatewayServerName,
    deploymentType: s.deploymentType,
    runtimeStatus: s.runtimeStatus,
    syncStatus: s.syncStatus,
  }));

  sendSuccess(res, out);
}));

router.patch('/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body as { status?: string };

  if (!id) {
    return sendError(res, new Error('id is required'), 400);
  }
  if (status !== 'connected' && status !== 'error') {
    return sendError(res, new Error('status must be connected or error'), 400);
  }

  const repo = AppDataSource.getRepository(MCPServer);
  const existing = await repo.findOne({ where: { id } });
  if (!existing) {
    return sendError(res, new Error('MCP server not found'), 404);
  }

  if (status === 'connected') {
    const updateFields: Partial<MCPServer> = {
      status: 'connected',
      consecutiveFailures: 0,
    } as any;
    if (existing.syncStatus === 'suspended') {
      const gateway = getLLMGatewayClient();
      if (gateway.isEnabled()) {
        try {
          // Reuse the same config builder as the original registration
          // and the /health-eligible lazy path (buildGatewayServerConfig
          // + resolveCredentialData). The previous shape passed only
          // {server_name,url,transport,auth_type}, which dropped
          // staticHeaders / queryParams / headerParams / authConfig.
          // projectId is still forwarded so the gateway can namespace
          // the client name -- the VK `mcp_configs` write was removed,
          // and per-agent tool scoping now flows through
          // `x-bf-mcp-include-tools` headers from the agent runtime.
          const credentialData = await resolveCredentialData(
            existing.projectId,
            existing.credentialId,
          );
          const config = await buildGatewayServerConfig(
            existing.projectId,
            existing,
            credentialData,
          );
          const resp = await gateway.addMCPServer({
            server_name: existing.llmproxyGatewayServerName!,
            alias: existing.name,
            projectId: existing.projectId,
            ...config,
            ...(existing.extraHeaders?.length
              ? { extra_headers: existing.extraHeaders }
              : {}),
          });
          (updateFields as any).llmproxyGatewayServerId = resp.server_id;
        } catch (reregErr: any) {
          logger.error(
            `[MCPHealthCircuitBreaker] Re-registration failed for server id=${id} name=${existing.llmproxyGatewayServerName}: ${reregErr.message}`,
          );
        }
      }
      (updateFields as any).syncStatus = 'synced';
    } else if (existing.syncStatus !== 'synced') {
      // A probe just succeeded while we were `pending` or `error` — the
      // /health-eligible lazy re-registration must have brought the
      // server back to the gateway. Flip syncStatus so subsequent cycles
      // skip the re-registration step.
      (updateFields as any).syncStatus = 'synced';
    }
    await repo.update(id, updateFields);
    sendSuccess(res, {
      id,
      status,
      consecutiveFailures: 0,
      syncStatus: (updateFields as any).syncStatus ?? existing.syncStatus,
    });
    return;
  }

  const newFailures = (existing.consecutiveFailures || 0) + 1;
  const updateFields: Partial<MCPServer> = {
    status: 'error',
    consecutiveFailures: newFailures,
  } as any;

  let suspended = false;
  if (newFailures >= CIRCUIT_BREAKER_THRESHOLD && existing.llmproxyGatewayServerId && existing.syncStatus === 'synced') {
    const gateway = getLLMGatewayClient();
    if (gateway.isEnabled()) {
      try {
        await gateway.removeMCPServer(existing.llmproxyGatewayServerId);
        (updateFields as any).syncStatus = 'suspended';
        suspended = true;
        logger.info(
          `[MCPHealthCircuitBreaker] Deregistered server id=${id} name=${existing.llmproxyGatewayServerName} ` +
          `after ${newFailures} consecutive failures — syncStatus set to suspended`,
        );
      } catch (deregErr: any) {
        logger.error(
          `[MCPHealthCircuitBreaker] Failed to deregister server id=${id}: ${deregErr.message}`,
        );
      }
    }
  }

  await repo.update(id, updateFields);
  sendSuccess(res, { id, status, consecutiveFailures: newFailures, suspended });
}));

export default router;
