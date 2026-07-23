// Workflow-sandbox-safe subset of @agent-studio/shared/evaluation.
//
// Temporal workflow code runs in a V8 sandbox that forbids Node built-ins
// and native modules. `trigger.ts` (the public starter lib) depends on
// `@temporalio/client` + `node:crypto` and cannot be bundled into the
// workflow bundle.
//
// This file re-exports only the sandbox-safe surface: types, constants,
// workflow/signal/query names. The eval-worker bundler (see
// `src/nemo/workers/eval-worker/scripts/bundle-workflows.ts`) aliases
// `@agent-studio/shared/evaluation` to this module for workflow builds, so
// workflow source files can keep using the familiar import specifier while
// trigger / activities / non-workflow code continues to see the full barrel.

export * from './lib/runtime-overrides';
export * from './lib/golden-types';
export * from './lib/provenance';
export * from './lib/case-artifact';
export * from './lib/preflight-types';
export * from './lib/audit-types';
export * from './lib/ab-types';
export * from './lib/job-types';
export * from './lib/workflow-signals';
// Pure sandbox-safe helpers (no Node built-ins, no Temporal client).
export * from './lib/scorer-toggles';
export * from './lib/judge-toggles';
export * from './lib/metrics-catalog';
export * from './lib/template-types';
export * from './lib/resolve-template';
export type * from './lib/activity-signatures';
