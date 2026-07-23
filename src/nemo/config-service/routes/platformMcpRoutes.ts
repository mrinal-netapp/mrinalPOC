import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../db/postgres';
import { MCPServer } from '../models/MCPServer';
import { getLLMGatewayClient } from '../services/gatewayClient';
import { WEB_SEARCH_CATALOG_ID, SEARXNG_WEB_SEARCH_CATALOG_ID, ANALYTICS_DATASETS_CATALOG_ID } from '../catalog/mcpServerCatalog';
import {
  platformMcpExtraHeadersNeedUpdate,
  resolvePlatformMcpExtraHeaders,
} from '../catalog/platformMcpDefaults';
import { safeLog } from '../utils/safeStrings';

const router = Router();

const PLATFORM_PROJECT_ID = '__platform__';
const WEB_SEARCH_ENABLED = String(process.env.WEB_SEARCH_MCP_ENABLED || '').toLowerCase() === 'true';

// POST /api/v1/platform/mcp-servers -- create a platform MCP server
router.post('/', async (req: Request, res: Response) => {
  try {
    if (req.body.catalogId === WEB_SEARCH_CATALOG_ID && !WEB_SEARCH_ENABLED) {
      return res.status(403).json({ error: 'web_search_mcp is disabled by rollout guard' });
    }
    if (req.body.catalogId === SEARXNG_WEB_SEARCH_CATALOG_ID && !WEB_SEARCH_ENABLED) {
      return res.status(403).json({ error: 'searxng_web_search_mcp is disabled by rollout guard' });
    }

    const repo = AppDataSource.getRepository(MCPServer);
    const extraHeaders = resolvePlatformMcpExtraHeaders(req.body.extraHeaders);

    const existing = await repo.findOne({
      where: { projectId: PLATFORM_PROJECT_ID, name: req.body.name },
    });
    if (existing && existing.llmproxyGatewayServerId && existing.syncStatus === 'synced') {
      const gateway = getLLMGatewayClient();
      if (gateway.isEnabled()) {
        try {
          await gateway.editMCPServer({
            server_id: existing.llmproxyGatewayServerId,
            url: req.body.url || existing.url,
            transport: req.body.transport || existing.transport || 'http',
            auth_type: req.body.authType || existing.authType || 'none',
            extra_headers: extraHeaders,
          });
        } catch (err: any) {
          logger.error(`[platformMcpRoutes] Bifrost convergence edit failed:`, safeLog(err.message));
        }
        const dbUpdate: Partial<MCPServer> = {};
        if (req.body.url) dbUpdate.url = req.body.url;
        if (platformMcpExtraHeadersNeedUpdate(existing.extraHeaders)) {
          dbUpdate.extraHeaders = extraHeaders;
        }
        if (Object.keys(dbUpdate).length > 0) {
          await repo.update(existing.id, dbUpdate);
        }
      }
      const updated = await repo.findOne({ where: { id: existing.id } });
      return res.status(200).json(updated);
    }

    const rawGatewayName = req.body.llmproxyGatewayServerName || req.body.name;
    const llmproxyGatewayServerName = rawGatewayName.replace(/-/g, '_');
    const url = req.body.url;
    const transport = req.body.transport || 'http';
    const authType = req.body.authType || 'none';

    const gateway = getLLMGatewayClient();
    let llmproxyGatewayServerId: string | undefined;
    let syncStatus: 'synced' | 'pending' | 'error' = 'pending';

    if (gateway.isEnabled()) {
      try {
        const resp = await gateway.addMCPServer({
          server_name: llmproxyGatewayServerName,
          projectId: PLATFORM_PROJECT_ID,
          url,
          transport,
          auth_type: authType,
          extra_headers: extraHeaders,
        });
        llmproxyGatewayServerId = resp.server_id;
        syncStatus = 'synced';
      } catch (err: any) {
        // Use a single template-literal argument so Node's util.format does
        // not interpret user-supplied llmproxyGatewayServerName as a printf-style
        // format specifier consuming err.message (CodeQL
        // js/tainted-format-string).
        logger.error(
          `[platformMcpRoutes] Bifrost registration failed for ${safeLog(llmproxyGatewayServerName)}: ${safeLog(err.message)}`,
        );
        syncStatus = 'error';
      }
    }

    if (existing) {
      await repo.update(existing.id, {
        // catalogId threaded through update so the persisted row reflects
        // the most-recent registration (the field exists on the entity
        // and is read by downstream filters; previous revision silently
        // dropped it on both create + update paths).
        catalogId: req.body.catalogId,
        llmproxyGatewayServerId, llmproxyGatewayServerName, syncStatus, url, transport,
        extraHeaders,
      });
      const updated = await repo.findOne({ where: { id: existing.id } });
      return res.status(200).json(updated);
    }

    const server = repo.create({
      projectId: PLATFORM_PROJECT_ID,
      name: req.body.name,
      // catalogId is a first-class column on MCPServer (see models/MCPServer.ts).
      // It identifies the upstream catalog entry the registration came from
      // (e.g. `analytics_datasets_mcp` from analytics-mcp-server bootstrap)
      // and is filtered on by downstream consumers; persist it from the
      // request body. Earlier revisions left this off the `create` call,
      // silently NULL-ing the column on every platform-MCP registration.
      catalogId: req.body.catalogId,
      description: req.body.description,
      transport,
      url,
      authType,
      extraHeaders,
      deploymentType: 'platform',
      llmproxyGatewayServerName,
      llmproxyGatewayServerId,
      syncStatus,
    });
    const saved = await repo.save(server);
    res.status(201).json(saved);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/v1/platform/mcp-servers -- list all platform MCP servers
router.get('/', async (_req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(MCPServer);
    const servers = await repo.find({ where: { deploymentType: 'platform' } });
    res.json(servers);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/v1/platform/mcp-servers/:id -- delete a platform MCP server
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(MCPServer);
    const existing = await repo.findOne({
      where: { id: req.params.id, deploymentType: 'platform' },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Platform MCP server not found' });
    }

    const gateway = getLLMGatewayClient();
    if (gateway.isEnabled() && existing.llmproxyGatewayServerId) {
      try {
        await gateway.removeMCPServer(existing.llmproxyGatewayServerId, {
          projectId: PLATFORM_PROJECT_ID,
          mcpClientName: existing.llmproxyGatewayServerName || existing.name?.replace(/-/g, '_'),
        });
      } catch (err: any) {
        logger.error(`[platformMcpRoutes] Bifrost removal failed for ${safeLog(existing.llmproxyGatewayServerId)}:`, safeLog(err.message));
      }
    }

    await repo.delete(req.params.id);
    res.json({ deleted: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
