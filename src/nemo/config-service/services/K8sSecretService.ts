import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';

/**
 * Extract HTTP status code from a @kubernetes/client-node error.
 * v1.x generated client throws ApiException with .code as the HTTP status.
 */
function getK8sErrorStatus(err: any): number | undefined {
  if (typeof err?.code === 'number') return err.code;
  return (
    err?.response?.status ??
    err?.response?.statusCode ??
    err?.statusCode ??
    err?.body?.code ??
    undefined
  );
}

const SHARED_NAMESPACE = process.env.K8S_NAMESPACE || process.env.NAMESPACE || 'nemo';

/**
 * Service for managing Kubernetes Secrets used by the Credential system.
 * All secrets are stored in the shared application namespace (NAMESPACE env var,
 * default "nemo"). Project isolation is achieved via secret naming conventions
 * and the `agentstudio/project-id` label.
 */
export class K8sSecretService {
  private coreApi: k8s.CoreV1Api;
  private namespace: string;

  constructor() {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      kc.loadFromCluster();
    }
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.namespace = SHARED_NAMESPACE;
    logger.info(`[K8sSecretService] Using shared namespace: ${this.namespace}`);
  }

  /**
   * Create a K8s Opaque Secret in the shared namespace.
   * @param projectId - Project that owns this credential (used for labeling)
   * @param secretName - Name of the secret
   * @param data - Key-value pairs to store (will be base64 encoded by K8s)
   */
  async createSecret(
    projectId: string,
    secretName: string,
    data: Record<string, string>
  ): Promise<void> {
    const stringData = { ...data };
    await this.coreApi.createNamespacedSecret({
      namespace: this.namespace,
      body: {
        metadata: {
          name: secretName,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'config-service',
            'agentstudio/credential': 'true',
            'agentstudio/project-id': projectId,
          },
        },
        type: 'Opaque',
        stringData,
      },
    });
    logger.info(`[K8sSecretService] Created secret ${secretName} in namespace ${this.namespace}`);
  }

  /**
   * Read a K8s Secret and return decoded data.
   */
  async readSecret(secretName: string): Promise<Record<string, string>> {
    const response = await this.coreApi.readNamespacedSecret({
      name: secretName,
      namespace: this.namespace,
    });
    const raw = response?.data || {};
    const decoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        decoded[key] = Buffer.from(value, 'base64').toString('utf-8');
      }
    }
    return decoded;
  }

  /**
   * Update an existing K8s Secret (replace all data).
   * @param projectId - Project that owns this credential (used for labeling)
   */
  async updateSecret(
    projectId: string,
    secretName: string,
    data: Record<string, string>
  ): Promise<void> {
    await this.coreApi.replaceNamespacedSecret({
      name: secretName,
      namespace: this.namespace,
      body: {
        metadata: {
          name: secretName,
          namespace: this.namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'config-service',
            'agentstudio/credential': 'true',
            'agentstudio/project-id': projectId,
          },
        },
        type: 'Opaque',
        stringData: { ...data },
      },
    });
    logger.info(`[K8sSecretService] Updated secret ${secretName} in namespace ${this.namespace}`);
  }

  /**
   * Delete a K8s Secret.
   */
  async deleteSecret(secretName: string): Promise<void> {
    try {
      await this.coreApi.deleteNamespacedSecret({
        name: secretName,
        namespace: this.namespace,
      });
      logger.info(`[K8sSecretService] Deleted secret ${secretName} from namespace ${this.namespace}`);
    } catch (err: any) {
      if (getK8sErrorStatus(err) === 404) {
        logger.warn(`[K8sSecretService] Secret ${secretName} not found in namespace ${this.namespace}, skipping delete`);
      } else {
        throw err;
      }
    }
  }
}

/** Singleton instance */
let instance: K8sSecretService | null = null;

export function getK8sSecretService(): K8sSecretService {
  if (!instance) {
    instance = new K8sSecretService();
  }
  return instance;
}
