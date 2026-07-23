import { DeploymentManager } from '../DeploymentManager';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

function buildDeployment(opts: {
  name?: string;
  volumes?: any[];
  containers?: any[];
} = {}): any {
  return {
    metadata: { name: opts.name || 'test-deploy', labels: {} },
    spec: {
      selector: { matchLabels: {} },
      template: {
        metadata: {},
        spec: {
          volumes: opts.volumes ?? [],
          containers: opts.containers ?? [
            {
              name: 'main',
              image: 'test:latest',
              volumeMounts: [],
            },
          ],
        },
      },
    },
  };
}

function buildManager(appsApi: any, coreApi: any, logLevel = 'info') {
  return new DeploymentManager(appsApi, coreApi, 'test-ns', logLevel);
}

describe('DeploymentManager', () => {
  let mockAppsApi: any;
  let mockCoreApi: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAppsApi = {
      listNamespacedDeployment: jest.fn(),
      readNamespacedDeployment: jest.fn(),
      replaceNamespacedDeployment: jest.fn(),
    };
    mockCoreApi = {
      readNamespacedPersistentVolumeClaim: jest.fn(),
    };
  });

  describe('updateDeploymentWithPVC', () => {
    it('does nothing when no deployments found', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(new Error('not found'));

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-test');

      expect(mockCoreApi.readNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    });

    it('skips update when PVC read fails', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockRejectedValue(new Error('not found'));

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-test');

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('adds PVC to deployment volumes and mounts', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { labels: { 'agentstudio.io/bucket-name': 'my-bucket' } },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-my-bucket');

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
      const callArgs = mockAppsApi.replaceNamespacedDeployment.mock.calls[0][0];
      const volumes = callArgs.body.spec.template.spec.volumes;
      expect(volumes.some((v: any) => v.persistentVolumeClaim?.claimName === 'pvc-my-bucket')).toBe(true);
    });

    it('skips when PVC volume already exists in deployment', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-existing', persistentVolumeClaim: { claimName: 'pvc-existing' } }],
        containers: [
          {
            name: 'main',
            volumeMounts: [{ name: 'pvc-existing', mountPath: '/mnt/pvcs/bucket' }],
          },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { labels: { 'agentstudio.io/bucket-name': 'bucket' } },
      });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-existing');

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('handles replace error gracefully (logs warn and continues)', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { labels: {} },
      });
      mockAppsApi.replaceNamespacedDeployment.mockRejectedValue(
        Object.assign(new Error('conflict'), { statusCode: 409, body: { message: 'conflict', reason: 'Conflict' } })
      );

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await expect(mgr.updateDeploymentWithPVC('pvc-test')).resolves.not.toThrow();
    });

    it('finds deployment by name fallback when label selector returns empty', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockAppsApi.readNamespacedDeployment.mockResolvedValueOnce(deployment);
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { labels: {} },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-test');

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });

    it('replaces mount at conflicting mountPath', async () => {
      const mountPath = '/mnt/pvcs/bucket';
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [],
        containers: [
          {
            name: 'main',
            volumeMounts: [{ name: 'old-pvc', mountPath }],
          },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { labels: { 'agentstudio.io/bucket-name': 'bucket' } },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('new-pvc');

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });
  });

  describe('removePVCFromDeployment', () => {
    it('does nothing when no deployments found', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(new Error('not found'));

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.removePVCFromDeployment('pvc-test');

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('removes PVC from deployment volumes and mounts', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-test', persistentVolumeClaim: { claimName: 'pvc-test' } }],
        containers: [
          {
            name: 'main',
            volumeMounts: [{ name: 'pvc-test', mountPath: '/mnt/pvcs/test' }],
          },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.removePVCFromDeployment('pvc-test');

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
      const callArgs = mockAppsApi.replaceNamespacedDeployment.mock.calls[0][0];
      const volumes = callArgs.body.spec.template.spec.volumes;
      expect(volumes.some((v: any) => v.name === 'pvc-test')).toBe(false);
    });

    it('skips update when PVC is not in the deployment', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.removePVCFromDeployment('pvc-missing');

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('handles remove error gracefully', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-test', persistentVolumeClaim: { claimName: 'pvc-test' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-test', mountPath: '/mnt/pvcs/test' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockAppsApi.replaceNamespacedDeployment.mockRejectedValue(new Error('conflict'));

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await expect(mgr.removePVCFromDeployment('pvc-test')).resolves.not.toThrow();
    });
  });

  describe('reconcileDeployment', () => {
    it('does nothing when no deployments found', async () => {
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [] });
      mockAppsApi.readNamespacedDeployment.mockRejectedValue(new Error('not found'));

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-valid']));

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('removes orphaned PVC volumes from deployment', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-orphan', persistentVolumeClaim: { claimName: 'pvc-orphan' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-orphan', mountPath: '/mnt/pvcs/orphan' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-orphan',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-valid']));

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });

    it('keeps valid PVC volumes', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-valid', persistentVolumeClaim: { claimName: 'pvc-valid' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-valid', mountPath: '/mnt/pvcs/valid' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-valid',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-valid']));

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('skips newly created PVCs', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-new', persistentVolumeClaim: { claimName: 'pvc-new' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-new', mountPath: '/mnt/pvcs/new' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-new',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-valid']), new Set(['pvc-new']));

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('keeps non-storage-manager PVC volumes', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-helm', persistentVolumeClaim: { claimName: 'pvc-helm' } }],
        containers: [],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: { name: 'pvc-helm', labels: { 'agentstudio.io/managed-by': 'helm' } },
      });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set());

      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('treats 404 PVC read error as orphaned (removes from volumes)', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-missing', persistentVolumeClaim: { claimName: 'pvc-missing' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-missing', mountPath: '/mnt/pvcs/missing' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      const err = Object.assign(new Error('not found'), { statusCode: 404 });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockRejectedValue(err);
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set());

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });

    it('keeps volumes when PVC read has non-404 error', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-err', persistentVolumeClaim: { claimName: 'pvc-err' } }],
        containers: [],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      const err = Object.assign(new Error('server error'), { statusCode: 500 });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockRejectedValue(err);

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set());

      // Non-404 keeps volume, no replace should happen
      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('logs debug info when logLevel is debug', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-orphan', persistentVolumeClaim: { claimName: 'pvc-orphan' } }],
        containers: [
          { name: 'main', volumeMounts: [{ name: 'pvc-orphan', mountPath: '/mnt/pvcs/orphan' }] },
        ],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-orphan',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi, 'debug');
      await mgr.reconcileDeployment(new Set(['pvc-valid']));

      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });

    it('logs debug "no orphans" when all PVCs are valid and logLevel is debug', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-valid', persistentVolumeClaim: { claimName: 'pvc-valid' } }],
        containers: [{ name: 'main', volumeMounts: [{ name: 'pvc-valid', mountPath: '/mnt/pvcs/valid' }] }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-valid',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });

      const mgr = buildManager(mockAppsApi, mockCoreApi, 'debug');
      await mgr.reconcileDeployment(new Set(['pvc-valid']));
      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('removes storage-manager PVC not in validSet (covers managedBy check path)', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-sm', persistentVolumeClaim: { claimName: 'pvc-sm' } }],
        containers: [{ name: 'main', volumeMounts: [{ name: 'pvc-sm', mountPath: '/mnt/pvcs/sm' }] }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-sm',
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-other'])); // pvc-sm not in validSet
      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });

    it('keeps non-PVC volumes (e.g. configmap, emptyDir)', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [
          { name: 'configmap-vol', configMap: { name: 'my-config' } },
          { name: 'empty-vol', emptyDir: {} },
        ],
        containers: [{ name: 'main', volumeMounts: [] }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set());
      expect(mockAppsApi.replaceNamespacedDeployment).not.toHaveBeenCalled();
    });

    it('handles PVC name mismatch warning (actualPVCName !== pvcName)', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-claimed', persistentVolumeClaim: { claimName: 'pvc-claimed' } }],
        containers: [{ name: 'main', volumeMounts: [{ name: 'pvc-claimed', mountPath: '/mnt' }] }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-actual-name', // Different from 'pvc-claimed'
          labels: { 'agentstudio.io/managed-by': 'storage-manager' },
        },
      });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.reconcileDeployment(new Set(['pvc-valid']));
      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });
  });

  describe('updateDeploymentWithPVC - mount already exists by name', () => {
    it('skips adding volume mount when container already has mountName === pvcName', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [],
        containers: [{
          name: 'main',
          image: 'test:latest',
          volumeMounts: [{ name: 'pvc-existing', mountPath: '/mnt/existing' }],
        }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockAppsApi.replaceNamespacedDeployment.mockResolvedValue({});
      mockCoreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
        metadata: {
          name: 'pvc-existing',
          labels: { 'agentstudio.io/bucket-name': 'existing' },
        },
      });

      const mgr = buildManager(mockAppsApi, mockCoreApi);
      await mgr.updateDeploymentWithPVC('pvc-existing');

      // Volume is added but container already has the mount - should use container as-is
      expect(mockAppsApi.replaceNamespacedDeployment).toHaveBeenCalled();
    });
  });

  describe('updateDeploymentWithPVC - debug and edge cases', () => {
    it('logs debug info when logLevel is debug', async () => {
      const deployment = buildDeployment({ name: 's3gateway' });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockAppsApi.replaceNamespacedDeployment.mockRejectedValue(
        Object.assign(new Error('failed'), {
          statusCode: 500,
          body: { message: 'server error', reason: 'InternalError' },
          response: { body: { message: 'response error' } },
        })
      );

      const mgr = buildManager(mockAppsApi, mockCoreApi, 'debug');
      await mgr.updateDeploymentWithPVC('pvc-debug');
      // Should not throw, just log
    });

    it('logs debug info for removePVCFromDeployment when logLevel is debug', async () => {
      const deployment = buildDeployment({
        name: 's3gateway',
        volumes: [{ name: 'pvc-1', persistentVolumeClaim: { claimName: 'pvc-1' } }],
        containers: [{ name: 'main', volumeMounts: [{ name: 'pvc-1', mountPath: '/mnt' }] }],
      });
      mockAppsApi.listNamespacedDeployment.mockResolvedValue({ items: [deployment] });
      mockAppsApi.replaceNamespacedDeployment.mockRejectedValue(
        Object.assign(new Error('failed'), {
          statusCode: 500,
          body: { message: 'server err', reason: 'Internal' },
        })
      );

      const mgr = buildManager(mockAppsApi, mockCoreApi, 'debug');
      await mgr.removePVCFromDeployment('pvc-1');
      // Should not throw
    });
  });
});
