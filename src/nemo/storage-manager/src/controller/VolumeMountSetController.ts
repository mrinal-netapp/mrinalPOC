import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
/**
 * VolumeMountSet controller: reconciles VolumeMountSet CRs by patching target
 * Deployment volumes/volumeMounts (managed PVCs only), detects mount failures
 * via Pod Events, and updates CR status (evictedPvcNames, pvcConditions).
 */

import * as k8s from '@kubernetes/client-node';

const CRD_GROUP = 'agentstudio.io';
const CRD_VERSION = 'v1';
const CRD_PLURAL = 'volumemountsets';

const DEFAULT_MOUNT_PATH_BASE = '/mnt/pvcs';
/** When true (default), managed volumeMounts use readOnly — safe for ONTAP source volumes; set false only if a managed PVC must be writable. */
const READ_ONLY_MANAGED_MOUNTS =
  (process.env.VOLUME_MOUNT_SET_READ_ONLY || 'true').toLowerCase() !== 'false';
const MOUNT_FAILURE_REMOVAL_MINUTES = parseInt(process.env.MOUNT_FAILURE_REMOVAL_MINUTES || '5', 10);
const MOUNT_FAILURE_RETRY_INTERVAL_MINUTES = parseInt(
  process.env.MOUNT_FAILURE_RETRY_INTERVAL_MINUTES || '30',
  10
);
const RECONCILE_INTERVAL_MS = 15_000;

interface VolumeMountSetCR {
  apiVersion?: string;
  kind?: string;
  metadata: { name: string; namespace: string; generation?: number };
  spec?: {
    target?: { deploymentName?: string };
    desiredPvcNames?: string[];
    mountPathBase?: string;
    pvcMountPaths?: Record<string, string>;
  };
  status?: {
    evictedPvcNames?: string[];
    pvcConditions?: Array<{
      pvcName: string;
      mounted?: boolean;
      message?: string;
      firstFailureAt?: string;
      lastFailureAt?: string;
      evictedAt?: string;
    }>;
    conditions?: Array<{ type: string; message?: string; lastTransitionTime?: string }>;
    observedGeneration?: number;
  };
}

export class VolumeMountSetController {
  private customObjectsApi: k8s.CustomObjectsApi;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private storageApi: k8s.StorageV1Api;
  private namespace: string;
  private kubeConfig: k8s.KubeConfig;
  private watch: k8s.Watch | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private logLevel: string;

  constructor(options: {
    customObjectsApi: k8s.CustomObjectsApi;
    coreApi: k8s.CoreV1Api;
    appsApi: k8s.AppsV1Api;
    storageApi: k8s.StorageV1Api;
    namespace: string;
    kubeConfig: k8s.KubeConfig;
    logLevel?: string;
  }) {
    this.customObjectsApi = options.customObjectsApi;
    this.coreApi = options.coreApi;
    this.appsApi = options.appsApi;
    this.storageApi = options.storageApi;
    this.namespace = options.namespace;
    this.kubeConfig = options.kubeConfig;
    this.logLevel = options.logLevel ?? 'info';
  }

  start(): void {
    const path = `/apis/${CRD_GROUP}/${CRD_VERSION}/namespaces/${this.namespace}/${CRD_PLURAL}`;
    this.watch = new k8s.Watch(this.kubeConfig);

    const startWatch = () => {
      this.watch!.watch(
        path,
        {},
        (type: string, obj: VolumeMountSetCR) => {
          if (type === 'ADDED' || type === 'MODIFIED') {
            this.reconcileOne(obj).catch((err: any) =>
              logger.error(`[VolumeMountSetController] Reconcile error for ${obj.metadata?.name}:`, err?.message)
            );
          }
        },
        (err: any) => {
          if (err) {
            logger.error('[VolumeMountSetController] Watch error:', err?.message || err);
            setTimeout(() => startWatch(), 5000);
          }
        }
      );
    };
    startWatch();

    this.reconcileTimer = setInterval(() => {
      this.reconcileAll().catch((err: any) =>
        logger.error('[VolumeMountSetController] Periodic reconcile error:', err?.message)
      );
    }, RECONCILE_INTERVAL_MS);

    logger.info(
      `[VolumeMountSetController] Started watching ${CRD_PLURAL} in namespace ${this.namespace}`
    );
  }

  stop(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.watch = null;
  }

  private async reconcileAll(): Promise<void> {
    const response = await this.customObjectsApi.listNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: this.namespace,
      plural: CRD_PLURAL
    });
    const list = (response as any).body || response;
    const items = list.items || [];
    for (const cr of items) {
      await this.reconcileOne(cr);
    }
  }

  private async reconcileOne(cr: VolumeMountSetCR): Promise<void> {
    const name = cr.metadata?.name;
    const ns = cr.metadata?.namespace || this.namespace;
    if (!name || !cr.spec?.target?.deploymentName) return;

    const desiredPvcNames = cr.spec.desiredPvcNames || [];
    const evictedPvcNames = cr.status?.evictedPvcNames || [];
    const effectivePvcNames = desiredPvcNames.filter((p) => !evictedPvcNames.includes(p));
    const mountPathBase = cr.spec.mountPathBase ?? DEFAULT_MOUNT_PATH_BASE;
    const pvcMountPaths = cr.spec.pvcMountPaths || {};
    const generation = cr.metadata.generation ?? 0;
    const observedGeneration = cr.status?.observedGeneration;

    // 1) Resolve target deployment
    let deployment: k8s.V1Deployment;
    try {
      const res = await this.appsApi.readNamespacedDeployment({
        name: cr.spec.target.deploymentName,
        namespace: ns
      });
      deployment = (res as any).body ?? res;
    } catch (err: any) {
      if (err.statusCode === 404 || err.body?.code === 404) {
        await this.patchStatus(cr, {
          conditions: [{ type: 'TargetNotFound', message: `Deployment ${cr.spec.target.deploymentName} not found`, lastTransitionTime: new Date().toISOString() }],
          observedGeneration: generation
        });
        return;
      }
      throw err;
    }

    // 2) Deployment patch: only when spec changed or first time
    const skipDeployPatch = observedGeneration === generation;
    if (!skipDeployPatch) {
      const currentVolumes = deployment.spec?.template?.spec?.volumes || [];
      const currentContainers = deployment.spec?.template?.spec?.containers || [];
      const managedVolumeNames = new Set(desiredPvcNames);
      const nonManagedVolumes = currentVolumes.filter((v) => {
        const claim = v.persistentVolumeClaim?.claimName;
        return !claim || !managedVolumeNames.has(claim);
      });
      const managedVolumes: k8s.V1Volume[] = [];
      const managedMountPaths = new Map<string, string>();

      for (const pvcName of effectivePvcNames) {
        let mountPath = pvcMountPaths[pvcName];
        if (!mountPath) {
          try {
            const pvcRes = await this.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: ns });
            const pvc = (pvcRes as any).body ?? pvcRes;
            const bucketName = pvc?.metadata?.labels?.['agentstudio.io/bucket-name'] || pvcName;
            mountPath = `${mountPathBase}/${bucketName}`;
          } catch {
            mountPath = `${mountPathBase}/${pvcName}`;
          }
        }
        managedMountPaths.set(pvcName, mountPath);
        managedVolumes.push({
          name: pvcName,
          persistentVolumeClaim: { claimName: pvcName }
        });
      }

      const newVolumes = [...nonManagedVolumes, ...managedVolumes];
      const newContainers = currentContainers.map((container) => {
        const currentMounts = container.volumeMounts || [];
        const nonManagedMounts = currentMounts.filter((vm) => !managedVolumeNames.has(vm.name));
        const managedMounts: k8s.V1VolumeMount[] = effectivePvcNames.map((pvcName) => ({
          name: pvcName,
          mountPath: managedMountPaths.get(pvcName) || `${mountPathBase}/${pvcName}`,
          readOnly: READ_ONLY_MANAGED_MOUNTS,
        }));
        return {
          name: container.name,
          volumeMounts: [...nonManagedMounts, ...managedMounts]
        };
      });

      const patchBody = {
        spec: {
          template: {
            spec: {
              volumes: newVolumes,
              containers: newContainers
            }
          }
        }
      };

      try {
        await this.appsApi.patchNamespacedDeployment({
          name: cr.spec.target.deploymentName,
          namespace: ns,
          body: patchBody as any
        });
        if (this.logLevel === 'debug') {
          logger.debug(`[VolumeMountSetController] Patched deployment ${cr.spec.target.deploymentName} with ${effectivePvcNames.length} managed PVC(s)`);
        }
      } catch (patchErr: any) {
        logger.error(`[VolumeMountSetController] Failed to patch deployment: ${patchErr?.message}`);
      }
    }

    // 3) Mount failure detection: list Pods and Events
    const selector = deployment.spec?.selector?.matchLabels;
    const labelSelector = selector ? Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',') : undefined;
    let pods: k8s.V1Pod[] = [];
    try {
      const listPods = await this.coreApi.listNamespacedPod({
        namespace: ns,
        labelSelector
      });
      const listBody = (listPods as any).body ?? listPods;
      pods = listBody.items || [];
    } catch {
      // continue without pods
    }

    const failedMountPvcs = new Set<string>();
    const failureMessages = new Map<string, string>();
    const removalThresholdMs = MOUNT_FAILURE_REMOVAL_MINUTES * 60 * 1000;
    const retryThresholdMs = MOUNT_FAILURE_RETRY_INTERVAL_MINUTES * 60 * 1000;
    try {
      const eventsList = await this.coreApi.listNamespacedEvent({
        namespace: ns
      });
      const eventsBody = (eventsList as any).body ?? eventsList;
      const events = eventsBody.items || [];

      for (const ev of events) {
        if (ev.reason !== 'FailedMount') continue;
        const involved = ev.involvedObject;
        const isPod = involved?.kind === 'Pod' && pods.some((p) => p.metadata?.name === involved.name && p.metadata?.namespace === involved.namespace);
        if (!isPod) continue;
        const msg = ev.message || '';
        const match = msg.match(/volume "([^"]+)"/);
        const volumeName = match ? match[1] : null;
        if (!volumeName || !desiredPvcNames.includes(volumeName)) continue;
        failedMountPvcs.add(volumeName);
        if (msg && !failureMessages.has(volumeName)) failureMessages.set(volumeName, msg.slice(0, 200));
      }
    } catch {
      // continue without events
    }

    // Detect runtime mount failures via pod NotReady status (e.g. readiness probe failing
    // when NFS server is unreachable). We cannot determine which PVC caused NotReady, so
    // mark all desired PVCs as potentially failing.
    for (const pod of pods) {
      const conditions = pod.status?.conditions || [];
      const readyCondition = conditions.find((c) => c.type === 'Ready');
      if (readyCondition?.status === 'False') {
        const msg = readyCondition.message || 'Pod not ready (possible mount failure)';
        for (const pvcName of desiredPvcNames) {
          if (!failedMountPvcs.has(pvcName)) {
            failedMountPvcs.add(pvcName);
            if (!failureMessages.has(pvcName)) {
              failureMessages.set(pvcName, msg.slice(0, 200));
            }
          }
        }
      }
    }

    const existingConditions = new Map(
      (cr.status?.pvcConditions || []).map((c) => [c.pvcName, c])
    );
    const nowIso = new Date().toISOString();
    const newPvcConditions: NonNullable<VolumeMountSetCR['status']>['pvcConditions'] = [];
    let newEvictedPvcNames = [...evictedPvcNames];

    for (const pvcName of desiredPvcNames) {
      const failing = failedMountPvcs.has(pvcName);
      const prev = existingConditions.get(pvcName);
      const firstFailureAt = prev?.firstFailureAt ?? (failing ? nowIso : undefined);
      const lastFailureAt = failing ? nowIso : prev?.lastFailureAt;
      const evictedAt = prev?.evictedAt;
      const mounted = !failing && !evictedPvcNames.includes(pvcName);

      if (failing) {
        const message = failureMessages.get(pvcName) || 'MountVolume.SetUp failed';
        if (firstFailureAt) {
          const firstTs = new Date(firstFailureAt).getTime();
          if (new Date().getTime() - firstTs >= removalThresholdMs && !newEvictedPvcNames.includes(pvcName)) {
            newEvictedPvcNames = [...newEvictedPvcNames, pvcName];
          }
        }
        const isEvicted = newEvictedPvcNames.includes(pvcName);
        newPvcConditions.push({
          pvcName,
          mounted: false,
          message,
          firstFailureAt: firstFailureAt || nowIso,
          lastFailureAt: lastFailureAt || nowIso,
          evictedAt: isEvicted ? (evictedAt || nowIso) : undefined
        });
      } else {
        if (evictedPvcNames.includes(pvcName)) {
          const evictedAtTime = evictedAt ? new Date(evictedAt).getTime() : 0;
          if (Date.now() - evictedAtTime >= retryThresholdMs) {
            newEvictedPvcNames = newEvictedPvcNames.filter((p) => p !== pvcName);
          }
          newPvcConditions.push({
            pvcName,
            mounted: false,
            message: prev?.message,
            firstFailureAt: prev?.firstFailureAt,
            lastFailureAt: prev?.lastFailureAt,
            evictedAt: prev?.evictedAt
          });
        } else {
          newPvcConditions.push({
            pvcName,
            mounted: true,
            message: undefined,
            firstFailureAt: undefined,
            lastFailureAt: undefined,
            evictedAt: undefined
          });
        }
      }
    }

    await this.patchStatus(cr, {
      evictedPvcNames: newEvictedPvcNames,
      pvcConditions: newPvcConditions,
      conditions: (cr.status?.conditions || []).filter((c) => c.type !== 'TargetNotFound'),
      observedGeneration: generation
    });
  }

  private async patchStatus(
    cr: VolumeMountSetCR,
    statusUpdate: Partial<NonNullable<VolumeMountSetCR['status']>>
  ): Promise<void> {
    const name = cr.metadata?.name;
    const ns = cr.metadata?.namespace || this.namespace;
    const currentStatus = cr.status || {};
    const newStatus = { ...currentStatus, ...statusUpdate };

    const patch = [{ op: 'replace' as const, path: '/status', value: newStatus }];

    await this.customObjectsApi.patchNamespacedCustomObjectStatus({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: ns,
      plural: CRD_PLURAL,
      name,
      body: patch as any
    });
  }
}
