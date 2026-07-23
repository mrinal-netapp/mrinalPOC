import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import express, { Request, Response } from 'express';
import * as http from 'http';
import * as https from 'https';
import {
  GetRoutingInfoResponse,
  HealthCheckResponse,
  ErrorResponse,
  Metrics
} from '../types/models';
import { StorageClassManager, StorageClassManagerConfig, BucketStorageClassSpec } from './StorageClassManager';
import { KubernetesErrorHandler } from './storage/utils/KubernetesErrorHandler';
import { BaseServer, BaseServerConfig } from '@agentstudio/common';

// Import types from centralized types file
import type {
  BucketConfig,
  DeploymentConfigResponse,
  BucketRoutingResponse
} from './types';

// Import service modules
import { HttpClient } from './services/HttpClient';
import { RoutingManager } from './services/RoutingManager';
import { ConfigSyncManager } from './services/ConfigSyncManager';
import { VolumeMountSetClient } from './volumeMountSet/VolumeMountSetClient';
import { KubernetesClientFactory } from './storage/factories/KubernetesClientFactory';

export interface ServerConfig extends BaseServerConfig {
  configService: string; // For all config-service APIs (deployment, routing, health/metrics, namespace/bucket)
  deploymentID: string;
  region: string;
  configSyncInterval: number;
  k8sNamespace?: string;
  kubeconfigPath?: string;
}

export class Server extends BaseServer<ServerConfig> {
  private bucketRegistry: Map<string, BucketConfig> = new Map(); // key: "project_id:bucket_name"
  private routingCacheRefreshTimer: NodeJS.Timeout | null = null;
  private configSyncTimer: NodeJS.Timeout | null = null;
  private healthReportTimer: NodeJS.Timeout | null = null;
  private storageClassManager: StorageClassManager;
  private lastHealthReport: number = 0;
  private storageClassUpdateCounter: number = 0;
  private readonly STORAGE_CLASS_UPDATE_INTERVAL = 10; // Update storage classes every 10 health reports
  /** When using VolumeMountSet CR, persist last successful volume mount status so we don't overwrite with healthy on CR read failure */
  private lastVolumeMountStatus: Record<string, { mounted: boolean; status: string }> = {};
  private volumeMountSetClient: VolumeMountSetClient | null = null;

  // Service modules
  private httpClient: HttpClient;
  private routingManager: RoutingManager;
  private configSyncManager: ConfigSyncManager;

  constructor(config: ServerConfig) {
    super(config);
    
    // Initialize HTTP client with service account authentication enabled
    // Service account credentials come from environment variables:
    // KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, KEYCLOAK_CLIENT_SECRET
    this.httpClient = new HttpClient({ 
      logLevel: config.logLevel,
      useServiceAccount: true // Enable service account authentication for service-to-service calls
    });
    
    // Initialize StorageClass Manager
    const scConfig: StorageClassManagerConfig = {
      kubeconfigPath: config.kubeconfigPath
    };
    this.storageClassManager = new StorageClassManager(scConfig);
    
    // Initialize Routing Manager
    this.routingManager = new RoutingManager(
      {
        configService: config.configService,
        logLevel: config.logLevel
      },
      this.httpClient
    );
    
    // Initialize Config Sync Manager
    this.configSyncManager = new ConfigSyncManager(
      {
        configService: config.configService,
        deploymentID: config.deploymentID,
        configSyncInterval: config.configSyncInterval,
        logLevel: config.logLevel
      },
      this.httpClient,
      this.storageClassManager,
      this.routingManager
    );

    if (process.env.USE_VOLUME_MOUNT_SET_CR) {
      const clients = KubernetesClientFactory.createClients(config.kubeconfigPath);
      const crName = process.env.VOLUME_MOUNT_SET_NAME || 's3gateway';
      const targetDeploymentName = process.env.TARGET_DEPLOYMENT_NAME || crName;
      this.volumeMountSetClient = new VolumeMountSetClient({
        customObjectsApi: clients.customObjectsApi,
        namespace: clients.namespace,
        crName,
        targetDeploymentName,
        mountPathBase: '/mnt/pvcs',
        logLevel: config.logLevel
      });
      logger.info(`[VolumeMountSet] CR mode enabled: CR name=${crName}, target deployment=${targetDeploymentName}`);
    }
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  protected setupRoutes(): void {
    // Call parent setupRoutes (Swagger, health endpoints)
    super.setupRoutes();

    // REST API endpoints
    this.getApp().get('/api/v1/routing/info', this.handleGetRoutingInfo.bind(this));
    this.getApp().get('/api/v1/health', this.handleHealthCheck.bind(this));

    // Legacy endpoints
    this.getApp().post('/api/v1/metrics', this.handleMetrics.bind(this));
  }

  async start(): Promise<void> {
    // Start the server using parent implementation
    await super.start();
    logger.info(`System Manager listening on port ${this.config.port}`);
    logger.info(`Ready to sync configuration from: ${this.config.configService}`);
    
    // Register deployment with config-service
    try {
      await this.registerDeployment();
    } catch (error: any) {
      logger.error(`[Server] Failed to register deployment: ${error.message}`);
      // Don't fail startup if registration fails - deployment info is stored durably
      // Health reports will be used to identify active deployments
    }
    
    // Perform initial config sync
    await this.syncConfig();
    // Start periodic config sync
    this.startConfigSync();
    logger.info(`Periodic config sync started (interval: ${this.config.configSyncInterval}ms)`);
    // Start periodic health reporting
    this.startHealthReporting();
    logger.info('Periodic health reporting started (interval: 30s)');
    // Start periodic routing cache refresh
    this.startRoutingCacheRefresh();
    logger.info('Periodic routing cache refresh started (interval: 5 minutes)');
  }

  async shutdown(): Promise<void> {
    // Stop config sync timer
    if (this.configSyncTimer) {
      clearInterval(this.configSyncTimer);
      this.configSyncTimer = null;
    }
    // Stop health reporting timer
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer);
      this.healthReportTimer = null;
    }
    
    // Stop routing cache refresh timer
    if (this.routingCacheRefreshTimer) {
      clearInterval(this.routingCacheRefreshTimer);
      this.routingCacheRefreshTimer = null;
    }
    
    // Call parent shutdown
    await super.shutdown();
  }

  // Override health endpoint for custom response format
  protected handleHealth(req: Request, res: Response): void {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      status: 'healthy',
      last_config_sync: new Date().toISOString()
    });
  }

  // handleReady is provided by BaseServer - no override needed

  private handleMetrics(req: Request, res: Response): void {
    // Placeholder for metrics submission
    const metrics = req.body as Metrics;
    logger.info('Received metrics:', metrics);
    res.json({ status: 'accepted' });
  }

  // handleGetRoutingInfo handles GET /api/v1/routing/info?bucket_name=xxx&project_id=yyy
  private async handleGetRoutingInfo(req: Request, res: Response): Promise<void> {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' } as ErrorResponse);
      return;
    }

    const bucketName = req.query.bucket_name as string;
    const projectId = req.query.project_id as string | undefined;

    if (!bucketName) {
      res.status(400).json({
        error: 'bucket_name is required',
        code: 'INVALID_REQUEST'
      } as ErrorResponse);
      return;
    }

    try {
      // Use RoutingManager to get routing info
      const routingInfo = await this.routingManager.getRoutingInfo(
        bucketName,
        projectId,
        this.bucketRegistry
      );

      if (!routingInfo) {
        res.status(404).json({
          error: `Bucket "${bucketName}" not found. project_id is required for remote bucket routing.`,
          code: 'NOT_FOUND'
        } as ErrorResponse);
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      res.json(routingInfo);
    } catch (error: any) {
      logger.error('Error getting routing info:', error);
      res.status(500).json({
        error: error.message || 'Failed to get routing info',
        code: 'INTERNAL_ERROR'
      } as ErrorResponse);
    }
  }

  // handleHealthCheck handles GET /api/v1/health
  private handleHealthCheck(req: Request, res: Response): void {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' } as ErrorResponse);
      return;
    }

    const response: HealthCheckResponse = {
      healthy: true,
      status_message: 'Proxy manager is healthy',
      last_config_sync: this.configSyncManager.getLastConfigSync()
    };

    res.setHeader('Content-Type', 'application/json');
    res.json(response);
  }

  // syncConfig pulls configuration from config-service
  private async syncConfig(): Promise<void> {
    // Use ConfigSyncManager to sync configuration
    const result = await this.configSyncManager.syncConfig(this.bucketRegistry);
    
    if (result) {
      // Update bucket registry
      this.bucketRegistry = result.newRegistry;
      
      // Create/update/delete StorageClasses based on changes
      try {
        await this.syncStorageClasses(result.added, result.removed, result.changed, result.newRegistry);
      } catch (error: any) {
        logger.error(`[Config Sync] Failed to sync StorageClasses: ${error.message}`);
      }
    }
  }

  // startConfigSync starts periodic config sync
  private startConfigSync(): void {
    if (this.configSyncTimer) {
      clearInterval(this.configSyncTimer);
    }
    this.configSyncTimer = setInterval(() => {
      this.syncConfig().catch(err => {
        logger.error('Periodic config sync error:', err);
      });
    }, this.config.configSyncInterval);
  }

  // stopConfigSync stops periodic config sync
  private stopConfigSync(): void {
    if (this.configSyncTimer) {
      clearInterval(this.configSyncTimer);
      this.configSyncTimer = null;
      logger.info('[Config Sync] Stopped periodic config sync');
    }
  }

  // startHealthReporting starts periodic health reporting to config-service
  private startHealthReporting(): void {
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer);
      logger.info('[Health Report] Restarting health reporting timer');
    }
    
    logger.info(
      `[Health Report] Starting periodic health reporting | ` +
      `Interval: 30s | ` +
      `Deployment: ${this.config.deploymentID} | ` +
      `Config Service: ${this.config.configService}`
    );
    
    // Report health every 30 seconds
    this.healthReportTimer = setInterval(() => {
      logger.info(`[Health Report] Triggering periodic health report (interval: 30s)`);
      this.reportHealth().catch(err => {
        logger.error('[Health Report] Periodic health report error:', err);
      });
    }, 30000);
    
    // Report immediately on startup
    logger.info('[Health Report] Scheduling initial health report in 5 seconds');
    setTimeout(() => {
      logger.info('[Health Report] Triggering initial health report');
      this.reportHealth().catch(err => {
        logger.error('[Health Report] Initial health report error:', err);
      });
    }, 5000); // Wait 5 seconds after startup
  }

  // stopHealthReporting stops periodic health reporting
  private stopHealthReporting(): void {
    if (this.healthReportTimer) {
      clearInterval(this.healthReportTimer);
      this.healthReportTimer = null;
      logger.info('[Health Report] Stopped periodic health reporting');
    }
  }

  // startRoutingCacheRefresh starts periodic refresh of routing info cache
  private startRoutingCacheRefresh(): void {
    if (this.routingCacheRefreshTimer) {
      clearInterval(this.routingCacheRefreshTimer);
      logger.info('[Routing Cache] Restarting routing cache refresh timer');
    }
    
    // Refresh cache every 5 minutes
    const refreshInterval = 5 * 60 * 1000; // 5 minutes
    
    this.routingCacheRefreshTimer = setInterval(() => {
      this.refreshRoutingCache().catch(err => {
        logger.error('[Routing Cache] Periodic cache refresh error:', err);
      });
    }, refreshInterval);
    
    // Perform initial refresh after a short delay
    setTimeout(() => {
      this.refreshRoutingCache().catch(err => {
        logger.error('[Routing Cache] Initial cache refresh error:', err);
      });
    }, 10000); // Wait 10 seconds after startup
  }

  // stopRoutingCacheRefresh stops periodic routing cache refresh
  private stopRoutingCacheRefresh(): void {
    if (this.routingCacheRefreshTimer) {
      clearInterval(this.routingCacheRefreshTimer);
      this.routingCacheRefreshTimer = null;
      logger.info('[Routing Cache] Stopped periodic routing cache refresh');
    }
  }

  // refreshRoutingCache refreshes routing info for all cached buckets and namespace routing registry
  private async refreshRoutingCache(): Promise<void> {
    // Use RoutingManager to refresh cache
    await this.routingManager.refreshCache();
  }

  // registerDeployment registers this deployment with config-service
  private async registerDeployment(): Promise<void> {
    try {
      // Get HTTPS endpoint (default, used for most operations)
      // Falls back to HTTP endpoint if HTTPS not available, then to constructed URL
      const httpsEndpoint = process.env.DEPLOYMENT_HTTPS_ENDPOINT || 
        process.env.DEPLOYMENT_ENDPOINT || 
        `https://${this.config.deploymentID}:${this.config.port}`;
      
      // Get HTTP endpoint (used for internal operations like Lakekeeper)
      // Falls back to constructed URL if not available
      const httpEndpoint = process.env.DEPLOYMENT_HTTP_ENDPOINT || 
        `http://${this.config.deploymentID}:${this.config.port}`;
      
      // Discover available storage classes from the cluster
      let storageClasses: string[] = [];
      try {
        storageClasses = await this.storageClassManager.listAllAvailableStorageClasses();
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Registration] Discovered ${storageClasses.length} storage classes: ${storageClasses.join(', ')}`);
        }
      } catch (error: any) {
        logger.warn(`[Registration] Failed to discover storage classes: ${error.message}`);
        // Continue registration even if storage class discovery fails
      }
      
      const registrationRequest = {
        id: this.config.deploymentID,
        region: this.config.region,
        endpoint: httpsEndpoint, // HTTPS endpoint (default, used for most operations)
        http_endpoint: httpEndpoint, // HTTP endpoint (used for internal operations like Lakekeeper)
        // Optional: capacity and capabilities can be added via environment variables
        capacity: process.env.DEPLOYMENT_MAX_BUCKETS || process.env.DEPLOYMENT_MAX_STORAGE_TB ? {
          max_buckets: process.env.DEPLOYMENT_MAX_BUCKETS ? parseInt(process.env.DEPLOYMENT_MAX_BUCKETS, 10) : undefined,
          max_storage_tb: process.env.DEPLOYMENT_MAX_STORAGE_TB ? parseInt(process.env.DEPLOYMENT_MAX_STORAGE_TB, 10) : undefined,
        } : undefined,
        capabilities: process.env.DEPLOYMENT_CAPABILITIES ? 
          process.env.DEPLOYMENT_CAPABILITIES.split(',').map(c => c.trim()) : undefined,
        storage_classes: storageClasses.length > 0 ? storageClasses : undefined
      };

      const url = `${this.config.configService}/api/v1/deployments`;
      
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Registration] Registering deployment: ${this.config.deploymentID}`);
        logger.debug(`[Registration] HTTPS Endpoint: ${httpsEndpoint}, HTTP Endpoint: ${httpEndpoint}, Region: ${this.config.region}`);
      }

      try {
        await this.httpRequest(url, 'POST', registrationRequest);
        logger.info(
          `[Registration] Successfully registered deployment ${this.config.deploymentID} ` +
          `(region: ${this.config.region}, https_endpoint: ${httpsEndpoint}, http_endpoint: ${httpEndpoint})`
        );
      } catch (error: any) {
        // If deployment already exists (409), that's okay - try to update instead
        if (error.statusCode === 409 || error.message?.includes('already exists') || error.message?.includes('CONFLICT')) {
          if (this.config.logLevel === 'debug') {
            logger.debug(`[Registration] Deployment ${this.config.deploymentID} already registered, updating...`);
          }
          // Try to update the deployment instead
          try {
            const updateUrl = `${this.config.configService}/api/v1/deployments/${this.config.deploymentID}`;
            await this.httpRequest(updateUrl, 'PUT', {
              region: this.config.region,
              endpoint: httpsEndpoint,
              http_endpoint: httpEndpoint,
              capacity: registrationRequest.capacity,
              capabilities: registrationRequest.capabilities,
              storage_classes: registrationRequest.storage_classes
            });
            if (this.config.logLevel === 'debug') {
              logger.debug(`[Registration] Updated deployment ${this.config.deploymentID}`);
            }
          } catch (updateError: any) {
            // If update also fails, log but don't fail - registration is stored durably
            logger.warn(`[Registration] Failed to update deployment: ${updateError.message}`);
          }
        } else {
          throw error; // Re-throw if it's not a "already exists" error
        }
      }
    } catch (error: any) {
      logger.error(
        `[Registration] Failed to register deployment ${this.config.deploymentID}: ${error.message}`
      );
      // Don't throw - registration failures shouldn't crash the service
      // Deployment registration is stored durably by config-service
      // Health reports will be used to identify active deployments
    }
  }

  // updateStorageClasses updates the storage classes list in config-service
  private async updateStorageClasses(): Promise<void> {
    try {
      // Discover available storage classes from the cluster
      const storageClasses = await this.storageClassManager.listAllAvailableStorageClasses();
      
      if (storageClasses.length === 0) {
        if (this.config.logLevel === 'debug') {
          logger.debug('[Storage Class Update] No storage classes found, skipping update');
        }
        return;
      }

      // Update deployment with latest storage classes
      const updateUrl = `${this.config.configService}/api/v1/deployments/${this.config.deploymentID}`;
      await this.httpRequest(updateUrl, 'PUT', {
        storage_classes: storageClasses
      });

      if (this.config.logLevel === 'debug') {
        logger.debug(
          `[Storage Class Update] Successfully updated storage classes: ${storageClasses.join(', ')}`
        );
      }
    } catch (error: any) {
      // Don't log as error if it's a 404 (deployment not found) - might be transient
      if (error.statusCode === 404) {
        if (this.config.logLevel === 'debug') {
          logger.debug(`[Storage Class Update] Deployment not found, skipping update`);
        }
      } else {
        logger.warn(`[Storage Class Update] Failed to update storage classes: ${error.message}`);
      }
    }
  }

  // reportHealth collects health information and reports it to config-service
  private async reportHealth(): Promise<void> {
    const reportStartTime = Date.now();
    
    logger.info(`[Health Report] Starting health report collection for deployment: ${this.config.deploymentID}`);
    
    try {
      // Collect health information from PVCs (works for both static and dynamic provisioning)
      let overallHealthy = true;
      const volumeMountStatus: Record<string, { mounted: boolean; status: string }> = {};
      let statusMessage = 'All buckets healthy';

      try {
        // Get all PVCs created by storage-manager (includes both static and dynamic volumes)
        logger.info(`[Health Report] Collecting PVC health information...`);
        const pvcMap = await this.storageClassManager.listVersitygwPVCs();
        logger.info(`[Health Report] Found ${pvcMap.size} PVC(s) managed by storage-manager`);
        const pvcBucketKeys = new Set<string>();

        const useCR = Boolean(this.volumeMountSetClient);
        let crStatus: Awaited<ReturnType<VolumeMountSetClient['getStatus']>> = null;
        if (useCR) {
          try {
            crStatus = await this.volumeMountSetClient!.getStatus();
          } catch (crError: any) {
            logger.error(`[Health Report] Failed to read VolumeMountSet CR status: ${crError.message}`);
            if (Object.keys(this.lastVolumeMountStatus).length > 0) {
              Object.assign(volumeMountStatus, this.lastVolumeMountStatus);
              logger.info(`[Health Report] Using last known volume mount status (CR read failed)`);
            }
            overallHealthy = false;
          }
          if (crStatus && crStatus.conditions?.some((c: { type: string }) => c.type === 'TargetNotFound')) {
            const cond = crStatus.conditions.find((c: { type: string; message?: string }) => c.type === 'TargetNotFound');
            overallHealthy = false;
            statusMessage = cond?.message || 'VolumeMountSet target deployment not found';
          }
        }

        // Check PVC status for all buckets with PVCs (or overlay CR status when using CR)
        for (const [bucketKey, pvcInfo] of pvcMap.entries()) {
          pvcBucketKeys.add(bucketKey);
          const { status, statusMessage: pvcStatusMessage, pvc } = pvcInfo;
          const pvcName = pvc.metadata?.name || 'unknown';

          let mounted = false;
          let healthStatus = pvcStatusMessage;

          if (useCR && crStatus) {
            const evicted = (crStatus.evictedPvcNames || []).includes(pvcName);
            const cond = (crStatus.pvcConditions || []).find((c: { pvcName: string }) => c.pvcName === pvcName);
            if (evicted || (cond && !cond.mounted)) {
              mounted = false;
              healthStatus = cond?.message || 'Evicted due to mount failure';
              overallHealthy = false;
              if (statusMessage === 'All buckets healthy') {
                const bucket = this.bucketRegistry.get(bucketKey);
                statusMessage = `Bucket ${bucket?.bucket_name || bucketKey} mount failed`;
              }
              logger.warn(`[Health Report] ✗ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
            } else {
              // Use PVC-based status
              switch (status) {
                case 'bound':
                  mounted = cond?.mounted ?? true;
                  healthStatus = cond?.message || 'PVC bound - volume ready';
                  if (mounted) logger.info(`[Health Report] ✓ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
                  break;
                case 'pending':
                  const bucketPending = this.bucketRegistry.get(bucketKey);
                  const isDynamic = bucketPending?.volume_info?.provisioning_mode === 'dynamic';
                  mounted = isDynamic;
                  healthStatus = isDynamic ? 'PVC pending - waiting for dynamic provisioner' : 'PVC pending - PV should be created for static provisioning';
                  if (!isDynamic) overallHealthy = false;
                  break;
                case 'lost':
                case 'failed':
                  mounted = false;
                  overallHealthy = false;
                  healthStatus = `PVC ${status} - ${pvcStatusMessage}`;
                  break;
                default:
                  mounted = false;
                  overallHealthy = false;
                  healthStatus = `PVC status unknown: ${pvcStatusMessage}`;
              }
            }
          } else if (!useCR || Object.keys(volumeMountStatus).length === 0) {
            // Legacy PVC-only or first run when CR read failed and no lastVolumeMountStatus
            switch (status) {
              case 'bound':
                mounted = true;
                healthStatus = `PVC bound - volume ready`;
                logger.info(`[Health Report] ✓ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
                break;
              case 'pending':
                const bucket = this.bucketRegistry.get(bucketKey);
                const isDynamic = bucket?.volume_info?.provisioning_mode === 'dynamic';
                if (isDynamic) {
                  mounted = true;
                  healthStatus = `PVC pending - waiting for dynamic provisioner`;
                  logger.info(`[Health Report] ⏳ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus} (dynamic provisioning)`);
                } else {
                  mounted = false;
                  overallHealthy = false;
                  healthStatus = `PVC pending - PV should be created for static provisioning`;
                  logger.warn(`[Health Report] ✗ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
                  if (statusMessage === 'All buckets healthy') statusMessage = `Bucket ${bucket?.bucket_name || bucketKey} PVC pending`;
                }
                break;
              case 'lost':
              case 'failed':
                mounted = false;
                overallHealthy = false;
                healthStatus = `PVC ${status} - ${pvcStatusMessage}`;
                logger.error(`[Health Report] ✗ Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
                if (statusMessage === 'All buckets healthy') {
                  const bucket = this.bucketRegistry.get(bucketKey);
                  statusMessage = `Bucket ${bucket?.bucket_name || bucketKey} PVC ${status}`;
                }
                break;
              default:
                mounted = false;
                overallHealthy = false;
                healthStatus = `PVC status unknown: ${pvcStatusMessage}`;
                logger.warn(`[Health Report] ? Bucket ${bucketKey} (PVC: ${pvcName}): ${healthStatus}`);
                if (statusMessage === 'All buckets healthy') {
                  const bucket = this.bucketRegistry.get(bucketKey);
                  statusMessage = `Bucket ${bucket?.bucket_name || bucketKey} PVC status unknown`;
                }
            }
          }

          volumeMountStatus[bucketKey] = { mounted, status: healthStatus };
        }

        if (useCR && crStatus) {
          this.lastVolumeMountStatus = { ...volumeMountStatus };
        }

        if (useCR && !crStatus) {
          overallHealthy = false;
          if (Object.keys(volumeMountStatus).length === 0) {
            for (const bucketKey of pvcBucketKeys) {
              volumeMountStatus[bucketKey] = {
                mounted: false,
                status: 'Failed to read VolumeMountSet status'
              };
            }
            if (statusMessage === 'All buckets healthy') statusMessage = 'VolumeMountSet CR unavailable';
          } else if (statusMessage === 'All buckets healthy') {
            statusMessage = 'VolumeMountSet CR status unavailable; using last known status';
          }
        }

        // Check if we have buckets in registry without PVCs
        const bucketsWithoutPVCs: string[] = [];
        for (const [bucketKey, bucket] of this.bucketRegistry.entries()) {
          if (!pvcBucketKeys.has(bucketKey)) {
            overallHealthy = false;
            bucketsWithoutPVCs.push(bucketKey);
            statusMessage = `Bucket ${bucket.bucket_name || bucketKey} missing PVC`;
            volumeMountStatus[bucketKey] = {
              mounted: false,
              status: 'PVC not found - should be created by storage-manager'
            };
            logger.warn(
              `[Health Report] ✗ Bucket ${bucketKey}: PVC not found - should be created by storage-manager`
            );
          }
        }
        if (bucketsWithoutPVCs.length > 0) {
          logger.info(
            `[Health Report] Found ${bucketsWithoutPVCs.length} bucket(s) in registry without PVCs: ${bucketsWithoutPVCs.join(', ')}`
          );
        }
      } catch (error: any) {
        logger.error(`[Health Report] Failed to collect PVC health info: ${error.message}`);
        // Mark all buckets as unknown if PVC check fails
        for (const [bucketKey, bucket] of this.bucketRegistry.entries()) {
          if (!volumeMountStatus[bucketKey]) {
            overallHealthy = false;
            volumeMountStatus[bucketKey] = {
              mounted: false,
              status: `Failed to check PVC status: ${error.message}`
            };
          }
        }
        if (statusMessage === 'All buckets healthy') {
          statusMessage = 'Failed to check PVC health status';
        }
      }

      // Prepare bucket-level health reports
      const bucketHealth: Array<{
        project_id: string;
        bucket_name: string;
        healthy: boolean;
        status_message?: string;
        volume_mount_status?: { mounted: boolean; status: string };
      }> = [];

      // Build bucket health from volume mount status
      for (const [bucketKey, mountStatus] of Object.entries(volumeMountStatus)) {
        const [projectId, bucketName] = bucketKey.split(':');
        if (projectId && bucketName) {
          bucketHealth.push({
            project_id: projectId,
            bucket_name: bucketName,
            healthy: mountStatus.mounted,
            status_message: mountStatus.status,
            volume_mount_status: {
              mounted: mountStatus.mounted,
              status: mountStatus.status
            }
          });
        }
      }

      // Prepare health report
      const healthReport = {
        deployment_id: this.config.deploymentID,
        timestamp: new Date().toISOString(),
        healthy: overallHealthy,
        status_message: statusMessage,
        volume_mount_status: Object.keys(volumeMountStatus).length > 0 ? volumeMountStatus : undefined,
        bucket_health: bucketHealth.length > 0 ? bucketHealth : undefined
      };

      // Log health report summary
      logger.info(
        `[Health Report] Health summary: ${overallHealthy ? 'HEALTHY' : 'UNHEALTHY'} | ` +
        `Buckets checked: ${Object.keys(volumeMountStatus).length} | ` +
        `Status: ${statusMessage}`
      );

      // Send health report to config-service
      const url = `${this.config.configService}/api/v1/deployments/${this.config.deploymentID}/health`;
      
      logger.info(`[Health Report] Sending health report to: ${url}`);
      if (this.config.logLevel === 'debug') {
        logger.debug(`[Health Report] Payload:`, JSON.stringify(healthReport, null, 2));
      } else {
        // Log a summary of the payload in non-debug mode
        logger.info(
          `[Health Report] Payload summary: ` +
          `deployment_id=${healthReport.deployment_id}, ` +
          `healthy=${healthReport.healthy}, ` +
          `buckets=${bucketHealth.length}, ` +
          `volume_mounts=${Object.keys(volumeMountStatus).length}`
        );
      }

      await this.httpRequest(url, 'POST', healthReport);
      logger.info(`[Health Report] Successfully sent health report to config-service`);
      
      const reportDuration = Date.now() - reportStartTime;
      this.lastHealthReport = Date.now();
      
      // Periodically update storage classes (every N health reports)
      this.storageClassUpdateCounter++;
      if (this.storageClassUpdateCounter >= this.STORAGE_CLASS_UPDATE_INTERVAL) {
        this.storageClassUpdateCounter = 0;
        logger.info(`[Health Report] Triggering periodic storage class update (every ${this.STORAGE_CLASS_UPDATE_INTERVAL} health reports)`);
        // Update storage classes in background (don't block health report)
        this.updateStorageClasses().catch(err => {
          logger.warn(`[Health Report] Failed to update storage classes: ${err.message}`);
        });
      }
      
      logger.info(
        `[Health Report] Completed health report in ${reportDuration}ms | ` +
        `Overall: ${overallHealthy ? 'HEALTHY' : 'UNHEALTHY'} | ` +
        `Buckets: ${Object.keys(volumeMountStatus).length} | ` +
        `Next report in 30s`
      );
    } catch (error: any) {
      const reportDuration = Date.now() - reportStartTime;
      logger.error(
        `[Health Report] Failed after ${reportDuration}ms | ` +
        `Error: ${error.message} | ` +
        `Stack: ${error.stack || 'N/A'}`
      );
      // Don't throw - health reporting failures shouldn't crash the service
    }
  }

  // httpRequest makes HTTP/HTTPS requests - delegates to HttpClient
  private httpRequest<T>(url: string, method: string = 'GET', body?: any): Promise<T> {
    return this.httpClient.request<T>(url, method, body);
  }

  /**
   * syncStorageClasses creates, updates, or deletes StorageClasses based on bucket ownership changes
   * Also creates/updates Secrets for auth info
   * Also reconciles existing StorageClasses to ensure they match the bucket registry
   */
  private async syncStorageClasses(
    added: string[],
    removed: string[],
    changed: string[],
    registry: Map<string, BucketConfig>
  ): Promise<void> {
    // Track PVCs created in this sync cycle to avoid removing them during reconciliation
    const newlyCreatedPVCNames = new Set<string>();
    
    // Create StorageClasses for newly added buckets
    for (const key of added) {
      const bucket = registry.get(key);
      if (!bucket) continue;

      // Skip PVC creation for global/helm-provisioned buckets (e.g. default-nemo)
      if (bucket.provisioning_source === 'helm' || bucket.skip_pvc_create) {
        logger.info(
          `[StorageClass Sync] Skipping PVC creation for helm-provisioned bucket: ${bucket.project_id}/${bucket.bucket_name}`
        );
        continue;
      }

      try {
        const spec: BucketStorageClassSpec = {
          project_id: bucket.project_id,
          bucket_name: bucket.bucket_name,
          volume_info: bucket.volume_info,
          auth_info: bucket.auth_info,
          protocol: bucket.protocol,
          role: bucket.role,
          // NEW: Add provisioning mode and related fields
          provisioning_mode: bucket.volume_info.provisioning_mode || 'static',
          storage_class_name: bucket.volume_info.storage_class_name,
          storage_size: bucket.volume_info.storage_size,
        };

        // Validate provisioning mode requirements
        if (spec.provisioning_mode === 'dynamic' && !spec.storage_class_name) {
          logger.error(
            `[StorageClass Sync] Bucket ${key} has dynamic provisioning_mode but no storage_class_name. ` +
            `Skipping bucket.`
          );
          continue;
        }

        const storageClass = await this.storageClassManager.createOrUpdateStorageClass(spec);
        // Create PVC for the StorageClass (with spec for both static and dynamic provisioning)
        try {
          const pvcName = await this.storageClassManager.createOrUpdatePVC(storageClass, bucket.bucket_name, spec);
          newlyCreatedPVCNames.add(pvcName);
          logger.info(
            `[StorageClass Sync] Created StorageClass and PVC for bucket: ${bucket.project_id}/${bucket.bucket_name} ` +
            `(provisioning: ${spec.provisioning_mode}, role: ${bucket.role}, protocol: ${bucket.protocol}, volume: ${bucket.volume_info.type})`
          );
        } catch (pvcError: any) {
          // Log detailed error information
          const errorDetails: string[] = [];
          if (pvcError.statusCode) errorDetails.push(`Status: ${pvcError.statusCode}`);
          if (pvcError.body?.message) errorDetails.push(`Message: ${pvcError.body.message}`);
          if (pvcError.body?.reason) errorDetails.push(`Reason: ${pvcError.body.reason}`);
          
          const errorMsg = errorDetails.length > 0 
            ? `${pvcError.message} (${errorDetails.join(', ')})`
            : pvcError.message;
          
          logger.error(
            `[StorageClass Sync] Failed to create PVC for bucket ${bucket.project_id}/${bucket.bucket_name}: ${errorMsg}`
          );
          
          // If it's a permissions error, log a helpful message
          if (pvcError.statusCode === 403 || pvcError.message?.includes('forbidden') || pvcError.message?.includes('permission')) {
            logger.error(
              `[StorageClass Sync] Permission denied creating PVC. Ensure ServiceAccount has 'create' permission ` +
              `on 'persistentvolumeclaims' resource in namespace '${this.config.k8sNamespace || 'default'}'. ` +
              `Check RBAC configuration.`
            );
          }
          
          // Continue - StorageClass was created successfully, PVC can be retried
        }
      } catch (error: any) {
        // Log detailed error information for StorageClass creation failures
        const errorDetails: string[] = [];
        if (error.statusCode) errorDetails.push(`Status: ${error.statusCode}`);
        if (error.body?.message) errorDetails.push(`Message: ${error.body.message}`);
        if (error.body?.reason) errorDetails.push(`Reason: ${error.body.reason}`);
        if (error.body?.details) {
          if (error.body.details.causes) {
            const causes = error.body.details.causes.map((c: any) => 
              `${c.field}: ${c.message}`
            ).join('; ');
            errorDetails.push(`Validation Errors: ${causes}`);
          }
          if (error.body.details.name) {
            errorDetails.push(`Resource: ${error.body.details.name}`);
          }
        }
        
        // Check if this is an expected 404 (StorageClass doesn't exist yet)
        // This should be handled internally by createOrUpdateStorageClass, but log appropriately if it bubbles up
        const isNotFound = KubernetesErrorHandler.isNotFoundError(error);
        
        if (!isNotFound) {
          // Log detailed error information for non-404 errors
          const errorMsg = errorDetails.length > 0 
            ? `${error.message} (${errorDetails.join(', ')})`
            : error.message;
          
          logger.error(
            `[StorageClass Sync] Failed to create StorageClass for bucket ${key} ` +
            `(${bucket.project_id}/${bucket.bucket_name}): ${errorMsg}`
          );
          
          // Log full error details in debug mode
          if (this.config.logLevel === 'debug' || process.env.LOG_LEVEL === 'debug') {
            logger.debug(`[StorageClass Sync] Full error object:`, JSON.stringify(error, null, 2).substring(0, 1000));
          }
        } else {
          // 404 errors should be handled internally, but log as warning if they bubble up
          logger.warn(
            `[StorageClass Sync] StorageClass not found for bucket ${key} ` +
            `(${bucket.project_id}/${bucket.bucket_name}). ` +
            `This may indicate a transient issue - will retry on next sync.`
          );
        }
        
        // Provide helpful hints for common errors
        if (error.statusCode === 403 || error.message?.includes('forbidden') || error.message?.includes('permission')) {
          logger.error(
            `[StorageClass Sync] Permission denied creating StorageClass. Ensure ServiceAccount has 'create' permission ` +
            `on 'storageclasses' resource. Check RBAC configuration.`
          );
        } else if (error.statusCode === 422) {
          logger.error(
            `[StorageClass Sync] StorageClass spec validation failed. Check: ` +
            `- StorageClass name is valid (RFC 1123 subdomain), ` +
            `- Provisioner is valid, ` +
            `- Parameters are correctly formatted`
          );
        } else if (error.statusCode === 409) {
          logger.warn(
            `[StorageClass Sync] StorageClass already exists (race condition). This is usually harmless.`
          );
        }
      }
    }

    // Update StorageClasses for changed buckets
    for (const key of changed) {
      const bucket = registry.get(key);
      if (!bucket) continue;

      // Skip PVC creation/update for global/helm-provisioned buckets
      if (bucket.provisioning_source === 'helm' || bucket.skip_pvc_create) {
        logger.info(
          `[StorageClass Sync] Skipping PVC update for helm-provisioned bucket: ${bucket.project_id}/${bucket.bucket_name}`
        );
        continue;
      }

      try {
        const spec: BucketStorageClassSpec = {
          project_id: bucket.project_id,
          bucket_name: bucket.bucket_name,
          volume_info: bucket.volume_info,
          auth_info: bucket.auth_info,
          protocol: bucket.protocol,
          role: bucket.role,
          // NEW: Add provisioning mode and related fields
          provisioning_mode: bucket.volume_info.provisioning_mode || 'static',
          storage_class_name: bucket.volume_info.storage_class_name,
          storage_size: bucket.volume_info.storage_size,
        };

        // Validate provisioning mode requirements
        if (spec.provisioning_mode === 'dynamic' && !spec.storage_class_name) {
          logger.error(
            `[StorageClass Sync] Bucket ${key} has dynamic provisioning_mode but no storage_class_name. ` +
            `Skipping bucket update.`
          );
          continue;
        }

        const storageClass = await this.storageClassManager.createOrUpdateStorageClass(spec);
        // Update PVC for the StorageClass (with spec for both static and dynamic provisioning)
        try {
          const pvcName = await this.storageClassManager.createOrUpdatePVC(storageClass, bucket.bucket_name, spec);
          // Track updated PVCs as well to avoid race conditions
          newlyCreatedPVCNames.add(pvcName);
          logger.info(
            `[StorageClass Sync] Updated StorageClass and PVC for bucket: ${bucket.project_id}/${bucket.bucket_name} ` +
            `(provisioning: ${spec.provisioning_mode}, role: ${bucket.role}, protocol: ${bucket.protocol}, volume: ${bucket.volume_info.type})`
          );
        } catch (pvcError: any) {
          logger.error(
            `[StorageClass Sync] Failed to update PVC for bucket ${bucket.project_id}/${bucket.bucket_name}: ` +
            pvcError.message
          );
          // Continue - StorageClass was updated successfully, PVC can be retried
        }
      } catch (error: any) {
        logger.error(
          `[StorageClass Sync] Failed to update StorageClass for bucket ${key} ` +
          `(${bucket.project_id}/${bucket.bucket_name}): ${error.message}`
        );
      }
    }

    // Delete StorageClasses for removed buckets
    for (const key of removed) {
      // Parse project_id and bucket_name from key
      const [projectId, ...bucketParts] = key.split(':');
      const bucketName = bucketParts.join(':'); // Handle bucket names with colons

      try {
        await this.storageClassManager.deleteStorageClass(projectId, bucketName);
        logger.info(`[StorageClass Sync] Deleted StorageClass for bucket: ${projectId}/${bucketName}`);
      } catch (error: any) {
        logger.error(`[StorageClass] Failed to delete StorageClass for bucket ${key}:`, error.message);
      }
    }

    // Reconcile: Check for orphaned StorageClasses that don't match any bucket in registry
    try {
      const existingStorageClasses = await this.storageClassManager.listStorageClasses();
      const registryKeys = new Set(registry.keys());
      let orphanedCount = 0;

      for (const sc of existingStorageClasses) {
        const bucketName = sc.metadata?.labels?.['agentstudio.io/bucket-name'];
        const projectId = sc.metadata?.labels?.['agentstudio.io/project-id'];
        
        if (!bucketName || !projectId) {
          continue; // Skip StorageClasses without proper labels
        }

        const scKey = `${projectId}:${bucketName}`;
        
        // If StorageClass doesn't have a corresponding bucket in registry, it's orphaned
        if (!registryKeys.has(scKey)) {
          orphanedCount++;
          try {
            await this.storageClassManager.deleteStorageClass(projectId, bucketName);
            logger.info(
              `[StorageClass Reconciliation] Deleted orphaned StorageClass for bucket: ${bucketName} ` +
              `(${scKey}) - not in bucket registry`
            );
          } catch (error: any) {
            logger.error(
              `[StorageClass Reconciliation] Failed to delete orphaned StorageClass for ${scKey}:`,
              error.message
            );
          }
        }
      }

      if (orphanedCount > 0) {
        logger.info(
          `[StorageClass Reconciliation] Cleaned up ${orphanedCount} orphaned StorageClass(es) ` +
          `that didn't match bucket registry`
        );
      } else if (existingStorageClasses.length > 0) {
        logger.info(
          `[StorageClass Reconciliation] All ${existingStorageClasses.length} StorageClass(es) match bucket registry`
        );
      }
    } catch (error: any) {
      logger.error(`[StorageClass Reconciliation] Failed to reconcile StorageClasses:`, error.message);
      // Don't throw - reconciliation failure shouldn't break sync
    }

    // Reconcile orphaned PVCs: Clean up PVCs that don't have associated buckets
    // This acts as a controller to ensure no excess or unreleased PVCs exist
    // Specifically focuses on dynamic buckets as they may have PVCs allocated without proper tracking
    try {
      // Convert registry to format expected by reconcileOrphanedPVCs
      const registryForValidation = new Map<string, { 
        project_id: string; 
        bucket_name: string;
        volume_info?: {
          provisioning_mode?: 'static' | 'dynamic';
          storage_class_name?: string;
        };
      }>();
      for (const [key, bucket] of registry.entries()) {
        registryForValidation.set(key, {
          project_id: bucket.project_id,
          bucket_name: bucket.bucket_name,
          volume_info: bucket.volume_info
        });
      }
      const orphanedCount = await this.storageClassManager.reconcileOrphanedPVCs(registryForValidation);
      if (orphanedCount > 0 && this.config.logLevel === 'debug') {
        logger.debug(
          `[PVC Reconciliation] Cleaned up ${orphanedCount} orphaned PVC(s) during sync`
        );
      }
    } catch (error: any) {
      logger.error(`[PVC Reconciliation] Failed to reconcile orphaned PVCs:`, error.message);
      // Don't throw - reconciliation failure shouldn't break sync
    }

    // Reconcile deployment: Remove orphaned PVC mounts (or update VolumeMountSet CR when using CR mode)
    try {
      if (this.volumeMountSetClient) {
        // VolumeMountSet CR mode: desiredPvcNames must exclude helm/skip_pvc_create buckets
        const registryForCR = new Map<string, {
          project_id: string;
          bucket_name: string;
          volume_info?: {
            provisioning_mode?: 'static' | 'dynamic';
            storage_class_name?: string;
          };
        }>();
        for (const [key, bucket] of registry.entries()) {
          if (bucket.provisioning_source === 'helm' || bucket.skip_pvc_create) continue;
          registryForCR.set(key, {
            project_id: bucket.project_id,
            bucket_name: bucket.bucket_name,
            volume_info: bucket.volume_info
          });
        }
        const desiredPvcNames = this.storageClassManager.getValidPVCNames(registryForCR);
        await this.volumeMountSetClient.createOrUpdate({
          desiredPvcNames: Array.from(desiredPvcNames),
          mountPathBase: '/mnt/pvcs'
        });
        if (this.config.logLevel === 'debug') {
          logger.debug(`[VolumeMountSet] Updated CR with ${desiredPvcNames.size} desired PVC(s)`);
        }
      } else {
        // Legacy: direct deployment reconciliation
        const registryForValidation = new Map<string, {
          project_id: string;
          bucket_name: string;
          volume_info?: {
            provisioning_mode?: 'static' | 'dynamic';
            storage_class_name?: string;
          };
        }>();
        for (const [key, bucket] of registry.entries()) {
          registryForValidation.set(key, {
            project_id: bucket.project_id,
            bucket_name: bucket.bucket_name,
            volume_info: bucket.volume_info
          });
        }
        const validPVCNames = this.storageClassManager.getValidPVCNames(registryForValidation);
        if (this.config.logLevel === 'debug') {
          logger.debug(
            `[Deployment Reconciliation] Valid PVCs: ${Array.from(validPVCNames).join(', ')}, ` +
            `Newly created: ${Array.from(newlyCreatedPVCNames).join(', ')}`
          );
        }
        await this.storageClassManager.reconcileDeployment(validPVCNames, newlyCreatedPVCNames);
      }
    } catch (error: any) {
      logger.error(
        this.volumeMountSetClient
          ? `[VolumeMountSet] Failed to update CR: ${error.message}`
          : `[Deployment Reconciliation] Failed to reconcile deployment: ${error.message}`
      );
      // Don't throw - reconciliation failure shouldn't break sync
    }
  }

}

