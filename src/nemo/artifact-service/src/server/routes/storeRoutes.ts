import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Router, Response, NextFunction } from 'express';
import { StoreRepo } from '../../repo/StoreRepo';
import { AclResolver, roleAtLeast } from '../../acl/AclResolver';
import { GitEngine } from '../../engine/GitEngine';
import { RequestWithCtx } from '../../middleware/auth';
import { toStoreView } from '../../types/ArtifactStore';

export interface StoreRoutesDeps {
  storeRepo: StoreRepo;
  aclResolver: AclResolver;
  engine: GitEngine;
}

const STORE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Conservative git branch-name regex. Rejects shell metacharacters,
 * path traversal, and anything outside the safe alphabet. Real git
 * has more permissive (but trap-laden) rules; we deliberately stay
 * inside an obviously-safe subset so `git init`/`git update-ref`
 * never has to refuse the value.
 */
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

/** Sanity cap on the LFS threshold (1 GiB). */
const MAX_LFS_THRESHOLD_BYTES = 1024 * 1024 * 1024;

/** Sanity cap on per-store quota (1 PiB) — plenty of headroom. */
const MAX_QUOTA_BYTES = 1024 ** 5;

function isSafeBranchName(s: string): boolean {
  return BRANCH_NAME_RE.test(s) && !s.includes('..') && !s.endsWith('.lock');
}

function isPositiveInt(n: number, max: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= max;
}

function isNonNegativeInt(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= max;
}

/**
 * Catalog CRUD endpoints under
 * /v1/projects/:projectId/artifact-stores[/:storeId]
 */
export function buildStoreRouter(deps: StoreRoutesDeps): Router {
  const router = Router({ mergeParams: true });
  const { storeRepo, aclResolver, engine } = deps;

  // POST /v1/projects/:projectId/artifact-stores  — create
  router.post('/', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const { projectId } = req.params;
      if (projectId !== ctx.projectId) {
        return res.status(403).json({ error: 'projectId mismatch with X-Project-ID' });
      }
      if (ctx.principal.kind !== 'user' && ctx.principal.kind !== 'service') {
        return res.status(403).json({ error: 'only users and service accounts may create stores' });
      }
      const { name, description, lfsThresholdBytes, quotaBytes, defaultBranch } = req.body ?? {};
      if (typeof name !== 'string' || !STORE_NAME_RE.test(name)) {
        return res.status(400).json({ error: 'name must match /^[A-Za-z0-9._-]{1,128}$/' });
      }
      const existing = await storeRepo.findByProjectAndName(projectId, name);
      if (existing) {
        return res.status(409).json({ error: 'store with this name already exists', id: existing.id });
      }

      // Value validation (in addition to the type checks above). Bad
      // values from a misbehaving client must NOT reach git init / the
      // ref layer — invalid branch names crash `git init`, negative
      // sizes break the LFS threshold comparison, etc.
      if (defaultBranch !== undefined && (typeof defaultBranch !== 'string' || !isSafeBranchName(defaultBranch))) {
        return res.status(400).json({
          error: 'defaultBranch must match /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/ (no .., no .lock suffix)',
        });
      }
      if (lfsThresholdBytes !== undefined && (typeof lfsThresholdBytes !== 'number' || !isPositiveInt(lfsThresholdBytes, MAX_LFS_THRESHOLD_BYTES))) {
        return res.status(400).json({
          error: `lfsThresholdBytes must be a positive integer ≤ ${MAX_LFS_THRESHOLD_BYTES}`,
        });
      }
      if (quotaBytes !== undefined && quotaBytes !== null && (typeof quotaBytes !== 'number' || !isNonNegativeInt(quotaBytes, MAX_QUOTA_BYTES))) {
        return res.status(400).json({
          error: `quotaBytes must be null or a non-negative integer ≤ ${MAX_QUOTA_BYTES}`,
        });
      }

      const ownerUserId =
        ctx.principal.kind === 'user' ? ctx.principal.id : `service:${ctx.principal.id}`;
      const row = await storeRepo.create({
        projectId,
        name,
        ownerUserId,
        description: typeof description === 'string' ? description : undefined,
        defaultBranch: typeof defaultBranch === 'string' ? defaultBranch : undefined,
        lfsThresholdBytes: typeof lfsThresholdBytes === 'number' ? lfsThresholdBytes : undefined,
        quotaBytes: typeof quotaBytes === 'number' ? quotaBytes : undefined,
      });
      try {
        await engine.initStore(row.projectId, row.id, row.defaultBranch);
      } catch (initErr) {
        // Roll back the catalog row so we don't leave an orphan
        // pointing at a bare repo that never existed. Without this,
        // any future request for the row would 5xx because the repo
        // dir is missing.
        try {
          await storeRepo.hardDelete(row.id);
        } catch (cleanupErr) {
          // eslint-disable-next-line no-console
          logger.error('orphan_cleanup_failed', {
            store_id: row.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
        throw initErr;
      }
      res.status(201).json(toStoreView(row));
    } catch (err) {
      next(err);
    }
  });

  // GET /v1/projects/:projectId/artifact-stores  — list
  router.get('/', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const { projectId } = req.params;
      if (projectId !== ctx.projectId) {
        return res.status(403).json({ error: 'projectId mismatch with X-Project-ID' });
      }
      const mine = req.query.mine === 'true' || req.query.mine === '1';
      const stores = await storeRepo.list({
        projectId,
        ownerUserId: mine && ctx.principal.kind === 'user' ? ctx.principal.id : undefined,
        limit: parseLimit(req.query.limit, 200),
      });
      // Filter by ACL visibility. Use the batched resolver so we do
      // one SQL query for the whole list instead of N (N+1 pattern
      // would otherwise add up to ~200 queries at the page cap).
      const roles = await aclResolver.resolveMany(ctx, stores);
      const visible = stores
        .filter((s) => (roles.get(s.id) ?? 'none') !== 'none')
        .map((s) => toStoreView(s));
      res.json({ items: visible });
    } catch (err) {
      next(err);
    }
  });

  // GET /v1/projects/:projectId/artifact-stores/:storeId  — stat
  router.get('/:storeId', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const { projectId } = req.params;
      const row = await loadStoreOrRespond(req, res, deps);
      if (!row) return;
      if (row.projectId !== projectId) {
        return res.status(404).json({ error: 'store not found in project' });
      }
      const role = await aclResolver.resolve(ctx, row);
      if (!roleAtLeast(role, 'reader')) {
        return res.status(403).json({ error: 'no read access' });
      }
      res.json({ ...toStoreView(row), role });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /v1/projects/:projectId/artifact-stores/:storeId  — rename / description / quota
  router.patch('/:storeId', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const row = await loadStoreOrRespond(req, res, deps);
      if (!row) return;
      const role = await aclResolver.resolve(ctx, row);
      if (!roleAtLeast(role, 'owner')) {
        return res.status(403).json({ error: 'patch requires owner' });
      }
      const patch: Record<string, unknown> = {};
      if (typeof req.body?.name === 'string') {
        if (!STORE_NAME_RE.test(req.body.name)) {
          return res.status(400).json({ error: 'name must match /^[A-Za-z0-9._-]{1,128}$/' });
        }
        // Pre-check (best-effort; a concurrent rename can still race
        // and surface as a 23505 below — we catch that too).
        if (req.body.name !== row.name) {
          const collision = await deps.storeRepo.findByProjectAndName(row.projectId, req.body.name);
          if (collision && collision.id !== row.id) {
            return res.status(409).json({
              error: 'store with this name already exists',
              id: collision.id,
            });
          }
        }
        patch.name = req.body.name;
      }
      if (req.body?.description === null || typeof req.body?.description === 'string') {
        patch.description = req.body.description;
      }
      if (req.body?.quotaBytes === null) {
        patch.quotaBytes = null;
      } else if (req.body?.quotaBytes !== undefined) {
        if (typeof req.body.quotaBytes !== 'number' || !isNonNegativeInt(req.body.quotaBytes, MAX_QUOTA_BYTES)) {
          return res.status(400).json({
            error: `quotaBytes must be null or a non-negative integer ≤ ${MAX_QUOTA_BYTES}`,
          });
        }
        patch.quotaBytes = req.body.quotaBytes;
      }
      let updated;
      try {
        updated = await deps.storeRepo.update(row.id, patch);
      } catch (err: any) {
        // Concurrent rename can win the race after the pre-check
        // above, in which case Postgres raises a 23505 unique-violation
        // on (projectId, name). Translate that into a 409 instead of
        // letting it bubble as a 500.
        const isUniqueViolation =
          err?.code === '23505' ||
          /duplicate key|unique constraint/i.test(String(err?.message ?? err));
        if (isUniqueViolation) {
          return res.status(409).json({
            error: 'store with this name already exists',
          });
        }
        throw err;
      }
      if (!updated) return res.status(404).json({ error: 'store not found' });
      res.json(toStoreView(updated));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /v1/projects/:projectId/artifact-stores/:storeId  — soft-delete
  router.delete('/:storeId', async (req: RequestWithCtx, res: Response, next: NextFunction) => {
    try {
      const ctx = req.ctx!;
      const row = await loadStoreOrRespond(req, res, deps);
      if (!row) return;
      const role = await aclResolver.resolve(ctx, row);
      if (!roleAtLeast(role, 'owner')) {
        return res.status(403).json({ error: 'delete requires owner' });
      }
      const ok = await deps.storeRepo.softDelete(row.id);
      if (!ok) return res.status(409).json({ error: 'store cannot be deleted in current state' });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function loadStoreOrRespond(
  req: RequestWithCtx,
  res: Response,
  deps: StoreRoutesDeps,
) {
  const { storeId } = req.params;
  const row = await deps.storeRepo.findById(storeId);
  if (!row) {
    res.status(404).json({ error: 'store not found' });
    return null;
  }
  return row;
}

function parseLimit(raw: unknown, def: number): number {
  if (typeof raw === 'string') {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) return Math.max(1, Math.min(1000, n));
  }
  return def;
}
