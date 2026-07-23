import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import type { Request, Response } from 'express';
import { BaseServer, BaseServerConfig } from '@agentstudio/common';
import { PathResolver } from '../engine/PathResolver';
import { RefResolver } from '../engine/RefResolver';
import { LfsSidecar } from '../engine/LfsSidecar';
import { GitEngine } from '../engine/GitEngine';
import { Db } from '../db/Db';
import { StoreRepo } from '../repo/StoreRepo';
import { AclRepo } from '../repo/AclRepo';
import { AclResolver } from '../acl/AclResolver';
import { buildAuthMiddleware, RequestWithCtx } from '../middleware/auth';
import { buildStoreRouter } from './routes/storeRoutes';
import { buildViewerRouter } from './routes/viewerRoutes';
import { buildMergeRouter } from './routes/mergeRoute';
import { buildWhoamiRouter } from './routes/whoamiRoute';
import { IdempotencyStore } from '../services/IdempotencyStore';
import type { Redis } from 'ioredis';
import { handleMcpRequest } from '../mcp/server';

export interface ArtifactServiceConfig extends BaseServerConfig {
  storeRoot?: string;
  db: Db;
  redis?: Redis | null;
}

/**
 * Artifact-service HTTP server. Mounts:
 *   /v1/projects/:projectId/artifact-stores            (catalog CRUD)
 *   /v1/projects/:projectId/artifact-stores/:storeId/  (viewer + merge)
 *   /v1/artifact-stores/whoami                          (debug)
 *   POST /mcp                                           (Streamable-HTTP MCP)
 */
export class Server extends BaseServer<ArtifactServiceConfig> {
  protected readonly paths: PathResolver;
  protected readonly refs: RefResolver;
  protected readonly lfs: LfsSidecar;
  protected readonly engine: GitEngine;
  protected readonly storeRepo: StoreRepo;
  protected readonly aclRepo: AclRepo;
  protected readonly aclResolver: AclResolver;
  protected readonly idempotency: IdempotencyStore;

  constructor(config: ArtifactServiceConfig) {
    super(config);
    this.paths = new PathResolver(config.storeRoot);
    this.refs = new RefResolver();
    this.lfs = new LfsSidecar(this.paths);
    this.engine = new GitEngine(this.paths, this.refs, this.lfs);
    this.storeRepo = new StoreRepo(config.db);
    this.aclRepo = new AclRepo(config.db);
    this.aclResolver = new AclResolver(this.aclRepo);
    this.idempotency = new IdempotencyStore(config.redis ?? null);
    this.mountRoutes();
  }

  protected mountRoutes(): void {
    const auth = buildAuthMiddleware();
    const deps = {
      storeRepo: this.storeRepo,
      aclResolver: this.aclResolver,
      engine: this.engine,
    };

    // /v1/artifact-stores/whoami (no project-scope)
    this.app.use('/v1/artifact-stores', auth, buildWhoamiRouter());

    // /v1/projects/:projectId/artifact-stores...
    const baseBase = '/v1/projects/:projectId/artifact-stores';
    this.app.use(baseBase, auth, buildStoreRouter(deps));
    this.app.use(`${baseBase}/:storeId`, auth, buildViewerRouter(deps));
    this.app.use(`${baseBase}/:storeId`, auth, buildMergeRouter(deps));

    // MCP server: POST /mcp. Stateless per-request transport; the
    // streamable-HTTP SDK handles SSE for streaming responses internally.
    const mcpDeps = {
      ...deps,
      aclRepo: this.aclRepo,
      idempotency: this.idempotency,
    };
    this.app.post('/mcp', auth, (req: RequestWithCtx, res: Response) => {
      handleMcpRequest(req as unknown as Request, res, mcpDeps, req.ctx!).catch((err) => {
        // The transport may already have written the headers; only emit a
        // fallback if it hasn't.
        // eslint-disable-next-line no-console
        logger.error('mcp_request_handler_failed', { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.status(500).json({ error: 'mcp_internal_error' });
        }
      });
    });
  }

  /** Override health to also check DB connectivity. */
  protected async handleHealth(req: import('express').Request, res: import('express').Response): Promise<void> {
    const ok = await this.config.db.healthCheck();
    if (ok) {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } else {
      res.status(503).json({ status: 'unhealthy', reason: 'db', timestamp: new Date().toISOString() });
    }
  }

  async shutdown(): Promise<void> {
    await this.config.db.close().catch(() => undefined);
    if (this['server']) {
      await new Promise<void>((resolve, reject) => {
        this['server']!.close((err) => (err ? reject(err) : resolve()));
      });
    }
  }
}
