import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  debounce,
  DirectoryWatcher,
  type DebouncedRenameHandler,
} from './file-watcher';
import { ReloadableTlsContext } from './tls-context';
import {
  type CreateSecretStoreOptions,
  type SecretStore,
  type TlsContext,
  type Unsubscribe,
} from './types';

const DEFAULT_ROOT = '/mnt/secrets';
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_TLS_COALESCE_MS = 500;
const CONSECUTIVE_ERROR_LOG_THRESHOLD = 5; // after this many consecutive errors, wrap the message with a count summary

type Subscribers = Set<(next: string) => void>;

/**
 * Internal implementation of SecretStore. Not exported directly — consumers
 * use `createSecretStore`.
 */
class SecretStoreImpl implements SecretStore {
  private readonly _root: string;
  private readonly _cache = new Map<string, Buffer>();
  private readonly _subscribers = new Map<string, Subscribers>();
  private readonly _tlsContexts = new Map<string, ReloadableTlsContext>();
  private readonly _watcher: DirectoryWatcher;
  private readonly _debouncedHandler: DebouncedRenameHandler;
  private readonly _consecutiveErrors = new Map<string, number>();
  private readonly _onError: (key: string, err: Error) => void;
  private readonly _tlsCoalesceMs: number;

  constructor(
    root: string,
    debounceMs: number,
    tlsCoalesceMs: number,
    onError: (key: string, err: Error) => void,
  ) {
    this._root = root;
    this._tlsCoalesceMs = tlsCoalesceMs;
    this._onError = onError;

    this._debouncedHandler = debounce(
      (filePath) => this._handleRename(filePath),
      debounceMs,
    );

    this._watcher = new DirectoryWatcher(
      this._root,
      this._debouncedHandler,
      (err) => this._onError('watcher:fs', err),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getString(key: string): string {
    return this._readFromCache(key).toString('utf8');
  }

  getBuffer(key: string): Buffer {
    return this._readFromCache(key);
  }

  getJSON<T = unknown>(key: string): T {
    return JSON.parse(this.getString(key)) as T;
  }

  watch(key: string, cb: (next: string) => void): Unsubscribe {
    const normalizedKey = this._normalizeSecretKey(key);
    if (!this._cache.has(normalizedKey)) {
      throw new Error(
        `[secrets-client] Cannot watch key "${key}": it was not declared in requiredKeys.`,
      );
    }
    let subs = this._subscribers.get(normalizedKey);
    if (!subs) {
      subs = new Set();
      this._subscribers.set(normalizedKey, subs);
    }
    subs.add(cb);
    return () => subs.delete(cb);
  }

  getTlsContext(name: string): TlsContext {
    const ctx = this._tlsContexts.get(name);
    if (!ctx) {
      throw new Error(
        `[secrets-client] TLS context "${name}" was not declared in requiredTlsContexts`,
      );
    }
    return ctx;
  }

  close(): void {
    this._watcher.close();
    this._debouncedHandler.cancel();
    for (const ctx of this._tlsContexts.values()) {
      ctx.close();
    }
    this._subscribers.clear();
    this._tlsContexts.clear();
  }

  // ---------------------------------------------------------------------------
  // Init helpers (called from createSecretStore)
  // ---------------------------------------------------------------------------

  /**
   * Eagerly loads a required key into the cache. Throws if the file is missing.
   */
  loadRequired(key: string): void {
    const normalizedKey = this._normalizeSecretKey(key);
    const filePath = path.join(this._root, normalizedKey);
    const bytes = fs.readFileSync(filePath);
    this._cache.set(normalizedKey, bytes);
  }

  /**
   * Eagerly assembles a TLS context from the three PEM files.
   * Throws if any file is missing or invalid.
   */
  loadTlsContext(name: string): void {
    this._assertSafeName(name);
    const dir = path.join(this._root, 'tls', name);
    const ctx = new ReloadableTlsContext(
      dir,
      this._tlsCoalesceMs,
      this._onError,
    );
    this._tlsContexts.set(name, ctx);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Rejects names that could escape the secrets root via path traversal. */
  private _assertSafeName(name: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(
        `[secrets-client] Invalid TLS context name "${name}": only letters, digits, hyphens, and underscores are allowed.`,
      );
    }
  }

  /**
   * Validates and normalises a secret key to a safe relative forward-slash
   * path. Throws if the key is absolute or contains `..` segments, which
   * would allow it to escape the secrets root.
   *
   * `.` segments are collapsed via `path.posix.normalize` so that cache keys
   * always match the canonical paths produced by the file watcher (e.g.
   * `./db/url` and `db/./url` both normalise to `db/url`).
   */
  private _normalizeSecretKey(key: string): string {
    const slashNormalized = key.replace(/\\/g, '/');
    if (path.isAbsolute(key) || path.posix.isAbsolute(slashNormalized)) {
      throw new Error(
        `[secrets-client] Invalid secret key "${key}": keys must be relative to the secrets root.`,
      );
    }
    if (slashNormalized.split('/').includes('..')) {
      throw new Error(
        `[secrets-client] Invalid secret key "${key}": keys must not contain ".." path segments.`,
      );
    }
    // Collapse any remaining `.` segments and strip a leading `./` so the
    // returned key is always in the same form the watcher emits.
    const normalized = path.posix.normalize(slashNormalized).replace(/^\.\//, '');
    if (normalized === '.' || normalized === '') {
      throw new Error(
        `[secrets-client] Invalid secret key "${key}": key resolves to the secrets root.`,
      );
    }
    return normalized;
  }

  private _readFromCache(key: string): Buffer {
    const normalizedKey = this._normalizeSecretKey(key);
    const cached = this._cache.get(normalizedKey);
    if (cached === undefined) {
      throw new Error(
        `[secrets-client] Key "${key}" is not in the cache. Declare it in requiredKeys.`,
      );
    }
    return cached;
  }

  private _keyToPath(key: string): string {
    return path.join(this._root, this._normalizeSecretKey(key));
  }

  private _handleRename(filePath: string): void {
    // Normalise to forward slashes up front so every comparison below is
    // platform-independent and consistent with the TLS regex.
    const relative = path.relative(this._root, filePath).replace(/\\/g, '/');

    // The CSI Secrets Store driver rotates content by atomically renaming the
    // `..data` symlink to point at a new timestamped directory. The individual
    // file paths (e.g. `db/url`) are symlinks through `..data`, so their
    // content changes without generating rename events of their own.
    //
    // fs.watch behaviour for symlink renames is platform-dependent: some
    // kernels report the destination path (`..data`), others report a path
    // that ends with `/..data` (e.g. when the watcher root is resolved
    // differently). Both patterns are matched here.
    const isDataRotation =
      relative === '..data' || relative.endsWith('/..data');

    if (isDataRotation) {
      for (const key of this._cache.keys()) {
        this._reloadKey(key);
      }
      // TLS contexts also live under ..data — schedule a reload for each.
      for (const ctx of this._tlsContexts.values()) {
        ctx.scheduleReload();
      }
      return;
    }

    // Check if this is a TLS file (tls/<name>/{cert,chain,key}.pem).
    const tlsMatch = relative.match(/^tls\/([^/]+)\/(cert|chain|key)\.pem$/);
    if (tlsMatch) {
      const name = tlsMatch[1];
      const ctx = this._tlsContexts.get(name);
      if (ctx) {
        ctx.scheduleReload();
      }
      return;
    }

    // Plain secret key — re-read and notify subscribers.
    if (!this._cache.has(relative)) {
      return; // we don't track this file
    }

    this._reloadKey(relative);
  }

  private _reloadKey(key: string): void {
    const filePath = this._keyToPath(key);
    try {
      const bytes = fs.readFileSync(filePath);
      const prev = this._cache.get(key);
      // Skip notification if content is byte-for-byte identical.
      if (prev && bytes.equals(prev)) {
        return;
      }
      this._cache.set(key, bytes);
      this._consecutiveErrors.set(key, 0);
      const value = bytes.toString('utf8');
      const subs = this._subscribers.get(key);
      if (subs) {
        for (const cb of subs) {
          try {
            cb(value);
          } catch (err) {
            this._onError(key, err as Error);
          }
        }
      }
    } catch (err) {
      const count = (this._consecutiveErrors.get(key) ?? 0) + 1;
      this._consecutiveErrors.set(key, count);
      if (count >= CONSECUTIVE_ERROR_LOG_THRESHOLD) {
        // Route the escalation through the injected onError so custom handlers
        // (structured loggers, alerting) see it — avoid bypassing with console.error.
        this._onError(
          key,
          new Error(
            `[secrets-client] ${count} consecutive rotation read errors for key "${key}"; ` +
              `last error: ${(err as Error).message}`,
          ),
        );
      } else {
        this._onError(key, err as Error);
      }
      // cache retains the last-known-good value — subscribers are NOT invoked
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates and initialises a long-lived SecretStore.
 *
 * Eagerly reads every `requiredKey` and assembles every `requiredTlsContext`
 * at init time. Throws if any key is missing or any TLS context cannot be
 * assembled — application boot fails fast rather than operating with missing
 * secrets.
 *
 * Returns a Promise so that future async init steps (e.g. metrics registration)
 * can be added without breaking the caller contract.
 */
export async function createSecretStore(
  opts: CreateSecretStoreOptions,
): Promise<SecretStore> {
  const root = opts.root ?? process.env['SECRETS_ROOT'] ?? DEFAULT_ROOT;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const tlsCoalesceMs = opts.tlsCoalesceMs ?? DEFAULT_TLS_COALESCE_MS;
  const onError =
    opts.onError ??
    ((key: string, err: unknown) => {
      console.error(`[secrets-client] Error for "${key}":`, err);
    });

  const store = new SecretStoreImpl(root, debounceMs, tlsCoalesceMs, onError);

  // Fail-fast on missing required keys.
  for (const key of opts.requiredKeys) {
    try {
      store.loadRequired(key);
    } catch (err) {
      store.close();
      throw new Error(
        `[secrets-client] Required key "${key}" is missing at "${root}/${key}": ${(err as Error).message}`,
      );
    }
  }

  // Fail-fast on missing required TLS contexts.
  for (const name of opts.requiredTlsContexts ?? []) {
    try {
      store.loadTlsContext(name);
    } catch (err) {
      store.close();
      throw new Error(
        `[secrets-client] Required TLS context "${name}" could not be assembled: ${(err as Error).message}`,
      );
    }
  }

  return store;
}
