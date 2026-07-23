import * as fs from 'node:fs';
import * as path from 'node:path';

export type RenameHandler = (filename: string) => void;

/**
 * Watches a directory tree for rename events by placing a non-recursive
 * `fs.watch` on every real (non-symlink) subdirectory.
 *
 * Why not `{ recursive: true }`?
 * Node.js `fs.watch({ recursive: true })` on Linux uses inotify but its
 * delivery of `IN_MOVED_TO` events for files inside *subdirectories* is
 * unreliable on container filesystems (e.g. overlayfs / Docker). Plain
 * per-directory inotify watches are fully supported on all Linux kernels and
 * filesystem types, and work identically on macOS (kqueue EVFILT_VNODE).
 *
 * Layout covered:
 *  - Root directory: detects `..data` symlink-swap (CSI driver rotation).
 *  - Each real subdirectory (e.g. `db/`, `tls/server/`): detects individual
 *    key-file atomic renames.
 *  - New subdirectories created at runtime are automatically picked up.
 */
export class DirectoryWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly onRename: RenameHandler,
    private readonly onWatchError: (err: Error) => void = (err) =>
      console.error('[secrets-client] fs.watch error:', err),
  ) {
    this._watch(dir, '');
  }

  private _watch(dirPath: string, prefix: string): void {
    if (this.watchers.has(dirPath)) return;

    const watcher = fs.watch(
      dirPath,
      { persistent: false },
      (eventType, filename) => {
        if (this.closed || eventType !== 'rename') return;

        if (!filename) {
          // Some platforms/filesystems omit the filename in the callback.
          // Conservatively re-scan the directory: signal the ..data symlink
          // for the root (covers CSI rotation) and every visible non-".."
          // entry so any pending rotation is picked up.
          if (!prefix) {
            this.onRename(path.join(this.dir, '..data'));
          }
          try {
            for (const entry of fs.readdirSync(dirPath)) {
              if (entry.startsWith('..')) continue;
              const relative = prefix ? `${prefix}/${entry}` : entry;
              this.onRename(path.join(this.dir, relative));
              try {
                if (fs.lstatSync(path.join(dirPath, entry)).isDirectory()) {
                  this._watch(path.join(dirPath, entry), relative);
                }
              } catch {
                // Entry disappeared — skip.
              }
            }
          } catch {
            // Directory gone or not listable — ignore.
          }
          return;
        }

        const relative = prefix ? `${prefix}/${filename}` : filename;
        this.onRename(path.join(this.dir, relative));

        // If a new real subdirectory just appeared, start watching it —
        // unless its name starts with ".." (CSI versioned data dirs such as
        // "..data_v2" or "..2026_01_01_..."). Those are internal driver
        // artefacts: we detect their rotation via the root-level "..data"
        // symlink rename and do not need to recurse into them. Skipping them
        // prevents inotify handle exhaustion as rotations accumulate over time.
        try {
          if (
            !filename.startsWith('..') &&
            fs.lstatSync(path.join(dirPath, filename)).isDirectory()
          ) {
            this._watch(path.join(dirPath, filename), relative);
          }
        } catch {
          // Entry is gone (rename source) or inaccessible — ignore.
        }
      },
    );

    watcher.on('error', (err) => {
      if (!this.closed) this.onWatchError(err as Error);
    });

    this.watchers.set(dirPath, watcher);

    // Recursively watch real subdirectories that already exist, skipping ".."
    // directories for the same reason as above.
    try {
      for (const entry of fs.readdirSync(dirPath)) {
        try {
          if (entry.startsWith('..')) continue;
          const entryPath = path.join(dirPath, entry);
          if (fs.lstatSync(entryPath).isDirectory()) {
            this._watch(entryPath, prefix ? `${prefix}/${entry}` : entry);
          }
        } catch {
          // Entry might be inaccessible — skip.
        }
      }
    } catch {
      // dirPath might not be listable — ignore.
    }
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  get directory(): string {
    return this.dir;
  }
}

/**
 * A debounced rename handler that also exposes `cancel()` so that callers
 * (e.g. `SecretStoreImpl.close()`) can drain any pending timer on shutdown,
 * honouring the "releases all timers" contract in `types.ts`.
 */
export interface DebouncedRenameHandler {
  (filePath: string): void;
  cancel(): void;
}

/**
 * Returns a debounced wrapper around `fn` that accumulates every unique path
 * seen within `delayMs` and then calls `fn` once for each unique path.
 *
 * Unlike a last-arg-wins debounce, this guarantees that the DESTINATION of an
 * atomic rename (e.g. `db/url`) is always processed even when the platform
 * fires the source event (`db/.tmp-xxx`) last. On macOS (FSEvents) and on
 * Linux with inotify, a `renameSync(src, dst)` produces two 'rename' events
 * whose delivery order is non-deterministic; accumulating both ensures the
 * cached key path reaches `_handleRename` regardless of that order.
 *
 * Call `.cancel()` to clear any pending timer and discard buffered paths.
 */
export function debounce(
  fn: (filePath: string) => void,
  delayMs: number,
): DebouncedRenameHandler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();

  const handler = (filePath: string) => {
    pending.add(filePath);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = [...pending];
      pending.clear();
      for (const p of paths) fn(p);
    }, delayMs);
  };

  handler.cancel = () => {
    clearTimeout(timer);
    pending.clear();
    timer = undefined;
  };

  return handler as DebouncedRenameHandler;
}
