/**
 * Resolves the user-facing `ref` argument (including the `'SESSION'`
 * sentinel) to a fully-qualified git ref name.
 *
 * Conventions:
 *   - `SESSION`              -> refs/heads/sessions/{sessionId}
 *   - `main` / branch name   -> refs/heads/<name>
 *   - `tag:foo` or annotated tag name resolved via git
 *   - already-qualified `refs/...` ref -> pass through
 *
 * The agent never threads a handle; the per-call `sessionId` (from the
 * gateway-injected `X-Session-ID` header) IS the handle.
 */
export class RefResolver {
  static readonly SESSION_SENTINEL = 'SESSION';

  /**
   * Resolve a user-supplied ref to a canonical git ref name.
   * @param ref user-supplied ref or sentinel
   * @param sessionId from X-Session-ID header (required when ref === 'SESSION')
   */
  resolve(ref: string | undefined, sessionId?: string): string {
    const r = ref ?? RefResolver.SESSION_SENTINEL;
    if (r === RefResolver.SESSION_SENTINEL) {
      if (!sessionId) {
        throw new Error("ref='SESSION' but no X-Session-ID header present");
      }
      this.assertSafeSegment(sessionId, 'sessionId');
      return `refs/heads/sessions/${sessionId}`;
    }
    if (r.startsWith('refs/')) {
      this.assertSafeRef(r);
      return r;
    }
    // Bare names → heads
    this.assertSafeSegment(r, 'ref');
    return `refs/heads/${r}`;
  }

  /** Compute the session branch name without resolving (for branch creation). */
  sessionBranch(sessionId: string): string {
    this.assertSafeSegment(sessionId, 'sessionId');
    return `refs/heads/sessions/${sessionId}`;
  }

  private assertSafeRef(ref: string): void {
    if (ref.includes('..') || ref.includes(' ') || ref.endsWith('/')) {
      throw new Error(`unsafe ref: ${ref}`);
    }
  }

  private assertSafeSegment(seg: string, label: string): void {
    if (!seg) throw new Error(`${label} is empty`);
    if (!/^[A-Za-z0-9_./-]+$/.test(seg)) {
      throw new Error(`${label} contains illegal characters: ${seg}`);
    }
    if (seg.startsWith('.') || seg.startsWith('-') || seg.includes('..')) {
      throw new Error(`${label} has unsafe shape: ${seg}`);
    }
  }
}
