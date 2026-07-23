import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tls from 'node:tls';

import { type TlsContext, type Unsubscribe } from './types';

/**
 * Reads the three PEM files for a TLS context from `dir` and creates a
 * `tls.SecureContext`.
 *
 * File semantics:
 *  - `cert.pem` — leaf server certificate presented to peers (required).
 *  - `key.pem`  — private key matching `cert.pem` (required).
 *  - `chain.pem` — intermediate CA certificates to be appended to `cert.pem`
 *    so that peers can verify the full chain up to a trusted root. Optional;
 *    omit or leave empty when the leaf cert is directly signed by a root CA
 *    (e.g. self-signed) or when the intermediates are already concatenated
 *    into `cert.pem`.
 *
 * Throws if cert.pem or key.pem is missing or unreadable.
 * Throws if chain.pem exists but cannot be read (ENOENT is silently ignored).
 */
function buildSecureContext(dir: string): tls.SecureContext {
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));
  const key = fs.readFileSync(path.join(dir, 'key.pem'));

  let certChain: Buffer | Buffer[] = cert;
  const chainPath = path.join(dir, 'chain.pem');
  try {
    const chainBytes = fs.readFileSync(chainPath);
    if (chainBytes.length > 0) {
      certChain = [cert, chainBytes];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // chain.pem absent — leaf cert is self-signed or chain is already in cert.pem
  }

  return tls.createSecureContext({ cert: certChain, key });
}

/**
 * Hot-swapping TLS context implementation.
 *
 * Holds a reference to the current SecureContext under a single pointer.
 * A rotation event for any of the three PEM files triggers a coalesced
 * re-read (within `coalesceMs`) so that three rapid renames produce exactly
 * one context swap.
 *
 * The swap is a single reference assignment — readers that call `current()`
 * always see a consistent, fully-assembled SecureContext.
 */
export class ReloadableTlsContext implements TlsContext {
  private _current: tls.SecureContext;
  private readonly _subscribers = new Set<() => void>();
  private _coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dir: string,
    private readonly coalesceMs: number,
    private readonly onError: (key: string, err: Error) => void,
  ) {
    this._current = buildSecureContext(dir);
  }

  current(): tls.SecureContext {
    return this._current;
  }

  onRotate(cb: () => void): Unsubscribe {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  /**
   * Signal that one of the three TLS files may have been updated.
   * Coalesces rapid events within `coalesceMs` into a single rebuild.
   */
  scheduleReload(): void {
    clearTimeout(this._coalesceTimer);
    this._coalesceTimer = setTimeout(() => this._reload(), this.coalesceMs);
  }

  private _reload(): void {
    try {
      const next = buildSecureContext(this.dir);
      this._current = next;
      for (const cb of this._subscribers) {
        try {
          cb();
        } catch (err) {
          this.onError(`tls:${path.basename(this.dir)}:onRotate`, err as Error);
        }
      }
    } catch (err) {
      this.onError(`tls:${path.basename(this.dir)}`, err as Error);
      // _current retains the last-known-good context
    }
  }

  close(): void {
    clearTimeout(this._coalesceTimer);
    this._subscribers.clear();
  }
}
