import * as tls from 'node:tls';

export type Unsubscribe = () => void;

/** A hot-swapping TLS context backed by three PEM files: cert.pem, chain.pem, key.pem. */
export interface TlsContext {
  /** Returns the current SecureContext; always reflects the latest rotated material. */
  current(): tls.SecureContext;
  /** Subscribe to rotation. Callback is invoked AFTER the context swap completes. */
  onRotate(cb: () => void): Unsubscribe;
}

/**
 * Long-lived secret store for the life of the process.
 * Reads come from an in-memory cache populated at init and kept fresh by the
 * file watcher. All reads are O(1) and never block on I/O after init.
 */
export interface SecretStore {
  /** Read the current value of `key` as a UTF-8 string. Throws if `key` was not in `requiredKeys`. */
  getString(key: string): string;
  /** Read the current value of `key` as raw bytes. Throws if `key` was not in `requiredKeys`. */
  getBuffer(key: string): Buffer;
  /**
   * Read and JSON-parse the current value of `key`.
   * Throws if `key` was not in `requiredKeys`, or if the cached content is not valid JSON.
   */
  getJSON<T = unknown>(key: string): T;
  /**
   * Subscribes to future rotations for `key`.
   * The callback is invoked with the new string value after each rotation.
   * Returns an unsubscribe function.
   * Throws if `key` was not declared in `requiredKeys` (consistent with getString/getBuffer).
   */
  watch(key: string, cb: (next: string) => void): Unsubscribe;
  /** Get a hot-swapping TLS context backed by tls/<name>/{cert,chain,key}.pem. */
  getTlsContext(name: string): TlsContext;
  /**
   * Releases inotify/fs.watch handles and all timers.
   * Test-only: production code should never call this.
   */
  close(): void;
}

export interface CreateSecretStoreOptions {
  /** Defaults to process.env.SECRETS_ROOT ?? '/mnt/secrets'. */
  root?: string;
  /** Debounce window for rename events. Defaults to 250 ms. */
  debounceMs?: number;
  /**
   * Coalescing window for TLS triple-rename events.
   * Rotation of cert/chain/key within this window produces exactly one swap.
   * Defaults to 500 ms.
   */
  tlsCoalesceMs?: number;
  /** Required keys verified eagerly at init. Throws if any are missing. */
  requiredKeys: string[];
  /** Required TLS context names verified eagerly at init. */
  requiredTlsContexts?: string[];
  /** Invoked on read errors during rotation. Default: console.error. */
  onError?: (key: string, err: Error) => void;
}
