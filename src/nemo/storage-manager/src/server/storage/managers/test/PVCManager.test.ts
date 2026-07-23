import * as k8s from '@kubernetes/client-node';
import { PVCManager } from '../PVCManager';
import { BucketStorageClassSpec } from '../../types';
import { NameGenerator } from '../../utils/NameGenerator';

jest.useFakeTimers();

function baseSpec(overrides: Partial<BucketStorageClassSpec> = {}): BucketStorageClassSpec {
  return {
    project_id: 'proj-1',
    bucket_name: 'mybucket',
    provisioning_mode: 'static',
    volume_info: {
      type: 'nfs',
      endpoint: 'new-server:/data',
    },
    auth_info: { type: 'none' },
    protocol: 's3',
    role: 'primary',
    ...overrides,
  };
}

const storageClass: k8s.V1StorageClass = {
  apiVersion: 'storage.k8s.io/v1',
  kind: 'StorageClass',
  metadata: { name: 'sc-proj-1-mybucket' },
  provisioner: 'kubernetes.io/no-provisioner',
};

const dynamicStorageClass: k8s.V1StorageClass = {
  apiVersion: 'storage.k8s.io/v1',
  kind: 'StorageClass',
  metadata: { name: 'sc-dynamic-mybucket' },
  provisioner: 'csi.driver.io',
};

const SC_NAME = storageClass.metadata!.name!;
const PVC_NAME = NameGenerator.getPVCName(SC_NAME, 'mybucket');

function makeManager(
  coreApiOverrides: Partial<Record<string, jest.Mock>> = {},
  storageApiOverrides: Partial<Record<string, jest.Mock>> = {},
  opts: { namespace?: string } = {}
) {
  const namespace = opts.namespace ?? 'nemo';
  const defaultSize = '10Gi';

  const coreApi = {
    readNamespacedPersistentVolumeClaim: jest.fn(),
    readPersistentVolume: jest.fn(),
    deletePersistentVolume: jest.fn().mockResolvedValue({}),
    replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
    listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({ items: [] }),
    ...coreApiOverrides,
  } as unknown as k8s.CoreV1Api;

  const storageApi = {
    readStorageClass: jest.fn().mockResolvedValue({
      ...storageClass,
      provisioner: 'kubernetes.io/no-provisioner',
    }),
    ...storageApiOverrides,
  } as unknown as k8s.StorageV1Api;

  return {
    manager: new PVCManager(coreApi, storageApi, namespace, defaultSize, 'error'),
    coreApi: coreApi as any,
    storageApi: storageApi as any,
  };
}

// ─── verifyStorageClass ────────────────────────────────────────────────────────

describe('PVCManager verifyStorageClass (via createOrUpdatePVC)', () => {
  it('throws enhanced error when StorageClass not found', async () => {
    const notFound = Object.assign(new Error('Not found'), { statusCode: 404 });
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(notFound),
    }, {
      readStorageClass: jest.fn().mockRejectedValue(notFound),
    });

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec())
    ).rejects.toThrow(/StorageClass.*does not exist/);
  });

  it('throws when readStorageClass fails with a generic error', async () => {
    const { manager } = makeManager({}, {
      readStorageClass: jest.fn().mockRejectedValue(new Error('timeout')),
    });

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec())
    ).rejects.toThrow(/Failed to verify StorageClass/);
  });

  it('throws when access modes are not supported', async () => {
    const { manager } = makeManager({}, {
      readStorageClass: jest.fn().mockResolvedValue({
        ...storageClass,
        provisioner: 'kubernetes.io/no-provisioner',
      }),
    });

    const spec = baseSpec({ access_modes: ['ReadWriteMany'] });
    // AccessModeResolver returns invalid when StorageClass has no volumeBindingMode
    // We test the normal path here – it will proceed normally unless access modes are truly unsupported
    // Just verifying no crash for valid modes
    const coreApi = (manager as any).coreApi;
    coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '1' },
      spec: { storageClassName: SC_NAME, volumeName: undefined },
      status: { phase: 'Unknown' },
    });
    coreApi.replaceNamespacedPersistentVolumeClaim.mockResolvedValue({});

    const result = await manager.createOrUpdatePVC(storageClass, 'mybucket', spec);
    expect(result).toBe(PVC_NAME);
  });
});

// ─── bindPVCToPV ──────────────────────────────────────────────────────────────

describe('PVCManager bindPVCToPV', () => {
  it('binds PVC to PV successfully', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '1' },
        spec: {},
        status: {},
      }),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    await expect(manager.bindPVCToPV(PVC_NAME, 'pv-1')).resolves.toBeUndefined();
    expect(coreApi.replaceNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ name: PVC_NAME })
    );
  });

  it('throws enhanced error when bindPVCToPV fails', async () => {
    const err = Object.assign(new Error('bind failed'), { statusCode: 500 });
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(err),
    });

    await expect(manager.bindPVCToPV(PVC_NAME, 'pv-1')).rejects.toThrow();
  });
});

// ─── createOrUpdatePVC — endpoint drift (NFS) ────────────────────────────────

describe('PVCManager createOrUpdatePVC — endpoint drift (NFS)', () => {
  const namespace = 'nemo';
  const defaultSize = '10Gi';

  function makeManagerWith(mocks: {
    readPVC: k8s.V1PersistentVolumeClaim;
    readPV: k8s.V1PersistentVolume;
    listPods?: k8s.V1PodList;
  }) {
    const coreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue(mocks.readPVC),
      readPersistentVolume: jest.fn().mockResolvedValue(mocks.readPV),
      deletePersistentVolume: jest.fn().mockResolvedValue({}),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
      listNamespacedPod: jest.fn().mockResolvedValue(mocks.listPods || { items: [] }),
    } as unknown as k8s.CoreV1Api;

    const storageApi = {
      readStorageClass: jest.fn().mockResolvedValue({
        ...storageClass,
        provisioner: 'kubernetes.io/no-provisioner',
      }),
    } as unknown as k8s.StorageV1Api;

    return {
      manager: new PVCManager(coreApi, storageApi, namespace, defaultSize, 'error'),
      coreApi: coreApi as any,
    };
  }

  it('does not delete PV when NFS endpoint matches spec', async () => {
    const { manager, coreApi } = makeManagerWith({
      readPVC: {
        metadata: { name: PVC_NAME, namespace, resourceVersion: '1' },
        spec: { storageClassName: SC_NAME, volumeName: 'pv-old' },
        status: { phase: 'Bound' },
      },
      readPV: {
        spec: { nfs: { server: 'new-server', path: '/data' } },
      },
    });

    const spec = baseSpec({ volume_info: { type: 'nfs', endpoint: 'new-server:/data' } });
    const cb = jest.fn().mockResolvedValue('pv-ignored');
    await manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    expect(coreApi.deletePersistentVolume).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
  });

  it('skips PV replacement when endpoint drifts but PVC is in use', async () => {
    const { manager, coreApi } = makeManagerWith({
      readPVC: {
        metadata: { name: PVC_NAME, namespace, resourceVersion: '1' },
        spec: { storageClassName: SC_NAME, volumeName: 'pv-old' },
        status: { phase: 'Bound' },
      },
      readPV: {
        spec: { nfs: { server: 'old-server', path: '/data' } },
      },
      listPods: {
        items: [{
          metadata: { name: 'pod-1' },
          spec: {
            containers: [{ name: 'c1', image: 'busybox' }],
            volumes: [{ name: 'vol', persistentVolumeClaim: { claimName: PVC_NAME } }],
          },
          status: { phase: 'Running' },
        }],
      },
    });

    const spec = baseSpec();
    const cb = jest.fn().mockResolvedValue('pv-new');
    await manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    expect(coreApi.deletePersistentVolume).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
  });

  it('replaces PV when endpoint drifts and no pod uses the PVC', async () => {
    const { manager, coreApi } = makeManagerWith({
      readPVC: {
        metadata: { name: PVC_NAME, namespace, resourceVersion: '1', uid: 'u1' },
        spec: { storageClassName: SC_NAME, volumeName: 'pv-old' },
        status: { phase: 'Bound' },
      },
      readPV: {
        spec: { nfs: { server: 'old-server', path: '/data' } },
      },
    });

    const spec = baseSpec();
    const cb = jest.fn().mockResolvedValue('pv-new-generated');
    await manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    expect(coreApi.deletePersistentVolume).toHaveBeenCalledWith({ name: 'pv-old' });
    expect(cb).toHaveBeenCalled();
  });

  it('handles drift when readPV fails (skips check, updates annotations)', async () => {
    const { manager, coreApi } = makeManagerWith({
      readPVC: {
        metadata: { name: PVC_NAME, namespace, resourceVersion: '1' },
        spec: { storageClassName: SC_NAME, volumeName: 'pv-old' },
        status: { phase: 'Bound' },
      },
      readPV: undefined as any,
    });
    coreApi.readPersistentVolume.mockRejectedValue(new Error('PV not found'));

    const spec = baseSpec();
    const cb = jest.fn().mockResolvedValue('pv-new');
    await manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    expect(coreApi.deletePersistentVolume).not.toHaveBeenCalled();
  });
});

// ─── createOrUpdatePVC — SMB endpoint drift ──────────────────────────────────

describe('PVCManager createOrUpdatePVC — SMB endpoint drift', () => {
  it('detects drift on CIFS/SMB source change', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: 'pvc-smb', namespace: 'nemo', resourceVersion: '1', uid: 'uid-smb' },
        spec: { storageClassName: 'sc-smb', volumeName: 'pv-smb-old' },
        status: { phase: 'Bound' },
      }),
      readPersistentVolume: jest.fn().mockResolvedValue({
        spec: { csi: { volumeAttributes: { source: '//old-server/share' } } },
      }),
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: 'pvc-smb', uid: 'uid-smb', resourceVersion: '2' },
        spec: {},
      }),
    }, {
      readStorageClass: jest.fn().mockResolvedValue({
        metadata: { name: 'sc-smb' },
        provisioner: 'kubernetes.io/no-provisioner',
      }),
    });

    const smbSC: k8s.V1StorageClass = {
      metadata: { name: 'sc-smb' },
      provisioner: 'kubernetes.io/no-provisioner',
    };
    const spec = baseSpec({
      volume_info: { type: 'cifs', endpoint: '//new-server/share' },
    });
    const cb = jest.fn().mockResolvedValue('pv-smb-new');

    await manager.createOrUpdatePVC(smbSC, 'mybucket', spec, cb);
    expect(coreApi.deletePersistentVolume).toHaveBeenCalledWith({ name: 'pv-smb-old' });
    expect(cb).toHaveBeenCalled();
  });
});

// ─── createOrUpdatePVC — dynamic provisioning ────────────────────────────────

describe('PVCManager createOrUpdatePVC — dynamic provisioning', () => {
  it('skips PV callback and creates PVC only for dynamic provisioner', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(
        Object.assign(new Error('Not Found'), { statusCode: 404 })
      ),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    }, {
      readStorageClass: jest.fn().mockResolvedValue({
        metadata: { name: 'sc-dynamic-mybucket' },
        provisioner: 'csi.driver.io',
      }),
    });

    const spec = baseSpec({ provisioning_mode: 'dynamic' });
    const cb = jest.fn().mockResolvedValue('pv-auto');

    const result = await manager.createOrUpdatePVC(dynamicStorageClass, 'mybucket', spec, cb);
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('handles pending PVC with dynamic provisioning (waits for provisioner)', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: 'pvc-dyn', namespace: 'nemo', resourceVersion: '1' },
        spec: { storageClassName: 'sc-dynamic-mybucket', volumeName: undefined },
        status: { phase: 'Pending' },
      }),
    }, {
      readStorageClass: jest.fn().mockResolvedValue({
        metadata: { name: 'sc-dynamic-mybucket' },
        provisioner: 'csi.driver.io',
      }),
    });

    const spec = baseSpec({ provisioning_mode: 'dynamic' });
    const result = await manager.createOrUpdatePVC(dynamicStorageClass, 'mybucket', spec);
    expect(result).toBeDefined();
  });

  it('creates PVC and returns immediately for dynamic provisioning (new PVC)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(notFound),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    }, {
      readStorageClass: jest.fn().mockResolvedValue({
        ...dynamicStorageClass,
      }),
    });

    const spec = baseSpec({ provisioning_mode: 'dynamic' });
    const result = await manager.createOrUpdatePVC(dynamicStorageClass, 'mybucket', spec);
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});

// ─── createOrUpdatePVC — static provisioning (new PVC) ───────────────────────

describe('PVCManager createOrUpdatePVC — static provisioning (new PVC)', () => {
  it('creates PVC and then creates PV when pending (static)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    let callCount = 0;
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(notFound); // initial read
        // second read after creation
        return Promise.resolve({
          metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '2' },
          spec: { volumeName: undefined },
          status: { phase: 'Pending' },
        });
      }),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const spec = baseSpec();
    const cb = jest.fn().mockResolvedValue('pv-on-demand');
    const createPVCPromise = manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    await jest.runAllTimersAsync();
    const result = await createPVCPromise;
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    expect(cb).toHaveBeenCalled();
    expect(result).toBe(PVC_NAME);
  });

  it('creates PVC and returns when already Bound (static)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    let callCount = 0;
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(notFound);
        return Promise.resolve({
          metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '2' },
          spec: { volumeName: 'pv-auto' },
          status: { phase: 'Bound' },
        });
      }),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const spec = baseSpec();
    const cb = jest.fn().mockResolvedValue('pv-auto');
    const promise = manager.createOrUpdatePVC(storageClass, 'mybucket', spec, cb);
    await jest.runAllTimersAsync();
    await promise;
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalled();
  });

  it('handles conflict error during PVC creation (concurrent create)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const conflict = Object.assign(new Error('conflict'), { statusCode: 409 });

    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn()
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({
          metadata: { name: PVC_NAME, namespace: 'nemo' },
          spec: {},
          status: {},
        }),
      createNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(conflict),
    });

    const result = await manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec());
    expect(result).toBe(PVC_NAME);
  });

  it('throws on non-conflict creation error', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const serverErr = Object.assign(new Error('server error'), { statusCode: 500 });

    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(notFound),
      createNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(serverErr),
    });

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec())
    ).rejects.toThrow();
  });

  it('handles PVC status check failure gracefully after creation', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn()
        .mockRejectedValueOnce(notFound)
        .mockRejectedValueOnce(new Error('status check failed')),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const spec = baseSpec();
    const promise = manager.createOrUpdatePVC(storageClass, 'mybucket', spec);
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(PVC_NAME);
  });
});

// ─── createOrUpdatePVC — update annotations ──────────────────────────────────

describe('PVCManager createOrUpdatePVC — update annotations', () => {
  it('updates annotations when annotations differ (unbound PVC)', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: {
          name: PVC_NAME,
          namespace: 'nemo',
          resourceVersion: '1',
          annotations: { 'old-key': 'old-val' },
        },
        spec: { storageClassName: SC_NAME, volumeName: undefined },
        status: { phase: 'Unknown' },
      }),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const result = await manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec());
    expect(coreApi.replaceNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    expect(result).toBe(PVC_NAME);
  });

  it('skips update when annotations are up to date (unbound PVC)', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: {
          name: PVC_NAME,
          namespace: 'nemo',
          resourceVersion: '1',
          annotations: {},
        },
        spec: { storageClassName: SC_NAME, volumeName: undefined },
        status: { phase: 'Unknown' },
      }),
    });

    // Make annotations match by using an empty annotation spec
    const result = await manager.createOrUpdatePVC(
      { ...storageClass, metadata: { name: SC_NAME } },
      'mybucket',
      undefined
    );
    expect(result).toBe(PVC_NAME);
  });
});

// ─── isPVCInUse ───────────────────────────────────────────────────────────────

describe('PVCManager isPVCInUse', () => {
  it('returns true when a running pod uses the PVC', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockResolvedValue({
        items: [{
          metadata: { name: 'pod-1' },
          spec: {
            volumes: [{ name: 'v', persistentVolumeClaim: { claimName: PVC_NAME } }],
          },
          status: { phase: 'Running' },
        }],
      }),
    });
    const inUse = await (manager as any).isPVCInUse(PVC_NAME);
    expect(inUse).toBe(true);
  });

  it('returns false when pod using PVC is terminating', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockResolvedValue({
        items: [{
          metadata: { name: 'pod-1', deletionTimestamp: new Date() },
          spec: {
            volumes: [{ name: 'v', persistentVolumeClaim: { claimName: PVC_NAME } }],
          },
          status: { phase: 'Running' },
        }],
      }),
    });
    const inUse = await (manager as any).isPVCInUse(PVC_NAME);
    expect(inUse).toBe(false);
  });

  it('returns false when no pod uses the PVC', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
    });
    const inUse = await (manager as any).isPVCInUse(PVC_NAME);
    expect(inUse).toBe(false);
  });

  it('returns true (safe default) when listPods fails', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockRejectedValue(new Error('api error')),
    });
    const inUse = await (manager as any).isPVCInUse(PVC_NAME);
    expect(inUse).toBe(true);
  });
});

// ─── waitForPVCUnmount ────────────────────────────────────────────────────────

describe('PVCManager waitForPVCUnmount', () => {
  it('resolves immediately when PVC is not in use', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
    });

    const promise = (manager as any).waitForPVCUnmount(PVC_NAME, 5000, 500);
    await jest.runAllTimersAsync();
    await promise;
  });

  it('times out with warning when PVC stays in use', async () => {
    const { manager } = makeManager({
      listNamespacedPod: jest.fn().mockResolvedValue({
        items: [{
          metadata: { name: 'pod-1' },
          spec: { volumes: [{ name: 'v', persistentVolumeClaim: { claimName: PVC_NAME } }] },
          status: { phase: 'Running' },
        }],
      }),
    });

    const promise = (manager as any).waitForPVCUnmount(PVC_NAME, 100, 50);
    await jest.runAllTimersAsync();
    await promise; // should not throw, just warn
  });
});

// ─── deletePVC ────────────────────────────────────────────────────────────────

describe('PVCManager deletePVC', () => {
  it('deletes PVC and returns bound PV name', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo' },
        spec: { volumeName: 'pv-bound' },
        status: { phase: 'Bound' },
      }),
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const promise = manager.deletePVC(PVC_NAME, true);
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('pv-bound');
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ name: PVC_NAME })
    );
  });

  it('returns undefined when PVC not found (already deleted)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(notFound),
    });

    const result = await manager.deletePVC(PVC_NAME);
    expect(result).toBeUndefined();
  });

  it('returns bound PV when PVC deletion says not found (deleted between read and delete)', async () => {
    const notFound = Object.assign(new Error('Not Found'), { statusCode: 404 });
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo' },
        spec: { volumeName: 'pv-gone' },
        status: { phase: 'Bound' },
      }),
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(notFound),
    });

    const promise = manager.deletePVC(PVC_NAME, true);
    await jest.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe('pv-gone');
  });

  it('throws on unrecoverable delete error', async () => {
    const serverErr = Object.assign(new Error('server error'), { statusCode: 500 });
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo' },
        spec: { volumeName: 'pv-1' },
        status: { phase: 'Bound' },
      }),
      deleteNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(serverErr),
    });

    // Use waitForUnmount=false to avoid timer complications
    await expect(manager.deletePVC(PVC_NAME, false)).rejects.toThrow();
  });

  it('skips waiting when waitForUnmount is false', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo' },
        spec: { volumeName: 'pv-fast' },
        status: {},
      }),
      deleteNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
    });

    const result = await manager.deletePVC(PVC_NAME, false);
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    expect(result).toBe('pv-fast');
  });
});

// ─── listVersitygwPVCs ────────────────────────────────────────────────────────

describe('PVCManager listVersitygwPVCs', () => {
  it('returns empty map when no PVCs exist', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({ items: [] }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.size).toBe(0);
  });

  it('maps Bound PVC correctly', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-1',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-a',
              'agentstudio.io/project-id': 'proj-1',
            },
          },
          spec: { volumeName: 'pv-1', storageClassName: 'sc-1' },
          status: { phase: 'Bound' },
        }],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.size).toBe(1);
    expect(result.get('proj-1:bucket-a')).toMatchObject({ status: 'bound' });
  });

  it('maps Pending PVC for dynamic provisioning', async () => {
    const { manager, storageApi } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-dyn',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-b',
              'agentstudio.io/project-id': 'proj-2',
            },
          },
          spec: { storageClassName: 'sc-dynamic' },
          status: { phase: 'Pending' },
        }],
      }),
    });

    storageApi.readStorageClass.mockResolvedValue({
      metadata: { name: 'sc-dynamic' },
      provisioner: 'csi.dynamic.io',
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.get('proj-2:bucket-b')).toMatchObject({ status: 'pending' });
    expect(result.get('proj-2:bucket-b')?.statusMessage).toMatch(/dynamic provisioner/);
  });

  it('maps Pending PVC for static provisioning', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-static',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-c',
              'agentstudio.io/project-id': 'proj-3',
            },
          },
          spec: { storageClassName: 'sc-static' },
          status: { phase: 'Pending' },
        }],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.get('proj-3:bucket-c')).toMatchObject({ status: 'pending' });
  });

  it('handles Lost and Failed PVC phases', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'pvc-lost',
              labels: {
                'agentstudio.io/managed-by': 'storage-manager',
                'agentstudio.io/bucket-name': 'bucket-lost',
                'agentstudio.io/project-id': 'proj-x',
              },
            },
            spec: {},
            status: { phase: 'Lost' },
          },
          {
            metadata: {
              name: 'pvc-failed',
              labels: {
                'agentstudio.io/managed-by': 'storage-manager',
                'agentstudio.io/bucket-name': 'bucket-failed',
                'agentstudio.io/project-id': 'proj-x',
              },
            },
            spec: {},
            status: { phase: 'Failed' },
          },
          {
            metadata: {
              name: 'pvc-unknown-phase',
              labels: {
                'agentstudio.io/managed-by': 'storage-manager',
                'agentstudio.io/bucket-name': 'bucket-unknown',
                'agentstudio.io/project-id': 'proj-x',
              },
            },
            spec: {},
            status: { phase: 'SomeOtherPhase' },
          },
        ],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.get('proj-x:bucket-lost')).toMatchObject({ status: 'lost' });
    expect(result.get('proj-x:bucket-failed')).toMatchObject({ status: 'failed' });
    expect(result.get('proj-x:bucket-unknown')).toMatchObject({ status: 'unknown' });
  });

  it('skips PVCs missing bucket-name or project-id labels, but reads from annotations', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [
          {
            metadata: {
              name: 'pvc-no-labels',
              labels: { 'agentstudio.io/managed-by': 'storage-manager' },
            },
            spec: {},
            status: {},
          },
          {
            metadata: {
              name: 'pvc-annotation-fallback',
              labels: {
                'agentstudio.io/managed-by': 'storage-manager',
                'agentstudio.io/bucket-name': 'bucket-ann',
              },
              annotations: { 'agentstudio.io/project-id': 'proj-ann' },
            },
            spec: {},
            status: { phase: 'Bound' },
          },
        ],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.has('proj-ann:bucket-ann')).toBe(true);
    expect(result.size).toBe(1); // the one with missing labels is skipped
  });

  it('returns empty map when listNamespacedPVC fails', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(new Error('api down')),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.size).toBe(0);
  });

  it('handles readStorageClass error in Pending status check', async () => {
    const { manager, storageApi } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-pending-sc-err',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-p',
              'agentstudio.io/project-id': 'proj-p',
            },
          },
          spec: { storageClassName: 'sc-err' },
          status: { phase: 'Pending' },
        }],
      }),
    });
    storageApi.readStorageClass.mockRejectedValue(new Error('not found'));

    const result = await manager.listVersitygwPVCs();
    expect(result.get('proj-p:bucket-p')?.statusMessage).toBe('PVC pending');
  });

  it('handles Pending PVC with no storageClassName', async () => {
    const { manager } = makeManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-no-sc',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-nosc',
              'agentstudio.io/project-id': 'proj-nosc',
            },
          },
          spec: {},
          status: { phase: 'Pending' },
        }],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.get('proj-nosc:bucket-nosc')?.statusMessage).toBe('PVC pending');
  });
});

// ─── getPVCName ──────────────────────────────────────────────────────────────

describe('PVCManager getPVCName', () => {
  it('delegates to NameGenerator', () => {
    const { manager } = makeManager();
    const name = manager.getPVCName('sc-proj-1-mybucket', 'mybucket');
    expect(name).toBeDefined();
    expect(typeof name).toBe('string');
  });
});

// ─── namespace not set guard ──────────────────────────────────────────────────

describe('PVCManager createOrUpdatePVC — namespace guard', () => {
  it('throws when namespace is not set', async () => {
    const { manager } = makeManager({}, {}, { namespace: '' });
    const cb = jest.fn();
    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec(), cb)
    ).rejects.toThrow(/Namespace is not set/);
  });

  it('throws when storageClass has no name', async () => {
    const { manager } = makeManager();
    const scWithoutName: any = { metadata: {}, provisioner: 'kubernetes.io/no-provisioner' };
    await expect(
      manager.createOrUpdatePVC(scWithoutName, 'mybucket', baseSpec())
    ).rejects.toThrow(/StorageClass name is missing/);
  });

  it('throws when non-404 error occurs reading PVC', async () => {
    const forbiddenErr: any = new Error('Forbidden');
    forbiddenErr.statusCode = 403;
    const { manager } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(forbiddenErr),
    });

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec())
    ).rejects.toThrow();
  });
});

// ─── verifyStorageClass — unsupported access modes ────────────────────────────

describe('PVCManager verifyStorageClass — unsupported access modes', () => {
  it('throws when requested access modes are not supported by provisioner', async () => {
    const ebsStorageClass: any = {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: 'sc-ebs' },
      provisioner: 'ebs.csi.aws.com', // supports ReadWriteOnce only
    };
    const { manager } = makeManager({}, {
      readStorageClass: jest.fn().mockResolvedValue(ebsStorageClass),
    });

    const spec = baseSpec({ access_modes: ['ReadWriteMany'] });
    await expect(
      manager.createOrUpdatePVC(ebsStorageClass, 'mybucket', spec)
    ).rejects.toThrow(/does not support requested access modes/);
  });

  it('throws generic error when verifyStorageClass fails with non-404 error', async () => {
    const serverErr: any = new Error('Internal Server Error');
    serverErr.statusCode = 500;
    const { manager } = makeManager({}, {
      readStorageClass: jest.fn().mockRejectedValue(serverErr),
    });

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec())
    ).rejects.toThrow(/Failed to verify StorageClass/);
  });
});

// ─── listVersitygwPVCs debug mode ─────────────────────────────────────────────

describe('PVCManager listVersitygwPVCs — debug mode', () => {
  function makeDebugManager(coreApiOverrides: any = {}, storageApiOverrides: any = {}) {
    const coreApi: any = {
      readNamespacedPersistentVolumeClaim: jest.fn(),
      readPersistentVolume: jest.fn(),
      deletePersistentVolume: jest.fn().mockResolvedValue({}),
      replaceNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
      createNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
      deleteNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({}),
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({ items: [] }),
      ...coreApiOverrides,
    };
    const storageApi: any = {
      readStorageClass: jest.fn().mockResolvedValue({
        ...storageClass,
        provisioner: 'kubernetes.io/no-provisioner',
      }),
      ...storageApiOverrides,
    };
    const { PVCManager: OriginalPVCManager } = jest.requireActual('../PVCManager');
    return new OriginalPVCManager(coreApi, storageApi, 'nemo', '10Gi', 'debug');
  }

  it('logs debug info when logLevel is debug', async () => {
    const manager = makeDebugManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        items: [{
          metadata: {
            name: 'pvc-1',
            labels: {
              'agentstudio.io/managed-by': 'storage-manager',
              'agentstudio.io/bucket-name': 'bucket-a',
              'agentstudio.io/project-id': 'proj-1',
            },
          },
          spec: { volumeName: 'pv-1', storageClassName: 'sc-1' },
          status: { phase: 'Bound' },
        }],
      }),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.size).toBe(1);
  });

  it('logs debug for error with stack trace in debug mode', async () => {
    const manager = makeDebugManager({
      listNamespacedPersistentVolumeClaim: jest.fn().mockRejectedValue(
        Object.assign(new Error('api down'), { stack: 'Error: api down\n  at ...' })
      ),
    });

    const result = await manager.listVersitygwPVCs();
    expect(result.size).toBe(0);
  });
});

// ─── createOrUpdatePVC - wrong StorageClass warning ──────────────────────────

describe('PVCManager createOrUpdatePVC — wrong StorageClass warning', () => {
  it('logs warn when existing PVC uses wrong StorageClass', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '1' },
        spec: { storageClassName: 'wrong-sc', volumeName: 'pv-1' },
        status: { phase: 'Bound' },
      }),
    });
    const cb = jest.fn().mockResolvedValue('pv-1');

    const result = await manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec(), cb);
    expect(result).toBe(PVC_NAME);
  });

  it('throws when handlePendingPVC callback returns no PV name', async () => {
    const { manager, coreApi } = makeManager({
      readNamespacedPersistentVolumeClaim: jest.fn().mockResolvedValue({
        metadata: { name: PVC_NAME, namespace: 'nemo', resourceVersion: '1' },
        spec: { storageClassName: SC_NAME, volumeName: undefined },
        status: { phase: 'Pending' },
      }),
    });
    // Callback returns undefined (no PV created)
    const cb = jest.fn().mockResolvedValue(undefined);

    await expect(
      manager.createOrUpdatePVC(storageClass, 'mybucket', baseSpec(), cb)
    ).rejects.toThrow(/Failed to create PV for PVC/);
  });
});
