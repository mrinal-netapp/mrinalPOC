import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../engine/PathResolver';
import { GitEngine } from '../../engine/GitEngine';
import { AclResolver } from '../../acl/AclResolver';
import { IdempotencyStore } from '../../services/IdempotencyStore';
import {
  handle_list_stores,
  handle_whoami,
  handle_read,
  handle_list,
  handle_log,
  handle_write,
  handle_delete,
  handle_tag,
  handle_revert,
  handle_merge,
  HandlerDeps,
} from '../../mcp/handlers';
import {
  ArtifactStoreAclRow,
  ArtifactStoreRow,
} from '../../types/ArtifactStore';
import { Principal, RequestContext } from '../../types/Principal';

/**
 * In-memory fakes for StoreRepo / AclRepo. The handlers only call a small
 * subset of methods, so the surface is intentionally narrow.
 */
function makeFakes(stores: ArtifactStoreRow[], acls: ArtifactStoreAclRow[]) {
  const storeRepo = {
    findById: async (id: string) =>
      stores.find((s) => s.id === id) ?? null,
    findByProjectAndName: async (projectId: string, name: string) =>
      stores.find((s) => s.projectId === projectId && s.name === name) ?? null,
    list: async ({ projectId }: { projectId: string }) =>
      stores.filter((s) => s.projectId === projectId && s.state !== 'deleting'),
    create: async () => stores[0],
    update: async () => stores[0],
    softDelete: async () => true,
  };
  const aclRepo = {
    listForStore: async (storeId: string) =>
      acls.filter((a) => a.storeId === storeId),
    find: async (
      storeId: string,
      pt: ArtifactStoreAclRow['principalType'],
      pid: string,
    ) =>
      acls.find(
        (a) => a.storeId === storeId && a.principalType === pt && a.principalId === pid,
      ) ?? null,
    upsert: async () => acls[0],
    remove: async () => true,
  };
  return { storeRepo, aclRepo };
}

const baseCtx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  principal: { kind: 'user', id: 'user-owner' } as Principal,
  projectId: 'projtest',
  sessionId: 'sess-1',
  ...overrides,
});

const mkStore = (overrides: Partial<ArtifactStoreRow> = {}): ArtifactStoreRow => ({
  id: 'asabc12345',
  projectId: 'projtest',
  name: 'demo',
  description: null,
  ownerUserId: 'user-owner',
  defaultBranch: 'main',
  lfsThresholdBytes: 102400,
  quotaBytes: null,
  state: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('MCP tool handlers', () => {
  let tmpRoot: string;
  let engine: GitEngine;
  let store: ArtifactStoreRow;
  let deps: HandlerDeps;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-handlers-'));
    const paths = new PathResolver(tmpRoot);
    engine = new GitEngine(paths);
    store = mkStore();
    await engine.initStore(store.projectId, store.id, store.defaultBranch);
    const { storeRepo, aclRepo } = makeFakes([store], []);
    deps = {
      engine,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storeRepo: storeRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aclRepo: aclRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aclResolver: new AclResolver(aclRepo as any),
      idempotency: new IdempotencyStore(null),
    };
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('whoami returns the resolved principal', async () => {
    const r = await handle_whoami(deps, baseCtx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.principal.encoded).toBe('user:user-owner');
      expect(r.data.sessionId).toBe('sess-1');
    }
  });

  it('list_stores filters by ACL visibility', async () => {
    const r = await handle_list_stores(deps, baseCtx(), {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.items.length).toBe(1);
      expect(r.data.items[0].id).toBe(store.id);
    }
  });

  it('list_stores rejects mismatched project_id', async () => {
    const r = await handle_list_stores(deps, baseCtx(), { project_id: 'wrong' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('write → read → log round-trip via tools', async () => {
    const content = Buffer.from('hello, world');
    const w = await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/notes.md',
      content_base64: content.toString('base64'),
      message: 'first',
    });
    expect(w.ok).toBe(true);

    const r = await handle_read(deps, baseCtx(), { store_id: store.id, path: '/notes.md' });
    expect(r.ok).toBe(true);
    if (r.ok && r.data) {
      expect(Buffer.from(r.data.bytes_base64, 'base64').toString('utf8')).toBe('hello, world');
    }

    const log = await handle_log(deps, baseCtx(), { store_id: store.id });
    expect(log.ok).toBe(true);
    if (log.ok) {
      const top = log.data.items[0] as { trailers: Record<string, string> };
      expect(top.trailers['X-Op']).toBe('write');
      expect(top.trailers['X-Principal']).toBe('user:user-owner');
    }
  });

  it('write returns forbidden when principal lacks access', async () => {
    const r = await handle_write(deps, baseCtx({ principal: { kind: 'agent', id: 'other-agent' } }), {
      store_id: store.id,
      path: '/x.md',
      content_base64: Buffer.from('x').toString('base64'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('forbidden');
  });

  it('idempotency: same key + same body → cached commit replayed', async () => {
    // Use a mock Redis so the dedup cache is exercised.
    const data = new Map<string, string>();
    const mockRedis = {
      get: async (k: string) => data.get(k) ?? null,
      set: async (k: string, v: string) => {
        data.set(k, v);
        return 'OK';
      },
    } as unknown as import('ioredis').Redis;
    deps.idempotency = new IdempotencyStore(mockRedis);

    const body = {
      store_id: store.id,
      path: '/dup.md',
      content_base64: Buffer.from('once').toString('base64'),
      idempotency_key: 'k1',
    };
    const r1 = await handle_write(deps, baseCtx(), body);
    expect(r1.ok).toBe(true);

    const r2 = await handle_write(deps, baseCtx(), body);
    expect(r2.ok).toBe(true);

    if (r1.ok && r2.ok) {
      expect(r2.data.commit_oid).toBe(r1.data.commit_oid);
    }

    // Different body with the same key → collision
    const r3 = await handle_write(deps, baseCtx(), {
      ...body,
      content_base64: Buffer.from('different').toString('base64'),
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe('idempotency_collision');
  });

  it('list returns tree entries without bytes', async () => {
    await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/a.md',
      content_base64: Buffer.from('a').toString('base64'),
    });
    const r = await handle_list(deps, baseCtx(), { store_id: store.id });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = (r.data.entries as { name: string }[]).map((e) => e.name);
      expect(names).toContain('a.md');
    }
  });

  it('delete removes the file', async () => {
    await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/del.md',
      content_base64: Buffer.from('to-delete').toString('base64'),
    });
    const d = await handle_delete(deps, baseCtx(), { store_id: store.id, path: '/del.md' });
    expect(d.ok).toBe(true);
    const r = await handle_read(deps, baseCtx(), { store_id: store.id, path: '/del.md' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBeNull();
  });

  it('tag and revert thread X-Op trailers correctly', async () => {
    // Need at least two commits so the second one has a parent to diff
    // against; revert of the root commit is now rejected explicitly.
    const w0 = await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/v.md',
      content_base64: Buffer.from('v0').toString('base64'),
    });
    expect(w0.ok).toBe(true);
    const w = await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/v.md',
      content_base64: Buffer.from('v1').toString('base64'),
    });
    expect(w.ok).toBe(true);
    if (!w.ok) return;

    const t = await handle_tag(deps, baseCtx(), {
      store_id: store.id,
      name: 'v1',
      message: 'first cut',
    });
    expect(t.ok).toBe(true);

    const r = await handle_revert(deps, baseCtx(), {
      store_id: store.id,
      commit: w.data.commit_oid,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe('ok');
    }

    const log = await handle_log(deps, baseCtx(), { store_id: store.id });
    expect(log.ok).toBe(true);
    if (log.ok) {
      const ops = (log.data.items as { trailers: Record<string, string> }[]).map(
        (c) => c.trailers['X-Op'],
      );
      expect(ops[0]).toBe('revert');
    }
  });

  it('merge ff into main succeeds when session is ahead', async () => {
    await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/x.md',
      content_base64: Buffer.from('x').toString('base64'),
      ref: 'refs/heads/main',
    });
    await handle_write(deps, baseCtx(), {
      store_id: store.id,
      path: '/y.md',
      content_base64: Buffer.from('y').toString('base64'),
    });
    const m = await handle_merge(deps, baseCtx(), { store_id: store.id });
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.data.status).toBe('ok');
    }
  });
});
