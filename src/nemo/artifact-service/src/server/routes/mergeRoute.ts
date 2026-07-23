import { Router, Response, NextFunction } from 'express';
import { StoreRepo } from '../../repo/StoreRepo';
import { AclResolver, roleAtLeast } from '../../acl/AclResolver';
import { GitEngine } from '../../engine/GitEngine';
import { RequestWithCtx } from '../../middleware/auth';

export interface MergeRouteDeps {
  storeRepo: StoreRepo;
  aclResolver: AclResolver;
  engine: GitEngine;
}

/**
 * POST /v1/projects/:projectId/artifact-stores/:storeId/merge
 *
 * GUI "Merge to main" button. Requires `writer` on the store.
 * Body: `{ from: string, into?: string, strategy?: 'ff-only' }`
 *
 * The MCP `artifact.merge` tool calls into the same `engine.mergeFastForward`
 * code path, so audit semantics are uniform regardless of caller.
 */
export function buildMergeRouter(deps: MergeRouteDeps): Router {
  const router = Router({ mergeParams: true });
  const { storeRepo, aclResolver, engine } = deps;

  router.post('/merge', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const { projectId, storeId } = req.params;
      if (projectId !== ctx.projectId) {
        return res.status(403).json({ error: 'projectId mismatch with X-Project-ID' });
      }
      const row = await storeRepo.findById(storeId);
      if (!row || row.projectId !== projectId) {
        return res.status(404).json({ error: 'store not found' });
      }
      if (row.state !== 'active') {
        return res.status(423).json({ error: `store is ${row.state}` });
      }
      const role = await aclResolver.resolve(ctx, row);
      if (!roleAtLeast(role, 'writer')) {
        return res.status(403).json({ error: 'merge requires writer' });
      }
      const { from, into, strategy } = req.body ?? {};
      if (typeof from !== 'string') {
        return res.status(400).json({ error: 'body.from required' });
      }
      const intoRef = typeof into === 'string' ? into : row.defaultBranch;
      if (strategy && strategy !== 'ff-only') {
        return res.status(400).json({ error: 'only strategy=ff-only is supported in P1' });
      }
      const result = await engine.mergeFastForward(row.projectId, row.id, ctx, from, intoRef);
      const status = result.status === 'conflict' ? 409 : 200;
      res.status(status).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
