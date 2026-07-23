import { createHash } from 'crypto';
import { GitEngine, RefDivergedError } from '../engine/GitEngine';
import { StoreRepo } from '../repo/StoreRepo';
import { AclRepo } from '../repo/AclRepo';
import { AclResolver, EffectiveRole, roleAtLeast } from '../acl/AclResolver';
import { IdempotencyStore } from '../services/IdempotencyStore';
import {
  ArtifactStoreRow,
  ArtifactStoreView,
  toStoreView,
} from '../types/ArtifactStore';
import { RequestContext, encodePrincipal } from '../types/Principal';
import { ArtifactOp } from '../engine/CommitBuilder';

/**
 * `list_stores` returns the public view with the caller's effective
 * role attached. Keeping this in a named type means callers (and the
 * MCP tool consumer) see `role` in the static shape, not just at
 * runtime via an `as` cast.
 */
export type ArtifactStoreListItem = ArtifactStoreView & { role: EffectiveRole };

export interface HandlerDeps {
  engine: GitEngine;
  storeRepo: StoreRepo;
  aclRepo: AclRepo;
  aclResolver: AclResolver;
  idempotency: IdempotencyStore;
}

/**
 * Standard envelope returned by every tool. `ok: false` carries a code
 * and a human-friendly message; `ok: true` carries the tool-specific
 * payload.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; details?: unknown };

const OK = <T>(data: T): ToolResult<T> => ({ ok: true, data });
const ERR = (code: string, message: string, details?: unknown): ToolResult<never> => ({
  ok: false,
  code,
  message,
  details,
});

// -------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------

export async function handle_list_stores(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { project_id?: string; mine?: boolean },
): Promise<ToolResult<{ items: ArtifactStoreListItem[] }>> {
  const projectId = args.project_id ?? ctx.projectId;
  if (projectId !== ctx.projectId) {
    return ERR('forbidden', 'project_id must match X-Project-ID header');
  }
  const rows = await deps.storeRepo.list({
    projectId,
    ownerUserId:
      args.mine && ctx.principal.kind === 'user' ? ctx.principal.id : undefined,
    limit: 200,
  });
  // Batch-resolve ACL roles in one SQL query rather than per-store
  // (the previous sequential loop was N+1 across up to 200 rows).
  const roles = await deps.aclResolver.resolveMany(ctx, rows);
  const visible: ArtifactStoreListItem[] = [];
  for (const r of rows) {
    const role = roles.get(r.id) ?? 'none';
    if (role !== 'none') {
      visible.push({ ...toStoreView(r), role });
    }
  }
  return OK({ items: visible });
}

export async function handle_whoami(
  _deps: HandlerDeps,
  ctx: RequestContext,
): Promise<
  ToolResult<{
    principal: { encoded: string; kind: string; id: string };
    projectId: string;
    sessionId?: string;
    agentId?: string;
    teamId?: string;
  }>
> {
  return OK({
    principal: {
      encoded: encodePrincipal(ctx.principal),
      kind: ctx.principal.kind,
      id: ctx.principal.id,
    },
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    teamId: ctx.teamId,
  });
}

// -------------------------------------------------------------------
// Reads
// -------------------------------------------------------------------

interface StoreCheck {
  row: ArtifactStoreRow;
  role: 'owner' | 'writer' | 'reader';
}

async function assertRole(
  deps: HandlerDeps,
  ctx: RequestContext,
  storeId: string,
  required: 'reader' | 'writer' | 'owner',
): Promise<{ ok: true; check: StoreCheck } | { ok: false; result: ToolResult<never> }> {
  const row = await deps.storeRepo.findById(storeId);
  if (!row) return { ok: false, result: ERR('not_found', `store ${storeId} not found`) };
  const role = await deps.aclResolver.resolve(ctx, row);
  if (role === 'none') return { ok: false, result: ERR('forbidden', 'no access to store') };
  if (!roleAtLeast(role, required)) {
    return { ok: false, result: ERR('forbidden', `${required} role required`) };
  }
  return { ok: true, check: { row, role } };
}

export async function handle_read(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; path: string; ref?: string; max_bytes?: number },
): Promise<
  ToolResult<{
    bytes_base64: string;
    size: number;
    truncated: boolean;
    lfs: boolean;
    oid: string;
  } | null>
> {
  const guard = await assertRole(deps, ctx, args.store_id, 'reader');
  if (!guard.ok) return guard.result;
  const max = args.max_bytes ?? 32 * 1024;
  const result = await deps.engine.readBlob(
    guard.check.row.projectId,
    guard.check.row.id,
    args.ref,
    args.path,
    ctx.sessionId,
    Math.min(max, 1024 * 1024),
  );
  if (!result) return OK(null);
  return OK({
    bytes_base64: Buffer.from(result.bytes).toString('base64'),
    size: result.size,
    truncated: result.truncated,
    lfs: result.lfs,
    oid: result.oid,
  });
}

export async function handle_list(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; path?: string; ref?: string; recursive?: boolean; limit?: number },
): Promise<ToolResult<{ entries: unknown[] }>> {
  const guard = await assertRole(deps, ctx, args.store_id, 'reader');
  if (!guard.ok) return guard.result;
  const entries = await deps.engine.listTree(
    guard.check.row.projectId,
    guard.check.row.id,
    args.ref,
    args.path ?? '/',
    ctx.sessionId,
    args.recursive ?? false,
    Math.max(1, Math.min(2000, args.limit ?? 200)),
  );
  return OK({ entries });
}

export async function handle_log(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; ref?: string; path?: string; limit?: number },
): Promise<ToolResult<{ items: unknown[] }>> {
  const guard = await assertRole(deps, ctx, args.store_id, 'reader');
  if (!guard.ok) return guard.result;
  const items = await deps.engine.log(
    guard.check.row.projectId,
    guard.check.row.id,
    args.ref,
    ctx.sessionId,
    {
      limit: Math.max(1, Math.min(200, args.limit ?? 20)),
      path: args.path,
    },
  );
  return OK({ items });
}

// -------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------

async function withIdempotency<T>(
  deps: HandlerDeps,
  ctx: RequestContext,
  namespace: string,
  bodyHash: string,
  build: () => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  const key = ctx.idempotencyKey;
  if (!key) return build();
  const ns = `${namespace}:${ctx.projectId}`;
  const found = await deps.idempotency.lookup<ToolResult<T>>(ns, key, bodyHash);
  if (found.status === 'hit') return found.value;
  if (found.status === 'collision') {
    return ERR(
      'idempotency_collision',
      'idempotency_key reused with a different body',
    );
  }
  const result = await build();
  if (result.ok) {
    await deps.idempotency.store<ToolResult<T>>(ns, key, bodyHash, result);
  }
  return result;
}

async function assertActiveWriter(
  deps: HandlerDeps,
  ctx: RequestContext,
  storeId: string,
): Promise<{ ok: true; check: StoreCheck } | { ok: false; result: ToolResult<never> }> {
  const guard = await assertRole(deps, ctx, storeId, 'writer');
  if (!guard.ok) return guard;
  if (guard.check.row.state !== 'active') {
    return {
      ok: false,
      result: ERR('locked', `store is ${guard.check.row.state}`),
    };
  }
  return guard;
}

export async function handle_write(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: {
    store_id: string;
    path: string;
    content_base64: string;
    message?: string;
    mode?: string;
    ref?: string;
    idempotency_key?: string;
  },
): Promise<ToolResult<{ commit_oid: string; blob_oid: string; lfs: boolean }>> {
  const effCtx: RequestContext = {
    ...ctx,
    idempotencyKey: args.idempotency_key ?? ctx.idempotencyKey,
  };
  const guard = await assertActiveWriter(deps, effCtx, args.store_id);
  if (!guard.ok) return guard.result;
  const content = Buffer.from(args.content_base64, 'base64');
  const bodyHash = IdempotencyStore.hashBody({
    store_id: args.store_id,
    path: args.path,
    content_sha: createHash('sha256').update(content).digest('hex'),
    ref: args.ref ?? 'SESSION',
  });
  return withIdempotency(deps, effCtx, `${args.store_id}:write`, bodyHash, async () => {
    try {
      const w = await deps.engine.writeFile(
        guard.check.row.projectId,
        guard.check.row.id,
        effCtx,
        args.ref,
        args.path,
        new Uint8Array(content),
        guard.check.row.defaultBranch,
        guard.check.row.lfsThresholdBytes,
        {
          op: 'write',
          subject: args.message,
          mode: args.mode,
        },
      );
      return OK({ commit_oid: w.commitOid, blob_oid: w.blobOid, lfs: w.usedLfs });
    } catch (err) {
      if (err instanceof RefDivergedError) {
        return ERR('diverged', 'ref tip changed since you last looked', {
          currentTip: err.currentTip,
          yourTip: err.yourTip,
        });
      }
      throw err;
    }
  });
}

export async function handle_delete(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: {
    store_id: string;
    path: string;
    message?: string;
    ref?: string;
    idempotency_key?: string;
  },
): Promise<ToolResult<{ commit_oid: string }>> {
  const effCtx: RequestContext = {
    ...ctx,
    idempotencyKey: args.idempotency_key ?? ctx.idempotencyKey,
  };
  const guard = await assertActiveWriter(deps, effCtx, args.store_id);
  if (!guard.ok) return guard.result;
  const bodyHash = IdempotencyStore.hashBody({
    op: 'delete',
    store_id: args.store_id,
    path: args.path,
    ref: args.ref ?? 'SESSION',
  });
  return withIdempotency(deps, effCtx, `${args.store_id}:delete`, bodyHash, async () => {
    const result = await deps.engine.deleteFile(
      guard.check.row.projectId,
      guard.check.row.id,
      effCtx,
      args.ref,
      args.path,
      guard.check.row.defaultBranch,
      { subject: args.message },
    );
    if ('status' in result && result.status === 'not_found') {
      return ERR('not_found', `path ${args.path} not in tree`);
    }
    return OK({ commit_oid: (result as { commitOid: string }).commitOid });
  });
}

export async function handle_tag(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; name: string; message: string; ref?: string; idempotency_key?: string },
): Promise<ToolResult<{ tag_oid: string; commit_oid: string }>> {
  const effCtx: RequestContext = {
    ...ctx,
    idempotencyKey: args.idempotency_key ?? ctx.idempotencyKey,
  };
  const guard = await assertActiveWriter(deps, effCtx, args.store_id);
  if (!guard.ok) return guard.result;
  if (!/^[A-Za-z0-9_.\-/]{1,200}$/.test(args.name)) {
    return ERR('invalid_arg', 'tag name has illegal characters');
  }
  const bodyHash = IdempotencyStore.hashBody({
    op: 'tag',
    store_id: args.store_id,
    name: args.name,
    ref: args.ref ?? 'SESSION',
  });
  return withIdempotency(deps, effCtx, `${args.store_id}:tag`, bodyHash, async () => {
    const t = await deps.engine.tag(
      guard.check.row.projectId,
      guard.check.row.id,
      effCtx,
      args.name,
      args.ref,
      args.message,
    );
    return OK({ tag_oid: t.tagOid, commit_oid: t.commitOid });
  });
}

export async function handle_revert(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; commit: string; ref?: string; subject?: string; idempotency_key?: string },
): Promise<
  ToolResult<
    | { status: 'ok'; commit_oid: string }
    | { status: 'noop'; commit_oid: string }
    | { status: 'conflict'; conflicts: unknown[] }
  >
> {
  const effCtx: RequestContext = {
    ...ctx,
    idempotencyKey: args.idempotency_key ?? ctx.idempotencyKey,
  };
  const guard = await assertActiveWriter(deps, effCtx, args.store_id);
  if (!guard.ok) return guard.result;
  if (!/^[0-9a-f]{40}$/.test(args.commit)) {
    return ERR('invalid_arg', 'commit must be a 40-hex git sha');
  }
  const bodyHash = IdempotencyStore.hashBody({
    op: 'revert',
    store_id: args.store_id,
    commit: args.commit,
    ref: args.ref ?? 'SESSION',
  });
  type RevertOk =
    | { status: 'ok'; commit_oid: string }
    | { status: 'noop'; commit_oid: string }
    | { status: 'conflict'; conflicts: unknown[] };
  return withIdempotency<RevertOk>(deps, effCtx, `${args.store_id}:revert`, bodyHash, async () => {
    const r = await deps.engine.revert(
      guard.check.row.projectId,
      guard.check.row.id,
      effCtx,
      args.commit,
      args.ref,
      guard.check.row.defaultBranch,
      args.subject,
    );
    if (r.status === 'ok') {
      return OK<RevertOk>({ status: 'ok', commit_oid: r.commitOid });
    }
    if (r.status === 'noop') {
      return OK<RevertOk>({ status: 'noop', commit_oid: r.commitOid });
    }
    return OK<RevertOk>({ status: 'conflict', conflicts: r.conflicts });
  });
}

export async function handle_merge(
  deps: HandlerDeps,
  ctx: RequestContext,
  args: { store_id: string; from_ref?: string; into?: string; strategy?: 'ff-only' },
): Promise<
  ToolResult<
    | { status: 'ok'; commit_oid: string; fast_forward: boolean }
    | { status: 'noop'; commit_oid: string }
    | { status: 'conflict'; conflicts: unknown[] }
  >
> {
  const guard = await assertActiveWriter(deps, ctx, args.store_id);
  if (!guard.ok) return guard.result;
  if (args.strategy && args.strategy !== 'ff-only') {
    return ERR('invalid_arg', 'only strategy=ff-only is supported in P1');
  }
  const result = await deps.engine.mergeFastForward(
    guard.check.row.projectId,
    guard.check.row.id,
    ctx,
    args.from_ref,
    args.into ?? guard.check.row.defaultBranch,
  );
  if (result.status === 'ok') {
    return OK({ status: 'ok', commit_oid: result.commitOid, fast_forward: result.fastForward });
  }
  if (result.status === 'noop') {
    return OK({ status: 'noop', commit_oid: result.commitOid });
  }
  return OK({ status: 'conflict', conflicts: result.conflicts });
}

/** Map a tool name to its handler function. Used by both the MCP server
 * registration and the unit tests. */
export const TOOL_HANDLERS = {
  list_stores: handle_list_stores,
  whoami: handle_whoami,
  read: handle_read,
  list: handle_list,
  log: handle_log,
  write: handle_write,
  delete: handle_delete,
  tag: handle_tag,
  revert: handle_revert,
  merge: handle_merge,
} as const;

export type ToolName = keyof typeof TOOL_HANDLERS;
export const TOOL_NAMES: ToolName[] = Object.keys(TOOL_HANDLERS) as ToolName[];

// Re-export so the MCP server can stamp the `X-Op` trailer correctly.
export type { ArtifactOp };
