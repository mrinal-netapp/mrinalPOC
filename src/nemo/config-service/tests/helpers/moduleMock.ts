/**
 * CommonJS module mocking via the `require` cache.
 *
 * Node v20 (CJS + ts-node) does not expose `node:test`'s `mock.module`, so we
 * stub whole modules by injecting a fake into `require.cache` BEFORE the
 * system-under-test is required. Use this for module-level function exports
 * (e.g. `utils/s3Utils`, `@agentstudio/common`). For class methods reachable
 * via a prototype, prefer `node:test`'s `mock.method(Class.prototype, ...)`.
 *
 * Ordering matters: if the SUT (or a transitive consumer) is already cached,
 * it has already bound the real dependency. Use `loadFresh()` to evict and
 * re-require the consumer after installing mocks.
 */
import Module from 'node:module';
import * as path from 'node:path';

const SERVICE_ROOT = path.resolve(__dirname, '..', '..');

function resolveFrom(relOrAbs: string): string {
  const target = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(SERVICE_ROOT, relOrAbs);
  // ts-node hooks the resolver, so a path without extension resolves to .ts.
  try {
    return require.resolve(target);
  } catch {
    // Allow bare package specifiers (e.g. '@agentstudio/common').
    return require.resolve(relOrAbs, { paths: [SERVICE_ROOT] });
  }
}

export type Restore = () => void;

/**
 * Replace a module's exports with `fakeExports`. Returns a restore function.
 * `target` may be a path relative to the config-service root, an absolute
 * path, or a package specifier.
 */
export function mockModule(target: string, fakeExports: Record<string, unknown>): Restore {
  const resolved = resolveFrom(target);
  const previous = require.cache[resolved];

  const fake = new Module(resolved, module) as NodeModule & { exports: unknown };
  fake.filename = resolved;
  fake.loaded = true;
  fake.paths = (Module as any)._nodeModulePaths(path.dirname(resolved));
  fake.exports = fakeExports;
  require.cache[resolved] = fake;

  return function restore() {
    if (previous) require.cache[resolved] = previous;
    else delete require.cache[resolved];
  };
}

/** Evict one or more modules (relative/absolute/specifier) from the require cache. */
export function clearModule(...targets: string[]): void {
  for (const target of targets) {
    try {
      delete require.cache[resolveFrom(target)];
    } catch {
      /* not resolvable / not cached */
    }
  }
}

/**
 * Evict `target` (and any extra modules) from cache, then require `target`
 * fresh so previously installed `mockModule` stubs take effect.
 */
export function loadFresh<T = any>(target: string, alsoClear: string[] = []): T {
  const resolved = resolveFrom(target);
  delete require.cache[resolved];
  for (const extra of alsoClear) clearModule(extra);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(resolved) as T;
}

/** Track several restores and undo them together. */
export function restoreScope(): { add(r: Restore): void; restoreAll(): void } {
  const restores: Restore[] = [];
  return {
    add(r: Restore) {
      restores.push(r);
    },
    restoreAll() {
      while (restores.length) {
        const r = restores.pop();
        try {
          r?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
