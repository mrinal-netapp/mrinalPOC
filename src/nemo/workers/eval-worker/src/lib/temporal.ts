import {
  NativeConnection,
  Worker,
  WorkerOptions,
  WorkflowBundlePath,
} from '@temporalio/worker';
import { getLogger } from './logger';

const logger = getLogger('temporal');

export function loadWorkflowBundle(codePath: string): WorkflowBundlePath {
  return { codePath };
}

export interface CreateWorkerOptions
  extends Omit<WorkerOptions, 'connection' | 'namespace'> {
  taskQueue: string;
  connection?: NativeConnection;
  namespace?: string;
}

export async function createWorker(options: CreateWorkerOptions): Promise<{
  worker: Worker;
  connection: NativeConnection;
}> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = options.namespace ?? process.env.TEMPORAL_NAMESPACE ?? 'default';

  const connection =
    options.connection ?? (await NativeConnection.connect({ address }));

  const { connection: _ignored, namespace: _ns, ...rest } = options;

  const worker = await Worker.create({
    connection,
    namespace,
    ...rest,
  });

  return { worker, connection };
}

export interface Disposable {
  close?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}

/**
 * Wire SIGINT/SIGTERM to signal the worker to drain. The actual drain
 * is observed by the caller awaiting `worker.run()` — only after that
 * resolves are activity completions guaranteed flushed and is it safe
 * to close the NativeConnection. `closeAfterDrain` performs that
 * post-drain cleanup; call it once `worker.run()` returns.
 */
export function registerProcessSignals(worker: Worker): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received shutdown signal', { signal });
    // shutdown() returns void — it signals intent. The drain happens
    // inside the active worker.run() promise the caller is awaiting.
    worker.shutdown();
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}

export async function closeAfterDrain(
  connection: NativeConnection,
  extras: Disposable[] = [],
): Promise<void> {
  try {
    for (const d of extras) {
      if (typeof d.close === 'function') await d.close();
      else if (typeof d.shutdown === 'function') await d.shutdown();
    }
  } catch (err) {
    logger.error('Error closing extras', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await connection.close();
  } catch (err) {
    logger.error('Error closing Temporal connection', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
