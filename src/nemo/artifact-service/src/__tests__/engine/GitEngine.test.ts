import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PathResolver } from '../../engine/PathResolver';
import { GitEngine, RefDivergedError } from '../../engine/GitEngine';
import { RequestContext } from '../../types/Principal';

const PROJECT = 'projtest';
const STORE = 'asabc12345';
const DEFAULT_BRANCH = 'main';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const ctx = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  principal: { kind: 'agent', id: STORE, displayName: 'demo-agent' },
  projectId: PROJECT,
  sessionId: 'sess-1',
  agentId: STORE,
  ...overrides,
});

describe('GitEngine', () => {
  let tmpRoot: string;
  let engine: GitEngine;
  let paths: PathResolver;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-engine-'));
    paths = new PathResolver(tmpRoot);
    engine = new GitEngine(paths);
    await engine.initStore(PROJECT, STORE, DEFAULT_BRANCH);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('write → read round-trip on the session branch', async () => {
    const w = await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/notes.md',
      enc('hello world'),
      DEFAULT_BRANCH,
      102400,
      { subject: 'first' },
    );
    expect(w.commitOid).toMatch(/^[0-9a-f]{40}$/);
    const r = await engine.readBlob(PROJECT, STORE, 'SESSION', '/notes.md', 'sess-1');
    expect(r).not.toBeNull();
    expect(dec(r!.bytes)).toBe('hello world');
    expect(r!.truncated).toBe(false);
    expect(r!.lfs).toBe(false);
  });

  it('auto-creates the session branch off defaultBranch on first write', async () => {
    // Seed main with a commit so sessions branch from a known tip.
    await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'refs/heads/main',
      '/base.md',
      enc('base'),
      DEFAULT_BRANCH,
      102400,
      { subject: 'seed' },
    );
    const mainOid = await engine.resolveRef(PROJECT, STORE, 'refs/heads/main');
    expect(mainOid).not.toBeNull();
    const w = await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/session-only.md',
      enc('session content'),
      DEFAULT_BRANCH,
      102400,
    );
    const sessionOid = await engine.resolveRef(PROJECT, STORE, 'SESSION', 'sess-1');
    expect(sessionOid).toBe(w.commitOid);
    // base.md is visible on session branch (inherited from main)
    const base = await engine.readBlob(PROJECT, STORE, 'SESSION', '/base.md', 'sess-1');
    expect(base).not.toBeNull();
    expect(dec(base!.bytes)).toBe('base');
  });

  it('stamps audit trailers on every commit via CommitBuilder', async () => {
    await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/a.txt',
      enc('a'),
      DEFAULT_BRANCH,
      102400,
    );
    const log = await engine.log(PROJECT, STORE, 'SESSION', 'sess-1');
    expect(log.length).toBeGreaterThan(0);
    const top = log[0];
    expect(top.trailers['X-Principal']).toBe('agent:' + STORE);
    expect(top.trailers['X-Session-Id']).toBe('sess-1');
    expect(top.trailers['X-Op']).toBe('write');
  });

  it('CAS via ifMatch rejects stale parent', async () => {
    const w1 = await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/x.md',
      enc('one'),
      DEFAULT_BRANCH,
      102400,
    );
    // ifMatch=null means "no parent expected" — should diverge.
    await expect(
      engine.writeFile(
        PROJECT,
        STORE,
        ctx(),
        'SESSION',
        '/x.md',
        enc('two'),
        DEFAULT_BRANCH,
        102400,
        { ifMatch: '' },
      ),
    ).rejects.toBeInstanceOf(RefDivergedError);
    // Now supply the right parent oid and succeed.
    const w2 = await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/x.md',
      enc('two'),
      DEFAULT_BRANCH,
      102400,
      { ifMatch: w1.commitOid },
    );
    expect(w2.commitOid).not.toBe(w1.commitOid);
  });

  it('LFS sidecar engages above threshold; pointer dereferences transparently', async () => {
    const big = new Uint8Array(200 * 1024); // 200 KB
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const w = await engine.writeFile(
      PROJECT,
      STORE,
      ctx(),
      'SESSION',
      '/big.bin',
      big,
      DEFAULT_BRANCH,
      102400, // 100 KB threshold
    );
    expect(w.usedLfs).toBe(true);
    const r = await engine.readBlob(PROJECT, STORE, 'SESSION', '/big.bin', 'sess-1');
    expect(r!.lfs).toBe(true);
    expect(r!.bytes.length).toBe(big.length);
    // Underlying CAS file exists.
    const sha = await import('crypto').then((m) => m.createHash('sha256').update(big).digest('hex'));
    const onDisk = await fs.readFile(paths.blobPath(PROJECT, sha));
    expect(onDisk.length).toBe(big.length);
  });

  it('list returns tree entries for the ref', async () => {
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/a.md', enc('a'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/b/c.md', enc('c'), DEFAULT_BRANCH, 102400);
    const root = await engine.listTree(PROJECT, STORE, 'SESSION', '/', 'sess-1');
    const names = root.map((e) => e.name).sort();
    expect(names).toEqual(['a.md', 'b']);
    const recursive = await engine.listTree(PROJECT, STORE, 'SESSION', '/', 'sess-1', true);
    const all = recursive.map((e) => e.name).sort();
    expect(all).toEqual(['a.md', 'b', 'b/c.md']);
  });

  it('delete removes file via a forward commit', async () => {
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/x.md', enc('x'), DEFAULT_BRANCH, 102400);
    const d = await engine.deleteFile(PROJECT, STORE, ctx(), 'SESSION', '/x.md', DEFAULT_BRANCH);
    expect('commitOid' in d).toBe(true);
    const r = await engine.readBlob(PROJECT, STORE, 'SESSION', '/x.md', 'sess-1');
    expect(r).toBeNull();
  });

  it('tag creates an annotated tag at the current tip', async () => {
    const w = await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/n.md', enc('n'), DEFAULT_BRANCH, 102400);
    const t = await engine.tag(PROJECT, STORE, ctx(), 'v1', 'SESSION', 'first cut');
    expect(t.commitOid).toBe(w.commitOid);
    const tagOid = await engine.resolveRef(PROJECT, STORE, 'refs/tags/v1');
    expect(tagOid).not.toBeNull();
  });

  it('revert applies inverse as a new forward commit', async () => {
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/n.md', enc('one'), DEFAULT_BRANCH, 102400);
    const w2 = await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/n.md', enc('two'), DEFAULT_BRANCH, 102400);
    const r = await engine.revert(PROJECT, STORE, ctx(), w2.commitOid, 'SESSION', DEFAULT_BRANCH);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.commitOid).not.toBe(w2.commitOid);
    const content = await engine.readBlob(PROJECT, STORE, 'SESSION', '/n.md', 'sess-1');
    expect(dec(content!.bytes)).toBe('one');
    // Audit trailer carries X-Op:revert
    const log = await engine.log(PROJECT, STORE, 'SESSION', 'sess-1');
    expect(log[0].trailers['X-Op']).toBe('revert');
  });

  it('revert preserves later commits to unrelated files', async () => {
    // The old implementation reset the tree to target's parent, which
    // wiped every file touched after the target. The fix is a true
    // three-way revert: only target's changes are undone; everything
    // else stays.
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/a.md', enc('a-v1'), DEFAULT_BRANCH, 102400);
    const wB = await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/b.md', enc('b'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/c.md', enc('c'), DEFAULT_BRANCH, 102400);
    const r = await engine.revert(PROJECT, STORE, ctx(), wB.commitOid, 'SESSION', DEFAULT_BRANCH);
    expect(r.status).toBe('ok');
    // a.md and c.md must survive; b.md must be gone.
    const a = await engine.readBlob(PROJECT, STORE, 'SESSION', '/a.md', 'sess-1');
    const b = await engine.readBlob(PROJECT, STORE, 'SESSION', '/b.md', 'sess-1');
    const c = await engine.readBlob(PROJECT, STORE, 'SESSION', '/c.md', 'sess-1');
    expect(a).not.toBeNull();
    expect(dec(a!.bytes)).toBe('a-v1');
    expect(b).toBeNull();
    expect(c).not.toBeNull();
    expect(dec(c!.bytes)).toBe('c');
  });

  it('revert surfaces a conflict when the target path was re-modified after target', async () => {
    // target = wMid modifies a.md from "v1" -> "v2". Then we modify a.md
    // again to "v3". Reverting wMid would have to put a.md back to "v1",
    // but HEAD has "v3" (neither target's nor target's parent's). That's
    // the conflict case.
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/a.md', enc('v1'), DEFAULT_BRANCH, 102400);
    const wMid = await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/a.md', enc('v2'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/a.md', enc('v3'), DEFAULT_BRANCH, 102400);
    const r = await engine.revert(PROJECT, STORE, ctx(), wMid.commitOid, 'SESSION', DEFAULT_BRANCH);
    expect(r.status).toBe('conflict');
    if (r.status !== 'conflict') return;
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0].path).toBe('a.md');
    expect(r.conflicts[0].reason).toBe('modified_after_target');
    // The session-branch ref should NOT have advanced — we refused to commit.
    const headAfter = await engine.readBlob(PROJECT, STORE, 'SESSION', '/a.md', 'sess-1');
    expect(dec(headAfter!.bytes)).toBe('v3');
  });

  it('revert noop when target is the root commit fails clearly', async () => {
    // First commit on a fresh session branch has no parent; can't diff.
    const first = await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/x.md', enc('x'), DEFAULT_BRANCH, 102400);
    await expect(
      engine.revert(PROJECT, STORE, ctx(), first.commitOid, 'SESSION', DEFAULT_BRANCH),
    ).rejects.toThrow(/root commit/);
  });

  it('ff merge of session branch into main', async () => {
    await engine.writeFile(PROJECT, STORE, ctx(), 'refs/heads/main', '/m.md', enc('m'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/s.md', enc('s'), DEFAULT_BRANCH, 102400);
    const result = await engine.mergeFastForward(PROJECT, STORE, ctx(), 'SESSION', 'main');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.fastForward).toBe(true);
    const mainHas = await engine.readBlob(PROJECT, STORE, 'refs/heads/main', '/s.md');
    expect(mainHas).not.toBeNull();
  });

  it('non-ff merge surfaces a structured conflict', async () => {
    // Diverge: write on main then write differently on the session branch
    // (session branched off the prior tip, but we then advance main).
    await engine.writeFile(PROJECT, STORE, ctx(), 'refs/heads/main', '/seed.md', enc('seed'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/session.md', enc('s'), DEFAULT_BRANCH, 102400);
    await engine.writeFile(PROJECT, STORE, ctx(), 'refs/heads/main', '/post.md', enc('post'), DEFAULT_BRANCH, 102400);
    const result = await engine.mergeFastForward(PROJECT, STORE, ctx(), 'SESSION', 'main');
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.conflicts[0].reason).toBe('non_ff_merge_required');
    }
  });

  it('returns truncated:true when maxBytes is exceeded', async () => {
    const text = 'x'.repeat(1000);
    await engine.writeFile(PROJECT, STORE, ctx(), 'SESSION', '/big.txt', enc(text), DEFAULT_BRANCH, 1024 * 1024);
    const r = await engine.readBlob(PROJECT, STORE, 'SESSION', '/big.txt', 'sess-1', 100);
    expect(r!.truncated).toBe(true);
    expect(r!.bytes.length).toBe(100);
    expect(r!.size).toBe(1000);
  });
});
