import * as k8s from '@kubernetes/client-node';
import { LabelBuilder } from '../utils/LabelBuilder';
import { NameGenerator } from '../utils/NameGenerator';
import { BucketStorageClassSpec } from '../types';
import { AccessModeResolver } from '../utils/AccessModeResolver';

/**
 * Builder for Kubernetes PersistentVolumeClaim resources
 */
export class PVCBuilder {
  /**
   * Build PVC spec
   */
  static buildPVCSpec(
    storageClass: {
      metadata?: {
        name?: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
    },
    bucketName: string,
    storageSize: string,
    namespace: string,
    spec?: BucketStorageClassSpec // NEW: Optional spec for dynamic provisioning
  ): k8s.V1PersistentVolumeClaim {
    const scName = storageClass.metadata?.name;
    if (!scName) {
      throw new Error('StorageClass name is missing');
    }

    const pvcName = NameGenerator.getPVCName(scName, bucketName);
    // Pass project_id from spec if available (required for dynamic provisioning)
    const annotations = LabelBuilder.buildPVCAnnotations(
      storageClass,
      bucketName,
      scName,
      spec?.project_id // Pass explicit project_id for dynamic provisioning
    );

    // Use storage_size from spec if provided, otherwise use default
    const finalStorageSize = spec?.storage_size || storageSize;

    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: pvcName,
        namespace: namespace,
        labels: {
          ...LabelBuilder.buildBucketLabels(
            bucketName,
            annotations['agentstudio.io/project-id'] || ''
          ),
          'agentstudio.io/storage-class': scName,
        },
        annotations: annotations,
      },
      spec: {
        // Resolve access modes: use requested modes from spec, or best mode based on StorageClass
        accessModes: AccessModeResolver.resolveAccessModes(
          storageClass as k8s.V1StorageClass,
          spec?.access_modes
        ),
        storageClassName: scName,
        // Don't set volumeName initially - create PV on-demand if PVC is pending
        resources: {
          requests: {
            storage: finalStorageSize,
          },
        },
      },
    };
  }

  /**
   * Get PVC name from StorageClass and bucket name
   */
  static getPVCName(storageClassName: string, bucketName: string): string {
    return NameGenerator.getPVCName(storageClassName, bucketName);
  }
}

