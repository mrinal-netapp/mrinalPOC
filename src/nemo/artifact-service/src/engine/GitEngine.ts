import * as fsCb from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as git from 'isomorphic-git';
import { PathResolver } from './PathResolver';
import { RefResolver } from './RefResolver';
import { LfsSidecar } from './LfsSidecar';
import {
  CommitBuilder,
  ArtifactOp,
  BuildCommitMessageInput,
} from './CommitBuilder';
import { RequestContext } from '../types/Principal';

export interface TreeEntryView {
  mode: string;
  name: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
  /** Size in bytes (for blobs; lazily computed). */
  size?: number;
  /** True if the blob is an LFS pointer; size reflects the underlying object. */
  lfs?: boolean;
}

export interface BlobReadResult {
  bytes: Uint8Array;
  oid: string;
  /** Total uncompressed size of the underlying content (post-LFS). */
  size: number;
  /** True if response was truncated by a caller-supplied size cap. */
  truncated: boolean;
  /** True if the blob is an LFS pointer; bytes are the dereferenced content. */
  lfs: boolean;
}

export interface CommitView {
  oid: string;
  parents: string[];
  message: string;
  subject: string;
  trailers: Record<string, string>;
  author: { name: string; email: string; timestamp: number; timezoneOffset: number };
  committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
}

export interface MergeConflict {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  reason: string;
}

export type MergeResult =
  | { status: 'ok'; commitOid: string; fastForward: boolean }
  | { status: 'noop'; commitOid: string }
  | { status: 'conflict'; conflicts: MergeConflict[] };

/**
 * Result of `revert`. Mirrors MergeResult so callers handle conflicts
 * the same way regardless of whether they were reached via merge or
 * revert.
 */
export type RevertResult =
  | { status: 'ok'; commitOid: string }
  | { status: 'noop'; commitOid: string }
  | { status: 'conflict'; conflicts: MergeConflict[] };

export interface WriteFileOpts {
  /** Operation tag for the audit trailer (defaults to 'write'). */
  op?: ArtifactOp;
  /** Optional commit subject; an op-specific default is used when absent. */
  subject?: string;
  /** Optional commit body. */
  body?: string;
  /** File mode (default 0o100644 regular file). */
  mode?: string;
  /** Optional CAS guard: only commit if parent ref tip matches this oid. */
  ifMatch?: string | null;
}

export interface LogOpts {
  limit?: number;
  path?: string;
  since?: Date;
  until?: Date;
  author?: string;
}

/**
 * Single point of access to bare git repositories for the artifact store.
 * Wraps isomorphic-git with the path/ref/LFS/trailer conventions used by
 * the rest of the service.
 *
 * Concurrency: all write methods take a per-storeId async lock so two
 * concurrent writes targeting the same store are serialised within
 * this process. Different stores write in parallel. This protects
 * isomorphic-git's ref/object writes from racing on the same `.git/`
 * directory under load. Multi-pod safety needs a Redis-distributed
 * lock — out of scope for P1; values.yaml ships replicaCount: 1.
 */
export class GitEngine {
  /**
   * Tail of the in-flight write chain per storeId. New writes append
   * to the chain and wait for previous writes to settle. Entries are
   * GC'd when their chain drains (so steady-state memory is O(active
   * writers), not O(stores ever touched)).
   */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly paths: PathResolver = new PathResolver(),
    private readonly refs: RefResolver = new RefResolver(),
    private readonly lfs: LfsSidecar = new LfsSidecar(paths),
  ) {}

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /** Initialize the bare repo for a store if it doesn't exist. */
  async initStore(
    projectId: string,
    storeId: string,
    defaultBranch = 'main',
  ): Promise<void> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    await fs.mkdir(this.paths.artifactsDir(projectId), { recursive: true });
    try {
      await fs.access(path.join(gitdir, 'HEAD'));
      return; // already initialised
    } catch {
      // fallthrough
    }
    await fs.mkdir(gitdir, { recursive: true });
    await git.init({ fs: fsCb, gitdir, bare: true, defaultBranch });
  }

  async repoExists(projectId: string, storeId: string): Promise<boolean> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    try {
      await fs.access(path.join(gitdir, 'HEAD'));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async resolveRef(
    projectId: string,
    storeId: string,
    ref: string | undefined,
    sessionId?: string,
  ): Promise<string | null> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fq = this.refs.resolve(ref, sessionId);
    try {
      return await git.resolveRef({ fs: fsCb, gitdir, ref: fq });
    } catch {
      return null;
    }
  }

  async listRefs(
    projectId: string,
    storeId: string,
  ): Promise<{ name: string; oid: string }[]> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const heads = await git.listBranches({ fs: fsCb, gitdir }).catch(() => []);
    const tags = await git.listTags({ fs: fsCb, gitdir }).catch(() => []);
    const out: { name: string; oid: string }[] = [];
    for (const h of heads) {
      const name = `refs/heads/${h}`;
      try {
        out.push({ name, oid: await git.resolveRef({ fs: fsCb, gitdir, ref: name }) });
      } catch {
        // ignore
      }
    }
    for (const t of tags) {
      const name = `refs/tags/${t}`;
      try {
        out.push({ name, oid: await git.resolveRef({ fs: fsCb, gitdir, ref: name }) });
      } catch {
        // ignore
      }
    }
    return out;
  }

  /**
   * Read a file at `ref:path`. If `maxBytes` is set, response is truncated
   * and `truncated: true` is returned. LFS pointers are transparently
   * dereferenced.
   */
  async readBlob(
    projectId: string,
    storeId: string,
    ref: string | undefined,
    filePath: string,
    sessionId?: string,
    maxBytes?: number,
  ): Promise<BlobReadResult | null> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(ref, sessionId);
    const commitOid = await git
      .resolveRef({ fs: fsCb, gitdir, ref: fqRef })
      .catch(() => null);
    if (!commitOid) return null;

    const normalized = this.normalizeFilePath(filePath);
    let blobObj;
    try {
      blobObj = await git.readBlob({
        fs: fsCb,
        gitdir,
        oid: commitOid,
        filepath: normalized,
      });
    } catch {
      return null;
    }

    let bytes = new Uint8Array(blobObj.blob.buffer, blobObj.blob.byteOffset, blobObj.blob.byteLength);
    let lfs = false;
    if (LfsSidecar.isPointer(bytes)) {
      const pointer = LfsSidecar.parsePointer(bytes);
      bytes = await this.lfs.load(projectId, pointer);
      lfs = true;
    }

    const total = bytes.length;
    let truncated = false;
    if (maxBytes && bytes.length > maxBytes) {
      bytes = bytes.subarray(0, maxBytes);
      truncated = true;
    }

    return { bytes, oid: blobObj.oid, size: total, truncated, lfs };
  }

  /**
   * List entries at `ref:path/` (one level by default; pass recursive=true
   * to walk subtrees, capped at `limit` entries).
   */
  async listTree(
    projectId: string,
    storeId: string,
    ref: string | undefined,
    dirPath: string,
    sessionId?: string,
    recursive = false,
    limit = 200,
  ): Promise<TreeEntryView[]> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(ref, sessionId);
    const commitOid = await git
      .resolveRef({ fs: fsCb, gitdir, ref: fqRef })
      .catch(() => null);
    if (!commitOid) return [];

    const dir = this.normalizeDirPath(dirPath);
    const result: TreeEntryView[] = [];

    const walk = async (currentDir: string, depth: number): Promise<void> => {
      if (result.length >= limit) return;
      let tree;
      try {
        tree = await git.readTree({
          fs: fsCb,
          gitdir,
          oid: commitOid,
          filepath: currentDir,
        });
      } catch {
        return;
      }
      for (const e of tree.tree) {
        if (result.length >= limit) return;
        const view: TreeEntryView = {
          mode: e.mode,
          name: currentDir ? `${currentDir}/${e.path}` : e.path,
          oid: e.oid,
          type: e.type as 'blob' | 'tree' | 'commit',
        };
        result.push(view);
        if (recursive && e.type === 'tree') {
          await walk(view.name, depth + 1);
        }
      }
    };

    await walk(dir, 0);
    return result;
  }

  // -------------------------------------------------------------------
  // Writes (per-storeId serialised via withStoreLock)
  // -------------------------------------------------------------------

  /**
   * Per-storeId serialisation gate. Chains in-flight writes so two
   * concurrent calls touching the same store don't race on
   * isomorphic-git's ref/object writes. Cross-store writes proceed
   * in parallel.
   *
   * Implementation: maintain a tail-promise per storeId; each new
   * task waits for the previous chain to settle, then runs. After
   * settlement we drop the entry if no one else has appended.
   */
  private async withStoreLock<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(storeId) ?? Promise.resolve();
    // .catch swallows the prior task's failure so a failed write
    // doesn't poison the chain for subsequent writes.
    const task = prev.catch(() => undefined).then(() => fn());
    this.writeChains.set(storeId, task);
    try {
      return await task;
    } finally {
      if (this.writeChains.get(storeId) === task) {
        this.writeChains.delete(storeId);
      }
    }
  }

  /**
   * Atomically write a file and commit. Creates the session branch off
   * `defaultBranch` if it doesn't exist. Returns the new commit oid.
   *
   * Optional CAS via `ifMatch`: if supplied and the current ref tip
   * doesn't match, throws `RefDivergedError` which higher layers translate
   * to a 409 with `{currentTip, yourTip, diverged:true}`.
   */
  async writeFile(
    projectId: string,
    storeId: string,
    ctx: RequestContext,
    refOrSentinel: string | undefined,
    filePath: string,
    content: Uint8Array,
    defaultBranch: string,
    lfsThresholdBytes: number,
    opts: WriteFileOpts = {},
  ): Promise<{ commitOid: string; blobOid: string; usedLfs: boolean }> {
    return this.withStoreLock(storeId, async () => {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(refOrSentinel, ctx.sessionId);
    const normalized = this.normalizeFilePath(filePath);

    const { parentOid, parentTreeOid } = await this.resolveParent(
      gitdir,
      fqRef,
      defaultBranch,
    );

    if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
      if (opts.ifMatch !== (parentOid ?? '')) {
        const e = new RefDivergedError(parentOid ?? null, opts.ifMatch);
        throw e;
      }
    }

    // LFS handling: large blobs become a pointer JSON.
    let usedLfs = false;
    let blobBytes: Uint8Array = content;
    if (content.length >= lfsThresholdBytes) {
      const pointer = await this.lfs.store(projectId, content);
      blobBytes = LfsSidecar.encodePointer(pointer);
      usedLfs = true;
    }

    const blobOid = await git.writeBlob({
      fs: fsCb,
      gitdir,
      blob: Buffer.from(blobBytes),
    });

    const mode = opts.mode ?? '100644';
    const newRootTreeOid = await this.upsertPathInTree(
      gitdir,
      parentTreeOid,
      normalized,
      blobOid,
      mode,
    );

    const commitOid = await this.buildCommit({
      gitdir,
      ctx,
      op: opts.op ?? 'write',
      subject: opts.subject ?? `write ${normalized}`,
      body: opts.body,
      treeOid: newRootTreeOid,
      parentOid,
    });

    await git.writeRef({
      fs: fsCb,
      gitdir,
      ref: fqRef,
      value: commitOid,
      force: true,
    });

    return { commitOid, blobOid, usedLfs };
    });
  }

  async deleteFile(
    projectId: string,
    storeId: string,
    ctx: RequestContext,
    refOrSentinel: string | undefined,
    filePath: string,
    defaultBranch: string,
    opts: { subject?: string; ifMatch?: string | null } = {},
  ): Promise<{ commitOid: string } | { status: 'not_found' }> {
    return this.withStoreLock(storeId, async () => {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(refOrSentinel, ctx.sessionId);
    const normalized = this.normalizeFilePath(filePath);

    const { parentOid, parentTreeOid } = await this.resolveParent(
      gitdir,
      fqRef,
      defaultBranch,
    );
    if (!parentTreeOid) return { status: 'not_found' as const };

    if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
      if (opts.ifMatch !== (parentOid ?? '')) {
        throw new RefDivergedError(parentOid ?? null, opts.ifMatch);
      }
    }

    const newRoot = await this.removePathFromTree(gitdir, parentTreeOid, normalized);
    if (newRoot === null) return { status: 'not_found' as const };

    const commitOid = await this.buildCommit({
      gitdir,
      ctx,
      op: 'delete',
      subject: opts.subject ?? `delete ${normalized}`,
      treeOid: newRoot,
      parentOid,
    });
    await git.writeRef({ fs: fsCb, gitdir, ref: fqRef, value: commitOid, force: true });
    return { commitOid };
    });
  }

  /**
   * Create an annotated tag (= snapshot) at `ref`'s current tip.
   */
  async tag(
    projectId: string,
    storeId: string,
    ctx: RequestContext,
    tagName: string,
    refOrSentinel: string | undefined,
    message: string,
  ): Promise<{ tagOid: string; commitOid: string }> {
    return this.withStoreLock(storeId, async () => {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(refOrSentinel, ctx.sessionId);
    const commitOid = await git.resolveRef({ fs: fsCb, gitdir, ref: fqRef });

    const author = CommitBuilder.buildAuthor({ principal: ctx.principal });
    const body = CommitBuilder.buildMessage({
      ctx,
      op: 'tag',
      subject: message || `tag ${tagName}`,
    });

    const tagOid = await git.annotatedTag({
      fs: fsCb,
      gitdir,
      ref: tagName,
      object: commitOid,
      message: body,
      tagger: {
        name: author.name,
        email: author.email,
        timestamp: author.timestamp,
        timezoneOffset: author.timezoneOffset,
      },
    });
    return { tagOid: typeof tagOid === 'string' ? tagOid : commitOid, commitOid };
    });
  }

  /**
   * Forward-commit revert: apply the inverse of `targetCommitOid` as a
   * new commit on top of `ref`'s current tip. This is a real three-way
   * revert (mirrors `git revert`): the changes target introduced
   * relative to its parent are inverted against HEAD's tree. Files
   * target modified that have NOT been re-modified after target are
   * restored; files added by target are removed; files deleted by
   * target are restored. Anything that was changed again after target
   * surfaces as a structured conflict and we DO NOT commit — callers
   * decide whether to resolve and retry.
   *
   * The previous implementation reset HEAD's tree to target's parent's
   * tree, which silently dropped every change made after target. That
   * was data loss; this version is correct.
   */
  async revert(
    projectId: string,
    storeId: string,
    ctx: RequestContext,
    targetCommitOid: string,
    refOrSentinel: string | undefined,
    defaultBranch: string,
    subject?: string,
  ): Promise<RevertResult> {
    return this.withStoreLock(storeId, async () => {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(refOrSentinel, ctx.sessionId);

    const target = await git.readCommit({ fs: fsCb, gitdir, oid: targetCommitOid });
    if (target.commit.parent.length === 0) {
      throw new Error('cannot revert root commit (no parent to diff against)');
    }
    const baseCommitOid = target.commit.parent[0];

    const { parentOid } = await this.resolveParent(gitdir, fqRef, defaultBranch);
    if (!parentOid) throw new Error('ref has no commits to revert');
    const headCommit = await git.readCommit({ fs: fsCb, gitdir, oid: parentOid });
    const headTreeOid = headCommit.commit.tree;

    // Diff base..target — the set of paths target changed.
    const changes = await this.diffCommits(gitdir, baseCommitOid, targetCommitOid);
    if (changes.length === 0) {
      return { status: 'noop', commitOid: parentOid };
    }

    const conflicts: MergeConflict[] = [];
    let newRoot = headTreeOid;

    for (const c of changes) {
      const headEntry = await this.tryReadBlobEntryAt(gitdir, headTreeOid, c.path);
      const headOid = headEntry?.oid ?? null;

      if (c.aOid === null && c.bOid !== null) {
        // target ADDED this file → revert removes it.
        if (headOid === c.bOid) {
          const next = await this.removePathFromTree(gitdir, newRoot, c.path);
          if (next !== null) newRoot = next;
        } else if (headOid === null) {
          // Already removed; no-op
        } else {
          conflicts.push({
            path: c.path,
            base: null,
            ours: headOid,
            theirs: c.bOid,
            reason: 'modified_after_target_add',
          });
        }
      } else if (c.aOid !== null && c.bOid === null) {
        // target DELETED this file → revert restores it with aOid + aMode.
        if (headOid === null) {
          newRoot = await this.upsertPathInTree(
            gitdir,
            newRoot,
            c.path,
            c.aOid,
            c.aMode ?? '100644',
          );
        } else if (headOid === c.aOid) {
          // HEAD already has the pre-target version; no-op
        } else {
          conflicts.push({
            path: c.path,
            base: c.aOid,
            ours: headOid,
            theirs: null,
            reason: 'modified_after_target_delete',
          });
        }
      } else if (c.aOid !== null && c.bOid !== null) {
        // target MODIFIED this file → revert restores aOid.
        if (headOid === c.bOid) {
          newRoot = await this.upsertPathInTree(
            gitdir,
            newRoot,
            c.path,
            c.aOid,
            c.aMode ?? '100644',
          );
        } else if (headOid === c.aOid) {
          // Already reverted; no-op
        } else {
          conflicts.push({
            path: c.path,
            base: c.aOid,
            ours: headOid,
            theirs: c.bOid,
            reason: 'modified_after_target',
          });
        }
      }
    }

    if (conflicts.length > 0) {
      return { status: 'conflict', conflicts };
    }
    if (newRoot === headTreeOid) {
      // No actionable diffs landed in the tree (e.g. every change was
      // already reverted independently); emit noop instead of an empty
      // commit so audit logs aren't polluted.
      return { status: 'noop', commitOid: parentOid };
    }

    const commitOid = await this.buildCommit({
      gitdir,
      ctx,
      op: 'revert',
      subject: subject ?? `revert ${targetCommitOid.slice(0, 7)}`,
      treeOid: newRoot,
      parentOid,
    });
    await git.writeRef({ fs: fsCb, gitdir, ref: fqRef, value: commitOid, force: true });
    return { status: 'ok' as const, commitOid };
    });
  }

  /**
   * Fast-forward `into` to `from` if `from` is a descendant. Returns a
   * structured conflict otherwise (three-way merge is P2).
   */
  async mergeFastForward(
    projectId: string,
    storeId: string,
    ctx: RequestContext,
    fromRefOrSentinel: string | undefined,
    intoRef: string,
  ): Promise<MergeResult> {
    return this.withStoreLock(storeId, async () => {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fromFq = this.refs.resolve(fromRefOrSentinel, ctx.sessionId);
    const intoFq = intoRef.startsWith('refs/') ? intoRef : `refs/heads/${intoRef}`;

    const fromOid = await git.resolveRef({ fs: fsCb, gitdir, ref: fromFq });
    const intoOid = await git
      .resolveRef({ fs: fsCb, gitdir, ref: intoFq })
      .catch(() => null);

    if (!intoOid) {
      await git.writeRef({ fs: fsCb, gitdir, ref: intoFq, value: fromOid, force: true });
      return { status: 'ok' as const, commitOid: fromOid, fastForward: true };
    }

    if (fromOid === intoOid) return { status: 'noop' as const, commitOid: intoOid };

    // Check ancestry: into must be ancestor of from for FF.
    const ancestor = await this.isAncestor(gitdir, intoOid, fromOid);
    if (!ancestor) {
      return {
        status: 'conflict' as const,
        conflicts: [
          {
            path: '',
            base: null,
            ours: intoOid,
            theirs: fromOid,
            reason: 'non_ff_merge_required',
          },
        ],
      };
    }

    await git.writeRef({ fs: fsCb, gitdir, ref: intoFq, value: fromOid, force: true });
    return { status: 'ok' as const, commitOid: fromOid, fastForward: true };
    });
  }

  // -------------------------------------------------------------------
  // Log
  // -------------------------------------------------------------------

  async log(
    projectId: string,
    storeId: string,
    refOrSentinel: string | undefined,
    sessionId: string | undefined,
    opts: LogOpts = {},
  ): Promise<CommitView[]> {
    const gitdir = this.paths.repoDir(projectId, storeId);
    const fqRef = this.refs.resolve(refOrSentinel, sessionId);
    const limit = opts.limit ?? 20;

    let commits;
    try {
      commits = await git.log({ fs: fsCb, gitdir, ref: fqRef, depth: limit * 4 });
    } catch {
      return [];
    }

    const out: CommitView[] = [];
    for (const c of commits) {
      if (out.length >= limit) break;
      if (opts.path) {
        const includes = await this.commitTouchesPath(gitdir, c.oid, opts.path).catch(() => false);
        if (!includes) continue;
      }
      if (opts.since && c.commit.committer.timestamp * 1000 < opts.since.getTime()) continue;
      if (opts.until && c.commit.committer.timestamp * 1000 > opts.until.getTime()) continue;
      if (opts.author && !c.commit.author.name.includes(opts.author) && !c.commit.author.email.includes(opts.author)) continue;

      const msg = c.commit.message;
      const trailers = CommitBuilder.parseTrailers(msg);
      const subject = msg.split('\n')[0] ?? '';
      out.push({
        oid: c.oid,
        parents: c.commit.parent,
        message: msg,
        subject,
        trailers,
        author: { ...c.commit.author },
        committer: { ...c.commit.committer },
      });
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Build a commit object via the single audited code path.
   *
   * @internal Do not call git.writeCommit anywhere except inside this method.
   *           Lint test `commit-builder-only.test.ts` enforces the invariant.
   */
  private async buildCommit(input: {
    gitdir: string;
    ctx: RequestContext;
    op: ArtifactOp;
    subject: string;
    body?: string;
    treeOid: string;
    parentOid: string | null;
  }): Promise<string> {
    const author = CommitBuilder.buildAuthor({ principal: input.ctx.principal });
    const committer = CommitBuilder.serviceCommitter(author.timestamp, author.timezoneOffset);
    const messageInput: BuildCommitMessageInput = {
      ctx: input.ctx,
      op: input.op,
      subject: input.subject,
      body: input.body,
    };
    const message = CommitBuilder.buildMessage(messageInput);

    return await git.writeCommit({
      fs: fsCb,
      gitdir: input.gitdir,
      commit: {
        message,
        tree: input.treeOid,
        parent: input.parentOid ? [input.parentOid] : [],
        author,
        committer,
      },
    });
  }

  /**
   * Diff two commits, returning the per-path file-level changes
   * (blob-level only — directories surface via their children).
   * `aOid`/`bOid` are null when the path is absent from that side
   * (so `(null, X)` = added, `(X, null)` = deleted, `(X, Y)` = modified).
   */
  private async diffCommits(
    gitdir: string,
    aCommitOid: string,
    bCommitOid: string,
  ): Promise<
    Array<{
      path: string;
      aOid: string | null;
      bOid: string | null;
      aMode: string | null;
      bMode: string | null;
    }>
  > {
    const changes: Array<{
      path: string;
      aOid: string | null;
      bOid: string | null;
      aMode: string | null;
      bMode: string | null;
    }> = [];
    await git.walk({
      fs: fsCb,
      gitdir,
      trees: [git.TREE({ ref: aCommitOid }), git.TREE({ ref: bCommitOid })],
      // NOTE: returning null here stops git.walk from descending into the
      // children (see iso-git walk impl: `if (parent !== null) iterate(...)`).
      // We must return undefined / a truthy value to keep recursing into
      // subtrees so file-level diffs at deeper paths are visited.
      map: async (filepath, entries) => {
        if (filepath === '.' || !entries) return undefined;
        const [a, b] = entries;
        const aType = a ? await a.type() : null;
        const bType = b ? await b.type() : null;
        // Trees surface via their children — continue descending.
        if (aType === 'tree' || bType === 'tree') return undefined;
        if (aType !== 'blob' && bType !== 'blob') return undefined;
        const aOid = aType === 'blob' && a ? await a.oid() : null;
        const bOid = bType === 'blob' && b ? await b.oid() : null;
        if (aOid === bOid) return undefined;
        const aMode = aType === 'blob' && a ? (await a.mode()).toString(8) : null;
        const bMode = bType === 'blob' && b ? (await b.mode()).toString(8) : null;
        changes.push({ path: filepath, aOid, bOid, aMode, bMode });
        return undefined;
      },
    });
    return changes;
  }

  /**
   * Read a blob entry at `filepath` inside a tree, returning its oid +
   * mode, or null if the path is missing or refers to a directory.
   */
  private async tryReadBlobEntryAt(
    gitdir: string,
    rootTreeOid: string,
    filepath: string,
  ): Promise<{ oid: string; mode: string } | null> {
    const parts = filepath.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    let currentTreeOid = rootTreeOid;
    for (let i = 0; i < parts.length - 1; i++) {
      const t = await git.readTree({ fs: fsCb, gitdir, oid: currentTreeOid }).catch(() => null);
      if (!t) return null;
      const entry = t.tree.find((e) => e.path === parts[i] && e.type === 'tree');
      if (!entry) return null;
      currentTreeOid = entry.oid;
    }
    const leafName = parts[parts.length - 1];
    const t = await git.readTree({ fs: fsCb, gitdir, oid: currentTreeOid }).catch(() => null);
    if (!t) return null;
    const entry = t.tree.find((e) => e.path === leafName && e.type === 'blob');
    return entry ? { oid: entry.oid, mode: entry.mode } : null;
  }

  private async resolveParent(
    gitdir: string,
    fqRef: string,
    defaultBranch: string,
  ): Promise<{ parentOid: string | null; parentTreeOid: string | null }> {
    // Try the ref directly.
    let parentOid = await git
      .resolveRef({ fs: fsCb, gitdir, ref: fqRef })
      .catch(() => null);

    // Session branches fall back to defaultBranch's tip on first write.
    if (!parentOid && fqRef.startsWith('refs/heads/sessions/')) {
      parentOid = await git
        .resolveRef({ fs: fsCb, gitdir, ref: `refs/heads/${defaultBranch}` })
        .catch(() => null);
    }

    if (!parentOid) return { parentOid: null, parentTreeOid: null };

    const c = await git.readCommit({ fs: fsCb, gitdir, oid: parentOid });
    return { parentOid, parentTreeOid: c.commit.tree };
  }

  /**
   * Walk down the tree path, inserting/replacing a blob entry, writing
   * intermediate trees as we go back up. Returns the new root tree oid.
   */
  private async upsertPathInTree(
    gitdir: string,
    parentTreeOid: string | null,
    filePath: string,
    blobOid: string,
    mode: string,
  ): Promise<string> {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length === 0) throw new Error('empty file path');

    return this.recursiveUpsert(gitdir, parentTreeOid, parts, blobOid, mode);
  }

  private async recursiveUpsert(
    gitdir: string,
    currentTreeOid: string | null,
    parts: string[],
    blobOid: string,
    mode: string,
  ): Promise<string> {
    const head = parts[0];
    const isLeaf = parts.length === 1;

    let entries: git.TreeEntry[] = [];
    if (currentTreeOid) {
      const t = await git.readTree({ fs: fsCb, gitdir, oid: currentTreeOid });
      entries = t.tree.slice();
    }

    if (isLeaf) {
      const without = entries.filter((e) => e.path !== head);
      without.push({ mode, path: head, oid: blobOid, type: 'blob' });
      return await git.writeTree({ fs: fsCb, gitdir, tree: without });
    }

    const existingDir = entries.find((e) => e.path === head && e.type === 'tree');
    const subTreeOid = await this.recursiveUpsert(
      gitdir,
      existingDir ? existingDir.oid : null,
      parts.slice(1),
      blobOid,
      mode,
    );
    const without = entries.filter((e) => e.path !== head);
    without.push({ mode: '040000', path: head, oid: subTreeOid, type: 'tree' });
    return await git.writeTree({ fs: fsCb, gitdir, tree: without });
  }

  /** Returns null if path doesn't exist; otherwise the new root tree oid. */
  private async removePathFromTree(
    gitdir: string,
    rootTreeOid: string,
    filePath: string,
  ): Promise<string | null> {
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    return this.recursiveRemove(gitdir, rootTreeOid, parts);
  }

  private async recursiveRemove(
    gitdir: string,
    currentTreeOid: string,
    parts: string[],
  ): Promise<string | null> {
    const head = parts[0];
    const isLeaf = parts.length === 1;

    const t = await git.readTree({ fs: fsCb, gitdir, oid: currentTreeOid });
    const entries = t.tree.slice();
    const entry = entries.find((e) => e.path === head);
    if (!entry) return null;

    if (isLeaf) {
      const without = entries.filter((e) => e.path !== head);
      return await git.writeTree({ fs: fsCb, gitdir, tree: without });
    }
    if (entry.type !== 'tree') return null;

    const newSub = await this.recursiveRemove(gitdir, entry.oid, parts.slice(1));
    if (newSub === null) return null;
    const without = entries.filter((e) => e.path !== head);
    without.push({ mode: '040000', path: head, oid: newSub, type: 'tree' });
    return await git.writeTree({ fs: fsCb, gitdir, tree: without });
  }

  private async isAncestor(
    gitdir: string,
    candidate: string,
    descendant: string,
  ): Promise<boolean> {
    // Walk descendant's parents BFS-style up to a safety depth.
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    const MAX = 5000;
    while (queue.length > 0 && seen.size < MAX) {
      const oid = queue.shift()!;
      if (oid === candidate) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      try {
        const c = await git.readCommit({ fs: fsCb, gitdir, oid });
        for (const p of c.commit.parent) queue.push(p);
      } catch {
        return false;
      }
    }
    return false;
  }

  private async commitTouchesPath(
    gitdir: string,
    commitOid: string,
    filePath: string,
  ): Promise<boolean> {
    const c = await git.readCommit({ fs: fsCb, gitdir, oid: commitOid });
    const treeOid = c.commit.tree;
    try {
      await git.readBlob({
        fs: fsCb,
        gitdir,
        oid: treeOid,
        filepath: this.normalizeFilePath(filePath),
      });
      return true;
    } catch {
      return false;
    }
  }

  private normalizeFilePath(filePath: string): string {
    if (!filePath) throw new Error('path is required');
    if (filePath.length > MAX_PATH_LEN) throw new Error('path too long');
    if (filePath.includes('..')) throw new Error(`unsafe path: ${filePath}`);
    let p = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    p = stripTrailingSlashes(p);
    if (!p) throw new Error('path is empty');
    return p;
  }

  private normalizeDirPath(dirPath: string): string {
    if (!dirPath || dirPath === '/' || dirPath === '.') return '';
    if (dirPath.length > MAX_PATH_LEN) throw new Error('path too long');
    if (dirPath.includes('..')) throw new Error(`unsafe path: ${dirPath}`);
    let p = dirPath.startsWith('/') ? dirPath.slice(1) : dirPath;
    p = stripTrailingSlashes(p);
    return p;
  }
}

const MAX_PATH_LEN = 4096;

/**
 * Strip trailing '/' characters via a linear scan instead of a regex.
 * The regex form (`/\/+$/`) was flagged by CodeQL as a ReDoS hazard
 * when applied to user-controlled inputs with long runs of slashes;
 * the linear scan is O(n) by construction and not dependent on
 * regex-engine internals.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return end === s.length ? s : s.slice(0, end);
}

export class RefDivergedError extends Error {
  readonly currentTip: string | null;
  readonly yourTip: string;
  constructor(currentTip: string | null, yourTip: string) {
    super('ref tip diverged');
    this.name = 'RefDivergedError';
    this.currentTip = currentTip;
    this.yourTip = yourTip;
  }
}
