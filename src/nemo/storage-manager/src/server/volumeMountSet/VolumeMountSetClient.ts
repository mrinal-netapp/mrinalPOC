import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
/**
 * Client for VolumeMountSet CR (agentstudio.io/v1).
 * Storage-manager writes spec (desiredPvcNames); controller writes status.
 */

import * as k8s from '@kubernetes/client-node';

const CRD_GROUP = 'agentstudio.io';
const CRD_VERSION = 'v1';
const CRD_PLURAL = 'volumemountsets';

export interface VolumeMountSetSpec {
  target: {
    deploymentName: string;
    labelSelector?: string;
    kind?: string;
  };
  desiredPvcNames: string[];
  mountPathBase?: string;
  pvcMountPaths?: Record<string, string>;
}

export interface VolumeMountSetPvcCondition {
  pvcName: string;
  mounted: boolean;
  message?: string;
  firstFailureAt?: string;
  lastFailureAt?: string;
  evictedAt?: string;
}

export interface VolumeMountSetStatus {
  evictedPvcNames?: string[];
  pvcConditions?: VolumeMountSetPvcCondition[];
  targetResolved?: object;
  conditions?: Array<{ type: string; message?: string; lastTransitionTime?: string }>;
  observedGeneration?: number;
}

export interface VolumeMountSetCR {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string; [key: string]: unknown };
  spec?: VolumeMountSetSpec;
  status?: VolumeMountSetStatus;
}

export class VolumeMountSetClient {
  private customObjectsApi: k8s.CustomObjectsApi;
  private namespace: string;
  private crName: string;
  private targetDeploymentName: string;
  private mountPathBase: string;
  private logLevel: string;

  constructor(options: {
    customObjectsApi: k8s.CustomObjectsApi;
    namespace: string;
    crName: string;
    targetDeploymentName: string;
    mountPathBase?: string;
    logLevel?: string;
  }) {
    this.customObjectsApi = options.customObjectsApi;
    this.namespace = options.namespace;
    this.crName = options.crName;
    this.targetDeploymentName = options.targetDeploymentName;
    this.mountPathBase = options.mountPathBase ?? '/mnt/pvcs';
    this.logLevel = options.logLevel ?? 'info';
  }

  /**
   * Create or update the VolumeMountSet CR spec (desiredPvcNames, target, mountPathBase).
   * Does not touch status (controller owns status).
   */
  async createOrUpdate(spec: { desiredPvcNames: string[]; mountPathBase?: string }): Promise<void> {
    const body: VolumeMountSetCR = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
      kind: 'VolumeMountSet',
      metadata: {
        name: this.crName,
        namespace: this.namespace,
      },
      spec: {
        target: {
          deploymentName: this.targetDeploymentName,
        },
        desiredPvcNames: spec.desiredPvcNames,
        mountPathBase: spec.mountPathBase ?? this.mountPathBase,
      },
    };

    try {
      await this.customObjectsApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
        name: this.crName,
      });

      await this.customObjectsApi.replaceNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
        name: this.crName,
        body,
      });
      if (this.logLevel === 'debug') {
        logger.debug(`[VolumeMountSet] Updated CR ${this.crName}, desiredPvcNames: ${spec.desiredPvcNames.length}`);
      } else {
        logger.info(`[VolumeMountSet] Updated CR ${this.crName} with ${spec.desiredPvcNames.length} desired PVC(s)`);
      }
    } catch (error: any) {
      if (error.statusCode === 404 || error.body?.code === 404) {
        await this.customObjectsApi.createNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: this.namespace,
          plural: CRD_PLURAL,
          body,
        });
        logger.info(`[VolumeMountSet] Created CR ${this.crName} with ${spec.desiredPvcNames.length} desired PVC(s)`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Read the VolumeMountSet CR and return its status (and spec for reference).
   * Used by reportHealth to get evictedPvcNames and pvcConditions.
   */
  async getStatus(): Promise<VolumeMountSetStatus | null> {
    try {
      const response = await this.customObjectsApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
        name: this.crName,
      });
      const cr = response.body as VolumeMountSetCR;
      return cr.status ?? null;
    } catch (error: any) {
      if (error.statusCode === 404 || error.body?.code === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Read the full CR (spec + status). Used when we need both.
   */
  async get(): Promise<VolumeMountSetCR | null> {
    try {
      const response = await this.customObjectsApi.getNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace: this.namespace,
        plural: CRD_PLURAL,
        name: this.crName,
      });
      return response.body as VolumeMountSetCR;
    } catch (error: any) {
      if (error.statusCode === 404 || error.body?.code === 404) {
        return null;
      }
      throw error;
    }
  }
}
