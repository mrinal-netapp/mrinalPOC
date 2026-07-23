// `temporal.ts` is mostly thin glue around @temporalio/worker's NativeConnection
// + Worker.create — both require a live Temporal cluster, so we cover the two
// pure helpers and assert that registerProcessSignals wires up the right
// process events.

import {
  closeAfterDrain,
  loadWorkflowBundle,
  registerProcessSignals,
} from '../../src/lib/temporal';
import type { NativeConnection, Worker } from '@temporalio/worker';

describe('loadWorkflowBundle', () => {
  it('wraps the codePath in the WorkflowBundlePath shape', () => {
    expect(loadWorkflowBundle('/tmp/bundle.js')).toEqual({
      codePath: '/tmp/bundle.js',
    });
  });
});

describe('registerProcessSignals', () => {
  let signalHandlers: Map<string, NodeJS.SignalsListener>;
  let originalProcessOnce: typeof process.once;

  beforeEach(() => {
    signalHandlers = new Map();
    originalProcessOnce = process.once.bind(process);
    jest
      .spyOn(process, 'once')
      .mockImplementation(((event: string | symbol, handler: (...a: never[]) => void) => {
        if (event === 'SIGINT' || event === 'SIGTERM') {
          signalHandlers.set(event as string, handler as NodeJS.SignalsListener);
        }
        return process;
      }) as typeof process.once);
  });

  afterEach(() => {
    (process.once as unknown as { mockRestore?: () => void }).mockRestore?.();
    process.once = originalProcessOnce;
  });

  it('registers a handler for SIGINT and SIGTERM', () => {
    const worker = { shutdown: jest.fn() } as unknown as Worker;
    registerProcessSignals(worker);
    expect(signalHandlers.has('SIGINT')).toBe(true);
    expect(signalHandlers.has('SIGTERM')).toBe(true);
  });

  it('calls worker.shutdown on signal (drain is observed by the caller awaiting worker.run)', () => {
    const shutdown = jest.fn();
    const worker = { shutdown } as unknown as Worker;
    registerProcessSignals(worker);
    signalHandlers.get('SIGTERM')!('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across multiple signals (only signals shutdown once)', () => {
    const shutdown = jest.fn();
    const worker = { shutdown } as unknown as Worker;
    registerProcessSignals(worker);
    signalHandlers.get('SIGINT')!('SIGINT');
    signalHandlers.get('SIGTERM')!('SIGTERM');
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('closeAfterDrain', () => {
  it('closes extras and then the connection', async () => {
    const order: string[] = [];
    const close = jest.fn(async () => {
      order.push('connection.close');
    });
    const extraShutdown = jest.fn(async () => {
      order.push('extra.shutdown');
    });
    const extraClose = jest.fn(async () => {
      order.push('extra.close');
    });
    const connection = { close } as unknown as NativeConnection;
    await closeAfterDrain(connection, [
      { shutdown: extraShutdown },
      { close: extraClose },
    ]);
    expect(extraShutdown).toHaveBeenCalledTimes(1);
    expect(extraClose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    // connection.close runs after extras.
    expect(order).toEqual(['extra.shutdown', 'extra.close', 'connection.close']);
  });

  it('still closes the connection if an extra throws', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const connection = { close } as unknown as NativeConnection;
    await closeAfterDrain(connection, [
      {
        close: jest.fn(async () => {
          throw new Error('boom');
        }),
      },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
