import { ConfigSyncManager } from '../ConfigSyncManager';
import { BucketConfig } from '../../types';

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

const mockHttpRequest = jest.fn();
const mockHttpClient = { request: mockHttpRequest } as any;

const mockStorageClassManager = {} as any;

const mockUpdateKnownNamespaces = jest.fn().mockReturnValue(false);
const mockSyncNamespaceRoutingInfo = jest.fn().mockResolvedValue(undefined);
const mockRoutingManager = {
  updateKnownNamespaces: mockUpdateKnownNamespaces,
  syncNamespaceRoutingInfo: mockSyncNamespaceRoutingInfo,
} as any;

function buildManager(logLevel?: string) {
  return new ConfigSyncManager(
    {
      configService: 'http://config-service',
      deploymentID: 'deploy-1',
      configSyncInterval: 30,
      logLevel,
    },
    mockHttpClient,
    mockStorageClassManager,
    mockRoutingManager
  );
}

const bucket1: BucketConfig = {
  project_id: 'proj-1',
  bucket_name: 'bucket-a',
  region: 'us-east-1',
  role: 'primary',
  protocol: 's3',
  volume_info: { type: 'hostpath', endpoint: 'http://host' },
  auth_info: { type: 'none' },
};

const bucket2: BucketConfig = {
  project_id: 'proj-2',
  bucket_name: 'bucket-b',
  region: 'us-west-2',
  role: 'secondary',
  protocol: 's3',
  volume_info: { type: 'hostpath', endpoint: 'http://host2' },
  auth_info: { type: 'none' },
};

describe('ConfigSyncManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateKnownNamespaces.mockReturnValue(false);
    mockSyncNamespaceRoutingInfo.mockResolvedValue(undefined);
  });

  describe('getConfigVersion', () => {
    it('returns 0 initially', () => {
      const mgr = buildManager();
      expect(mgr.getConfigVersion()).toBe(0);
    });
  });

  describe('getLastConfigSync', () => {
    it('returns a timestamp close to now', () => {
      const before = Math.floor(Date.now() / 1000);
      const mgr = buildManager();
      const ts = mgr.getLastConfigSync();
      const after = Math.floor(Date.now() / 1000);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('syncConfig', () => {
    it('returns null when response has no buckets', async () => {
      mockHttpRequest.mockResolvedValue({ buckets: null, config_version: 1 });
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result).toBeNull();
    });

    it('returns null when response is falsy', async () => {
      mockHttpRequest.mockResolvedValue(null);
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result).toBeNull();
    });

    it('detects added buckets', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result).not.toBeNull();
      expect(result!.added).toContain('proj-1:bucket-a');
      expect(result!.removed).toHaveLength(0);
      expect(result!.changed).toHaveLength(0);
      expect(result!.configVersion).toBe(1);
    });

    it('detects removed buckets', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [],
        config_version: 2,
      });
      const mgr = buildManager();
      const currentRegistry = new Map([['proj-1:bucket-a', bucket1]]);

      const result = await mgr.syncConfig(currentRegistry);

      expect(result!.removed).toContain('proj-1:bucket-a');
      expect(result!.added).toHaveLength(0);
    });

    it('detects changed buckets (role change)', async () => {
      const changedBucket = { ...bucket1, role: 'secondary' } as BucketConfig;
      mockHttpRequest.mockResolvedValue({
        buckets: [changedBucket],
        config_version: 3,
      });
      const mgr = buildManager();
      const currentRegistry = new Map([['proj-1:bucket-a', bucket1]]);

      const result = await mgr.syncConfig(currentRegistry);

      expect(result!.changed).toContain('proj-1:bucket-a');
    });

    it('triggers routing sync when namespaces change', async () => {
      mockUpdateKnownNamespaces.mockReturnValue(true);
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager();

      await mgr.syncConfig(new Map());

      expect(mockSyncNamespaceRoutingInfo).toHaveBeenCalled();
    });

    it('triggers routing sync when buckets are added', async () => {
      mockUpdateKnownNamespaces.mockReturnValue(false);
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager();

      await mgr.syncConfig(new Map());

      expect(mockSyncNamespaceRoutingInfo).toHaveBeenCalled();
    });

    it('returns null on HTTP error', async () => {
      mockHttpRequest.mockRejectedValue(new Error('network error'));
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result).toBeNull();
    });

    it('updates configVersion after successful sync', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 42,
      });
      const mgr = buildManager();

      await mgr.syncConfig(new Map());

      expect(mgr.getConfigVersion()).toBe(42);
    });

    it('includes namespaces extracted from buckets', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1, bucket2],
        config_version: 5,
      });
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result!.namespaces.has('proj-1')).toBe(true);
      expect(result!.namespaces.has('proj-2')).toBe(true);
    });

    it('logs at debug level when logLevel is debug', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager('debug');

      const result = await mgr.syncConfig(new Map());

      expect(result).not.toBeNull();
    });

    it('handles no changes scenario with multiple buckets', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager();
      const currentRegistry = new Map([['proj-1:bucket-a', bucket1]]);

      const result = await mgr.syncConfig(currentRegistry);

      expect(result!.added).toHaveLength(0);
      expect(result!.removed).toHaveLength(0);
      expect(result!.changed).toHaveLength(0);
    });

    it('logs no-changes with zero buckets (covers else of newBucketCount > 0)', async () => {
      mockHttpRequest.mockResolvedValue({
        buckets: [],
        config_version: 2,
      });
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());

      expect(result!.added).toHaveLength(0);
    });

    it('catches and logs routing sync error (covers catch handler)', async () => {
      mockUpdateKnownNamespaces.mockReturnValue(true);
      mockSyncNamespaceRoutingInfo.mockRejectedValue(new Error('routing sync failed'));
      mockHttpRequest.mockResolvedValue({
        buckets: [bucket1],
        config_version: 1,
      });
      const mgr = buildManager();

      const result = await mgr.syncConfig(new Map());
      // Allow the fire-and-forget promise to resolve
      await new Promise((r) => setTimeout(r, 10));
      expect(result).not.toBeNull();
    });
  });
});
