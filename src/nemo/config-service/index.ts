import 'reflect-metadata';
import express, { Request, Response } from 'express';
import { RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { connectToPostgres, closePostgresConnection } from './db/postgres';
import { initializeRepositoryFactory } from './repositories/RepositoryFactory';
import { AppDataSource } from './db/postgres';
import type { Server } from 'http';
import { getMCPRuntimeManager } from './services/MCPRuntimeManager';
import { bootstrapPlatformMcpServers } from './services/PlatformMCPBootstrap';
import { notFoundHandler, errorHandlerMiddleware } from './middleware/errorHandler';
import { projectRoleMiddleware } from './middleware/projectRole';
import { unifiedGuardGlobal } from './middleware/unifiedGuard';
import {
  extractProjectId,
  configure_observability_for_service,
  requestLoggingMiddleware,
} from '@agentstudio/common';
import { get_logger } from '@agentstudio/observability-client-runtime';


import credentialRoutes from './routes/credentialRoutes';
import dataSetRoutes from './routes/dataSetRoutes';
import manifestRoutes from './routes/manifestRoutes';
import searchRouter from './routes/searchRoutes';
import knowledgeBaseRoutes from './routes/knowledgeBaseRoutes';
import mcpServerRoutes from './routes/mcpServerRoutes';
import modelRoutes from './routes/modelRoutes';
import pipelineRoutes from './routes/pipelineRoutes';
import projectRoutes from './routes/projectRoutes';
import projectMembershipRoutes from './routes/projectMembershipRoutes';
import deploymentRoutes from './routes/deploymentRoutes';
import dataSourceRoutes from './routes/dataSourceRoutes';
import workspaceTemplateRoutes from './routes/workspaceTemplateRoutes';
import workspaceRoutes from './routes/workspaceRoutes';
import internalWorkspaceRoutes from './routes/internalWorkspaceRoutes';
import internalMcpHealthRoutes from './routes/internalMcpHealthRoutes';
import internalReferenceEdgeRoutes from './routes/internalReferenceEdgeRoutes';
import internalProjectRoutes from './routes/internalProjectRoutes';
import internalDataSourceRoutes from './routes/internalDataSourceRoutes';
import userResolutionRoutes from './routes/userResolutionRoutes';
import workspaceQueryRoutes from './routes/workspaceQueryRoutes';
import setupRoutes from './routes/setupRoutes';
import agentRoutes from './routes/agentRoutes';
import agentTeamRoutes from './routes/agentTeamRoutes';
import evaluationAgentRoutes from './routes/evaluationAgentRoutes';
import evaluationCatalogRoutes from './routes/evaluationCatalogRoutes';
import catalogRoutes from './routes/catalogRoutes';
import platformMcpRoutes from './routes/platformMcpRoutes';
import explorerRoutes from './routes/explorerRoutes';
import gatewayRoutes from './routes/gatewayRoutes';
import governanceRoutes from './routes/governanceRoutes';
import guardrailRoutes from './routes/guardrailRoutes';
import modelProviderRoutes from './routes/modelProviderRoutes';

// Initialise observability (file logs, OTel traces, Prometheus RED metrics on dedicated port)
configure_observability_for_service('config-service');
const DEBUG_ENABLED = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
const logger = get_logger();

const app = express();

// Structured request logging middleware (injects X-Request-Id + OTel trace correlation)
app.use(requestLoggingMiddleware);

// Default Express JSON limit is ~100kb — manual dataset registration sends one object per file
// (key, url, size, originalName) and exceeds that for thousands of files. Override via env.
const jsonBodyLimit = process.env.EXPRESS_JSON_BODY_LIMIT || '64mb';
app.use(express.json({ limit: jsonBodyLimit }));

// Health and readiness endpoints (must be defined BEFORE auth middleware)
app.get('/health', (req: Request, res: Response) => {
  if (DEBUG_ENABLED) {
    logger.debug('health_check', { path: req.path, method: req.method });
  }
  res.status(200).json({ 
    status: 'healthy',
    service: 'config-service',
    timestamp: new Date().toISOString()
  });
});

app.get('/ready', async (req: Request, res: Response) => {
  if (DEBUG_ENABLED) {
    logger.debug('readiness_check', { path: req.path, method: req.method });
  }
  
  // Check database connection
  let dbConnected = false;
  try {
    if (AppDataSource.isInitialized) {
      await AppDataSource.query('SELECT 1');
      dbConnected = true;
    }
  } catch (error: any) {
    if (DEBUG_ENABLED) {
      logger.error('readiness_db_check_failed', { error: (error as Error).message });
    }
  }
  
  if (dbConnected) {
    res.status(200).json({ 
      status: 'ready',
      service: 'config-service',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(503).json({ 
      status: 'not ready',
      service: 'config-service',
      database: 'not connected',
      timestamp: new Date().toISOString()
    });
  }
});

// Setup routes (must be before auth middleware - public endpoint)
app.use('/api/v1/setup', setupRoutes);

// Unified guard: policy table assigns every /api/v1 route a user scope;
// token-less / no-email callers pass through to the mesh AuthorizationPolicy.
app.use(unifiedGuardGlobal());

// Project role middleware - enriches request with project role from database
// This should run after auth middleware to add X-Project-Role header
app.use(projectRoleMiddleware);

// Setup Swagger UI
const possibleSwaggerPaths = [
  path.join(__dirname, 'openapi.yaml'), // dist/openapi.yaml
  path.join(process.cwd(), 'openapi.yaml'),
  path.join(process.cwd(), 'dist/openapi.yaml')
];

let swaggerSetup = false;
for (const swaggerPath of possibleSwaggerPaths) {
  try {
    if (fs.existsSync(swaggerPath)) {
      const yamlContent = fs.readFileSync(swaggerPath, 'utf8');
      const swaggerDocument = yaml.load(yamlContent) as any;

      // Serve OpenAPI spec as JSON/YAML
      app.get('/swagger.json', (req: Request, res: Response) => {
        res.setHeader('Content-Type', 'application/yaml');
        res.sendFile(path.resolve(swaggerPath));
      });

      // Setup Swagger UI
      app.use('/swagger', swaggerUi.serve);
      app.get('/swagger', swaggerUi.setup(swaggerDocument));

      // Redirect /docs to /swagger
      app.get('/docs', (req: Request, res: Response) => {
        res.redirect('/swagger');
      });

      swaggerSetup = true;
      logger.info('swagger_ready', { paths: ['/swagger', '/docs'] });
      break;
    }
  } catch (error) {
    logger.warn('swagger_load_failed', { path: swaggerPath, error: String(error) });
  }
}

if (!swaggerSetup) {
  logger.warn('swagger_spec_not_found');
}

// Connect to PostgreSQL
connectToPostgres()
  .then(async () => {
    logger.info('postgres_connected');
    initializeRepositoryFactory(AppDataSource);
    try {
      await getMCPRuntimeManager().reconcileOrphans();
    } catch (err: any) {
      logger.warn('mcp_orphan_reconcile_skipped', { error: (err as Error).message });
    }
    try {
      const summary = await bootstrapPlatformMcpServers(AppDataSource);
      logger.info('platform_mcp_bootstrap', {
        registered: summary.registered,
        updated: summary.updated,
        skipped: summary.skipped,
      });
    } catch (err: any) {
      logger.warn('platform_mcp_bootstrap_skipped', { error: (err as Error).message });
    }
  })
  .catch((err) => {
    logger.error('postgres_connection_failed', { error: String(err) });
    process.exit(1);
  });

app.get('/', (_req, res) => res.send('AgentStudio Config Service'));
// Project and deployment routes (not scoped under project)
app.use('/', projectRoutes);
// Read-only project membership endpoints backed by Keycloak Authorization
// Services. Writes still live in workflow-engine (Temporal-backed). See
// docs/design/keycloak-per-project-authorization.md §6 and PR #31.
app.use('/', projectMembershipRoutes);
app.use('/', deploymentRoutes);
// Per-project model providers (table + list/refresh)
app.use('/', modelProviderRoutes);
// All entity APIs are now scoped under projects
app.use('/api/v1/projects/:projectId/datasources', dataSourceRoutes);
app.use('/api/v1/projects/:projectId/credentials', credentialRoutes);
app.use('/api/v1/projects/:projectId/datasets', dataSetRoutes);
app.use('/api/v1/projects/:projectId/datasets/:dataSetId/manifests', manifestRoutes);
app.use('/api/v1/projects/:projectId/knowledgebases', knowledgeBaseRoutes);
app.use('/api/v1/projects/:projectId/mcp-servers', mcpServerRoutes);
app.use('/api/v1/projects/:projectId/models', modelRoutes);
app.use('/api/v1/projects/:projectId/pipelines', pipelineRoutes);
app.use('/api/v1/projects/:projectId/agents', agentRoutes);
app.use('/api/v1/projects/:projectId/agent-teams', agentTeamRoutes);
app.use('/api/v1/projects/:projectId/evaluation/agents', evaluationAgentRoutes);
// Evaluation rubric catalog (global, read-only static data)
app.use('/api/v1/evaluation', evaluationCatalogRoutes);
app.use('/api/v1/projects/:projectId/workspace-templates', workspaceTemplateRoutes);
app.use('/api/v1/projects/:projectId/workspaces', workspaceRoutes);
// Internal routes for service-to-service communication. Authorization is
// enforced at the mesh layer (Istio AuthorizationPolicy + NetworkPolicy in
// the config-service chart), which restricts these paths to known in-cluster
// ServiceAccount SPIFFE IDs.
app.use('/api/v1/internal/workspaces', internalWorkspaceRoutes);
app.use('/api/v1/internal/mcp-servers', internalMcpHealthRoutes);
app.use('/api/v1/internal/reference-edges', internalReferenceEdgeRoutes);
app.use('/api/v1/internal/projects', internalProjectRoutes);
app.use('/api/v1/internal/datasources', internalDataSourceRoutes);
// Resolve-or-create Keycloak users by email (M2M from workflow-engine project-init)
app.use('/api/v1/internal/users', userResolutionRoutes);
// Workspace query route for workspace orchestrator polling (without namespaceId)
app.use('/api/v1/workspaces', workspaceQueryRoutes);
// Platform MCP servers (not project-scoped, admin-only)
app.use('/api/v1/platform/mcp-servers', platformMcpRoutes);
// Same handler, mounted again under /internal/* for in-cluster bootstrap
// Jobs (e.g. analytics-mcp-server-bootstrap). The canonical /platform path
// expects a user-context JWT (email + preferred_username); Keycloak
// client_credentials tokens that bootstrap Jobs mint don't carry those
// claims and the /platform handler rejects them with `token_shape_invalid`.
// The /internal mount trusts the mesh identity instead — the primary
// authorization gate is the chart's Istio AuthorizationPolicy that binds
// the analytics-mcp-server SA's SPIFFE ID as the only allowed caller. The
// inline `refuseEdgeIngressed` middleware below is defense-in-depth: the
// public gateway sets X-Forwarded-Host on edge-ingressed requests, while
// in-mesh service-to-service traffic addresses pods directly via cluster
// DNS and does NOT carry that header — so a regression in the mesh policy
// can't expose this route to the outside world.
const refuseEdgeIngressed: RequestHandler = (req, res, next) => {
  if (req.get('x-forwarded-host')) {
    return res.status(404).end();
  }
  return next();
};
app.use('/api/v1/internal/platform-mcp-servers', refuseEdgeIngressed, platformMcpRoutes);
// MCP server catalog (not project-scoped, read-only static data)
app.use('/api/v1/mcp-server-catalog', catalogRoutes);
// Explorer provider discovery (global, not project-scoped)
app.use('/api/v1/explorer', explorerRoutes);
// Bifrost gateway admin (global)
app.use('/api/v1/gateway', gatewayRoutes);
app.use('/api/v1/governance', governanceRoutes);
// Guardrails catalog (global, not project-scoped)
app.use('/api/v1/guardrails', guardrailRoutes);
// Search route (may need to be updated to support project scoping)
app.use('/api/v1/search', searchRouter);

// Error handling middleware (must be last)
app.use(notFoundHandler);
app.use(errorHandlerMiddleware);

const PORT = process.env.PORT || 3000;

const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10); // max wait for server close + DB close

let server: Server | null = null;
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info('shutdown_started', { signal });
	if (server) {
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(resolve, SHUTDOWN_GRACE_MS);
			server!.close(() => {
				clearTimeout(timeout);
				resolve();
			});
		});
		server = null;
	}
	await closePostgresConnection();
	logger.info('shutdown_complete');
	process.exit(0);
}

process.on('SIGTERM', () => {
	gracefulShutdown('SIGTERM').catch((err) => {
		logger.error('shutdown_error', { signal: 'SIGTERM', error: String(err) });
		process.exit(1);
	});
});
process.on('SIGINT', () => {
	gracefulShutdown('SIGINT').catch((err) => {
		logger.error('shutdown_error', { signal: 'SIGINT', error: String(err) });
		process.exit(1);
	});
});

server = app.listen(PORT, () => {
	const keycloakIssuer = process.env.KEYCLOAK_ISSUER;
	logger.info('service_started', {
		port: PORT,
		auth_enabled: !!keycloakIssuer,
		keycloak_issuer: keycloakIssuer ?? 'DISABLED',
		debug: DEBUG_ENABLED,
	});
});
