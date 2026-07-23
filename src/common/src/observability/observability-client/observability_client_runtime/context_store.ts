/**
 * AsyncLocalStorage-based context store for per-request fields.
 *
 * The express middleware calls `runWithContext` so every async continuation
 * handling the same HTTP request inherits the same store, meaning
 * `getProjectId()` returns the correct value even after awaits.
 *
 * Non-HTTP callers (Temporal workers, scripts) can use `runWithContext`
 * directly to bind a project_id for the lifetime of an activity.
 */
import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  project_id?: string;
}

const _asyncStore = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` within a new async context carrying the supplied fields.
 * All async work spawned inside `fn` (awaits, callbacks, promises) sees
 * the same context via `getProjectId()`.
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return _asyncStore.run(ctx, fn);
}

/**
 * Retrieve the project_id from the active async context.
 * Returns `undefined` when called outside a `runWithContext` scope.
 */
export function getProjectId(): string | undefined {
  return _asyncStore.getStore()?.project_id;
}
