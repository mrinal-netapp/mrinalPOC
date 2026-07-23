import { get_logger } from '@agentstudio/observability-client-runtime';
import { BaseDeletionOperator, DeletionContext } from '../DeletionOperator';
import { DeploymentCleanupOperator } from '../DeploymentCleanupOperator';
import { SecretCleanupOperator } from '../SecretCleanupOperator';
import { StorageClassCleanupOperator } from '../StorageClassCleanupOperator';
import { PVCCleanupOperator } from '../PVCCleanupOperator';
import { PVCleanupOperator } from '../PVCleanupOperator';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

const mockLogger = { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() };

const baseContext: DeletionContext = {
  projectId: 'proj-1',
  bucketName: 'my-bucket',
  storageClassName: 'sc-proj-1-my-bucket',
  pvcName: 'pvc-proj-1-my-bucket',
  namespace: 'nemo',
};

// ---- BaseDeletionOperator (setNext / chain) ----

class NoopOperator extends BaseDeletionOperator {
  executed = false;
  async execute(context: DeletionContext): Promise<boolean> {
    this.executed = true;
    await this.executeNext(context);
    return true;
  }
}

describe('BaseDeletionOperator', () => {
  it('setNext returns the next operator', () => {
    const op1 = new NoopOperator();
    const op2 = new NoopOperator();
    const result = op1.setNext(op2);
    expect(result).toBe(op2);
  });

  it('executes chain in order', async () => {
    const order: number[] = [];
    class OrderedOp extends BaseDeletionOperator {
      constructor(private id: number) { super(); }
      async execute(context: DeletionContext): Promise<boolean> {
        order.push(this.id);
        await this.executeNext(context);
        return true;
      }
    }
    const op1 = new OrderedOp(1);
    const op2 = new OrderedOp(2);
    const op3 = new OrderedOp(3);
    op1.setNext(op2).setNext(op3);
    await op1.execute(baseContext);
    expect(order).toEqual([1, 2, 3]);
  });

  it('executes without next operator', async () => {
    const op = new NoopOperator();
    const result = await op.execute(baseContext);
    expect(result).toBe(true);
  });
});

// ---- DeploymentCleanupOperator ----

describe('DeploymentCleanupOperator', () => {
  it('calls removePVCFromDeployment and executes chain', async () => {
    const removeFn = jest.fn().mockResolvedValue(undefined);
    const next = new NoopOperator();
    const op = new DeploymentCleanupOperator({ removePVCFromDeployment: removeFn });
    op.setNext(next);

    const result = await op.execute(baseContext);
    expect(removeFn).toHaveBeenCalledWith(baseContext.pvcName);
    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });

  it('continues chain even when removePVCFromDeployment throws', async () => {
    const removeFn = jest.fn().mockRejectedValue(new Error('deployment unavailable'));
    const next = new NoopOperator();
    const op = new DeploymentCleanupOperator({ removePVCFromDeployment: removeFn });
    op.setNext(next);

    const result = await op.execute(baseContext);
    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });
});

// ---- SecretCleanupOperator ----

describe('SecretCleanupOperator', () => {
  it('calls deleteSecret and executes chain', async () => {
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const next = new NoopOperator();
    const op = new SecretCleanupOperator({ deleteSecret: deleteFn });
    op.setNext(next);

    const result = await op.execute(baseContext);
    expect(deleteFn).toHaveBeenCalledWith(baseContext.projectId, baseContext.bucketName);
    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });

  it('returns false when deleteSecret throws', async () => {
    const deleteFn = jest.fn().mockRejectedValue(new Error('secret not found'));
    const op = new SecretCleanupOperator({ deleteSecret: deleteFn });

    const result = await op.execute(baseContext);
    expect(result).toBe(false);
  });
});

// ---- StorageClassCleanupOperator ----

describe('StorageClassCleanupOperator', () => {
  it('deletes StorageClass and unbound PVs, then continues chain', async () => {
    const deleteScFn = jest.fn().mockResolvedValue(undefined);
    const deleteUnboundFn = jest.fn().mockResolvedValue(0);
    const next = new NoopOperator();
    const op = new StorageClassCleanupOperator(
      { deleteStorageClass: deleteScFn },
      { deleteUnboundPVs: deleteUnboundFn }
    );
    op.setNext(next);

    const result = await op.execute(baseContext);
    expect(deleteScFn).toHaveBeenCalledWith(baseContext.projectId, baseContext.bucketName);
    expect(deleteUnboundFn).toHaveBeenCalledWith(baseContext.storageClassName);
    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });

  it('returns false when deleteStorageClass throws', async () => {
    const deleteScFn = jest.fn().mockRejectedValue(new Error('not found'));
    const deleteUnboundFn = jest.fn().mockResolvedValue(0);
    const op = new StorageClassCleanupOperator(
      { deleteStorageClass: deleteScFn },
      { deleteUnboundPVs: deleteUnboundFn }
    );

    const result = await op.execute(baseContext);
    expect(result).toBe(false);
  });
});

// ---- PVCCleanupOperator ----

describe('PVCCleanupOperator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('deletes PVC and stores bound PV name in context', async () => {
    const mockCoreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        spec: { volumeName: 'pv-1' }
      }),
    } as any;
    const deletePVCFn = jest.fn().mockResolvedValue('pv-1');
    const getPVCNameFn = jest.fn().mockReturnValue('pvc-proj-1-my-bucket');
    const next = new NoopOperator();
    const op = new PVCCleanupOperator(mockCoreApi, { deletePVC: deletePVCFn, getPVCName: getPVCNameFn });
    op.setNext(next);

    const ctx = { ...baseContext };
    const execPromise = op.execute(ctx);
    await jest.runAllTimersAsync();
    const result = await execPromise;

    expect(deletePVCFn).toHaveBeenCalledWith(baseContext.pvcName, true);
    expect(ctx.boundPVName).toBe('pv-1');
    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });

  it('continues chain even when PVC read fails (404)', async () => {
    const mockCoreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue({ statusCode: 404 }),
    } as any;
    const deletePVCFn = jest.fn().mockResolvedValue(undefined);
    const getPVCNameFn = jest.fn().mockReturnValue('pvc-proj-1-my-bucket');
    const next = new NoopOperator();
    const op = new PVCCleanupOperator(mockCoreApi, { deletePVC: deletePVCFn, getPVCName: getPVCNameFn });
    op.setNext(next);

    const execPromise = op.execute(baseContext);
    await jest.runAllTimersAsync();
    const result = await execPromise;

    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });

  it('continues chain even when deletePVC throws', async () => {
    const mockCoreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({ spec: {} }),
    } as any;
    const deletePVCFn = jest.fn().mockRejectedValue(new Error('pvc locked'));
    const getPVCNameFn = jest.fn().mockReturnValue('pvc-1');
    const next = new NoopOperator();
    const op = new PVCCleanupOperator(mockCoreApi, { deletePVC: deletePVCFn, getPVCName: getPVCNameFn });
    op.setNext(next);

    const execPromise = op.execute(baseContext);
    await jest.runAllTimersAsync();
    const result = await execPromise;

    expect(next.executed).toBe(true);
    expect(result).toBe(true);
  });
});

// ---- PVCleanupOperator ----

describe('PVCleanupOperator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('skips PV cleanup when no boundPVName', async () => {
    const mockCoreApi = { readPersistentVolume: jest.fn() } as any;
    const pvManager = { unbindPV: jest.fn(), deletePV: jest.fn() };
    const next = new NoopOperator();
    const op = new PVCleanupOperator(mockCoreApi, pvManager);
    op.setNext(next);

    const ctx = { ...baseContext }; // no boundPVName
    const execPromise = op.execute(ctx);
    await jest.runAllTimersAsync();
    await execPromise;

    expect(mockCoreApi.readPersistentVolume).not.toHaveBeenCalled();
    expect(next.executed).toBe(true);
  });

  it('deletes PV when reclaimPolicy is Delete and matches claim', async () => {
    const mockCoreApi = {
      readPersistentVolume: jest.fn().mockResolvedValue({
        spec: {
          persistentVolumeReclaimPolicy: 'Delete',
          claimRef: { name: baseContext.pvcName, namespace: baseContext.namespace },
        },
      }),
    } as any;
    const unbindFn = jest.fn().mockResolvedValue(undefined);
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    const pvManager = { unbindPV: unbindFn, deletePV: deleteFn };
    const next = new NoopOperator();
    const op = new PVCleanupOperator(mockCoreApi, pvManager);
    op.setNext(next);

    const ctx = { ...baseContext, boundPVName: 'pv-abc' };
    const execPromise = op.execute(ctx);
    await jest.runAllTimersAsync();
    await execPromise;

    expect(unbindFn).toHaveBeenCalledWith('pv-abc');
    expect(deleteFn).toHaveBeenCalledWith('pv-abc');
    expect(next.executed).toBe(true);
  });

  it('skips PV deletion when reclaimPolicy is Retain', async () => {
    const mockCoreApi = {
      readPersistentVolume: jest.fn().mockResolvedValue({
        spec: { persistentVolumeReclaimPolicy: 'Retain', claimRef: {} },
      }),
    } as any;
    const deleteFn = jest.fn();
    const pvManager = { unbindPV: jest.fn(), deletePV: deleteFn };
    const next = new NoopOperator();
    const op = new PVCleanupOperator(mockCoreApi, pvManager);
    op.setNext(next);

    const ctx = { ...baseContext, boundPVName: 'pv-retain' };
    const execPromise = op.execute(ctx);
    await jest.runAllTimersAsync();
    await execPromise;

    expect(deleteFn).not.toHaveBeenCalled();
    expect(next.executed).toBe(true);
  });

  it('handles PV read errors gracefully', async () => {
    const mockCoreApi = {
      readPersistentVolume: jest.fn().mockRejectedValue(new Error('not found')),
    } as any;
    const pvManager = { unbindPV: jest.fn(), deletePV: jest.fn() };
    const next = new NoopOperator();
    const op = new PVCleanupOperator(mockCoreApi, pvManager);
    op.setNext(next);

    const ctx = { ...baseContext, boundPVName: 'pv-missing' };
    const execPromise = op.execute(ctx);
    await jest.runAllTimersAsync();
    const result = await execPromise;

    expect(result).toBe(true);
    expect(next.executed).toBe(true);
  });
});
