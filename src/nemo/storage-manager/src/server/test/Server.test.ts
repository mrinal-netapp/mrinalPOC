import request from 'supertest';
import { Server } from '../Server';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

const mockStorageClasses: any[] = [];
const mockStorageClassManager = {
  listStorageClasses: jest.fn().mockResolvedValue(mockStorageClasses),
  createOrUpdateStorageClass: jest.fn().mockResolvedValue({}),
  createOrUpdatePVC: jest.fn().mockResolvedValue('pvc-1'),
  deleteStorageClass: jest.fn().mockResolvedValue(undefined),
  reconcileDeployment: jest.fn().mockResolvedValue(undefined),
  listAllAvailableStorageClasses: jest.fn().mockResolvedValue([]),
  listVersitygwPVCs: jest.fn().mockResolvedValue(new Map()),
  reconcileOrphanedPVCs: jest.fn().mockResolvedValue(0),
  getValidPVCNames: jest.fn().mockReturnValue(new Set<string>()),
};

const mockGetRoutingInfo = jest.fn();
const mockRoutingManager = {
  getRoutingInfo: mockGetRoutingInfo,
  updateKnownNamespaces: jest.fn().mockReturnValue(false),
  syncNamespaceRoutingInfo: jest.fn().mockResolvedValue(undefined),
  refreshCache: jest.fn().mockResolvedValue(undefined),
  getKnownNamespaces: jest.fn().mockReturnValue(new Set()),
};

const mockConfigSyncManager = {
  syncConfig: jest.fn().mockResolvedValue(null),
  getConfigVersion: jest.fn().mockReturnValue(0),
  getLastConfigSync: jest.fn().mockReturnValue(Math.floor(Date.now() / 1000)),
};

jest.mock('../StorageClassManager', () => ({
  StorageClassManager: jest.fn().mockImplementation(() => mockStorageClassManager),
}));

jest.mock('../services/HttpClient', () => ({
  HttpClient: jest.fn().mockImplementation(() => ({
    request: jest.fn(),
  })),
}));

jest.mock('../services/RoutingManager', () => ({
  RoutingManager: jest.fn().mockImplementation(() => mockRoutingManager),
}));

jest.mock('../services/ConfigSyncManager', () => ({
  ConfigSyncManager: jest.fn().mockImplementation(() => mockConfigSyncManager),
}));

jest.mock('../storage/factories/KubernetesClientFactory', () => ({
  KubernetesClientFactory: {
    createClients: jest.fn().mockReturnValue({
      storageApi: {},
      coreApi: {},
      appsApi: {},
      customObjectsApi: {},
      namespace: 'test-ns',
    }),
  },
}));

const mockVolumeMountSetClient = {
  getStatus: jest.fn().mockResolvedValue(null),
  createOrUpdate: jest.fn().mockResolvedValue({}),
};

jest.mock('../volumeMountSet/VolumeMountSetClient', () => ({
  VolumeMountSetClient: jest.fn().mockImplementation(() => mockVolumeMountSetClient),
}));

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(),
    loadFromDefault: jest.fn(),
    loadFromFile: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({}),
    getCurrentContext: jest.fn().mockReturnValue('ctx'),
    getContextObject: jest.fn().mockReturnValue({ namespace: 'test-ns' }),
  })),
  StorageV1Api: class {},
  CoreV1Api: class {},
  AppsV1Api: class {},
  CustomObjectsApi: class {},
}));

jest.mock('@agentstudio/common', () => {
  const express = require('express');
  class MockBaseServer {
    protected config: any;
    protected app: any;
    protected server: any = null;
    constructor(config: any) {
      this.config = config;
      this.app = express();
      this.app.use(express.json());
      this.setupMiddleware();
      this.setupRoutes();
    }
    setupMiddleware() {}
    setupRoutes() {}
    getApp() { return this.app; }
    async start() {}
    async shutdown() {
      if (this.server) {
        this.server.close();
        this.server = null;
      }
    }
    handleHealth(_req: any, res: any) { res.json({ status: 'ok' }); }
    handleReady(_req: any, res: any) { res.json({ status: 'ok' }); }
  }
  return {
    BaseServer: MockBaseServer,
    BaseServerConfig: {},
    createServiceAccountClientFromEnv: jest.fn().mockReturnValue(null),
    ServiceAccountClient: jest.fn(),
  };
});

function buildServerConfig() {
  return {
    port: 0,
    configService: 'http://config-svc',
    deploymentID: 'deploy-1',
    region: 'us-east-1',
    configSyncInterval: 30,
    logLevel: 'info',
  };
}

describe('Server', () => {
  let server: Server;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRoutingInfo.mockResolvedValue(null);
    mockConfigSyncManager.getLastConfigSync.mockReturnValue(Math.floor(Date.now() / 1000));
    mockConfigSyncManager.syncConfig.mockResolvedValue(null);
    server = new Server(buildServerConfig());
  });

  afterEach(async () => {
    await server.shutdown();
  });

  describe('GET /api/v1/health', () => {
    it('returns healthy status', async () => {
      const app = server.getApp();
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.healthy).toBe(true);
    });

    it('returns last_config_sync timestamp', async () => {
      const app = server.getApp();
      const res = await request(app).get('/api/v1/health');
      expect(res.body.last_config_sync).toBeDefined();
    });
  });

  describe('GET /api/v1/routing/info', () => {
    it('returns 400 when bucket_name is missing', async () => {
      const app = server.getApp();
      const res = await request(app).get('/api/v1/routing/info');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('bucket_name');
    });

    it('returns 404 when bucket not found', async () => {
      mockGetRoutingInfo.mockResolvedValue(null);
      const app = server.getApp();
      const res = await request(app).get('/api/v1/routing/info?bucket_name=unknown');
      expect(res.status).toBe(404);
    });

    it('returns routing info when bucket found', async () => {
      mockGetRoutingInfo.mockResolvedValue({
        is_local: true,
        redirect_url: '',
        serving_deployments: ['deploy-1'],
        role: 'primary',
      });
      const app = server.getApp();
      const res = await request(app).get('/api/v1/routing/info?bucket_name=my-bucket');
      expect(res.status).toBe(200);
      expect(res.body.is_local).toBe(true);
    });

    it('passes project_id to routing manager when provided', async () => {
      mockGetRoutingInfo.mockResolvedValue({
        is_local: false,
        redirect_url: 'http://remote/bucket',
        serving_deployments: [],
        role: 'primary',
      });
      const app = server.getApp();
      await request(app).get('/api/v1/routing/info?bucket_name=bucket&project_id=proj-1');
      expect(mockGetRoutingInfo).toHaveBeenCalledWith('bucket', 'proj-1', expect.any(Map));
    });

    it('returns 500 when routing manager throws', async () => {
      mockGetRoutingInfo.mockRejectedValue(new Error('routing error'));
      const app = server.getApp();
      const res = await request(app).get('/api/v1/routing/info?bucket_name=bucket');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/v1/metrics', () => {
    it('accepts metrics and returns 200', async () => {
      const app = server.getApp();
      const res = await request(app)
        .post('/api/v1/metrics')
        .send({ cpu: 0.5, memory: 1024 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');
    });
  });

  describe('start and shutdown', () => {
    it('starts without error', async () => {
      await expect(server.start()).resolves.not.toThrow();
    });

    it('shuts down without error', async () => {
      await server.start();
      await expect(server.shutdown()).resolves.not.toThrow();
    });

    it('starts with USE_VOLUME_MOUNT_SET_CR set', async () => {
      process.env.USE_VOLUME_MOUNT_SET_CR = 'true';
      const srv = new Server(buildServerConfig());
      await expect(srv.start()).resolves.not.toThrow();
      await srv.shutdown();
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
    });

    it('handles registerDeployment failure gracefully', async () => {
      const { HttpClient } = require('../services/HttpClient');
      (HttpClient as jest.Mock).mockImplementationOnce(() => ({
        request: jest.fn().mockRejectedValue(new Error('connection refused')),
      }));
      const srv = new Server(buildServerConfig());
      await expect(srv.start()).resolves.not.toThrow();
      await srv.shutdown();
    });
  });

  describe('syncConfig with actual results (syncStorageClasses path)', () => {
    const bucketA = {
      project_id: 'proj-1',
      bucket_name: 'bucket-a',
      region: 'us-east-1',
      role: 'primary' as const,
      protocol: 's3',
      volume_info: { type: 'nfs', endpoint: 'nfs://server/path' },
      auth_info: { type: 'none' },
    };

    it('creates StorageClass and PVC for newly added buckets', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).toHaveBeenCalled();
      expect(mockStorageClassManager.createOrUpdatePVC).toHaveBeenCalled();
    });

    it('deletes StorageClass for removed buckets', async () => {
      const registry = new Map<string, any>();
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: ['proj-1:bucket-old'],
        changed: [],
        newRegistry: registry,
        configVersion: 2,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.deleteStorageClass).toHaveBeenCalledWith('proj-1', 'bucket-old');
    });

    it('handles PVC creation failure gracefully', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdatePVC.mockRejectedValueOnce(
        Object.assign(new Error('forbidden'), { statusCode: 403 })
      );

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).toHaveBeenCalled();
    });

    it('handles StorageClass creation failure gracefully', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(
        new Error('validation failed')
      );

      await server.start();
      await server.shutdown();
    });

    it('skips helm-provisioned buckets', async () => {
      const helmBucket = { ...bucketA, provisioning_source: 'helm' };
      const registry = new Map([['proj-1:bucket-helm', helmBucket as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-helm'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).not.toHaveBeenCalled();
    });

    it('skips buckets with skip_pvc_create flag', async () => {
      const skipBucket = { ...bucketA, skip_pvc_create: true };
      const registry = new Map([['proj-1:bucket-skip', skipBucket as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-skip'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).not.toHaveBeenCalled();
    });

    it('skips dynamic buckets without storage_class_name', async () => {
      const dynamicBucket = {
        ...bucketA,
        volume_info: { ...bucketA.volume_info, provisioning_mode: 'dynamic' },
      };
      const registry = new Map([['proj-1:bucket-dyn', dynamicBucket as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-dyn'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).not.toHaveBeenCalled();
    });

    it('handles deleteStorageClass failure gracefully', async () => {
      const registry = new Map<string, any>();
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: ['proj-1:bucket-old'],
        changed: [],
        newRegistry: registry,
        configVersion: 2,
        namespaces: new Set(),
      });
      mockStorageClassManager.deleteStorageClass.mockRejectedValueOnce(new Error('not found'));

      await server.start();
      await server.shutdown();
    });

    it('processes changed buckets', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: ['proj-1:bucket-a'],
        newRegistry: registry,
        configVersion: 3,
        namespaces: new Set(['proj-1']),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).toHaveBeenCalled();
      expect(mockStorageClassManager.createOrUpdatePVC).toHaveBeenCalled();
    });

    it('handles changed bucket StorageClass update failure gracefully', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: ['proj-1:bucket-a'],
        newRegistry: registry,
        configVersion: 3,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(
        new Error('update failed')
      );

      await server.start();
      await server.shutdown();
    });

    it('handles changed bucket PVC update failure gracefully', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: ['proj-1:bucket-a'],
        newRegistry: registry,
        configVersion: 3,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdatePVC.mockRejectedValueOnce(
        new Error('pvc update failed')
      );

      await server.start();
      await server.shutdown();
    });

    it('skips helm-provisioned changed buckets', async () => {
      const helmBucket = { ...bucketA, provisioning_source: 'helm' };
      const registry = new Map([['proj-1:bucket-helm', helmBucket as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: ['proj-1:bucket-helm'],
        newRegistry: registry,
        configVersion: 3,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).not.toHaveBeenCalled();
    });

    it('skips changed dynamic buckets without storage_class_name', async () => {
      const dynamicBucket = {
        ...bucketA,
        volume_info: { ...bucketA.volume_info, provisioning_mode: 'dynamic' },
      };
      const registry = new Map([['proj-1:bucket-dyn', dynamicBucket as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: ['proj-1:bucket-dyn'],
        newRegistry: registry,
        configVersion: 3,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.createOrUpdateStorageClass).not.toHaveBeenCalled();
    });

    it('reconciles orphaned StorageClasses not in registry', async () => {
      const registry = new Map<string, any>();
      mockStorageClassManager.listStorageClasses.mockResolvedValueOnce([{
        metadata: {
          name: 'sc-proj-x-orphan',
          labels: {
            'agentstudio.io/bucket-name': 'orphan',
            'agentstudio.io/project-id': 'proj-x',
          },
        },
      }]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 4,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();

      expect(mockStorageClassManager.deleteStorageClass).toHaveBeenCalledWith('proj-x', 'orphan');
    });

    it('handles reconciliation failure of orphaned StorageClasses gracefully', async () => {
      const registry = new Map<string, any>();
      mockStorageClassManager.listStorageClasses.mockResolvedValueOnce([{
        metadata: {
          name: 'sc-proj-x-orphan',
          labels: {
            'agentstudio.io/bucket-name': 'orphan',
            'agentstudio.io/project-id': 'proj-x',
          },
        },
      }]);
      mockStorageClassManager.deleteStorageClass.mockRejectedValueOnce(new Error('delete failed'));
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 4,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();
    });

    it('handles listStorageClasses failure in reconciliation gracefully', async () => {
      const registry = new Map<string, any>();
      mockStorageClassManager.listStorageClasses.mockRejectedValueOnce(new Error('list failed'));
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: [],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 4,
        namespaces: new Set(),
      });

      await server.start();
      await server.shutdown();
    });

    it('reconciles with VolumeMountSet client when USE_VOLUME_MOUNT_SET_CR is set', async () => {
      process.env.USE_VOLUME_MOUNT_SET_CR = 'true';
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 5,
        namespaces: new Set(['proj-1']),
      });

      const srv = new Server(buildServerConfig());
      await srv.start();
      await srv.shutdown();
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
    });

    it('handles StorageClass creation error with 404 (not found bubbles up)', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      const notFoundErr = Object.assign(new Error('Not found'), { statusCode: 404 });
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(notFoundErr);

      await server.start();
      await server.shutdown();
    });

    it('handles StorageClass creation error with 422 (validation failed)', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      const validationErr = Object.assign(new Error('Unprocessable'), { statusCode: 422 });
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(validationErr);

      await server.start();
      await server.shutdown();
    });

    it('handles StorageClass creation error with 409 (conflict/race condition)', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      const conflictErr = Object.assign(new Error('Conflict'), { statusCode: 409 });
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(conflictErr);

      await server.start();
      await server.shutdown();
    });

    it('handles StorageClass creation with body.details error info', async () => {
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      const err = Object.assign(new Error('server error'), {
        statusCode: 500,
        body: {
          message: 'Internal server error',
          reason: 'InternalError',
          details: {
            causes: [{ field: 'spec.provisioner', message: 'required' }],
            name: 'sc-proj-1-bucket-a',
          },
        },
      });
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 1,
        namespaces: new Set(['proj-1']),
      });
      mockStorageClassManager.createOrUpdateStorageClass.mockRejectedValueOnce(err);

      await server.start();
      await server.shutdown();
    });
  });

  describe('updateStorageClasses (private via direct invocation)', () => {
    it('skips update when no storage classes available', async () => {
      mockStorageClassManager.listAllAvailableStorageClasses.mockResolvedValueOnce([]);
      await (server as any).updateStorageClasses();
      // Just verifies it doesn't throw
    });

    it('calls httpRequest when storage classes found', async () => {
      mockStorageClassManager.listAllAvailableStorageClasses.mockResolvedValueOnce(['sc-1', 'sc-2']);
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).updateStorageClasses();
      expect(httpClientMock.request).toHaveBeenCalled();
    });

    it('handles 404 error silently', async () => {
      mockStorageClassManager.listAllAvailableStorageClasses.mockResolvedValueOnce(['sc-1']);
      const notFoundErr = Object.assign(new Error('Not found'), { statusCode: 404 });
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockRejectedValue(notFoundErr);
      await (server as any).updateStorageClasses(); // should not throw
    });

    it('logs warning on non-404 httpRequest error', async () => {
      mockStorageClassManager.listAllAvailableStorageClasses.mockResolvedValueOnce(['sc-1']);
      const serverErr = Object.assign(new Error('server error'), { statusCode: 500 });
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockRejectedValue(serverErr);
      await (server as any).updateStorageClasses(); // should not throw
    });
  });

  describe('reportHealth (private via direct invocation)', () => {
    it('reports health with empty PVC map (no buckets)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map());
      await (server as any).reportHealth();
    });

    it('reports health with Bound PVC', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1', labels: {} } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
      expect(httpClientMock.request).toHaveBeenCalled();
    });

    it('reports health with Pending static PVC (unhealthy)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'pending',
          statusMessage: 'PVC pending',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('reports health with Pending dynamic PVC (healthy - waiting)', async () => {
      // Register a bucket in the bucketRegistry
      const dynamicBucket = {
        project_id: 'proj-1',
        bucket_name: 'dyn-bucket',
        volume_info: { provisioning_mode: 'dynamic', type: 'nfs', endpoint: 'server:/path' },
      };
      (server as any).bucketRegistry = new Map([['proj-1:dyn-bucket', dynamicBucket]]);
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:dyn-bucket', {
          pvc: { metadata: { name: 'pvc-dyn' } },
          status: 'pending',
          statusMessage: 'waiting for provisioner',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('reports health with Lost PVC (unhealthy)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-lost' } },
          status: 'lost',
          statusMessage: 'PVC lost',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('reports health with Failed PVC (unhealthy)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-failed' } },
          status: 'failed',
          statusMessage: 'PVC failed',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('reports health with Unknown PVC status', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-unknown' } },
          status: 'unknown',
          statusMessage: 'PVC status unknown',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('handles buckets in registry without PVCs', async () => {
      (server as any).bucketRegistry = new Map([
        ['proj-1:missing-pvc-bucket', {
          project_id: 'proj-1',
          bucket_name: 'missing-pvc-bucket',
          volume_info: {},
        }],
      ]);
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map());
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth();
    });

    it('handles listVersitygwPVCs failure gracefully', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockRejectedValueOnce(new Error('api error'));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (server as any).reportHealth(); // should not throw
    });

    it('handles httpRequest error in reportHealth gracefully', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      const httpClientMock = (server as any).httpClient;
      httpClientMock.request = jest.fn().mockRejectedValue(new Error('http error'));
      await (server as any).reportHealth(); // should not throw
    });
  });

  describe('reportHealth with VolumeMountSet CR mode', () => {
    let crServer: Server;

    beforeEach(() => {
      jest.clearAllMocks();
      mockGetRoutingInfo.mockResolvedValue(null);
      mockConfigSyncManager.getLastConfigSync.mockReturnValue(Math.floor(Date.now() / 1000));
      mockConfigSyncManager.syncConfig.mockResolvedValue(null);
      process.env.USE_VOLUME_MOUNT_SET_CR = 'true';
      crServer = new Server(buildServerConfig());
    });

    afterEach(async () => {
      await crServer.shutdown();
      delete process.env.USE_VOLUME_MOUNT_SET_CR;
    });

    it('reports health with CR status - all mounted', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce({
        conditions: [],
        evictedPvcNames: [],
        pvcConditions: [{ pvcName: 'pvc-1', mounted: true, message: 'Mounted' }],
      });
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
      expect(httpClientMock.request).toHaveBeenCalled();
    });

    it('reports health with CR status - evicted PVC', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-evicted' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce({
        conditions: [],
        evictedPvcNames: ['pvc-evicted'],
        pvcConditions: [],
      });
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
      expect(httpClientMock.request).toHaveBeenCalled();
    });

    it('reports health with CR TargetNotFound condition', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map());
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce({
        conditions: [{ type: 'TargetNotFound', message: 'Deployment not found' }],
        evictedPvcNames: [],
        pvcConditions: [],
      });
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
      expect(httpClientMock.request).toHaveBeenCalled();
    });

    it('reports health when CR getStatus fails and no lastVolumeMountStatus', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockRejectedValueOnce(new Error('CR api error'));
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
    });

    it('reports health when CR getStatus fails but lastVolumeMountStatus available', async () => {
      // Set lastVolumeMountStatus on server
      (crServer as any).lastVolumeMountStatus = {
        'proj-1:bucket-a': { mounted: true, status: 'PVC bound' },
      };
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockRejectedValueOnce(new Error('CR api error'));
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
    });

    it('reports health with CR - Pending static PVC (unhealthy)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-pending' } },
          status: 'pending',
          statusMessage: 'PVC pending',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce({
        conditions: [],
        evictedPvcNames: [],
        pvcConditions: [],
      });
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
    });

    it('reports health with CR - Lost PVC (unhealthy)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-lost', {
          pvc: { metadata: { name: 'pvc-lost' } },
          status: 'lost',
          statusMessage: 'PVC lost',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce({
        conditions: [],
        evictedPvcNames: [],
        pvcConditions: [],
      });
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
    });

    it('reports health with CR - crStatus is null (no CR yet)', async () => {
      mockStorageClassManager.listVersitygwPVCs.mockResolvedValueOnce(new Map([
        ['proj-1:bucket-a', {
          pvc: { metadata: { name: 'pvc-1' } },
          status: 'bound',
          statusMessage: 'PVC bound',
        }],
      ]));
      mockVolumeMountSetClient.getStatus.mockResolvedValueOnce(null);
      const httpClientMock = (crServer as any).httpClient;
      httpClientMock.request = jest.fn().mockResolvedValue({});
      await (crServer as any).reportHealth();
    });

    it('updates VolumeMountSet CR during syncStorageClasses', async () => {
      const bucketA = {
        project_id: 'proj-1',
        bucket_name: 'bucket-a',
        region: 'us-east-1',
        role: 'primary' as const,
        protocol: 's3',
        volume_info: { type: 'nfs', endpoint: 'nfs://server/path' },
        auth_info: { type: 'none' },
      };
      const registry = new Map([['proj-1:bucket-a', bucketA as any]]);
      mockConfigSyncManager.syncConfig.mockResolvedValueOnce({
        added: ['proj-1:bucket-a'],
        removed: [],
        changed: [],
        newRegistry: registry,
        configVersion: 5,
        namespaces: new Set(['proj-1']),
      });

      await crServer.start();
      await crServer.shutdown();

      expect(mockVolumeMountSetClient.createOrUpdate).toHaveBeenCalled();
    });
  });
});
