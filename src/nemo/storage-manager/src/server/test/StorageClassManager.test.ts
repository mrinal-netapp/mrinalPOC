import { StorageClassManager } from '../StorageClassManager';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

// Mock all manager modules before they're imported
const mockSecretManager = {
  createOrUpdateSecret: jest.fn().mockResolvedValue('secret-name'),
  deleteSecret: jest.fn().mockResolvedValue(undefined),
};
const mockStorageClassRM = {
  createOrUpdateStorageClass: jest.fn().mockResolvedValue({ metadata: { name: 'test-sc' } }),
  validateStorageClass: jest.fn().mockResolvedValue({ metadata: { name: 'existing-sc' } }),
  deleteStorageClass: jest.fn().mockResolvedValue(undefined),
  listStorageClasses: jest.fn().mockResolvedValue([]),
  getStorageClassName: jest.fn().mockReturnValue('sc-proj-1-bucket'),
};
const mockPVManager = {
  createPVOnDemandWithSecret: jest.fn().mockResolvedValue('pv-1'),
  listPVsForStorageClass: jest.fn().mockResolvedValue([]),
  findAvailablePV: jest.fn().mockResolvedValue(null),
  deleteUnboundPVs: jest.fn().mockResolvedValue(0),
  unbindPV: jest.fn().mockResolvedValue(undefined),
  deletePV: jest.fn().mockResolvedValue(undefined),
};
const mockPVCManager = {
  createOrUpdatePVC: jest.fn().mockResolvedValue('pvc-1'),
  deletePVC: jest.fn().mockResolvedValue('pv-1'),
  getPVCName: jest.fn().mockReturnValue('pvc-proj-1-bucket'),
  listVersitygwPVCs: jest.fn().mockResolvedValue(new Map()),
};
const mockDeploymentManager = {
  updateDeploymentWithPVC: jest.fn().mockResolvedValue(undefined),
  removePVCFromDeployment: jest.fn().mockResolvedValue(undefined),
  reconcileDeployment: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../storage/managers/SecretManager', () => ({
  SecretManager: jest.fn().mockImplementation(() => mockSecretManager),
}));
jest.mock('../storage/managers/StorageClassResourceManager', () => ({
  StorageClassResourceManager: jest.fn().mockImplementation(() => mockStorageClassRM),
}));
jest.mock('../storage/managers/PVManager', () => ({
  PVManager: jest.fn().mockImplementation(() => mockPVManager),
}));
jest.mock('../storage/managers/PVCManager', () => ({
  PVCManager: jest.fn().mockImplementation(() => mockPVCManager),
}));
jest.mock('../storage/managers/DeploymentManager', () => ({
  DeploymentManager: jest.fn().mockImplementation(() => mockDeploymentManager),
}));

const mockMakeApiClient = jest.fn().mockReturnValue({});
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(),
    loadFromDefault: jest.fn(),
    loadFromFile: jest.fn(),
    makeApiClient: mockMakeApiClient,
    getCurrentContext: jest.fn().mockReturnValue('ctx'),
    getContextObject: jest.fn().mockReturnValue({ namespace: 'test-ns' }),
  })),
  StorageV1Api: class {},
  CoreV1Api: class {},
  AppsV1Api: class {},
  CustomObjectsApi: class {},
}));

jest.mock('../storage/factories/KubernetesClientFactory', () => ({
  KubernetesClientFactory: {
    createClients: jest.fn().mockReturnValue({
      storageApi: { listStorageClass: jest.fn().mockResolvedValue({ items: [] }) },
      coreApi: {},
      appsApi: {},
      customObjectsApi: {},
      namespace: 'test-ns',
    }),
  },
}));

describe('StorageClassManager', () => {
  let mgr: StorageClassManager;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-configure return values after clearAllMocks
    mockSecretManager.createOrUpdateSecret.mockResolvedValue('secret-name');
    mockStorageClassRM.createOrUpdateStorageClass.mockResolvedValue({ metadata: { name: 'test-sc' } });
    mockStorageClassRM.validateStorageClass.mockResolvedValue({ metadata: { name: 'existing-sc' } });
    mockStorageClassRM.listStorageClasses.mockResolvedValue([]);
    mockStorageClassRM.getStorageClassName.mockReturnValue('sc-proj-1-bucket');
    mockPVManager.listPVsForStorageClass.mockResolvedValue([]);
    mockPVManager.findAvailablePV.mockResolvedValue(null);
    mockPVManager.createPVOnDemandWithSecret.mockResolvedValue('pv-1');
    mockPVCManager.createOrUpdatePVC.mockResolvedValue('pvc-1');
    mockPVCManager.getPVCName.mockReturnValue('pvc-proj-1-bucket');
    mockDeploymentManager.updateDeploymentWithPVC.mockResolvedValue(undefined);
    mockDeploymentManager.reconcileDeployment.mockResolvedValue(undefined);

    const { KubernetesClientFactory } = require('../storage/factories/KubernetesClientFactory');
    KubernetesClientFactory.createClients.mockReturnValue({
      storageApi: { listStorageClass: jest.fn().mockResolvedValue({ items: [] }) },
      coreApi: {},
      appsApi: {},
      customObjectsApi: {},
      namespace: 'test-ns',
    });

    mgr = new StorageClassManager({});
  });

  describe('constructor', () => {
    it('creates StorageClassManager successfully', () => {
      expect(mgr).toBeDefined();
    });

    it('uses logLevel from config', () => {
      const mgrWithLog = new StorageClassManager({ logLevel: 'debug' });
      expect(mgrWithLog).toBeDefined();
    });
  });

  describe('createOrUpdateStorageClass', () => {
    const baseSpec = {
      project_id: 'proj-1',
      bucket_name: 'bucket',
      volume_info: { type: 'hostpath', endpoint: 'http://endpoint' },
      auth_info: { type: 'none' },
      protocol: 's3',
      role: 'primary' as const,
    };

    it('delegates to static provisioning strategy for static mode', async () => {
      const spec = { ...baseSpec, provisioning_mode: 'static' as const };

      const result = await mgr.createOrUpdateStorageClass(spec);

      expect(mockStorageClassRM.createOrUpdateStorageClass).toHaveBeenCalled();
      expect(result).toEqual({ metadata: { name: 'test-sc' } });
    });

    it('delegates to dynamic provisioning strategy for dynamic mode', async () => {
      const spec = {
        ...baseSpec,
        provisioning_mode: 'dynamic' as const,
        storage_class_name: 'existing-sc',
      };

      const result = await mgr.createOrUpdateStorageClass(spec);

      expect(mockStorageClassRM.validateStorageClass).toHaveBeenCalledWith('existing-sc');
      expect(result).toEqual({ metadata: { name: 'existing-sc' } });
    });
  });

  describe('createPVOnDemand', () => {
    it('calls secretManager and pvManager', async () => {
      const spec = {
        project_id: 'proj-1',
        bucket_name: 'bucket',
        volume_info: { type: 'smb', endpoint: 'http://endpoint' },
        auth_info: { type: 'none' },
        protocol: 's3',
        role: 'primary' as const,
      } as any;

      const pvName = await mgr.createPVOnDemand({ metadata: { name: 'sc-1' } } as any, spec, 'pvc-1');

      expect(mockSecretManager.createOrUpdateSecret).toHaveBeenCalled();
      expect(mockPVManager.createPVOnDemandWithSecret).toHaveBeenCalled();
      expect(pvName).toBe('pv-1');
    });
  });

  describe('ensurePVPool', () => {
    it('is a no-op and completes without error', async () => {
      const spec = {
        project_id: 'proj-1',
        bucket_name: 'bucket',
        volume_info: { type: 'hostpath' },
        auth_info: { type: 'none' },
        protocol: 's3',
        role: 'primary' as const,
      } as any;
      await expect(mgr.ensurePVPool({} as any, spec)).resolves.not.toThrow();
    });
  });

  describe('listPVsForStorageClass', () => {
    it('delegates to pvManager', async () => {
      mockPVManager.listPVsForStorageClass.mockResolvedValue([{ metadata: { name: 'pv-1' } }]);

      const pvs = await mgr.listPVsForStorageClass('sc-1');

      expect(mockPVManager.listPVsForStorageClass).toHaveBeenCalledWith('sc-1');
      expect(pvs).toHaveLength(1);
    });
  });

  describe('findAvailablePV', () => {
    it('delegates to pvManager', async () => {
      mockPVManager.findAvailablePV.mockResolvedValue({ metadata: { name: 'pv-available' } });

      const pv = await mgr.findAvailablePV('sc-1');

      expect(pv).toEqual({ metadata: { name: 'pv-available' } });
    });
  });

  describe('deleteStorageClass', () => {
    it('executes deletion chain', async () => {
      mockDeploymentManager.removePVCFromDeployment.mockResolvedValue(undefined);

      await mgr.deleteStorageClass('proj-1', 'bucket');

      expect(mockStorageClassRM.getStorageClassName).toHaveBeenCalledWith('proj-1', 'bucket');
      expect(mockPVCManager.getPVCName).toHaveBeenCalled();
    });
  });

  describe('createOrUpdatePVC', () => {
    it('creates PVC and updates deployment for static provisioning', async () => {
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
      const storageClass = {
        metadata: { name: 'sc-test' },
        provisioner: 'kubernetes.io/no-provisioner',
      } as any;
      const spec = {
        project_id: 'proj-1', bucket_name: 'bucket',
        volume_info: { type: 'hostpath' }, auth_info: { type: 'none' },
        protocol: 's3', role: 'primary' as const, provisioning_mode: 'static' as const,
      } as any;

      const pvcName = await mgr.createOrUpdatePVC(storageClass, 'bucket', spec);

      expect(mockPVCManager.createOrUpdatePVC).toHaveBeenCalled();
      expect(mockDeploymentManager.updateDeploymentWithPVC).toHaveBeenCalledWith('pvc-1');
      expect(pvcName).toBe('pvc-1');
    });

    it('creates PVC without updating deployment when USE_VOLUME_MOUNT_SET_CR is set', async () => {
      process.env.USE_VOLUME_MOUNT_SET_CR = 'true';
      const storageClass = {
        metadata: { name: 'sc-test' },
        provisioner: 'kubernetes.io/no-provisioner',
      } as any;

      await mgr.createOrUpdatePVC(storageClass, 'bucket');

      expect(mockDeploymentManager.updateDeploymentWithPVC).not.toHaveBeenCalled();
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
    });

    it('skips PV creation callback for dynamic provisioning', async () => {
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
      const storageClass = {
        metadata: { name: 'sc-dynamic' },
        provisioner: 'driver.csi.k8s.io',
      } as any;
      const spec = {
        project_id: 'proj-1', bucket_name: 'bucket',
        volume_info: { type: 'hostpath' }, auth_info: { type: 'none' },
        protocol: 's3', role: 'primary' as const, provisioning_mode: 'dynamic' as const,
      } as any;

      await mgr.createOrUpdatePVC(storageClass, 'bucket', spec);

      expect(mockPVCManager.createOrUpdatePVC).toHaveBeenCalled();
      // Verify the createPVCallback is undefined for dynamic provisioning
      const callArgs = mockPVCManager.createOrUpdatePVC.mock.calls[0];
      expect(callArgs[3]).toBeUndefined();
    });

    it('invokes createPV callback (covers arrow function body at line 291)', async () => {
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
      const storageClass = {
        metadata: { name: 'sc-static-cb' },
        provisioner: 'kubernetes.io/no-provisioner',
      } as any;
      const spec = {
        project_id: 'proj-1', bucket_name: 'bucket',
        volume_info: { type: 'nfs', endpoint: 'server:/path' }, auth_info: { type: 'none' },
        protocol: 's3', role: 'primary' as const, provisioning_mode: 'static' as const,
      } as any;

      // Make createOrUpdatePVC actually invoke the callback so line 291 is covered
      mockPVCManager.createOrUpdatePVC.mockImplementationOnce(
        async (sc: any, bucketName: string, specArg: any, callback: any) => {
          if (callback) await callback(sc, specArg, 'pvc-cb-test', undefined);
          return 'pvc-cb-test';
        }
      );
      mockPVManager.createPVOnDemandWithSecret.mockResolvedValue('pv-cb');

      const pvcName = await mgr.createOrUpdatePVC(storageClass, 'bucket', spec);
      expect(pvcName).toBe('pvc-cb-test');
    });
  });

  describe('listStorageClasses', () => {
    it('delegates to storageClassResourceManager', async () => {
      mockStorageClassRM.listStorageClasses.mockResolvedValue([
        { metadata: { name: 'sc-1' } },
      ]);

      const scs = await mgr.listStorageClasses();

      expect(scs).toHaveLength(1);
    });
  });

  describe('listAllAvailableStorageClasses', () => {
    it('returns filtered dynamic provisioner storage class names', async () => {
      const { KubernetesClientFactory } = require('../storage/factories/KubernetesClientFactory');
      const mockStorageApi = {
        listStorageClass: jest.fn().mockResolvedValue({
          items: [
            { metadata: { name: 'sc-dynamic' }, provisioner: 'driver.csi.k8s.io' },
            { metadata: { name: 'sc-static' }, provisioner: 'kubernetes.io/no-provisioner' },
            { metadata: { name: 'sc-noprovisioner' }, provisioner: '' },
          ],
        }),
      };
      KubernetesClientFactory.createClients.mockReturnValue({
        storageApi: mockStorageApi,
        coreApi: {},
        appsApi: {},
        customObjectsApi: {},
        namespace: 'test-ns',
      });
      const mgrWithMockApi = new StorageClassManager({});

      const names = await mgrWithMockApi.listAllAvailableStorageClasses();

      expect(names).toContain('sc-dynamic');
      expect(names).not.toContain('sc-static');
      expect(names).not.toContain('sc-noprovisioner');
    });

    it('returns empty array on error', async () => {
      const { KubernetesClientFactory } = require('../storage/factories/KubernetesClientFactory');
      const mockStorageApi = {
        listStorageClass: jest.fn().mockRejectedValue(new Error('forbidden')),
      };
      KubernetesClientFactory.createClients.mockReturnValue({
        storageApi: mockStorageApi,
        coreApi: {},
        appsApi: {},
        customObjectsApi: {},
        namespace: 'test-ns',
      });
      const mgrWithMockApi = new StorageClassManager({});

      const names = await mgrWithMockApi.listAllAvailableStorageClasses();

      expect(names).toEqual([]);
    });

    it('logs debug when logLevel is debug (covers debug log branch)', async () => {
      const { KubernetesClientFactory } = require('../storage/factories/KubernetesClientFactory');
      const mockStorageApi = {
        listStorageClass: jest.fn().mockResolvedValue({
          items: [
            { metadata: { name: 'sc-dynamic' }, provisioner: 'driver.csi.k8s.io' },
          ],
        }),
      };
      KubernetesClientFactory.createClients.mockReturnValue({
        storageApi: mockStorageApi,
        coreApi: {},
        appsApi: {},
        customObjectsApi: {},
        namespace: 'test-ns',
      });
      const debugMgr = new StorageClassManager({ logLevel: 'debug' });

      const names = await debugMgr.listAllAvailableStorageClasses();
      expect(names).toContain('sc-dynamic');
    });
  });

  describe('reconcileDeployment', () => {
    it('delegates to deploymentManager', async () => {
      const validPVCs = new Set(['pvc-1']);
      await mgr.reconcileDeployment(validPVCs);

      expect(mockDeploymentManager.reconcileDeployment).toHaveBeenCalledWith(validPVCs, undefined);
    });

    it('passes newlyCreatedPVCNames to deploymentManager', async () => {
      const validPVCs = new Set(['pvc-1']);
      const newPVCs = new Set(['pvc-new']);
      await mgr.reconcileDeployment(validPVCs, newPVCs);

      expect(mockDeploymentManager.reconcileDeployment).toHaveBeenCalledWith(validPVCs, newPVCs);
    });
  });

  describe('listVersitygwPVCs', () => {
    it('delegates to pvcManager', async () => {
      const fakeMap = new Map([['proj:bucket', { pvc: {}, status: 'bound', statusMessage: 'ok' }]]);
      mockPVCManager.listVersitygwPVCs = jest.fn().mockResolvedValue(fakeMap);

      const result = await mgr.listVersitygwPVCs();
      expect(result).toBe(fakeMap);
      expect(mockPVCManager.listVersitygwPVCs).toHaveBeenCalled();
    });
  });

  describe('getValidPVCNames', () => {
    it('returns valid PVC names for static provisioning buckets', () => {
      const registry = new Map([
        ['proj-1:bucket-a', { project_id: 'proj-1', bucket_name: 'bucket-a' }],
        ['proj-1:bucket-b', { project_id: 'proj-1', bucket_name: 'bucket-b' }],
      ]);
      const result = mgr.getValidPVCNames(registry);
      expect(result.size).toBe(2);
    });

    it('handles dynamic provisioning buckets with storage_class_name', () => {
      const registry = new Map([
        ['proj-1:dyn-bucket', {
          project_id: 'proj-1',
          bucket_name: 'dyn-bucket',
          volume_info: { provisioning_mode: 'dynamic' as const, storage_class_name: 'my-sc' },
        }],
      ]);
      const result = mgr.getValidPVCNames(registry);
      expect(result.size).toBe(1);
    });

    it('skips dynamic buckets missing storage_class_name', () => {
      const registry = new Map([
        ['proj-1:dyn-no-sc', {
          project_id: 'proj-1',
          bucket_name: 'dyn-no-sc',
          volume_info: { provisioning_mode: 'dynamic' as const },
        }],
      ]);
      const result = mgr.getValidPVCNames(registry);
      expect(result.size).toBe(0);
    });
  });

  describe('reconcileOrphanedPVCs', () => {
    beforeEach(() => {
      mockPVCManager.listVersitygwPVCs = jest.fn();
    });

    it('deletes orphaned PVCs not in registry', async () => {
      const fakePVCMap = new Map([
        ['proj-x:orphaned-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-orphan',
              labels: { 'agentstudio.io/bucket-name': 'orphaned-bucket', 'agentstudio.io/project-id': 'proj-x' },
            },
            spec: { storageClassName: 'sc-static' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      // storageApi is on mgr - access via internal property
      const storageApi = (mgr as any).storageApi;
      storageApi.readStorageClass = jest.fn().mockResolvedValue({
        provisioner: 'kubernetes.io/no-provisioner',
      });

      const registry = new Map<string, any>(); // empty - all PVCs are orphaned
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(1);
    });

    it('skips helm-managed orphaned PVCs', async () => {
      const fakePVCMap = new Map([
        ['proj-x:helm-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-helm',
              labels: {
                'agentstudio.io/managed-by': 'helm',
                'agentstudio.io/bucket-name': 'helm-bucket',
                'agentstudio.io/project-id': 'proj-x',
              },
            },
            spec: {},
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(0);
    });

    it('does not delete PVCs present in registry', async () => {
      const fakePVCMap = new Map([
        ['proj-1:known-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-known',
              labels: { 'agentstudio.io/bucket-name': 'known-bucket', 'agentstudio.io/project-id': 'proj-1' },
            },
            spec: {},
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);

      const registry = new Map([['proj-1:known-bucket', { project_id: 'proj-1', bucket_name: 'known-bucket' }]]);
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(0);
    });

    it('handles deleteStorageClass failure gracefully', async () => {
      const fakePVCMap = new Map([
        ['proj-err:fail-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-err',
              labels: { 'agentstudio.io/bucket-name': 'fail-bucket', 'agentstudio.io/project-id': 'proj-err' },
            },
            spec: { storageClassName: 'sc-err' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      // deleteStorageClass throws
      const deleteSpy = jest.spyOn(mgr as any, 'deleteStorageClass').mockRejectedValue(new Error('delete failed'));

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(0); // failed - not counted
      deleteSpy.mockRestore();
    });

    it('returns 0 and does not throw when listVersitygwPVCs fails', async () => {
      mockPVCManager.listVersitygwPVCs.mockRejectedValue(new Error('list failed'));

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(0);
    });

    it('handles isDynamicStorageClass error gracefully', async () => {
      const fakePVCMap = new Map([
        ['proj-d:dyn-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-dyn',
              labels: { 'agentstudio.io/bucket-name': 'dyn-bucket', 'agentstudio.io/project-id': 'proj-d' },
            },
            spec: { storageClassName: 'sc-dyn' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      const storageApi = (mgr as any).storageApi;
      storageApi.readStorageClass = jest.fn().mockRejectedValue(new Error('api error'));

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(1); // still deletes even if isDynamic check fails
    });

    it('correctly sorts dynamic orphans before static ones', async () => {
      // Insert dynamic first so comparator is called with (dynamic, static) -> covers line 513 TRUE branch
      const fakePVCMap = new Map([
        ['proj-d:dynamic-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-dynamic',
              labels: { 'agentstudio.io/bucket-name': 'dynamic-bucket', 'agentstudio.io/project-id': 'proj-d' },
            },
            spec: { storageClassName: 'sc-dynamic' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
        ['proj-s:static-bucket', {
          pvc: {
            metadata: {
              name: 'pvc-static',
              labels: { 'agentstudio.io/bucket-name': 'static-bucket', 'agentstudio.io/project-id': 'proj-s' },
            },
            spec: { storageClassName: 'sc-static' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      const storageApi = (mgr as any).storageApi;
      storageApi.readStorageClass = jest.fn()
        .mockImplementation(({ name }: { name: string }) => {
          if (name === 'sc-dynamic') return Promise.resolve({ provisioner: 'csi.dynamic.io' });
          return Promise.resolve({ provisioner: 'kubernetes.io/no-provisioner' });
        });

      const deleteOrder: string[] = [];
      jest.spyOn(mgr as any, 'deleteStorageClass').mockImplementation(
        async (...args: unknown[]) => {
          deleteOrder.push(args[1] as string);
        }
      );

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(2);
      // dynamic bucket should be processed first
      expect(deleteOrder[0]).toBe('dynamic-bucket');
    });

    it('covers sort return 0 branch when both orphans are same type (both static)', async () => {
      const fakePVCMap = new Map([
        ['proj-s1:static-bucket1', {
          pvc: {
            metadata: {
              name: 'pvc-static-1',
              labels: { 'agentstudio.io/bucket-name': 'static-bucket1', 'agentstudio.io/project-id': 'proj-s1' },
            },
            spec: { storageClassName: 'sc-static' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
        ['proj-s2:static-bucket2', {
          pvc: {
            metadata: {
              name: 'pvc-static-2',
              labels: { 'agentstudio.io/bucket-name': 'static-bucket2', 'agentstudio.io/project-id': 'proj-s2' },
            },
            spec: { storageClassName: 'sc-static' },
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      const storageApi = (mgr as any).storageApi;
      storageApi.readStorageClass = jest.fn().mockResolvedValue({
        provisioner: 'kubernetes.io/no-provisioner',
      });
      // Spy to avoid 2s delay per PVC in PVCCleanupOperator
      jest.spyOn(mgr as any, 'deleteStorageClass').mockResolvedValue(undefined);

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(2);
    });

    it('isDynamicStorageClass returns false when storageClassName is empty string', async () => {
      const fakePVCMap = new Map([
        ['proj-x:bucket-x', {
          pvc: {
            metadata: {
              name: 'pvc-x',
              labels: { 'agentstudio.io/bucket-name': 'bucket-x', 'agentstudio.io/project-id': 'proj-x' },
            },
            spec: { storageClassName: '' }, // empty storageClassName triggers isDynamicStorageClass('' ) -> false
          },
          status: 'bound',
          statusMessage: 'bound',
        }],
      ]);
      mockPVCManager.listVersitygwPVCs.mockResolvedValue(fakePVCMap);
      // Spy to avoid 2s delay in PVCCleanupOperator
      jest.spyOn(mgr as any, 'deleteStorageClass').mockResolvedValue(undefined);

      const registry = new Map<string, any>();
      const count = await mgr.reconcileOrphanedPVCs(registry);
      expect(count).toBe(1);
    });

    it('isDynamicStorageClass private method returns false directly when storageClassName is empty', async () => {
      const result = await (mgr as any).isDynamicStorageClass('');
      expect(result).toBe(false);
    });
  });
});
