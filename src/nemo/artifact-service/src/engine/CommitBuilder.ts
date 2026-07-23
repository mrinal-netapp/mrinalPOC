import { Principal, RequestContext, encodePrincipal } from '../types/Principal';

/**
 * Single, non-bypassable code path that constructs a commit message
 * with audit trailers.
 *
 * Every commit produced by `GitEngine` MUST be built through this
 * module — that invariant is enforced by `__tests__/lint/commit-builder-only.test.ts`,
 * which fails CI if any other code calls `git.commit(...)` directly.
 *
 * Trailer set:
 *   X-Principal:        user:<sub> | agent:<id> | team:<id> | service:<name>
 *   X-Session-Id:       <sid>                        (when present)
 *   X-Agent-Id:         <aid>                        (when present)
 *   X-Team-Id:          <tid>                        (when present)
 *   X-Op:               write|delete|mv|mkdir|tag|revert|merge|pull|rebase|...
 *   X-Idempotency-Key:  <sha256-of-body|user-key>    (when present)
 *
 * The audit log is then literally `git log --pretty='%H %an %ai %s%n%(trailers)'`.
 */

export type ArtifactOp =
  | 'write'
  | 'delete'
  | 'mv'
  | 'mkdir'
  | 'tag'
  | 'revert'
  | 'merge'
  | 'pull'
  | 'rebase'
  | 'branch'
  | 'attach';

export interface BuildCommitMessageInput {
  ctx: RequestContext;
  op: ArtifactOp;
  /**
   * Optional user-supplied subject line. If absent, an op-specific
   * default subject is generated so commits always have a human-readable
   * first line.
   */
  subject?: string;
  /** Optional free-form body (separated from the subject by a blank line). */
  body?: string;
}

export interface BuildCommitAuthorInput {
  principal: Principal;
  /** Override author name (rare). */
  name?: string;
  /** Override author email (rare). */
  email?: string;
  /** Timestamp seconds; defaults to now. */
  timestampSec?: number;
  /** Timezone offset in minutes; defaults to UTC. */
  timezoneOffset?: number;
}

export interface CommitAuthor {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export class CommitBuilder {
  /**
   * Build a commit message string with audit trailers appended.
   * Idempotent for the same inputs.
   */
  static buildMessage(input: BuildCommitMessageInput): string {
    const subject = input.subject?.trim() || defaultSubject(input.op);
    const body = input.body?.trim();

    const trailers: string[] = [];
    trailers.push(`X-Principal: ${encodePrincipal(input.ctx.principal)}`);
    if (input.ctx.sessionId) {
      trailers.push(`X-Session-Id: ${input.ctx.sessionId}`);
    }
    if (input.ctx.agentId) {
      trailers.push(`X-Agent-Id: ${input.ctx.agentId}`);
    }
    if (input.ctx.teamId) {
      trailers.push(`X-Team-Id: ${input.ctx.teamId}`);
    }
    trailers.push(`X-Op: ${input.op}`);
    if (input.ctx.idempotencyKey) {
      trailers.push(`X-Idempotency-Key: ${input.ctx.idempotencyKey}`);
    }

    const parts: string[] = [subject];
    if (body) parts.push('', body);
    parts.push('', trailers.join('\n'));
    return parts.join('\n');
  }

  /**
   * Build the git-commit author/committer object from the principal.
   * Committer is always the service identity to make it auditable that
   * the commit went through this code path; author is the principal.
   */
  static buildAuthor(input: BuildCommitAuthorInput): CommitAuthor {
    const p = input.principal;
    const name = input.name ?? p.displayName ?? `${p.kind}:${p.id}`;
    const email = input.email ?? p.email ?? `${p.kind}+${p.id}@artifact-service.invalid`;
    const timestamp = input.timestampSec ?? Math.floor(Date.now() / 1000);
    const timezoneOffset = input.timezoneOffset ?? 0;
    return { name, email, timestamp, timezoneOffset };
  }

  /** Service identity used as committer on every commit. */
  static serviceCommitter(timestampSec?: number, timezoneOffset = 0): CommitAuthor {
    return {
      name: 'artifact-service',
      email: 'artifact-service@platform.invalid',
      timestamp: timestampSec ?? Math.floor(Date.now() / 1000),
      timezoneOffset,
    };
  }

  /**
   * Parse trailers back out of a commit message body. Used by the
   * REST `/log` endpoint and by audit verifiers.
   */
  static parseTrailers(message: string): Record<string, string> {
    const result: Record<string, string> = {};
    // Trailers are conventionally the last non-empty block of `Key: value` lines.
    const lines = message.replace(/\r\n/g, '\n').split('\n');
    // Walk backwards collecting trailer lines until a blank line or non-trailer line.
    const trailers: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === '') {
        if (trailers.length > 0) break;
        continue;
      }
      if (/^[A-Za-z][A-Za-z0-9-]*:\s/.test(line)) {
        trailers.unshift(line);
      } else {
        break;
      }
    }
    for (const t of trailers) {
      const idx = t.indexOf(':');
      if (idx > 0) {
        result[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
      }
    }
    return result;
  }
}

function defaultSubject(op: ArtifactOp): string {
  switch (op) {
    case 'write':
      return 'artifact: write';
    case 'delete':
      return 'artifact: delete';
    case 'mv':
      return 'artifact: rename';
    case 'mkdir':
      return 'artifact: mkdir';
    case 'tag':
      return 'artifact: tag';
    case 'revert':
      return 'artifact: revert';
    case 'merge':
      return 'artifact: merge';
    case 'pull':
      return 'artifact: pull';
    case 'rebase':
      return 'artifact: rebase';
    case 'branch':
      return 'artifact: branch';
    case 'attach':
      return 'artifact: attach';
  }
}
