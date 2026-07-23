import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { LabelBuilder } from '../utils/LabelBuilder';
import { NameGenerator } from '../utils/NameGenerator';

/**
 * Builder for Kubernetes Secret resources
 */
export class SecretBuilder {
  /**
   * Build Secret spec for bucket authentication
   */
  static buildSecretSpec(
    spec: BucketStorageClassSpec,
    namespace: string
  ): k8s.V1Secret | null {
    // Only create secret if auth is needed
    if (!spec.auth_info.username && !spec.auth_info.password_encrypted) {
      return null;
    }

    const secretName = NameGenerator.getSecretName(
      spec.project_id,
      spec.bucket_name
    );
    const secretData: Record<string, string> = {};

    if (spec.auth_info.username) {
      secretData['username'] = spec.auth_info.username;
    }

    if (spec.auth_info.password_encrypted) {
      // Store password_encrypted as-is in secret
      // The CSI driver will use it directly for authentication
      secretData['password'] = spec.auth_info.password_encrypted;
    }

    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: namespace,
        labels: LabelBuilder.buildBucketLabels(
          spec.bucket_name,
          spec.project_id
        ),
      },
      type: 'Opaque',
      data: Object.fromEntries(
        Object.entries(secretData).map(([key, value]) => [
          key,
          Buffer.from(value).toString('base64'),
        ])
      ),
    };
  }
}

