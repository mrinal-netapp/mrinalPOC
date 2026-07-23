/**
 * Standalone entrypoint for the VolumeMountSet controller.
 * Run when the controller is deployed as a separate process (e.g. npm run start:controller).
 * Uses same env as storage-manager: KUBECONFIG_PATH, K8S_NAMESPACE, LOG_LEVEL.
 */

import * as k8s from '@kubernetes/client-node';
import { VolumeMountSetController } from './controller/VolumeMountSetController';
import { KubernetesClientFactory } from './server/storage/factories/KubernetesClientFactory';

const namespace = process.env.K8S_NAMESPACE || process.env.NAMESPACE || 'default';
const kubeconfigPath = process.env.KUBECONFIG_PATH;
const logLevel = process.env.LOG_LEVEL || 'info';

const kc = new k8s.KubeConfig();
if (kubeconfigPath) {
  kc.loadFromFile(kubeconfigPath);
} else {
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
}

const clients = KubernetesClientFactory.createClients(kubeconfigPath);
const controller = new VolumeMountSetController({
  customObjectsApi: clients.customObjectsApi,
  coreApi: clients.coreApi,
  appsApi: clients.appsApi,
  storageApi: clients.storageApi,
  namespace: clients.namespace,
  kubeConfig: kc,
  logLevel
});

controller.start();

const shutdown = () => {
  controller.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
