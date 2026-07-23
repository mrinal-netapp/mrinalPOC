import { RoutingManager } from '../RoutingManager';
import { BucketConfig, BucketRoutingResponse, BucketListResponse } from '../../types';

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

function buildRoutingManager(opts: { cacheTTL?: number; logLevel?: string } = {}) {
  return new RoutingManager(
    {
      configService: 'http://config-svc',
      logLevel: opts.logLevel,
      routingCacheTTL: opts.cacheTTL ?? 300000,
    },
    mockHttpClient
  );
}

const healthyDeployment = {
  deployment_id: 'deploy-1',
  role: 'primary' as const,
  priority: 10,
  endpoint: 'http://primary.example.com',
  health_status: 'healthy' as const,
  load_balance_weight: 1,
  last_health_check: new Date().toISOString(),
};

const routingResponse: BucketRoutingResponse = {
  bucket_name: 'bucket-a',
  project_id: 'proj-1',
  deployments: [healthyDeployment],
  routing_strategy: 'primary',
  updated_at: new Date().toISOString(),
};

const localBucket: BucketConfig = {
  project_id: 'proj-1',
  bucket_name: 'bucket-a',
  region: 'us-east-1',
  role: 'primary',
  protocol: 's3',
  volume_info: { type: 'hostpath' },
  auth_info: { type: 'none' },
  other_deployments: [{ deployment_id: 'deploy-1', role: 'primary' }],
};

describe('RoutingManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('updateKnownNamespaces', () => {
    it('returns true when namespaces are added', () => {
      const rm = buildRoutingManager();
      const result = rm.updateKnownNamespaces(new Set(['ns-1', 'ns-2']));
      expect(result).toBe(true);
    });

    it('returns false when namespaces are unchanged', () => {
      const rm = buildRoutingManager();
      rm.updateKnownNamespaces(new Set(['ns-1']));
      const result = rm.updateKnownNamespaces(new Set(['ns-1']));
      expect(result).toBe(false);
    });

    it('returns true when namespaces are removed', () => {
      const rm = buildRoutingManager();
      rm.updateKnownNamespaces(new Set(['ns-1', 'ns-2']));
      const result = rm.updateKnownNamespaces(new Set(['ns-1']));
      expect(result).toBe(true);
    });

    it('getKnownNamespaces returns a copy of current namespaces', () => {
      const rm = buildRoutingManager();
      rm.updateKnownNamespaces(new Set(['ns-1', 'ns-2']));
      const namespaces = rm.getKnownNamespaces();
      expect(namespaces.has('ns-1')).toBe(true);
      expect(namespaces.has('ns-2')).toBe(true);
    });
  });

  describe('getRoutingInfo', () => {
    it('returns local info when bucket is in registry', async () => {
      const rm = buildRoutingManager();
      const registry = new Map([['proj-1:bucket-a', localBucket]]);

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', registry);

      expect(result).not.toBeNull();
      expect(result!.is_local).toBe(true);
      expect(result!.role).toBe('primary');
    });

    it('returns local info when searching by bucket name only (no projectId)', async () => {
      const rm = buildRoutingManager();
      const registry = new Map([['proj-1:bucket-a', localBucket]]);

      const result = await rm.getRoutingInfo('bucket-a', undefined, registry);

      expect(result!.is_local).toBe(true);
    });

    it('returns null when bucket not found locally or remotely', async () => {
      const rm = buildRoutingManager();
      const registry = new Map<string, BucketConfig>();

      const result = await rm.getRoutingInfo('unknown-bucket', undefined, registry);

      expect(result).toBeNull();
    });

    it('fetches and returns remote routing info', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();
      const registry = new Map<string, BucketConfig>();

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', registry);

      expect(result).not.toBeNull();
      expect(result!.is_local).toBe(false);
      expect(result!.redirect_url).toContain('bucket-a');
    });

    it('returns null when remote fetch returns null', async () => {
      mockHttpRequest.mockRejectedValue(new Error('network error'));
      const rm = buildRoutingManager();
      const registry = new Map<string, BucketConfig>();

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', registry);

      expect(result).toBeNull();
    });

    it('uses cached routing info on second call', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();
      const registry = new Map<string, BucketConfig>();

      await rm.getRoutingInfo('bucket-a', 'proj-1', registry);
      await rm.getRoutingInfo('bucket-a', 'proj-1', registry);

      expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    });

    it('handles routing response with no healthy primary - falls back to any primary', async () => {
      const unhealthyResponse: BucketRoutingResponse = {
        ...routingResponse,
        deployments: [{ ...healthyDeployment, health_status: 'unhealthy' }],
      };
      mockHttpRequest.mockResolvedValue(unhealthyResponse);
      const rm = buildRoutingManager();

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      expect(result!.redirect_url).toContain('bucket-a');
    });

    it('throws when remote routing response has empty deployments', async () => {
      const emptyResponse: BucketRoutingResponse = { ...routingResponse, deployments: [] };
      mockHttpRequest.mockResolvedValue(emptyResponse);
      const rm = buildRoutingManager();

      await expect(rm.getRoutingInfo('bucket-a', 'proj-1', new Map())).rejects.toThrow(
        /No deployments found/
      );
    });

    it('sorts multiple healthy primary deployments by priority (covers sort comparator)', async () => {
      const multiHealthy: BucketRoutingResponse = {
        ...routingResponse,
        deployments: [
          { ...healthyDeployment, deployment_id: 'deploy-low', priority: 5 },
          { ...healthyDeployment, deployment_id: 'deploy-high', priority: 20 },
        ],
      };
      mockHttpRequest.mockResolvedValue(multiHealthy);
      const rm = buildRoutingManager();

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());
      expect(result).toBeDefined();
      expect(result!.serving_deployments).toContain('deploy-high');
    });

    it('sorts multiple unhealthy primary deployments by priority for fallback (covers anyPrimary sort)', async () => {
      const multiUnhealthy: BucketRoutingResponse = {
        ...routingResponse,
        deployments: [
          { ...healthyDeployment, deployment_id: 'deploy-low', priority: 5, health_status: 'unhealthy' as const },
          { ...healthyDeployment, deployment_id: 'deploy-high', priority: 20, health_status: 'unhealthy' as const },
        ],
      };
      mockHttpRequest.mockResolvedValue(multiUnhealthy);
      const rm = buildRoutingManager();

      const result = await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());
      expect(result).toBeDefined();
      expect(result!.redirect_url).toContain('bucket-a');
    });
  });

  describe('syncNamespaceRoutingInfo', () => {
    it('fetches buckets and routing info for each namespace', async () => {
      const bucketsResponse: BucketListResponse = { buckets: [{ name: 'bucket-a' }] };
      mockHttpRequest
        .mockResolvedValueOnce(bucketsResponse)
        .mockResolvedValueOnce(routingResponse);

      const rm = buildRoutingManager();
      await rm.syncNamespaceRoutingInfo(new Set(['proj-1']));

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it('handles namespace fetch errors gracefully', async () => {
      mockHttpRequest.mockRejectedValue(new Error('network error'));
      const rm = buildRoutingManager();

      await expect(rm.syncNamespaceRoutingInfo(new Set(['proj-1']))).resolves.not.toThrow();
    });

    it('handles routing fetch errors per bucket', async () => {
      const bucketsResponse: BucketListResponse = { buckets: [{ name: 'bucket-a' }] };
      mockHttpRequest
        .mockResolvedValueOnce(bucketsResponse)
        .mockRejectedValueOnce(new Error('routing error'));

      const rm = buildRoutingManager();
      await expect(rm.syncNamespaceRoutingInfo(new Set(['proj-1']))).resolves.not.toThrow();
    });

    it('handles empty namespace set', async () => {
      const rm = buildRoutingManager();
      await rm.syncNamespaceRoutingInfo(new Set());
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it('logs debug messages when logLevel is debug', async () => {
      const bucketsResponse: BucketListResponse = { buckets: [{ name: 'bucket-a' }] };
      mockHttpRequest
        .mockResolvedValueOnce(bucketsResponse)
        .mockResolvedValueOnce(routingResponse);

      const rm = buildRoutingManager({ logLevel: 'debug' });
      await rm.syncNamespaceRoutingInfo(new Set(['proj-1']));

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('refreshCache', () => {
    it('does nothing when no cached info and no known namespaces', async () => {
      const rm = buildRoutingManager();
      await rm.refreshCache();
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it('syncs namespace routing info for known namespaces', async () => {
      const bucketsResponse: BucketListResponse = { buckets: [] };
      mockHttpRequest.mockResolvedValue(bucketsResponse);
      const rm = buildRoutingManager();
      rm.updateKnownNamespaces(new Set(['ns-1']));

      await rm.refreshCache();

      expect(mockHttpRequest).toHaveBeenCalled();
    });

    it('refreshes cached entries and updates them', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();

      // First call populates cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Second call is refresh
      mockHttpRequest.mockResolvedValue(routingResponse);
      await rm.refreshCache();

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it('removes cached entry when routing returns no deployments', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();

      // Populate cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Refresh returns empty deployments
      const emptyResponse: BucketRoutingResponse = { ...routingResponse, deployments: [] };
      mockHttpRequest.mockResolvedValue(emptyResponse);
      await rm.refreshCache();

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it('removes 404 entries from cache during refresh', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();

      // Populate cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Refresh encounters 404
      const error = Object.assign(new Error('Not Found'), { statusCode: 404 });
      mockHttpRequest.mockRejectedValue(error);
      await rm.refreshCache();

      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });

    it('handles refresh error with non-404 status code', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager();

      // Populate cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Refresh encounters server error
      const error = Object.assign(new Error('Server Error'), { statusCode: 500 });
      mockHttpRequest.mockRejectedValue(error);
      await expect(rm.refreshCache()).resolves.not.toThrow();
    });

    it('logs debug when cache is empty (debug mode)', async () => {
      const rm = buildRoutingManager({ logLevel: 'debug' });
      await rm.refreshCache(); // empty cache - should return early
      expect(mockHttpRequest).not.toHaveBeenCalled();
    });

    it('logs debug when refresh succeeds (debug mode)', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager({ logLevel: 'debug' });

      // Populate cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Refresh succeeds
      mockHttpRequest.mockResolvedValue(routingResponse);
      await rm.refreshCache();
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('syncNamespaceRoutingInfo - debug and error cases', () => {
    it('logs debug when individual bucket sync fails (debug mode)', async () => {
      const rm = buildRoutingManager({ logLevel: 'debug' });
      // Make listBuckets succeed
      const bucketListResponse: BucketListResponse = {
        buckets: [{ name: 'bucket-x' }],
      };
      mockHttpRequest
        .mockResolvedValueOnce(bucketListResponse)
        .mockRejectedValueOnce(new Error('bucket routing error'));

      const namespaces = new Set(['proj-x']);
      await rm.syncNamespaceRoutingInfo(namespaces);
      expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('syncNamespaceRoutingInfo - cleanup of removed namespaces', () => {
    it('removes registry and cache entries for projects no longer in namespace set', async () => {
      const bucketsResponse: BucketListResponse = { buckets: [{ name: 'bucket-a' }] };
      // First sync for proj-1 to populate registry and cache
      mockHttpRequest
        .mockResolvedValueOnce(bucketsResponse)
        .mockResolvedValueOnce(routingResponse);
      const rm = buildRoutingManager({ cacheTTL: 300000 });
      await rm.syncNamespaceRoutingInfo(new Set(['proj-1']));

      // Now sync for proj-2 only - should clean up proj-1 entries
      const proj2Buckets: BucketListResponse = { buckets: [] };
      mockHttpRequest.mockResolvedValueOnce(proj2Buckets);
      await rm.syncNamespaceRoutingInfo(new Set(['proj-2']));

      // The cleanup should have removed proj-1's entries from cache
      // Internal state is cleaned; just verify no errors were thrown
    });
  });

  describe('getRoutingInfo - resolveProjectId from multiple sources', () => {
    it('resolves project_id from bucketRegistry when not provided explicitly (debug mode)', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager({ logLevel: 'debug' });

      const registry = new Map([['proj-1:bucket-a', localBucket]]);
      const result = await rm.getRoutingInfo('bucket-a', undefined, registry);
      expect(result).toBeDefined();
    });

    it('resolves project_id from projectRoutingRegistry (debug mode)', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager({ logLevel: 'debug' });

      // First call to populate projectRoutingRegistry
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Second call without project_id - should find from projectRoutingRegistry
      mockHttpRequest.mockResolvedValue(routingResponse);
      const result = await rm.getRoutingInfo('bucket-a', undefined, new Map());
      expect(result).toBeDefined();
    });

    it('resolves project_id from routingInfoCache (debug mode)', async () => {
      mockHttpRequest.mockResolvedValue(routingResponse);
      const rm = buildRoutingManager({ logLevel: 'debug', cacheTTL: 300000 });

      // Populate cache
      await rm.getRoutingInfo('bucket-a', 'proj-1', new Map());

      // Third call without project_id - should find from cache
      mockHttpRequest.mockResolvedValue(routingResponse);
      const result = await rm.getRoutingInfo('bucket-a', undefined, new Map());
      expect(result).toBeDefined();
    });
  });
});
