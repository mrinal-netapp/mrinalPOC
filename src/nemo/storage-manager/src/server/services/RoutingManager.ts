import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
/**
 * RoutingManager handles routing information queries, caching, and namespace routing registry
 */
import {
  BucketConfig,
  BucketRoutingResponse,
  CachedRoutingInfo,
  ProjectRoutingEntry,
  BucketListResponse
} from '../types';
import { GetRoutingInfoResponse } from '../../types/models';
import { HttpClient } from './HttpClient';

export interface RoutingManagerConfig {
  configService: string; // For all config-service APIs (routing, namespace/bucket)
  logLevel?: string;
  routingCacheTTL?: number; // Cache TTL in milliseconds
}

export class RoutingManager {
  private routingInfoCache: Map<string, CachedRoutingInfo> = new Map(); // key: "bucket_name"
  private projectRoutingRegistry: Map<string, ProjectRoutingEntry> = new Map(); // key: "project_id:bucket_name"
  private knownNamespaces: Set<string> = new Set();
  private readonly routingCacheTTL: number;

  constructor(
    private config: RoutingManagerConfig,
    private httpClient: HttpClient
  ) {
    this.routingCacheTTL = config.routingCacheTTL || 5 * 60 * 1000; // Default 5 minutes
  }

  /**
   * Get routing info for a bucket
   */
  async getRoutingInfo(
    bucketName: string,
    projectId: string | undefined,
    bucketRegistry: Map<string, BucketConfig>
  ): Promise<GetRoutingInfoResponse | null> {
    // Check if bucket is in local registry
    let localBucket: BucketConfig | undefined;
    
    if (projectId) {
      const bucketKey = `${projectId}:${bucketName}`;
      localBucket = bucketRegistry.get(bucketKey);
    } else {
      // Search by bucket name only
      for (const [key, bucket] of bucketRegistry.entries()) {
        if (bucket.bucket_name === bucketName) {
          localBucket = bucket;
          break;
        }
      }
    }

    if (localBucket) {
      // Bucket is served locally
      const servingDeployments = this.getServingDeployments(localBucket);
      return {
        is_local: true,
        redirect_url: '',
        serving_deployments: servingDeployments,
        role: localBucket.role
      };
    }

    // Bucket is not local, resolve namespace and get routing info
    const resolvedNamespaceId = this.resolveProjectId(bucketName, projectId, bucketRegistry);
    if (!resolvedNamespaceId) {
      return null; // Bucket not found
    }

    // Get routing info
    let routingInfo = this.getCachedRoutingInfo(bucketName, resolvedNamespaceId);
    
    if (!routingInfo) {
      routingInfo = await this.fetchRoutingInfo(resolvedNamespaceId, bucketName);
      if (!routingInfo) {
        return null; // Failed to get routing info
      }
    }

    return this.buildRoutingResponse(bucketName, routingInfo);
  }

  /**
   * Sync routing info for all buckets in the given projects
   */
  async syncNamespaceRoutingInfo(projects: Set<string>): Promise<void> {
    const syncStartTime = Date.now();
    logger.info(`[Namespace Routing Sync] Starting sync for ${projects.size} namespace(s)`);
    
    let totalBuckets = 0;
    let totalRoutingInfo = 0;
    let errors = 0;

    for (const projectId of projects) {
      try {
        // Get all buckets in this namespace (use config-service)
        const bucketsUrl = `${this.config.configService}/api/v1/projects/${projectId}/buckets`;
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Namespace Routing Sync] Fetching buckets for namespace: ${projectId}`);
        }
        
        const bucketsResponse = await this.httpClient.request<BucketListResponse>(bucketsUrl, 'GET');
        const buckets = bucketsResponse.buckets || [];
        totalBuckets += buckets.length;
        
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Namespace Routing Sync] Found ${buckets.length} bucket(s) in namespace ${projectId}`);
        }

        // Get routing info for each bucket
        for (const bucket of buckets) {
          try {
            const routingInfo = await this.fetchRoutingInfo(projectId, bucket.name);
            if (routingInfo && routingInfo.deployments && routingInfo.deployments.length > 0) {
              this.updateRoutingCache(projectId, bucket.name, routingInfo);
              totalRoutingInfo++;
            }
          } catch (error: any) {
            errors++;
            if (this.config.logLevel === 'debug') {
              logger.debug(`[Namespace Routing Sync] Failed to get routing for ${projectId}/${bucket.name}: ${error.message}`);
            }
          }
        }
      } catch (error: any) {
        errors++;
        logger.error(`[Namespace Routing Sync] Failed to sync namespace ${projectId}: ${error.message}`);
      }
    }

    // Clean up routing registry entries for projects we're no longer part of
    this.cleanupNamespaceRegistry(projects);

    const syncDuration = Date.now() - syncStartTime;
    logger.info(
      `[Namespace Routing Sync] Completed in ${syncDuration}ms | ` +
      `Namespaces: ${projects.size} | ` +
      `Buckets: ${totalBuckets} | ` +
      `Routing Info: ${totalRoutingInfo} | ` +
      `Errors: ${errors} | ` +
      `Registry Size: ${this.projectRoutingRegistry.size}`
    );
  }

  /**
   * Update known projects and return true if changed
   */
  updateKnownNamespaces(newNamespaces: Set<string>): boolean {
    const oldSize = this.knownNamespaces.size;
    const added: string[] = [];
    const removed: string[] = [];
    
    // Find added projects
    for (const ns of newNamespaces) {
      if (!this.knownNamespaces.has(ns)) {
        added.push(ns);
      }
    }
    
    // Find removed projects
    for (const ns of this.knownNamespaces) {
      if (!newNamespaces.has(ns)) {
        removed.push(ns);
      }
    }
    
    // Update the set
    this.knownNamespaces = new Set(newNamespaces);
    
    if (added.length > 0 || removed.length > 0) {
      logger.info(
        `[Namespace Registry] Updated known projects: ` +
        `Added: ${added.length} (${added.join(', ') || 'none'}), ` +
        `Removed: ${removed.length} (${removed.join(', ') || 'none'}), ` +
        `Total: ${this.knownNamespaces.size}`
      );
      return true;
    }
    
    return oldSize !== this.knownNamespaces.size;
  }

  /**
   * Refresh routing cache
   */
  async refreshCache(): Promise<void> {
    // Refresh namespace routing registry for all known projects
    if (this.knownNamespaces.size > 0) {
      await this.syncNamespaceRoutingInfo(this.knownNamespaces);
    }

    const cacheSize = this.routingInfoCache.size;
    if (cacheSize === 0) {
      if (this.config.logLevel === 'debug') {
        logger.debug('[Routing Cache] No cached routing info to refresh');
      }
      return;
    }

    logger.info(`[Routing Cache] Refreshing routing info for ${cacheSize} cached bucket(s)`);
    const refreshStartTime = Date.now();
    let refreshed = 0;
    let failed = 0;

    // Refresh routing info for all cached buckets
    for (const [bucketName, cached] of this.routingInfoCache.entries()) {
      try {
        const routingInfo = await this.fetchRoutingInfo(cached.project_id, bucketName);
        if (routingInfo && routingInfo.deployments && routingInfo.deployments.length > 0) {
          this.updateRoutingCache(cached.project_id, bucketName, routingInfo);
          refreshed++;
          if (this.config.logLevel === 'debug') {
            logger.debug(`[Routing Cache] Refreshed routing info for bucket: ${bucketName}`);
          }
        } else {
          // Bucket no longer exists or has no deployments, remove from cache
          this.removeFromCache(bucketName, cached.project_id);
          failed++;
        }
      } catch (error: any) {
        failed++;
        // If it's a 404, remove from cache
        if (error.statusCode === 404) {
          this.removeFromCache(bucketName, cached.project_id);
        } else {
          logger.warn(`[Routing Cache] Failed to refresh routing info for bucket ${bucketName}: ${error.message}`);
        }
      }
    }

    const refreshDuration = Date.now() - refreshStartTime;
    logger.info(
      `[Routing Cache] Cache refresh completed in ${refreshDuration}ms | ` +
      `Refreshed: ${refreshed}, Failed: ${failed}, Total: ${cacheSize} | ` +
      `Registry Size: ${this.projectRoutingRegistry.size}`
    );
  }

  /**
   * Get known projects
   */
  getKnownNamespaces(): Set<string> {
    return new Set(this.knownNamespaces);
  }

  // Private helper methods

  private resolveProjectId(
    bucketName: string,
    projectId: string | undefined,
    bucketRegistry: Map<string, BucketConfig>
  ): string | undefined {
    if (projectId) {
      return projectId;
    }

    // Try to find project_id from bucketRegistry
    for (const [key, bucket] of bucketRegistry.entries()) {
      if (bucket.bucket_name === bucketName) {
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Routing] Found project_id ${bucket.project_id} for bucket ${bucketName} from bucketRegistry`);
        }
        return bucket.project_id;
      }
    }
    
    // Check projectRoutingRegistry
    for (const [key, entry] of this.projectRoutingRegistry.entries()) {
      if (entry.bucket_name === bucketName) {
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Routing] Found project_id ${entry.project_id} for bucket ${bucketName} from projectRoutingRegistry`);
        }
        return entry.project_id;
      }
    }
    
    // Check cache
    const cached = this.routingInfoCache.get(bucketName);
    if (cached && (Date.now() - cached.last_updated) < this.routingCacheTTL) {
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Routing] Found project_id ${cached.project_id} for bucket ${bucketName} from cache`);
      }
      return cached.project_id;
    }

    return undefined;
  }

  private getCachedRoutingInfo(
    bucketName: string,
    projectId: string
  ): BucketRoutingResponse | null {
    // Check projectRoutingRegistry first
    const registryKey = `${projectId}:${bucketName}`;
    const registryEntry = this.projectRoutingRegistry.get(registryKey);
    if (registryEntry && (Date.now() - registryEntry.last_updated) < this.routingCacheTTL) {
      return registryEntry.routing_info;
    }

    // Check cache
    const cached = this.routingInfoCache.get(bucketName);
    if (cached && cached.project_id === projectId && (Date.now() - cached.last_updated) < this.routingCacheTTL) {
      return cached.routing_info;
    }

    return null;
  }

  private async fetchRoutingInfo(
    projectId: string,
    bucketName: string
  ): Promise<BucketRoutingResponse | null> {
    try {
      const url = `${this.config.configService}/api/v1/buckets/${projectId}/${bucketName}/routing`;
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Routing] Requesting routing info for bucket: ${projectId}/${bucketName}`);
      }
      const response = await this.httpClient.request<BucketRoutingResponse>(url, 'GET');
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Routing] Received routing info:`, JSON.stringify(response, null, 2));
      }
      
      // Update cache with successful response
      this.updateRoutingCache(projectId, bucketName, response);
      
      return response;
    } catch (error: any) {
      logger.error(`[Routing] Failed to get routing from config-service for ${projectId}/${bucketName}: ${error.message}`);
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Routing] Error details:`, error);
      }
      
      // If it's a 404, remove from cache (bucket might have been deleted)
      if (error.statusCode === 404) {
        this.removeFromCache(bucketName, projectId);
      }
      
      return null;
    }
  }

  private updateRoutingCache(
    projectId: string,
    bucketName: string,
    routingInfo: BucketRoutingResponse
  ): void {
    const now = Date.now();
    
    // Update cache
    this.routingInfoCache.set(bucketName, {
      project_id: projectId,
      routing_info: routingInfo,
      last_updated: now
    });
    
    // Update namespace routing registry
    const registryKey = `${projectId}:${bucketName}`;
    this.projectRoutingRegistry.set(registryKey, {
      project_id: projectId,
      bucket_name: bucketName,
      routing_info: routingInfo,
      last_updated: now
    });
  }

  private removeFromCache(bucketName: string, projectId: string): void {
    this.routingInfoCache.delete(bucketName);
    const registryKey = `${projectId}:${bucketName}`;
    this.projectRoutingRegistry.delete(registryKey);
  }

  private buildRoutingResponse(
    bucketName: string,
    routingInfo: BucketRoutingResponse
  ): GetRoutingInfoResponse {
    // Handle case where deployments might be undefined or empty
    if (!routingInfo.deployments || routingInfo.deployments.length === 0) {
      throw new Error(`No deployments found for bucket ${bucketName}`);
    }

    const primaryDeployments = routingInfo.deployments
      .filter(d => d.role === 'primary' && d.health_status === 'healthy')
      .sort((a, b) => b.priority - a.priority);

    if (primaryDeployments.length === 0) {
      // No healthy primary, check for any primary
      const anyPrimary = routingInfo.deployments
        .filter(d => d.role === 'primary')
        .sort((a, b) => b.priority - a.priority);
      
      if (anyPrimary.length > 0) {
        return {
          is_local: false,
          redirect_url: `${anyPrimary[0].endpoint}/${bucketName}`,
          serving_deployments: [anyPrimary[0].deployment_id],
          role: 'primary'
        };
      }
    }

    const targetDeployment = primaryDeployments[0];
    return {
      is_local: false,
      redirect_url: `${targetDeployment.endpoint}/${bucketName}`,
      serving_deployments: primaryDeployments.map(d => d.deployment_id),
      role: 'primary'
    };
  }

  private getServingDeployments(bucket: BucketConfig): string[] {
    const servingDeployments: string[] = [];
    // Add primary deployments
    if (bucket.other_deployments) {
      for (const other of bucket.other_deployments) {
        if (other.role === 'primary') {
          servingDeployments.push(other.deployment_id);
        }
      }
    }
    return servingDeployments;
  }

  private cleanupNamespaceRegistry(currentNamespaces: Set<string>): void {
    for (const [key, entry] of this.projectRoutingRegistry.entries()) {
      if (!currentNamespaces.has(entry.project_id)) {
        this.projectRoutingRegistry.delete(key);
        // Also remove from cache if it matches
        const cached = this.routingInfoCache.get(entry.bucket_name);
        if (cached && cached.project_id === entry.project_id) {
          this.routingInfoCache.delete(entry.bucket_name);
        }
      }
    }
  }
}

