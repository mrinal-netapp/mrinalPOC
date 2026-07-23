import * as k8s from '@kubernetes/client-node';

export interface KubernetesClients {
  storageApi: k8s.StorageV1Api;
  coreApi: k8s.CoreV1Api;
  appsApi: k8s.AppsV1Api;
  customObjectsApi: k8s.CustomObjectsApi;
  namespace: string;
}

/**
 * Factory for creating Kubernetes API clients
 */
export class KubernetesClientFactory {
  static createClients(kubeconfigPath?: string): KubernetesClients {
    const kc = new k8s.KubeConfig();

    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      try {
        kc.loadFromCluster();
      } catch (error) {
        kc.loadFromDefault();
      }
    }

    const storageApi = kc.makeApiClient(k8s.StorageV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const namespace = KubernetesClientFactory.getDefaultNamespace(kc);

    return {
      storageApi,
      coreApi,
      appsApi,
      customObjectsApi,
      namespace
    };
  }

  private static getDefaultNamespace(kc: k8s.KubeConfig): string {
    try {
      const fs = require('fs');
      const namespaceFile =
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
      if (fs.existsSync(namespaceFile)) {
        const namespace = fs.readFileSync(namespaceFile, 'utf8').trim();
        if (namespace) {
          return namespace;
        }
      }
    } catch (error) {
      // Ignore
    }

    try {
      const context = kc.getCurrentContext();
      const ctx = kc.getContextObject(context);
      if (ctx?.namespace) {
        return ctx.namespace;
      }
    } catch (error) {
      // Ignore
    }

    return 'default';
  }
}

