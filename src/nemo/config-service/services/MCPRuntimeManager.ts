import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';
import { PatchStrategy } from '@kubernetes/client-node/dist/patch.js';
import { setHeaderOptions } from '@kubernetes/client-node/dist/middleware.js';
import { createHash } from 'crypto';
import { AppDataSource } from '../db/postgres';
import { MCPServer } from '../models/MCPServer';
import { getLLMGatewayClient } from './gatewayClient';
import { getCredentialService } from './CredentialService';
import {
  CredentialMapping,
  MCPServerCatalogEntry,
  RESOURCE_PRESETS,
  SecretKeyRef,
} from '../catalog/mcpServerCatalog';
import { safeLog } from '../utils/safeStrings';

const NAMESPACE = process.env.K8S_NAMESPACE || 'default';
const LLM_GATEWAY_NAMESPACE = process.env.LLM_GATEWAY_NAMESPACE || 'agentstudio-llm-gateway';
const IMAGE_REPOSITORY = process.env.MCP_IMAGE_REPOSITORY || process.env.GLOBAL_IMAGE_REPOSITORY || '';
const IMAGE_TAG = process.env.MCP_IMAGE_TAG || '';
const IMAGE_PULL_SECRETS = (process.env.MCP_IMAGE_PULL_SECRETS || '').split(',').filter(Boolean);
const PROVISION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

const MANAGED_LABELS_BASE = {
  'app.kubernetes.io/managed-by': 'nemo-config-service',
  component: 'mcp-stdio-runner',
};

function getK8sErrorStatus(err: any): number | undefined {
  if (typeof err?.code === 'number') return err.code;
  return err?.response?.status ?? err?.response?.statusCode ?? err?.statusCode ?? err?.body?.code ?? undefined;
}

/** Name of the per-server K8s Secret that holds materialized runtime credentials. */
export function runtimeCredSecretName(serverId: string): string {
  return `mcp-runtime-cred-${serverId}`;
}

/**
 * Parse the egress TCP port out of a cluster URL such as
 *   https://cluster.example.com           -> 443
 *   https://cluster.example.com:8443/api  -> 8443
 *   http://lab-cluster:8080               -> 8080
 *
 * Returns ``[443, 8443]`` as a fallback when the URL is missing or malformed —
 * matches the reasoning in the design doc (lab clusters frequently expose 8443).
 */
export function parseEgressPortsFromUrl(url: string | undefined): number[] {
  if (!url) return [443, 8443];
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const p = Number(parsed.port);
      return Number.isFinite(p) && p > 0 ? [p] : [443, 8443];
    }
    return parsed.protocol === 'http:' ? [80] : [443];
  } catch {
    return [443, 8443];
  }
}

/**
 * Stable checksum of the materialized runtime credential — used to roll the
 * Deployment when the credential is rotated.
 */
export function checksumSecretData(data: Record<string, string>): string {
  const h = createHash('sha256');
  for (const k of Object.keys(data).sort()) {
    h.update(k);
    h.update('=');
    h.update(data[k]);
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

/** Project catalog allowedTools into the MCP pod env (server.py gating). */
export function mergeManagedAllowedToolsEnv(
  catalogId: string,
  nonSecretEnvVars: Record<string, string>,
  allowedTools?: string[],
): Record<string, string> {
  const merged = { ...nonSecretEnvVars };
  if (!allowedTools?.length) return merged;
  const joined = allowedTools.join(',');
  if (catalogId === 'anf_mcp') {
    merged.ANF_ALLOWED_TOOLS = joined;
  } else if (catalogId === 'ontap_mcp') {
    merged.ONTAP_ALLOWED_TOOLS = joined;
  }
  return merged;
}

export interface RuntimeStatusInfo {
  runtimeStatus: string;
  phase?: string;
  ready: boolean;
  restartCount: number;
  message?: string;
}

export class MCPRuntimeManager {
  private appsApi: k8s.AppsV1Api;
  private coreApi: k8s.CoreV1Api;
  private networkingApi: k8s.NetworkingV1Api;
  private rbacApi: k8s.RbacAuthorizationV1Api;

  constructor() {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      kc.loadFromCluster();
    }
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api);
    this.rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);
  }

  private resolveImage(catalogEntry: MCPServerCatalogEntry): string {
    // Preserve fully-qualified image references (e.g. ghcr.io/netapp/ontap-mcp)
    // without prepending the private repository prefix.
    const firstSegment = catalogEntry.image.split('/')[0] || '';
    const isQualified = firstSegment.includes('.') || firstSegment.includes(':') || catalogEntry.image.startsWith('localhost/');
    const repo = (IMAGE_REPOSITORY && !isQualified) ? `${IMAGE_REPOSITORY}/` : '';
    const tag = IMAGE_TAG || catalogEntry.defaultTag;
    return `${repo}${catalogEntry.image}:${tag}`;
  }

  private buildLabels(serverId: string, projectId: string): Record<string, string> {
    return {
      ...MANAGED_LABELS_BASE,
      'mcp-server-id': serverId,
      'project-id': projectId,
    };
  }

  /**
   * Asynchronous provisioning — fires and forgets.
   * Creates K8s resources, polls readiness, then updates DB + Bifrost gateway.
   */
  provisionAsync(
    serverId: string,
    projectId: string,
    serverName: string,
    k8sResourceName: string,
    catalogEntry: MCPServerCatalogEntry,
    secretEnvVars: Record<string, string>,
    nonSecretEnvVars: Record<string, string>,
    runtimeCredentialId?: string,
  ): void {
    setImmediate(() => {
      this.doProvision(
        serverId, projectId, serverName, k8sResourceName, catalogEntry,
        secretEnvVars, nonSecretEnvVars, runtimeCredentialId,
      )
        .catch((err) => {
          logger.error(`[MCPRuntimeManager] Unhandled error in provisionAsync for ${serverId}:`, err);
        });
    });
  }

  private async doProvision(
    serverId: string,
    projectId: string,
    serverName: string,
    k8sResourceName: string,
    catalogEntry: MCPServerCatalogEntry,
    secretEnvVars: Record<string, string>,
    nonSecretEnvVars: Record<string, string>,
    runtimeCredentialId?: string,
  ): Promise<void> {
    const repo = AppDataSource.getRepository(MCPServer);
    const labels = this.buildLabels(serverId, projectId);
    const secretName = `${k8sResourceName}-env`;
    const saName = `${k8sResourceName}-sa`;

    // Egress port for managed MCPs that wrap a downstream system. We parse from
    // the cluster_url-style env var (currently only ONTAP_CLUSTER_URL); falls back
    // to catalog.egressPorts when no override is detected.
    const dynamicEgressPorts = catalogEntry.credentialMapping
      ? parseEgressPortsFromUrl(nonSecretEnvVars.ONTAP_CLUSTER_URL || nonSecretEnvVars.ONTAP_URL)
      : undefined;

    // Materialize runtime credential into a per-server Secret, before the
    // Deployment is created so we can wire the volume mounts in one shot.
    let runtimeCredSecret: { secretName: string; envFromKeys: Record<string, string>; fileFromKeys: Record<string, { mountPath: string; envForPath: string; mode?: number }>; checksum: string } | undefined;
    if (catalogEntry.credentialMapping && runtimeCredentialId) {
      const materialized = await this.materializeRuntimeCredential(
        serverId, projectId, k8sResourceName, labels, catalogEntry.credentialMapping, runtimeCredentialId,
      );
      if (materialized) {
        runtimeCredSecret = materialized;
      }
    }

    try {
      // 1. Create K8s Secret for sensitive env vars (if any)
      if (Object.keys(secretEnvVars).length > 0) {
        await this.createSecret(k8sResourceName, secretName, labels, secretEnvVars);
      }

      // 2. Optional ServiceAccount + RBAC
      if (catalogEntry.requiresRBAC) {
        await this.createServiceAccountAndRBAC(k8sResourceName, saName, labels, catalogEntry);
      }

      // 3. NetworkPolicy
      await this.createNetworkPolicy(k8sResourceName, labels, catalogEntry, dynamicEgressPorts);

      // 4. Service
      await this.createService(k8sResourceName, labels);

      const serverRow = await repo.findOneBy({ id: serverId });
      const deployEnv = mergeManagedAllowedToolsEnv(
        catalogEntry.id,
        nonSecretEnvVars,
        serverRow?.allowedTools,
      );

      // 5. Deployment
      await this.createDeployment(
        k8sResourceName, labels, catalogEntry,
        deployEnv,
        Object.keys(secretEnvVars).length > 0 ? secretName : undefined,
        catalogEntry.requiresRBAC ? saName : undefined,
        runtimeCredSecret,
      );

      // 6a. Now that the Deployment exists we can attach an ownerReference to the
      // runtime credential Secret so K8s GC cleans it up automatically on
      // server delete (see `deprovision` for the explicit fallback).
      if (runtimeCredSecret) {
        await this.attachOwnerRefToSecret(runtimeCredSecret.secretName, k8sResourceName).catch((err) => {
          logger.warn(`[MCPRuntimeManager] Failed to attach ownerRef on ${runtimeCredSecret!.secretName}:`, err.message);
        });
      }

      // 6. Poll readiness
      const ready = await this.pollReadiness(k8sResourceName);
      if (!ready) {
        await repo.update(serverId, { runtimeStatus: 'failed' });
        logger.error(`[MCPRuntimeManager] Pod readiness timeout for ${k8sResourceName}`);
        return;
      }

      // 7. Update DB with transport/url and runtimeStatus
      const mcpPath = catalogEntry.mcpPath ?? '/mcp';
      const normalizedPath = mcpPath
        ? (mcpPath.startsWith('/') ? mcpPath : `/${mcpPath}`)
        : '';
      const svcUrl = `http://${k8sResourceName}.${NAMESPACE}.svc.cluster.local:8000${normalizedPath}`;
      await repo.update(serverId, {
        transport: 'http',
        url: svcUrl,
        authType: 'none',
        runtimeStatus: 'running',
      });

      // 8. Register with Bifrost gateway — read back the full entity.
      //    Retry a few times since the MCP pod just started and the gateway may
      //    not be immediately reachable (common during restart / reprovision flows).
      const gateway = getLLMGatewayClient();
      if (gateway.isEnabled()) {
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 5_000;
        let gatewayOk = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const updatedServer = await repo.findOneBy({ id: serverId });
            if (!updatedServer) throw new Error('Server disappeared from DB after update');

            const llmproxyGatewayServerName = `${projectId}_${serverName}`;
            const resp = await gateway.addMCPServer({
              server_name: llmproxyGatewayServerName,
              alias: serverName,
              projectId,
              url: svcUrl,
              transport: 'http',
              auth_type: 'none',
              static_headers: {
                // Supergateway streamable-http requires explicit dual accept.
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                // Pin protocol version: newer defaults fail against these
                // managed web MCP servers.
                'mcp-protocol-version': '2024-11-05',
              },
              allowed_tools: updatedServer.allowedTools?.length ? updatedServer.allowedTools : undefined,
              blocked_tools: updatedServer.disallowedTools?.length ? updatedServer.disallowedTools : undefined,
            });
            await repo.update(serverId, {
              llmproxyGatewayServerId: resp.server_id,
              llmproxyGatewayServerName,
              syncStatus: 'synced',
            });
            gatewayOk = true;
            break;
          } catch (gatewayErr: any) {
            logger.error(
              `[MCPRuntimeManager] Gateway MCP registration attempt ${attempt}/${MAX_RETRIES} failed for ${safeLog(serverId)}:`,
              safeLog(gatewayErr.message),
            );
            if (attempt < MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            }
          }
        }

        if (!gatewayOk) {
          logger.error(`[MCPRuntimeManager] Gateway MCP registration exhausted retries for ${safeLog(serverId)}`);
          await repo.update(serverId, { syncStatus: 'error' });
        }
      }

      logger.info(`[MCPRuntimeManager] Successfully provisioned ${k8sResourceName} for server ${serverId}`);
    } catch (err: any) {
      logger.error(`[MCPRuntimeManager] Provisioning failed for ${serverId}:`, err.message);
      await repo.update(serverId, { runtimeStatus: 'failed' }).catch(() => {});
    }
  }

  async deprovision(server: MCPServer): Promise<void> {
    const name = server.k8sResourceName;
    if (!name) return;

    const label = `mcp-server-id=${server.id}`;
    logger.info(`[MCPRuntimeManager] Deprovisioning ${name} (label=${label})`);

    await this.deleteDeployment(name);
    await this.deleteService(name);
    await this.deleteNetworkPolicy(name);
    await this.deleteSecret(`${name}-env`);
    // Belt-and-suspenders: ownerReferences should cascade-delete this, but
    // call it explicitly so deprovision is idempotent if the ownerRef patch
    // failed during provision.
    await this.deleteSecret(runtimeCredSecretName(server.id));

    if (server.catalogId) {
      const saName = `${name}-sa`;
      await this.deleteServiceAccount(saName);
      await this.deleteClusterRoleBinding(`${name}-crb`);
    }

    logger.info(`[MCPRuntimeManager] Deprovisioned ${name}`);
  }

  /**
   * Re-materialize the runtime credential into the per-server Secret and
   * trigger a Deployment rolling restart. Called by CredentialService when a
   * credential is updated. Idempotent: no-op if the server has no
   * runtimeCredentialId or its catalog entry has no credentialMapping.
   */
  async syncRuntimeSecret(server: MCPServer, catalogEntry: MCPServerCatalogEntry): Promise<void> {
    if (!catalogEntry.credentialMapping || !server.runtimeCredentialId || !server.k8sResourceName) {
      return;
    }
    const labels = this.buildLabels(server.id, server.projectId);
    const materialized = await this.materializeRuntimeCredential(
      server.id, server.projectId, server.k8sResourceName, labels,
      catalogEntry.credentialMapping, server.runtimeCredentialId,
    );
    if (!materialized) return;

    // Bump a checksum annotation to force a Deployment rollout. The Secret
    // contents have already been updated in-place inside materializeRuntimeCredential.
    try {
      await this.appsApi.patchNamespacedDeployment({
        name: server.k8sResourceName,
        namespace: NAMESPACE,
        body: {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'mcp.nemo/runtime-cred-checksum': materialized.checksum,
                },
              },
            },
          },
        },
      }, setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch));
      logger.info(`[MCPRuntimeManager] Triggered rollout for ${server.k8sResourceName} after credential rotation`);
    } catch (err: any) {
      logger.error(`[MCPRuntimeManager] Failed to roll deployment ${server.k8sResourceName}:`, err.message);
    }
  }

  async patchConfig(
    server: MCPServer,
    catalogEntry: MCPServerCatalogEntry,
    secretEnvVars: Record<string, string>,
    nonSecretEnvVars: Record<string, string>,
  ): Promise<void> {
    const name = server.k8sResourceName;
    if (!name) return;

    // Update secret if needed
    const secretName = `${name}-env`;
    if (Object.keys(secretEnvVars).length > 0) {
      try {
        await this.coreApi.replaceNamespacedSecret({
          name: secretName,
          namespace: NAMESPACE,
          body: {
            metadata: { name: secretName, namespace: NAMESPACE },
            type: 'Opaque',
            stringData: secretEnvVars,
          },
        });
      } catch (err: any) {
        if (getK8sErrorStatus(err) === 404) {
          const labels = this.buildLabels(server.id, server.projectId);
          await this.createSecret(name, secretName, labels, secretEnvVars);
        } else {
          throw err;
        }
      }
    }

    // Patch deployment env vars
    const preset = RESOURCE_PRESETS[server.managedConfig?.resourcePreset || catalogEntry.resourcePreset];
    const envList = Object.entries(nonSecretEnvVars).map(([k, v]) => ({ name: k, value: v }));

    try {
      await this.appsApi.patchNamespacedDeployment({
        name,
        namespace: NAMESPACE,
        body: {
          spec: {
            template: {
              spec: {
                containers: [{
                  name: 'mcp-server',
                  image: this.resolveImage(catalogEntry),
                  env: envList.length > 0 ? envList : undefined,
                  resources: {
                    requests: { cpu: preset.cpu, memory: preset.memory },
                    limits: { cpu: preset.cpuLimit, memory: preset.memoryLimit },
                  },
                }],
              },
            },
          },
        },
      }, setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch));
    } catch (err: any) {
      logger.error(`[MCPRuntimeManager] Patch deployment failed for ${name}:`, err.message);
      throw err;
    }
  }

  async getStatus(server: MCPServer): Promise<RuntimeStatusInfo> {
    const name = server.k8sResourceName;
    if (!name || !server.runtimeStatus) {
      return { runtimeStatus: server.runtimeStatus || 'unknown', ready: false, restartCount: 0 };
    }

    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: NAMESPACE,
        labelSelector: `mcp-server-id=${server.id}`,
      });

      const podList = pods.items || [];
      if (podList.length === 0) {
        return { runtimeStatus: server.runtimeStatus, ready: false, restartCount: 0, message: 'No pods found' };
      }

      const pod = podList[0];
      const phase = pod.status?.phase || 'Unknown';
      const containerStatus = pod.status?.containerStatuses?.[0];
      const ready = containerStatus?.ready || false;
      const restartCount = containerStatus?.restartCount || 0;

      let message: string | undefined;
      if (containerStatus?.state?.waiting) {
        message = containerStatus.state.waiting.reason || containerStatus.state.waiting.message;
      } else if (containerStatus?.state?.terminated) {
        message = containerStatus.state.terminated.reason || containerStatus.state.terminated.message;
      }

      return { runtimeStatus: server.runtimeStatus, phase, ready, restartCount, message };
    } catch (err: any) {
      logger.error(`[MCPRuntimeManager] getStatus failed for ${name}:`, err.message);
      return { runtimeStatus: server.runtimeStatus, ready: false, restartCount: 0, message: err.message };
    }
  }

  async reconcileOrphans(): Promise<void> {
    logger.info('[MCPRuntimeManager] Starting orphan reconciliation...');
    const repo = AppDataSource.getRepository(MCPServer);

    try {
      const deployments = await this.appsApi.listNamespacedDeployment({
        namespace: NAMESPACE,
        labelSelector: 'component=mcp-stdio-runner,app.kubernetes.io/managed-by=nemo-config-service',
      });

      const dbServers = await repo.find({ where: { deploymentType: 'managed' } });
      const dbIds = new Set(dbServers.map((s) => s.id));

      for (const dep of deployments.items || []) {
        const serverId = dep.metadata?.labels?.['mcp-server-id'];
        if (serverId && !dbIds.has(serverId)) {
          const name = dep.metadata?.name;
          logger.info(`[MCPRuntimeManager] Deleting orphaned resources for ${name} (server ${serverId})`);
          if (name) {
            await this.deleteDeployment(name);
            await this.deleteService(name);
            await this.deleteNetworkPolicy(name);
            await this.deleteSecret(`${name}-env`);
            await this.deleteServiceAccount(`${name}-sa`);
            await this.deleteClusterRoleBinding(`${name}-crb`);
          }
        }
      }

      // Mark stuck 'provisioning' records as 'failed' if no Deployment exists
      const k8sNames = new Set((deployments.items || []).map((d) => d.metadata?.name));
      for (const server of dbServers) {
        if (server.runtimeStatus === 'provisioning' && server.k8sResourceName && !k8sNames.has(server.k8sResourceName)) {
          logger.info(`[MCPRuntimeManager] Marking ${server.id} as failed (no Deployment found)`);
          await repo.update(server.id, { runtimeStatus: 'failed' });
        }
      }

      logger.info('[MCPRuntimeManager] Orphan reconciliation complete');
    } catch (err: any) {
      logger.error('[MCPRuntimeManager] Orphan reconciliation error:', err.message);
    }

    // Reconcile Bifrost gateway MCP server registrations separately so a K8s API
    // failure doesn't block cleanup of stale gateway entries (and vice versa).
    await this.reconcileGatewayServers();
  }

  /**
   * Reconcile Bifrost gateway's MCP server registry with the config-service DB.
   *
   * Handles three drift scenarios:
   *  1. **Stale gateway entries** — registered in Bifrost but no matching
   *     config-service record (e.g. server deleted while the gateway was down).
   *     → removed from Bifrost.
   *  2. **Duplicate gateway entries** — multiple registrations with the same
   *     server_name (e.g. re-provision without clean delete). → keep the one
   *     matching the DB's llmproxyGatewayServerId, remove the rest.
   *  3. **Desync'd DB records** — config-service record says syncStatus='synced'
   *     but the llmproxyGatewayServerId no longer exists in Bifrost (e.g. gateway DB
   *     was wiped). → re-register or mark as 'pending'.
   */
  private async reconcileGatewayServers(): Promise<void> {
    const gateway = getLLMGatewayClient();
    if (!gateway.isEnabled()) return;

    const repo = AppDataSource.getRepository(MCPServer);
    logger.log('[MCPRuntimeManager] Reconciling Bifrost MCP server registrations...');

    try {
      const [gatewayServers, allDbServers] = await Promise.all([
        gateway.listMCPServers(),
        repo.find(),
      ]);

      // Build lookup maps from config-service DB.
      const dbByGatewayId = new Map<string, MCPServer>();
      const dbByGatewayName = new Map<string, MCPServer>();
      for (const s of allDbServers) {
        if (s.llmproxyGatewayServerId) dbByGatewayId.set(s.llmproxyGatewayServerId, s);
        if (s.llmproxyGatewayServerName) dbByGatewayName.set(s.llmproxyGatewayServerName, s);
      }

      // Detect duplicates: group gateway entries by server_name.
      const gatewayByName = new Map<string, typeof gatewayServers>();
      for (const entry of gatewayServers) {
        const list = gatewayByName.get(entry.server_name) || [];
        list.push(entry);
        gatewayByName.set(entry.server_name, list);
      }

      let removed = 0;
      let deduped = 0;

      // 1. Remove stale entries and deduplicate.
      for (const [name, entries] of gatewayByName) {
        const dbServer = dbByGatewayName.get(name);

        if (!dbServer) {
          // No config-service record references this server_name → stale.
          for (const entry of entries) {
            logger.log(
              `[MCPRuntimeManager] Removing stale gateway MCP server: ` +
              `name=${safeLog(name)} id=${safeLog(entry.server_id)}`,
            );
            await gateway.removeMCPServer(entry.server_id).catch((err) => {
              logger.warn(`[MCPRuntimeManager] Failed to remove stale gateway entry ${safeLog(entry.server_id)}:`, safeLog(err.message));
            });
            removed++;
          }
          continue;
        }

        // Server exists in DB — if there are duplicates, keep the canonical one.
        if (entries.length > 1) {
          const canonicalId = dbServer.llmproxyGatewayServerId;
          for (const entry of entries) {
            if (entry.server_id !== canonicalId) {
              logger.log(
                `[MCPRuntimeManager] Removing duplicate gateway MCP server: ` +
                `name=${safeLog(name)} id=${safeLog(entry.server_id)} (canonical=${safeLog(canonicalId)})`,
              );
              await gateway.removeMCPServer(entry.server_id).catch((err) => {
                logger.warn(`[MCPRuntimeManager] Failed to remove duplicate entry ${safeLog(entry.server_id)}:`, safeLog(err.message));
              });
              deduped++;
            }
          }
        }
      }

      // 2. Re-register DB records that claim 'synced' but are missing from the gateway.
      const gatewayIdSet = new Set(gatewayServers.map((s) => s.server_id));
      let resynced = 0;
      for (const server of allDbServers) {
        if (
          server.syncStatus === 'synced' &&
          server.llmproxyGatewayServerId &&
          !gatewayIdSet.has(server.llmproxyGatewayServerId)
        ) {
          logger.log(
            `[MCPRuntimeManager] DB record ${safeLog(server.id)} (${safeLog(server.name)}) claims synced ` +
            `but llmproxyGatewayServerId=${safeLog(server.llmproxyGatewayServerId)} not found in gateway — marking pending for re-sync`,
          );
          await repo.update(server.id, { syncStatus: 'pending', llmproxyGatewayServerId: undefined as any });
          resynced++;
        }
      }

      if (removed || deduped || resynced) {
        logger.log(
          `[MCPRuntimeManager] Gateway reconciliation: removed=${removed} deduped=${deduped} marked_pending=${resynced}`,
        );
      } else {
        logger.log('[MCPRuntimeManager] Gateway reconciliation: no drift detected');
      }
    } catch (err: any) {
      logger.error('[MCPRuntimeManager] Gateway reconciliation error:', err.message);
    }
  }

  // ── K8s Resource Creation ──

  private async createDeployment(
    name: string,
    labels: Record<string, string>,
    catalogEntry: MCPServerCatalogEntry,
    nonSecretEnvVars: Record<string, string>,
    secretName?: string,
    serviceAccountName?: string,
    runtimeCredSecret?: {
      secretName: string;
      envFromKeys: Record<string, string>;
      fileFromKeys: Record<string, { mountPath: string; envForPath: string; mode?: number }>;
      checksum: string;
    },
  ): Promise<void> {
    const preset = RESOURCE_PRESETS[catalogEntry.resourcePreset];

    const defaultEnv = catalogEntry.defaultEnvFn?.() ?? {};
    const mergedEnv = { ...defaultEnv, ...nonSecretEnvVars };
    const envList: k8s.V1EnvVar[] = Object.entries(mergedEnv).map(([k, v]) => ({ name: k, value: v }));

    if (catalogEntry.secretKeyRefs?.length) {
      for (const ref of catalogEntry.secretKeyRefs) {
        envList.push({
          name: ref.envVar,
          valueFrom: { secretKeyRef: { name: ref.secretName, key: ref.key } },
        });
      }
    }

    const volumes: k8s.V1Volume[] = [{ name: 'tmp', emptyDir: {} }];
    const volumeMounts: k8s.V1VolumeMount[] = [{ name: 'tmp', mountPath: '/tmp' }];
    const initContainers: k8s.V1Container[] = [];

    if (catalogEntry.volumeMounts) {
      for (const vm of catalogEntry.volumeMounts) {
        volumes.push({ name: 'data', emptyDir: {} });
        volumeMounts.push({ name: 'data', mountPath: vm.mountPath });
      }
    }

    // Project runtime-credential keys as env vars / file mounts per the
    // catalog's credentialMapping.
    let podAnnotations: Record<string, string> | undefined;
    if (runtimeCredSecret) {
      // env-from-key projections
      for (const [credKey, envName] of Object.entries(runtimeCredSecret.envFromKeys)) {
        envList.push({
          name: envName,
          valueFrom: { secretKeyRef: { name: runtimeCredSecret.secretName, key: credKey, optional: true } },
        });
      }
      // file-from-key projections (one volume + per-key items, all backed by the same Secret)
      const fileEntries = Object.entries(runtimeCredSecret.fileFromKeys);
      if (fileEntries.length > 0) {
        const items: k8s.V1KeyToPath[] = fileEntries
          .map(([credKey, mapping]) => ({
            key: credKey,
            // mountPath is "/etc/ontap/client.crt" → relative path inside the volume is "client.crt"
            path: mapping.mountPath.split('/').pop() || credKey,
            mode: mapping.mode,
          }));
        // All target paths share a single parent dir per the catalog's convention
        // (e.g. /etc/ontap). Pick the first mountPath's directory; the catalog
        // is expected to keep all files under a common directory.
        const firstPath = fileEntries[0][1].mountPath;
        const parentDir = firstPath.substring(0, firstPath.lastIndexOf('/'));
        volumes.push({
          name: 'runtime-cred',
          secret: { secretName: runtimeCredSecret.secretName, items, optional: true },
        });
        volumeMounts.push({
          name: 'runtime-cred',
          mountPath: parentDir,
          readOnly: true,
        });
        for (const [, mapping] of fileEntries) {
          envList.push({ name: mapping.envForPath, value: mapping.mountPath });
        }
      }
      podAnnotations = {
        'mcp.nemo/runtime-cred-checksum': runtimeCredSecret.checksum,
      };
    }

    // Official ONTAP MCP image expects a config file (ontap.yaml) at startup.
    // Generate it from env + runtime credential secret in an init container.
    if (catalogEntry.id === 'ontap_mcp_official' && runtimeCredSecret) {
      const hasOntapMcpConfig = envList.some((env) => env.name === 'ONTAP_MCP_CONFIG');
      const ontapUrl = mergedEnv.ONTAP_URL || mergedEnv.ONTAP_CLUSTER_URL || '';
      const ontapInsecure = mergedEnv.ONTAP_INSECURE
        ?? ((mergedEnv.ONTAP_VERIFY_TLS || 'true').toLowerCase() === 'false' ? 'true' : 'false');

      if (!hasOntapMcpConfig) {
        envList.push({ name: 'ONTAP_MCP_CONFIG', value: '/etc/ontap-mcp/ontap.yaml' });
      }
      if (!envList.some((env) => env.name === 'ONTAP_URL') && ontapUrl) {
        envList.push({ name: 'ONTAP_URL', value: ontapUrl });
      }
      if (!envList.some((env) => env.name === 'ONTAP_INSECURE')) {
        envList.push({ name: 'ONTAP_INSECURE', value: ontapInsecure });
      }

      volumes.push({ name: 'ontap-config', emptyDir: {} });
      volumeMounts.push({ name: 'ontap-config', mountPath: '/etc/ontap-mcp' });

      initContainers.push({
        name: 'write-ontap-config',
        image: 'busybox:1.36',
        command: ['/bin/sh', '-c'],
        args: [
          [
            'cat > /work/ontap.yaml <<EOF',
            'clusters:',
            '  - name: default',
            '    url: "${ONTAP_URL}"',
            '    username: "${ONTAP_USERNAME}"',
            '    password: "${ONTAP_PASSWORD}"',
            '    insecure: ${ONTAP_INSECURE}',
            'EOF',
          ].join('\n'),
        ],
        env: [
          { name: 'ONTAP_URL', value: ontapUrl },
          { name: 'ONTAP_INSECURE', value: ontapInsecure },
          {
            name: 'ONTAP_USERNAME',
            valueFrom: { secretKeyRef: { name: runtimeCredSecret.secretName, key: 'username', optional: true } },
          },
          {
            name: 'ONTAP_PASSWORD',
            valueFrom: { secretKeyRef: { name: runtimeCredSecret.secretName, key: 'password', optional: true } },
          },
        ],
        volumeMounts: [{ name: 'ontap-config', mountPath: '/work' }],
      });
    }

    const useTcpProbe = catalogEntry.healthProbe === 'tcp';
    const healthPath = catalogEntry.healthPath || '/healthz';

    // Shared check action (TCP for servers without an HTTP health route, HTTP
    // GET otherwise). Each probe below adds its own timing/threshold.
    const probeAction: k8s.V1Probe = useTcpProbe
      ? { tcpSocket: { port: 8000 as any } }
      : { httpGet: { path: healthPath, port: 8000 as any } };

    // Startup probe absorbs slow cold starts (image pull + Node + supergateway
    // boot): up to ~150s before liveness/readiness begin, so a slow start never
    // counts as a liveness failure.
    const startupProbe: k8s.V1Probe = {
      ...probeAction,
      periodSeconds: 5,
      failureThreshold: 30,
      timeoutSeconds: 3,
    };

    // timeoutSeconds defaults to 1s, which is far too tight for an MCP pod that
    // can be briefly CPU-throttled — a slow-but-healthy /healthz then trips the
    // probe and the kubelet SIGKILLs the container (exit 137 / CrashLoopBackOff).
    // Use 5s, and a higher liveness failureThreshold so a transient stall does
    // not restart a healthy server.
    const livenessProbe: k8s.V1Probe = {
      ...probeAction,
      initialDelaySeconds: 10,
      periodSeconds: 15,
      timeoutSeconds: 5,
      failureThreshold: 5,
    };

    const readinessProbe: k8s.V1Probe = {
      ...probeAction,
      initialDelaySeconds: 5,
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 3,
    };

    const container: k8s.V1Container = {
      name: 'mcp-server',
      image: this.resolveImage(catalogEntry),
      imagePullPolicy: catalogEntry.imagePullPolicy,
      command: catalogEntry.command,
      args: catalogEntry.args,
      ports: [{ containerPort: 8000, protocol: 'TCP' }],
      env: envList.length > 0 ? envList : undefined,
      envFrom: secretName ? [{ secretRef: { name: secretName } }] : undefined,
      resources: {
        requests: { cpu: preset.cpu, memory: preset.memory },
        limits: { cpu: preset.cpuLimit, memory: preset.memoryLimit },
      },
      securityContext: {
        runAsNonRoot: catalogEntry.runAsNonRoot ?? true,
        runAsUser: catalogEntry.runAsUser,
        runAsGroup: catalogEntry.runAsGroup,
        readOnlyRootFilesystem: catalogEntry.readOnlyRootFilesystem ?? true,
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['ALL'] },
      },
      startupProbe,
      livenessProbe,
      readinessProbe,
      volumeMounts,
    };

    await this.appsApi.createNamespacedDeployment({
      namespace: NAMESPACE,
      body: {
        metadata: { name, namespace: NAMESPACE, labels },
        spec: {
          replicas: 1,
          selector: { matchLabels: { 'mcp-server-id': labels['mcp-server-id'] } },
          template: {
            metadata: { labels, annotations: podAnnotations },
            spec: {
              serviceAccountName: serviceAccountName || undefined,
              automountServiceAccountToken: !!serviceAccountName,
              initContainers: initContainers.length > 0 ? initContainers : undefined,
              containers: [container],
              volumes,
              imagePullSecrets: IMAGE_PULL_SECRETS.length > 0
                ? IMAGE_PULL_SECRETS.map((s) => ({ name: s }))
                : undefined,
            },
          },
        },
      },
    });
  }

  private async createService(name: string, labels: Record<string, string>): Promise<void> {
    await this.coreApi.createNamespacedService({
      namespace: NAMESPACE,
      body: {
        metadata: { name, namespace: NAMESPACE, labels },
        spec: {
          type: 'ClusterIP',
          selector: { 'mcp-server-id': labels['mcp-server-id'] },
          ports: [{ port: 8000, targetPort: 8000 as any, protocol: 'TCP' }],
        },
      },
    });
  }

  private async createNetworkPolicy(
    name: string,
    labels: Record<string, string>,
    catalogEntry: MCPServerCatalogEntry,
    extraEgressPorts?: number[],
  ): Promise<void> {
    const egressRules: k8s.V1NetworkPolicyEgressRule[] = [
      { to: [], ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
      // Istio control plane: the injected sidecar (pilot-agent) needs to reach
      // istiod for workload certificate signing (15012) and xDS config (15010/15014/15017).
      // Without these rules the sidecar cannot start, causing the pod to stay Pending.
      {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'istio-system' } } }],
        ports: [
          { port: 15010, protocol: 'TCP' },
          { port: 15012, protocol: 'TCP' },
          { port: 15014, protocol: 'TCP' },
          { port: 15017, protocol: 'TCP' },
        ],
      },
    ];

    if (catalogEntry.securityProfile === 'network-access') {
      egressRules.push({
        to: [],
        ports: [
          { port: 443, protocol: 'TCP' },
          { port: 80, protocol: 'TCP' },
          { port: 5432, protocol: 'TCP' },
          { port: 6443, protocol: 'TCP' },
        ],
      });
    }

    if (catalogEntry.egressPorts?.length) {
      egressRules.push({
        to: [],
        ports: catalogEntry.egressPorts.map((p) => ({ port: p, protocol: 'TCP' as const })),
      });
    }

    // Dynamic ports parsed from runtime credential URLs (e.g. ONTAP_CLUSTER_URL=...:8443).
    if (extraEgressPorts?.length) {
      egressRules.push({
        to: [],
        ports: extraEgressPorts.map((p) => ({ port: p, protocol: 'TCP' as const })),
      });
    }

    await this.networkingApi.createNamespacedNetworkPolicy({
      namespace: NAMESPACE,
      body: {
        metadata: { name, namespace: NAMESPACE, labels },
        spec: {
          podSelector: { matchLabels: { 'mcp-server-id': labels['mcp-server-id'] } },
          policyTypes: ['Ingress', 'Egress'],
          ingress: [{
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': LLM_GATEWAY_NAMESPACE },
                },
                podSelector: { matchLabels: { component: 'bifrost' } },
              },
              // config-service polls /health on port 8000 to track readiness.
              { 
                namespaceSelector: { 
                  matchLabels: { 'kubernetes.io/metadata.name': 'agentstudio-services' } 
                },
                podSelector: { matchLabels: { 'app.kubernetes.io/name': 'config-service' } } 
              },
            ],
            ports: [{ port: 8000, protocol: 'TCP' }],
          }],
          egress: egressRules,
        },
      },
    });
  }

  private async createSecret(
    resourceName: string,
    secretName: string,
    labels: Record<string, string>,
    data: Record<string, string>,
  ): Promise<void> {
    await this.coreApi.createNamespacedSecret({
      namespace: NAMESPACE,
      body: {
        metadata: { name: secretName, namespace: NAMESPACE, labels },
        type: 'Opaque',
        stringData: data,
      },
    });
  }

  /**
   * Read a connector credential's secret data and write a per-server K8s
   * Secret containing only the keys mentioned in the catalog's
   * credentialMapping (envFromKeys + fileFromKeys). Empty / missing values
   * are skipped so the projected envs / files behave as expected.
   *
   * Returns metadata describing what was projected, plus a checksum of the
   * Secret contents (used to roll the Deployment when the credential rotates).
   */
  private async materializeRuntimeCredential(
    serverId: string,
    projectId: string,
    k8sResourceName: string,
    labels: Record<string, string>,
    mapping: CredentialMapping,
    runtimeCredentialId: string,
  ): Promise<{
    secretName: string;
    envFromKeys: Record<string, string>;
    fileFromKeys: Record<string, { mountPath: string; envForPath: string; mode?: number }>;
    checksum: string;
  } | undefined> {
    const credentialData = await getCredentialService()
      .readSecretData(projectId, runtimeCredentialId)
      .catch((err: any) => {
        logger.error(
          `[MCPRuntimeManager] Failed to read runtime credential ${runtimeCredentialId} for server ${serverId}:`,
          err.message,
        );
        return null;
      });

    if (!credentialData) return undefined;

    // Filter to only the keys named in envFromKeys / fileFromKeys, drop empties.
    const allowedKeys = new Set([
      ...Object.keys(mapping.envFromKeys || {}),
      ...Object.keys(mapping.fileFromKeys || {}),
    ]);
    const projected: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentialData)) {
      if (allowedKeys.has(k) && typeof v === 'string' && v.length > 0) {
        projected[k] = v;
      }
    }
    if (Object.keys(projected).length === 0) {
      logger.warn(
        `[MCPRuntimeManager] Runtime credential ${runtimeCredentialId} has no keys matching mapping for server ${serverId}; skipping Secret creation.`,
      );
      return undefined;
    }

    const secretName = runtimeCredSecretName(serverId);
    const checksum = checksumSecretData(projected);

    // Idempotent upsert: try replace first, fall back to create on 404.
    try {
      await this.coreApi.replaceNamespacedSecret({
        name: secretName,
        namespace: NAMESPACE,
        body: {
          metadata: { name: secretName, namespace: NAMESPACE, labels: { ...labels, 'mcp-cred': 'runtime' } },
          type: 'Opaque',
          stringData: projected,
        },
      });
    } catch (err: any) {
      if (getK8sErrorStatus(err) === 404) {
        await this.coreApi.createNamespacedSecret({
          namespace: NAMESPACE,
          body: {
            metadata: { name: secretName, namespace: NAMESPACE, labels: { ...labels, 'mcp-cred': 'runtime' } },
            type: 'Opaque',
            stringData: projected,
          },
        });
      } else {
        throw err;
      }
    }

    const projectedKeys = new Set(Object.keys(projected));
    // Only wire env + file projections for keys actually stored. Otherwise
    // Ontap_mcp_logs (and similar) would set ONTAP_CLIENT_CERT_PATH to a path with
    // no file when the user chose basic auth only — the server then always
    // attempts mTLS reads and exits.
    const envFromKeys = Object.fromEntries(
      Object.entries(mapping.envFromKeys || {}).filter(([k]) => projectedKeys.has(k)),
    );
    const fileFromKeys = Object.fromEntries(
      Object.entries(mapping.fileFromKeys || {}).filter(([k]) => projectedKeys.has(k)),
    );

    return {
      secretName,
      envFromKeys,
      fileFromKeys,
      checksum,
    };
  }

  /**
   * Patch the runtime-credential Secret with an ownerReference to the
   * Deployment we just created so K8s GC handles cleanup if the server record
   * is deleted out of band. Best-effort; deprovision still does an explicit
   * delete.
   */
  private async attachOwnerRefToSecret(secretName: string, deploymentName: string): Promise<void> {
    const dep = await this.appsApi.readNamespacedDeployment({ name: deploymentName, namespace: NAMESPACE });
    const uid = dep.metadata?.uid;
    if (!uid) return;
    await this.coreApi.patchNamespacedSecret(
      {
        name: secretName,
        namespace: NAMESPACE,
        body: {
          metadata: {
            ownerReferences: [
              {
                apiVersion: 'apps/v1',
                kind: 'Deployment',
                name: deploymentName,
                uid,
                controller: false,
                blockOwnerDeletion: false,
              },
            ],
          },
        },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  }

  private async createServiceAccountAndRBAC(
    resourceName: string,
    saName: string,
    labels: Record<string, string>,
    catalogEntry: MCPServerCatalogEntry,
  ): Promise<void> {
    await this.coreApi.createNamespacedServiceAccount({
      namespace: NAMESPACE,
      body: {
        metadata: { name: saName, namespace: NAMESPACE, labels },
        imagePullSecrets: IMAGE_PULL_SECRETS.length > 0
          ? IMAGE_PULL_SECRETS.map((s) => ({ name: s }))
          : undefined,
      },
    });

    if (!catalogEntry.clusterRoleName) {
      logger.warn(`[MCPRuntimeManager] Catalog entry ${catalogEntry.id} requires RBAC but has no clusterRoleName — skipping binding`);
      return;
    }

    const crbName = `${resourceName}-crb`;
    await this.rbacApi.createClusterRoleBinding({
      body: {
        metadata: { name: crbName, labels },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: catalogEntry.clusterRoleName },
        subjects: [{ kind: 'ServiceAccount', name: saName, namespace: NAMESPACE }],
      },
    });
  }

  // ── K8s Resource Deletion (404-safe) ──

  private async deleteDeployment(name: string): Promise<void> {
    try {
      await this.appsApi.deleteNamespacedDeployment({ name, namespace: NAMESPACE });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete deployment ${name}:`, err.message);
    }
  }

  private async deleteService(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedService({ name, namespace: NAMESPACE });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete service ${name}:`, err.message);
    }
  }

  private async deleteNetworkPolicy(name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace: NAMESPACE });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete networkpolicy ${name}:`, err.message);
    }
  }

  private async deleteSecret(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedSecret({ name, namespace: NAMESPACE });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete secret ${name}:`, err.message);
    }
  }

  private async deleteServiceAccount(name: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedServiceAccount({ name, namespace: NAMESPACE });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete serviceaccount ${name}:`, err.message);
    }
  }

  private async deleteClusterRoleBinding(name: string): Promise<void> {
    try {
      await this.rbacApi.deleteClusterRoleBinding({ name });
    } catch (err: any) {
      if (getK8sErrorStatus(err) !== 404) logger.error(`[MCPRuntimeManager] Failed to delete clusterrolebinding ${name}:`, err.message);
    }
  }

  // ── Readiness Polling ──

  private async pollReadiness(name: string): Promise<boolean> {
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const dep = await this.appsApi.readNamespacedDeployment({ name, namespace: NAMESPACE });
        const readyReplicas = dep.status?.readyReplicas || 0;
        if (readyReplicas >= 1) return true;
      } catch {
        // deployment might not exist yet
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  }
}

let instance: MCPRuntimeManager | null = null;

export function getMCPRuntimeManager(): MCPRuntimeManager {
  if (!instance) {
    instance = new MCPRuntimeManager();
  }
  return instance;
}
