import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';

interface DeploymentTarget {
  labelSelector?: string;
  names: string[];
}

const DEFAULT_DEPLOYMENT_TARGETS: DeploymentTarget[] = [
  { labelSelector: 'component=s3gateway', names: ['s3gateway', 'ray-s3gateway'] },
  { names: ['workers-connector'] },
  { names: ['workers-dataset'] },
];

/**
 * Manages Kubernetes Deployment resources for volume mounting.
 * Targets multiple deployments: s3gateway, workers-connector, and workers-dataset.
 */
export class DeploymentManager {
  private targets: DeploymentTarget[];

  constructor(
    private appsApi: k8s.AppsV1Api,
    private coreApi: k8s.CoreV1Api,
    private namespace: string,
    private logLevel: string = 'info',
    targets?: DeploymentTarget[]
  ) {
    this.targets = targets || DEFAULT_DEPLOYMENT_TARGETS;
  }

  /**
   * Find a single deployment matching a target definition (label selector or name fallback)
   */
  private async findDeploymentByTarget(target: DeploymentTarget): Promise<{
    deployment: k8s.V1Deployment;
    deploymentName: string;
  } | null> {
    if (target.labelSelector) {
      try {
        const deployments = await this.appsApi.listNamespacedDeployment({
          namespace: this.namespace,
          labelSelector: target.labelSelector
        });

        if (deployments.items.length > 0) {
          const deployment = deployments.items[0];
          const deploymentName = deployment.metadata?.name;
          if (deploymentName) {
            return { deployment, deploymentName };
          }
        }
      } catch {
        // Fallback to name-based lookup
      }
    }

    for (const name of target.names) {
      try {
        const result = await this.appsApi.readNamespacedDeployment({
          name,
          namespace: this.namespace
        });
        return { deployment: result, deploymentName: name };
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Find all target deployments that exist in the cluster
   */
  private async findAllDeployments(): Promise<Array<{
    deployment: k8s.V1Deployment;
    deploymentName: string;
  }>> {
    const results: Array<{ deployment: k8s.V1Deployment; deploymentName: string }> = [];

    for (const target of this.targets) {
      const found = await this.findDeploymentByTarget(target);
      if (found) {
        results.push(found);
      }
    }

    return results;
  }

  /**
   * Update all target deployments to include PVC in volumes and volumeMounts
   */
  async updateDeploymentWithPVC(pvcName: string): Promise<void> {
    const deployments = await this.findAllDeployments();
    if (deployments.length === 0) {
      logger.debug(
        `[DeploymentManager] No target deployments found to update with PVC ${pvcName}`
      );
      return;
    }

    // Read PVC once (shared across all deployment updates)
    let bucketName: string;
    let mountPath: string;
    try {
      const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace: this.namespace
      });
      bucketName = pvc.metadata?.labels?.['agentstudio.io/bucket-name'] || pvcName;
      const pvcsMountPath = process.env.PVCS_MOUNT_PATH || '/mnt/pvcs';
      mountPath = `${pvcsMountPath}/${bucketName}`;
    } catch (error: any) {
      logger.warn(
        `[DeploymentManager] Failed to read PVC ${pvcName}: ${error.message}. ` +
        `Cannot determine mount path, skipping deployment updates.`
      );
      return;
    }

    for (const { deployment, deploymentName } of deployments) {
      await this.addPVCToDeployment(deployment, deploymentName, pvcName, bucketName, mountPath);
    }
  }

  /**
   * Add a PVC volume and mount to a single deployment
   */
  private async addPVCToDeployment(
    deployment: k8s.V1Deployment,
    deploymentName: string,
    pvcName: string,
    bucketName: string,
    mountPath: string
  ): Promise<void> {
    try {
      const volumes = deployment.spec?.template.spec?.volumes || [];
      const volumeName = pvcName;
      const volumeExists = volumes.some(
        (v) => v.persistentVolumeClaim?.claimName === pvcName && v.name === volumeName
      );

      if (volumeExists) {
        logger.debug(
          `[DeploymentManager] PVC ${pvcName} already in deployment ${deploymentName}`
        );
        return;
      }

      const newVolume: k8s.V1Volume = {
        name: volumeName,
        persistentVolumeClaim: {
          claimName: pvcName,
        },
      };

      const containers = deployment.spec?.template.spec?.containers || [];
      const updatedContainers = containers.map((container) => {
        const volumeMounts = container.volumeMounts || [];
        const mountExistsByName = volumeMounts.some((vm) => vm.name === volumeName);
        const mountExistsByPath = volumeMounts.some((vm) => vm.mountPath === mountPath);

        if (mountExistsByName) {
          return container;
        }

        if (mountExistsByPath) {
          logger.warn(
            `[DeploymentManager] Mount path ${mountPath} already exists in ${deploymentName}, replacing with PVC ${pvcName}`
          );
          const filteredMounts = volumeMounts.filter((vm) => vm.mountPath !== mountPath);
          return {
            ...container,
            volumeMounts: [
              ...filteredMounts,
              { name: volumeName, mountPath },
            ],
          };
        }

        return {
          ...container,
          volumeMounts: [
            ...volumeMounts,
            { name: volumeName, mountPath },
          ],
        };
      });

      if (!deployment.spec) {
        throw new Error(`Deployment ${deploymentName} has no spec`);
      }

      const updatedDeployment: k8s.V1Deployment = {
        ...deployment,
        spec: {
          ...deployment.spec,
          selector: deployment.spec.selector || { matchLabels: deployment.metadata?.labels || {} },
          template: {
            ...deployment.spec.template,
            spec: {
              ...deployment.spec.template?.spec,
              volumes: [...volumes, newVolume],
              containers: updatedContainers,
            },
          },
        },
      };

      await this.appsApi.replaceNamespacedDeployment({
        name: deploymentName,
        namespace: this.namespace,
        body: updatedDeployment
      });

      logger.info(
        `[DeploymentManager] Updated deployment ${deploymentName} to mount PVC ${pvcName} ` +
        `(bucket: ${bucketName}) at ${mountPath}`
      );
    } catch (error: any) {
      const errorDetails: string[] = [];
      if (error.statusCode) errorDetails.push(`HTTP-Code: ${error.statusCode}`);
      if (error.body?.message) errorDetails.push(`Message: ${error.body.message}`);
      if (error.body?.reason) errorDetails.push(`Reason: ${error.body.reason}`);
      if (error.response?.body?.message) errorDetails.push(`Response: ${error.response.body.message}`);

      const errorMsg = errorDetails.length > 0
        ? `${error.message} | ${errorDetails.join(' | ')}`
        : error.message;

      logger.warn(
        `[DeploymentManager] Failed to update deployment ${deploymentName} with PVC ${pvcName}: ${errorMsg}. ` +
        `PVC is created, but deployment will need helm upgrade or manual update to mount it.`
      );

      if (this.logLevel === 'debug') {
        logger.debug(`[DeploymentManager] Full error object:`, JSON.stringify(error, null, 2).substring(0, 1000));
      }
    }
  }

  /**
   * Remove PVC from all target deployments' volumes and volumeMounts
   */
  async removePVCFromDeployment(pvcName: string): Promise<void> {
    const deployments = await this.findAllDeployments();
    if (deployments.length === 0) {
      logger.debug(
        `[DeploymentManager] No target deployments found to remove PVC ${pvcName}`
      );
      return;
    }

    for (const { deployment, deploymentName } of deployments) {
      await this.removePVCFromSingleDeployment(deployment, deploymentName, pvcName);
    }
  }

  /**
   * Remove a PVC volume and mount from a single deployment
   */
  private async removePVCFromSingleDeployment(
    deployment: k8s.V1Deployment,
    deploymentName: string,
    pvcName: string
  ): Promise<void> {
    try {
      const volumeName = pvcName;
      const volumes = deployment.spec?.template.spec?.volumes || [];
      const volumeExists = volumes.some(
        (v) => v.persistentVolumeClaim?.claimName === pvcName && v.name === volumeName
      );

      if (!volumeExists) {
        logger.debug(
          `[DeploymentManager] PVC ${pvcName} not in deployment ${deploymentName}, nothing to remove`
        );
        return;
      }

      const updatedVolumes = volumes.filter(
        (v) => !(v.persistentVolumeClaim?.claimName === pvcName && v.name === volumeName)
      );

      const containers = deployment.spec?.template.spec?.containers || [];
      const updatedContainers = containers.map((container) => ({
        ...container,
        volumeMounts: (container.volumeMounts || []).filter(
          (vm) => vm.name !== volumeName
        ),
      }));

      if (!deployment.spec) {
        throw new Error(`Deployment ${deploymentName} has no spec`);
      }

      const updatedDeployment: k8s.V1Deployment = {
        ...deployment,
        spec: {
          ...deployment.spec,
          selector: deployment.spec.selector || { matchLabels: deployment.metadata?.labels || {} },
          template: {
            ...deployment.spec.template,
            spec: {
              ...deployment.spec.template?.spec,
              volumes: updatedVolumes,
              containers: updatedContainers,
            },
          },
        },
      };

      await this.appsApi.replaceNamespacedDeployment({
        name: deploymentName,
        namespace: this.namespace,
        body: updatedDeployment
      });

      logger.info(
        `[DeploymentManager] Removed PVC ${pvcName} from deployment ${deploymentName}`
      );
    } catch (error: any) {
      const errorDetails: string[] = [];
      if (error.statusCode) errorDetails.push(`HTTP-Code: ${error.statusCode}`);
      if (error.body?.message) errorDetails.push(`Message: ${error.body.message}`);
      if (error.body?.reason) errorDetails.push(`Reason: ${error.body.reason}`);

      const errorMsg = errorDetails.length > 0
        ? `${error.message} | ${errorDetails.join(' | ')}`
        : error.message;

      logger.warn(
        `[DeploymentManager] Failed to remove PVC ${pvcName} from deployment ${deploymentName}: ${errorMsg}`
      );

      if (this.logLevel === 'debug') {
        logger.debug(`[DeploymentManager] Full error object:`, JSON.stringify(error, null, 2).substring(0, 1000));
      }
    }
  }

  /**
   * Reconcile all target deployments: Remove PVC mounts that don't have corresponding PVCs or buckets
   * @param validPVCNames Set of valid PVC names that should be mounted
   * @param newlyCreatedPVCNames Optional set of PVC names that were just created (should not be removed)
   */
  async reconcileDeployment(validPVCNames: Set<string>, newlyCreatedPVCNames?: Set<string>): Promise<void> {
    const deployments = await this.findAllDeployments();
    if (deployments.length === 0) {
      logger.debug(
        `[DeploymentManager] No target deployments found for reconciliation`
      );
      return;
    }

    for (const { deployment, deploymentName } of deployments) {
      await this.reconcileSingleDeployment(deployment, deploymentName, validPVCNames, newlyCreatedPVCNames);
    }
  }

  /**
   * Reconcile a single deployment: remove orphaned PVC mounts
   */
  private async reconcileSingleDeployment(
    deployment: k8s.V1Deployment,
    deploymentName: string,
    validPVCNames: Set<string>,
    newlyCreatedPVCNames?: Set<string>
  ): Promise<void> {
    try {
      const volumes = deployment.spec?.template.spec?.volumes || [];
      const containers = deployment.spec?.template.spec?.containers || [];

      const orphanedPVCNames: string[] = [];
      const orphanedVolumeNames: Set<string> = new Set();
      const volumesToKeep: k8s.V1Volume[] = [];

      for (const volume of volumes) {
        const pvcName = volume.persistentVolumeClaim?.claimName;
        if (pvcName) {
          try {
            const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
              name: pvcName,
              namespace: this.namespace
            });

            const actualPVCName = pvc.metadata?.name || pvcName;
            if (actualPVCName !== pvcName) {
              logger.warn(
                `[DeploymentManager Reconciliation] PVC name mismatch in ${deploymentName}: ` +
                `volume claims ${pvcName}, but PVC name is ${actualPVCName}`
              );
            }

            const isStorageManagerPVC = pvc.metadata?.labels?.['agentstudio.io/managed-by'] === 'storage-manager';

            if (!isStorageManagerPVC) {
              volumesToKeep.push(volume);
              continue;
            }

            const managedBy = pvc.metadata?.labels?.['agentstudio.io/managed-by'] ||
                             pvc.metadata?.annotations?.['agentstudio.io/managed-by'] || '';
            if (managedBy === 'helm') {
              volumesToKeep.push(volume);
              logger.info(
                `[DeploymentManager Reconciliation] Keeping Helm-managed PVC in ${deploymentName}: ${actualPVCName}`
              );
              continue;
            }

            if (!validPVCNames.has(actualPVCName)) {
              if (newlyCreatedPVCNames &&
                  (newlyCreatedPVCNames.has(pvcName) || newlyCreatedPVCNames.has(actualPVCName))) {
                volumesToKeep.push(volume);
                logger.info(
                  `[DeploymentManager Reconciliation] Skipping newly created PVC ${actualPVCName} ` +
                  `in ${deploymentName} (will be validated on next sync cycle)`
                );
              } else {
                if (this.logLevel === 'debug') {
                  const validPVCsList = Array.from(validPVCNames).slice(0, 10).join(', ');
                  const newlyCreatedList = newlyCreatedPVCNames ? Array.from(newlyCreatedPVCNames).join(', ') : 'none';
                  logger.debug(
                    `[DeploymentManager Reconciliation] PVC ${actualPVCName} (volume claim: ${pvcName}) ` +
                    `not in validPVCNames for ${deploymentName}. Valid PVCs (first 10): ${validPVCsList}, ` +
                    `Newly created: ${newlyCreatedList}`
                  );
                }
                orphanedPVCNames.push(actualPVCName);
                orphanedVolumeNames.add(volume.name);
                orphanedVolumeNames.add(actualPVCName);
                orphanedVolumeNames.add(`pvc-${actualPVCName}`);
                logger.info(
                  `[DeploymentManager Reconciliation] Found orphaned PVC mount in ${deploymentName}: ${actualPVCName} ` +
                  `(volume claim: ${pvcName}, volume name: ${volume.name})`
                );
              }
            } else {
              volumesToKeep.push(volume);
            }
          } catch (error: any) {
            if (error.statusCode === 404) {
              orphanedPVCNames.push(pvcName);
              orphanedVolumeNames.add(volume.name);
              orphanedVolumeNames.add(pvcName);
              orphanedVolumeNames.add(`pvc-${pvcName}`);
              logger.info(
                `[DeploymentManager Reconciliation] Found orphaned PVC mount in ${deploymentName}: ${pvcName} ` +
                `(PVC no longer exists, volume name: ${volume.name})`
              );
            } else {
              volumesToKeep.push(volume);
            }
          }
        } else {
          volumesToKeep.push(volume);
        }
      }

      if (orphanedPVCNames.length > 0) {
        logger.info(
          `[DeploymentManager Reconciliation] Removing ${orphanedPVCNames.length} orphaned PVC mount(s) ` +
          `from deployment ${deploymentName}`
        );

        const updatedContainers = containers.map((container) => {
          const volumeMounts = (container.volumeMounts || []).filter((vm) => {
            return !orphanedVolumeNames.has(vm.name);
          });
          return { ...container, volumeMounts };
        });

        if (!deployment.spec) {
          throw new Error(`Deployment ${deploymentName} has no spec`);
        }

        const updatedDeployment: k8s.V1Deployment = {
          ...deployment,
          spec: {
            ...deployment.spec,
            selector: deployment.spec.selector || { matchLabels: deployment.metadata?.labels || {} },
            template: {
              ...deployment.spec.template,
              spec: {
                ...deployment.spec.template?.spec,
                volumes: volumesToKeep,
                containers: updatedContainers,
              },
            },
          },
        };

        await this.appsApi.replaceNamespacedDeployment({
          name: deploymentName,
          namespace: this.namespace,
          body: updatedDeployment
        });

        logger.info(
          `[DeploymentManager Reconciliation] Successfully removed ${orphanedPVCNames.length} ` +
          `orphaned PVC mount(s) from ${deploymentName}: ${orphanedPVCNames.join(', ')}`
        );
      } else {
        if (this.logLevel === 'debug') {
          logger.debug(
            `[DeploymentManager Reconciliation] No orphaned PVC mounts found in ${deploymentName}`
          );
        }
      }
    } catch (error: any) {
      logger.error(
        `[DeploymentManager Reconciliation] Failed to reconcile deployment ${deploymentName}: ${error.message}`
      );
      if (this.logLevel === 'debug') {
        logger.debug(`[DeploymentManager Reconciliation] Full error:`, error);
      }
    }
  }
}

