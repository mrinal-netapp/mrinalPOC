import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
/**
 * ConfigSyncManager handles configuration synchronization from config-service
 */
import { BucketConfig, DeploymentConfigResponse } from '../types';
import { HttpClient } from './HttpClient';
import { StorageClassManager } from '../StorageClassManager';
import { RoutingManager } from './RoutingManager';

export interface ConfigSyncManagerConfig {
  configService: string;
  deploymentID: string;
  configSyncInterval: number;
  logLevel?: string;
}

export interface ConfigSyncResult {
  added: string[];
  removed: string[];
  changed: string[];
  newRegistry: Map<string, BucketConfig>;
  configVersion: number;
  namespaces: Set<string>;
}

export class ConfigSyncManager {
  private configVersion: number = 0;
  private lastConfigSync: number;

  constructor(
    private config: ConfigSyncManagerConfig,
    private httpClient: HttpClient,
    private storageClassManager: StorageClassManager,
    private routingManager: RoutingManager
  ) {
    this.lastConfigSync = Math.floor(Date.now() / 1000);
  }

  /**
   * Sync configuration from config-service
   */
  async syncConfig(currentRegistry: Map<string, BucketConfig>): Promise<ConfigSyncResult | null> {
    const syncStartTime = Date.now();
    const currentBucketCount = currentRegistry.size;
    
    logger.info(`[Config Sync] Starting config sync (current version: ${this.configVersion}, buckets: ${currentBucketCount})`);
    
    try {
      const url = `${this.config.configService}/api/v1/deployments/${this.config.deploymentID}/buckets?since=${this.configVersion}`;
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Config Sync] Requesting bucket config from: ${url}`);
      }
      const response = await this.httpClient.request<DeploymentConfigResponse>(url, 'GET');
      
      if (!response || !response.buckets) {
        const syncDuration = Date.now() - syncStartTime;
        logger.info(
          `[Config Sync] Completed in ${syncDuration}ms | ` +
          `No buckets returned from config-service`
        );
        return null;
      }

      // Update bucket registry
      const newRegistry = new Map<string, BucketConfig>();
      for (const bucket of response.buckets) {
        const key = `${bucket.project_id}:${bucket.bucket_name}`;
        newRegistry.set(key, bucket);
      }
      
      // Detect changes
      const added: string[] = [];
      const removed: string[] = [];
      const changed: string[] = [];

      for (const [key, bucket] of newRegistry.entries()) {
        const oldBucket = currentRegistry.get(key);
        if (!oldBucket) {
          added.push(key);
        } else if (oldBucket.role !== bucket.role || 
                   JSON.stringify(oldBucket.volume_info) !== JSON.stringify(bucket.volume_info)) {
          changed.push(key);
        }
      }

      for (const key of currentRegistry.keys()) {
        if (!newRegistry.has(key)) {
          removed.push(key);
        }
      }

      // Update version and timestamp
      this.configVersion = response.config_version;
      this.lastConfigSync = Math.floor(Date.now() / 1000);
      
      // Extract unique namespaces from assigned buckets
      const namespaces = new Set<string>();
      for (const bucket of newRegistry.values()) {
        namespaces.add(bucket.project_id);
      }
      
      // Update known namespaces and sync namespace-wide routing info
      const namespaceChanged = this.routingManager.updateKnownNamespaces(namespaces);
      if (namespaceChanged || added.length > 0 || removed.length > 0) {
        // Sync routing info for all buckets in relevant namespaces
        this.routingManager.syncNamespaceRoutingInfo(namespaces).catch(err => {
          logger.error('[Config Sync] Failed to sync namespace routing info:', err);
        });
      }

      const syncDuration = Date.now() - syncStartTime;
      const newBucketCount = newRegistry.size;
      
      // Log sync result
      this.logSyncResult(added, removed, changed, newRegistry, newBucketCount, currentBucketCount, syncDuration);

      return {
        added,
        removed,
        changed,
        newRegistry,
        configVersion: this.configVersion,
        namespaces
      };
    } catch (error: any) {
      const syncDuration = Date.now() - syncStartTime;
      logger.error(
        `[Config Sync] Failed after ${syncDuration}ms | ` +
        `Error: ${error.message} | ` +
        `Continuing with last known config (${currentBucketCount} buckets)`
      );
      return null;
    }
  }

  /**
   * Get current config version
   */
  getConfigVersion(): number {
    return this.configVersion;
  }

  /**
   * Get last config sync timestamp
   */
  getLastConfigSync(): number {
    return this.lastConfigSync;
  }

  private logSyncResult(
    added: string[],
    removed: string[],
    changed: string[],
    newRegistry: Map<string, BucketConfig>,
    newBucketCount: number,
    currentBucketCount: number,
    syncDuration: number
  ): void {
    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      logger.info(
        `[Config Sync] Completed successfully in ${syncDuration}ms | ` +
        `Version: ${this.configVersion} | ` +
        `Buckets: ${currentBucketCount} → ${newBucketCount} | ` +
        `Added: ${added.length}, Removed: ${removed.length}, Changed: ${changed.length}`
      );
      
      // Log bucket details at info level
      if (added.length > 0) {
        const addedBuckets = added.map(key => {
          const bucket = newRegistry.get(key);
          return bucket ? `${bucket.project_id}/${bucket.bucket_name} (${bucket.role})` : key;
        });
        logger.info(`[Config Sync] Added buckets: ${addedBuckets.join(', ')}`);
      }
      if (removed.length > 0) {
        logger.info(`[Config Sync] Removed buckets: ${removed.join(', ')}`);
      }
      if (changed.length > 0) {
        const changedBuckets = changed.map(key => {
          const bucket = newRegistry.get(key);
          return bucket ? `${bucket.project_id}/${bucket.bucket_name} (${bucket.role})` : key;
        });
        logger.info(`[Config Sync] Changed buckets: ${changedBuckets.join(', ')}`);
      }
    } else {
      // Log all buckets even when no changes
      if (newBucketCount > 0) {
        const bucketList = Array.from(newRegistry.values()).map(b => 
          `${b.project_id}/${b.bucket_name} (${b.role})`
        ).join(', ');
        logger.info(
          `[Config Sync] Completed successfully in ${syncDuration}ms | ` +
          `Version: ${this.configVersion} | ` +
          `Buckets: ${newBucketCount} (no changes) | ` +
          `Current buckets: ${bucketList}`
        );
      } else {
        logger.info(
          `[Config Sync] Completed successfully in ${syncDuration}ms | ` +
          `Version: ${this.configVersion} | ` +
          `Buckets: ${newBucketCount} (no changes)`
        );
      }
    }
  }
}

