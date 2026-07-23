import { Router, Response, NextFunction } from 'express';
import { StoreRepo } from '../../repo/StoreRepo';
import { AclResolver, roleAtLeast } from '../../acl/AclResolver';
import { GitEngine } from '../../engine/GitEngine';
import { RequestWithCtx } from '../../middleware/auth';

export interface ViewerRoutesDeps {
  storeRepo: StoreRepo;
  aclResolver: AclResolver;
  engine: GitEngine;
}

/**
 * Read-only git viewer used by the GUI. Mounted on
 * /v1/projects/:projectId/artifact-stores/:storeId/...
 *
 * All endpoints are reader-permitted.
 */
export function buildViewerRouter(deps: ViewerRoutesDeps): Router {
  const router = Router({ mergeParams: true });
  const { storeRepo, aclResolver, engine } = deps;

  // GET .../refs  — `git for-each-ref` proxy
  router.get('/refs', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const row = await assertReader(req, res, deps);
      if (!row) return;
      const refs = await engine.listRefs(row.projectId, row.id);
      res.json({ items: refs });
    } catch (err) {
      next(err);
    }
  });

  // GET .../refs/:ref/tree?path=&recursive=&limit=  — directory listing
  router.get('/refs/:ref(*)/tree', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const row = await assertReader(req, res, deps);
      if (!row) return;
      const ref = decodeURIComponent(req.params.ref);
      const path = typeof req.query.path === 'string' ? req.query.path : '/';
      const recursive = req.query.recursive === 'true' || req.query.recursive === '1';
      const limit = parseLimit(req.query.limit, 200, 2000);
      const entries = await engine.listTree(
        row.projectId,
        row.id,
        ref,
        path,
        req.ctx!.sessionId,
        recursive,
        limit,
      );
      res.json({ ref, path, entries });
    } catch (err) {
      next(err);
    }
  });

  // GET .../refs/:ref/blob?path=  — read a blob
  router.get('/refs/:ref(*)/blob', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const row = await assertReader(req, res, deps);
      if (!row) return;
      const ref = decodeURIComponent(req.params.ref);
      const path = typeof req.query.path === 'string' ? req.query.path : '';
      if (!path) {
        return res.status(400).json({ error: 'path query param required' });
      }
      const maxBytes = parseLimit(req.query.maxBytes, 1024 * 1024, 1024 * 1024); // 1 MiB cap
      const result = await engine.readBlob(
        row.projectId,
        row.id,
        ref,
        path,
        req.ctx!.sessionId,
        maxBytes,
      );
      if (!result) return res.status(404).json({ error: 'blob not found' });

      const etag = `"${result.oid}"`;
      if (req.header('if-none-match') === etag) {
        res.setHeader('ETag', etag);
        return res.status(304).end();
      }
      res.setHeader('ETag', etag);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Artifact-Size', String(result.size));
      res.setHeader('X-Artifact-Lfs', result.lfs ? '1' : '0');
      res.setHeader('X-Artifact-Truncated', result.truncated ? '1' : '0');
      res.status(200).end(Buffer.from(result.bytes));
    } catch (err) {
      next(err);
    }
  });

  // GET .../log?ref=&path=&limit=  — paginated commit log with trailers
  router.get('/log', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const row = await assertReader(req, res, deps);
      if (!row) return;
      const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
      const path = typeof req.query.path === 'string' ? req.query.path : undefined;
      const limit = parseLimit(req.query.limit, 20, 200);
      const since = parseDate(req.query.since);
      const until = parseDate(req.query.until);
      const author = typeof req.query.author === 'string' ? req.query.author : undefined;
      const commits = await engine.log(row.projectId, row.id, ref, req.ctx!.sessionId, {
        limit,
        path,
        since,
        until,
        author,
      });
      res.json({ items: commits });
    } catch (err) {
      next(err);
    }
  });

  return router;

  async function assertReader(req: RequestWithCtx, res: Response, _deps: ViewerRoutesDeps) {
    const { storeId, projectId } = req.params;
    if (projectId !== req.ctx!.projectId) {
      res.status(403).json({ error: 'projectId mismatch with X-Project-ID' });
      return null;
    }
    const row = await storeRepo.findById(storeId);
    if (!row || row.projectId !== projectId) {
      res.status(404).json({ error: 'store not found' });
      return null;
    }
    const role = await aclResolver.resolve(req.ctx!, row);
    if (!roleAtLeast(role, 'reader')) {
      res.status(403).json({ error: 'no read access' });
      return null;
    }
    return row;
  }
}

/**
 * Parse a query-string limit, clamping to the endpoint-specific
 * `max`. Previously this clamped to 10,000,000 across all callers,
 * which meant a misbehaving client could ask for millions of tree
 * entries or commit log records and exhaust memory / response
 * latency. Each call site now passes its own ceiling matching what
 * the engine actually serves (tree ≤ 2000, log ≤ 200, blob byte
 * cap = 1 MiB).
 */
function parseLimit(raw: unknown, def: number, max: number): number {
  if (typeof raw === 'string') {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(max, n);
  }
  return def;
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string') return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}
