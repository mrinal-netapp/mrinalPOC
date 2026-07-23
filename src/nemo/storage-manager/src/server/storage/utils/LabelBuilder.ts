/**
 * Utility for building Kubernetes labels and annotations consistently
 */

export interface BucketLabels {
  'agentstudio.io/bucket-name': string;
  'agentstudio.io/project-id': string;
  'agentstudio.io/managed-by': string;
  [key: string]: string;
}

export interface StorageClassLabels extends BucketLabels {
  'agentstudio.io/volume-type': string;
}

/**
 * Type definitions for documentation purposes.
 * Methods return Record<string, string> for Kubernetes API compatibility.
 */
export interface StorageClassAnnotations {
  'agentstudio.io/volume-endpoint': string;
  'agentstudio.io/protocol': string;
  'agentstudio.io/role': string;
  'agentstudio.io/mount-options'?: string;
}

export interface PVCAnnotations {
  'agentstudio.io/bucket-name': string;
  'agentstudio.io/project-id': string;
  'agentstudio.io/storage-class': string;
  'agentstudio.io/managed-by': string;
  'nfs.csi.k8s.io/mountOptions'?: string;
  'smb.csi.k8s.io/mountOptions'?: string;
  'nfs.csi.k8s.io/server'?: string;
  'nfs.csi.k8s.io/share'?: string;
}

export class LabelBuilder {
  /**
   * Build common bucket labels
   */
  static buildBucketLabels(
    bucketName: string,
    projectId: string
  ): BucketLabels {
    return {
      'agentstudio.io/bucket-name': bucketName,
      'agentstudio.io/project-id': projectId,
      'agentstudio.io/managed-by': 'storage-manager',
    };
  }

  /**
   * Build StorageClass labels
   */
  static buildStorageClassLabels(
    bucketName: string,
    projectId: string,
    volumeType: string
  ): StorageClassLabels {
    return {
      ...this.buildBucketLabels(bucketName, projectId),
      'agentstudio.io/volume-type': volumeType.toLowerCase(),
    };
  }

  /**
   * Build StorageClass annotations
   * Returns Record<string, string> compatible with Kubernetes API
   */
  static buildStorageClassAnnotations(
    endpoint: string,
    protocol: string,
    role: string,
    mountOptions?: string[],
    volumeType: string = 'nfs'
  ): Record<string, string> {
    const annotations: Record<string, string> = {
      'agentstudio.io/volume-endpoint': endpoint,
      'agentstudio.io/protocol': protocol.toLowerCase(),
      'agentstudio.io/role': role,
    };

    if (mountOptions && mountOptions.length > 0) {
      annotations['agentstudio.io/mount-options'] = mountOptions.join(',');
    } else if (volumeType.toLowerCase() === 'nfs') {
      annotations['agentstudio.io/mount-options'] = 'noac'; // Default for NFS
    }

    return annotations;
  }

  /**
   * Build PVC annotations from StorageClass metadata
   * Returns Record<string, string> compatible with Kubernetes API
   * Only includes defined values (filters out undefined)
   * @param projectId Optional explicit project_id (required for dynamic provisioning where StorageClass doesn't have the label)
   */
  static buildPVCAnnotations(
    storageClass: {
      metadata?: {
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
    },
    bucketName: string,
    storageClassName: string,
    projectId?: string // NEW: Optional explicit project_id
  ): Record<string, string> {
    // Use explicit projectId if provided, otherwise try to get from StorageClass labels
    // For dynamic provisioning, StorageClass won't have the label, so projectId must be provided
    const finalNamespaceId = projectId || 
      storageClass.metadata?.labels?.['agentstudio.io/project-id'] || '';
    const volumeType =
      storageClass.metadata?.labels?.['agentstudio.io/volume-type'] || 'nfs';
    const mountOptions =
      storageClass.metadata?.annotations?.['agentstudio.io/mount-options'];
    const volumeEndpoint =
      storageClass.metadata?.annotations?.['agentstudio.io/volume-endpoint'];

    const annotations: Record<string, string> = {
      ...this.buildBucketLabels(bucketName, finalNamespaceId),
      'agentstudio.io/storage-class': storageClassName,
    };

    // Apply mount options as CSI driver annotation
    if (mountOptions) {
      if (volumeType === 'nfs') {
        annotations['nfs.csi.k8s.io/mountOptions'] = mountOptions;
      } else if (volumeType === 'cifs' || volumeType === 'smb') {
        annotations['smb.csi.k8s.io/mountOptions'] = mountOptions;
      }
    }

    // Copy NFS-specific annotations from StorageClass if present
    if (volumeEndpoint && volumeType === 'nfs') {
      const endpointParts = volumeEndpoint.split(':');
      if (endpointParts.length === 2) {
        annotations['nfs.csi.k8s.io/server'] = endpointParts[0];
        annotations['nfs.csi.k8s.io/share'] = endpointParts[1];
      }
    }

    return annotations;
  }
}

