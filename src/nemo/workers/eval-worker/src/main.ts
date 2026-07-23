// Eval-worker entry point. Hosts the single flat AgentEvaluationWorkflow
// on EVAL_TASK_QUEUE — per-case work runs inline via the `runCase`
// helper, not as a child workflow. Run modes are composition patterns
// driven by config-service, not standalone workflows here.

import { existsSync } from 'fs';
import { resolve } from 'path';
import { Runtime } from '@temporalio/worker';
import { getLogger } from './lib/logger';
import {
  closeAfterDrain,
  createWorker,
  loadWorkflowBundle,
  registerProcessSignals,
} from './lib/temporal';
import { EVAL_TASK_QUEUE } from './lib/evaluation';
import * as activities from './activities';

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9465', 10);

Runtime.install({
  telemetryOptions: {
    metrics: {
      prometheus: { bindAddress: `0.0.0.0:${METRICS_PORT}` },
    },
  },
});

const logger = getLogger('server');

/**
 * Production: a pre-built `workflow-bundle.js` lives next to this file (see
 * scripts/bundle-workflows.ts). Dev: no bundle is produced — fall back to
 * `workflowsPath` pointing at the workflows source dir, which the Temporal
 * SDK compiles on startup. Either path is valid as a Worker option.
 */
function resolveWorkflowSource():
  | { workflowBundle: ReturnType<typeof loadWorkflowBundle> }
  | { workflowsPath: string } {
  const bundlePath = resolve(__dirname, 'workflow-bundle.js');
  if (existsSync(bundlePath)) {
    return { workflowBundle: loadWorkflowBundle(bundlePath) };
  }
  const workflowsPath = resolve(__dirname, 'workflows');
  logger.info(
    `workflow-bundle.js not found; using workflowsPath (dev mode): ${workflowsPath}`,
  );
  return { workflowsPath };
}

async function main() {
  logger.info('Starting Eval Worker Service...');

  const workflowSource = resolveWorkflowSource();

  const { worker, connection } = await createWorker({
    ...workflowSource,
    activities,
    taskQueue: EVAL_TASK_QUEUE,
    maxCachedWorkflows: 200,
    stickyQueueScheduleToStartTimeout: '5s',
    shutdownGraceTime: '30s',
  });

  registerProcessSignals(worker);

  logger.info(`Eval Worker listening on queue: ${EVAL_TASK_QUEUE}`);
  try {
    // worker.run() resolves only after the worker has drained in-flight
    // activities following shutdown(). Close the NativeConnection *after*
    // it resolves — closing earlier aborts in-flight activity completions
    // and leaves workflows in WORKFLOW_TASK_TIMED_OUT.
    await worker.run();
  } finally {
    await closeAfterDrain(connection, []);
  }
}

main().catch((err) => {
  logger.error('Eval Worker failed to start', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
