import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { DataSource, Repository } from 'typeorm';
import { MCPServer } from '../models/MCPServer';
import {
  ANALYTICS_DATASETS_CATALOG_ID,
  ARTIFACT_STORE_CATALOG_ID,
  getCatalogEntry,
} from '../catalog/mcpServerCatalog';
import {
  mergePlatformMcpExtraHeaders,
  platformMcpExtraHeadersNeedUpdate,
  PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
} from '../catalog/platformMcpDefaults';

/**
 * Idempotent startup-time registration of platform-managed MCP servers.
 *
 * Registers artifact-store and analytics-datasets MCP rows so they appear
 * in every project's toolset list and agents can attach them via Bifrost.
 *
 * The agent-service consumes platform MCPs via the Bifrost gateway,
 * keyed by `llmproxyGatewayServerName`.
 */

const PLATFORM_PROJECT_ID = '__platform__';

type PlatformMcpSpec = {
  name: string;
  catalogId: string;
  description: string;
  llmproxyGatewayServerName: string;
  urlEnvVar?: string;
  defaultUrl: string;
  transport: MCPServer['transport'];
  authType: 'none';
};

const ARTIFACT_STORE_SPEC: PlatformMcpSpec = {
  name: 'artifact-store',
  catalogId: ARTIFACT_STORE_CATALOG_ID,
  description:
    'Persistent, version-tracked artifact store for agents. Read/write files, ' +
    'tag snapshots, revert commits, and merge session branches to main — all ' +
    'with non-bypassable audit trailers.',
  llmproxyGatewayServerName: 'artifact_store',
  urlEnvVar: 'ARTIFACT_SERVICE_URL',
  defaultUrl: 'http://artifact-service:8080/mcp',
  transport: 'streamable-http',
  authType: 'none',
};

const ANALYTICS_DATASETS_SPEC: PlatformMcpSpec = {
  name: 'analytics_datasets_mcp',
  catalogId: ANALYTICS_DATASETS_CATALOG_ID,
  description:
    getCatalogEntry(ANALYTICS_DATASETS_CATALOG_ID)?.description ??
    'SQL analytics on project datasets via the shared analytics-engine (Iceberg catalog).',
  llmproxyGatewayServerName: 'analytics_datasets_mcp',
  urlEnvVar: 'ANALYTICS_MCP_URL',
  defaultUrl: 'http://analytics-mcp-server:8000/mcp',
  transport: 'http',
  authType: 'none',
};

export interface BootstrapResult {
  registered: number;
  updated: number;
  skipped: number;
}

/**
 * Run all platform-MCP bootstrap steps. Safe to call repeatedly; each
 * step is idempotent on (projectId, name).
 */
export async function bootstrapPlatformMcpServers(
  dataSource: DataSource,
): Promise<BootstrapResult> {
  const result: BootstrapResult = { registered: 0, updated: 0, skipped: 0 };
  await ensurePlatformMcp(dataSource, ARTIFACT_STORE_SPEC, result);
  await ensurePlatformMcp(dataSource, ANALYTICS_DATASETS_SPEC, result);
  await ensurePlatformMcpExtraHeaders(dataSource, result);
  return result;
}

async function ensurePlatformMcp(
  dataSource: DataSource,
  spec: PlatformMcpSpec,
  result: BootstrapResult,
): Promise<void> {
  const repo = dataSource.getRepository(MCPServer);
  const url = (spec.urlEnvVar && process.env[spec.urlEnvVar]) || spec.defaultUrl;

  const existing = await repo.findOne({
    where: { projectId: PLATFORM_PROJECT_ID, name: spec.name },
  });

  if (!existing) {
    const row = repo.create({
      projectId: PLATFORM_PROJECT_ID,
      name: spec.name,
      description: spec.description,
      transport: spec.transport,
      url,
      authType: spec.authType,
      deploymentType: 'platform',
      catalogId: spec.catalogId,
      llmproxyGatewayServerName: spec.llmproxyGatewayServerName,
      extraHeaders: [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS],
      // Bifrost gateway registration happens via the existing platform
      // MCP route or operator action — we don't push it from here to
      // keep the bootstrap dependency-free at config-service startup.
      syncStatus: 'pending',
      status: 'unknown',
    });
    try {
      await repo.save(row);
      result.registered++;
      logger.info(`[PlatformMCPBootstrap] Registered ${spec.name} MCP: ${url}`);
    } catch (err: any) {
      const isUniqueViolation =
        err?.code === '23505' ||
        /duplicate key|unique constraint/i.test(String(err?.message ?? err));
      if (!isUniqueViolation) throw err;
      const concurrent = await repo.findOne({
        where: { projectId: PLATFORM_PROJECT_ID, name: spec.name },
      });
      if (!concurrent) throw err;
      logger.info(
        `[PlatformMCPBootstrap] Concurrent insert detected — converging to existing row id=${concurrent.id}`,
      );
      return updateExisting(repo, concurrent, spec, url, result);
    }
    return;
  }

  return updateExisting(repo, existing, spec, url, result);
}

async function updateExisting(
  repo: Repository<MCPServer>,
  existing: MCPServer,
  spec: PlatformMcpSpec,
  url: string,
  result: BootstrapResult,
): Promise<void> {
  const patch: Partial<MCPServer> = {};
  if (existing.url !== url) patch.url = url;
  if (existing.catalogId !== spec.catalogId) {
    patch.catalogId = spec.catalogId;
    patch.description = spec.description;
    patch.transport = spec.transport;
  }
  if (platformMcpExtraHeadersNeedUpdate(existing.extraHeaders)) {
    patch.extraHeaders = mergePlatformMcpExtraHeaders(existing.extraHeaders);
  }

  if (Object.keys(patch).length > 0) {
    await repo.update(existing.id, patch);
    result.updated++;
    logger.info(`[PlatformMCPBootstrap] Updated ${spec.name} MCP url=${url}`);
    return;
  }

  result.skipped++;
}

/** Backfill default forward headers on all platform MCP rows. */
async function ensurePlatformMcpExtraHeaders(
  dataSource: DataSource,
  result: BootstrapResult,
): Promise<void> {
  const repo = dataSource.getRepository(MCPServer);
  const platformServers = await repo.find({
    where: { projectId: PLATFORM_PROJECT_ID, deploymentType: 'platform' },
  });

  for (const server of platformServers) {
    if (!platformMcpExtraHeadersNeedUpdate(server.extraHeaders)) continue;
    const extraHeaders = [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS];
    await repo.update(server.id, { extraHeaders });
    result.updated++;
    logger.info(
      `[PlatformMCPBootstrap] Updated extraHeaders for platform MCP name=${server.name}`,
    );
  }
}
