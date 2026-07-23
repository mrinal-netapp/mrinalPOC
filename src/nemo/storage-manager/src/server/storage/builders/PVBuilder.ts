import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { EndpointParser, EndpointInfo, NfsEndpointInfo, SmbEndpointInfo } from '../utils/EndpointParser';
import { LabelBuilder } from '../utils/LabelBuilder';
import { NameGenerator } from '../utils/NameGenerator';

/**
 * Builder for Kubernetes PersistentVolume resources
 */
export class PVBuilder {
  /**
   * Build NFS PV spec. Always merges resilience options (soft, timeo=50, retrans=3)
   * into mount options; user-provided values take precedence. Explicit 'hard' is respected
   * (soft is not injected when user sets hard).
   */
  static buildNFSPVSpec(
    endpointInfo: NfsEndpointInfo,
    mountOptions: string,
    storageSize: string,
    storageClassName: string
  ): k8s.V1PersistentVolumeSpec {
    const userOptions = mountOptions
      ? mountOptions.split(',').map((o) => o.trim())
      : ['noac'];

    const hasHard = userOptions.includes('hard');
    const hasSoft = userOptions.includes('soft');
    const hasTimeo = userOptions.some((o) => o.startsWith('timeo'));
    const hasRetrans = userOptions.some((o) => o.startsWith('retrans'));

    if (!hasSoft && !hasHard) userOptions.push('soft');
    if (!hasTimeo) userOptions.push('timeo=50');
    if (!hasRetrans) userOptions.push('retrans=3');

    return {
      capacity: {
        storage: storageSize,
      },
      accessModes: ['ReadWriteMany'], // Shared access - mountable by multiple pods
      persistentVolumeReclaimPolicy: 'Retain', // Retain PV when PVC is deleted - preserves existing NFS data
      storageClassName: storageClassName, // Match StorageClass for binding
      // No nodeAffinity - allows mounting on any node where s3gateway pods run
      nfs: {
        server: endpointInfo.server || '',
        path: endpointInfo.share || '/',
      },
      mountOptions: userOptions,
    };
  }

  /**
   * Build SMB/CIFS PV spec
   */
  static buildSMBPVSpec(
    endpointInfo: SmbEndpointInfo,
    mountOptions: string,
    storageSize: string,
    storageClassName: string,
    secretName: string | null,
    namespace: string,
    volumeHandle: string
  ): k8s.V1PersistentVolumeSpec {
    return {
      capacity: {
        storage: storageSize,
      },
      accessModes: ['ReadWriteMany'], // Shared access - mountable by multiple pods
      persistentVolumeReclaimPolicy: 'Retain', // Retain PV when PVC is deleted - preserves existing NFS data
      storageClassName: storageClassName, // Match StorageClass for binding
      // No nodeAffinity - allows mounting on any node where s3gateway pods run
      csi: {
        driver: 'smb.csi.k8s.io',
        volumeHandle: volumeHandle,
        volumeAttributes: {
          source: endpointInfo.source || '',
        },
        nodeStageSecretRef: secretName
          ? {
              name: secretName,
              namespace: namespace,
            }
          : undefined,
      },
      mountOptions: mountOptions ? mountOptions.split(',') : [],
    };
  }

  /**
   * Build PV metadata
   */
  static buildPVMetadata(
    pvName: string,
    storageClassName: string,
    bucketName: string,
    projectId: string
  ): k8s.V1ObjectMeta {
    return {
      name: pvName,
      labels: {
        'agentstudio.io/storage-class': storageClassName,
        ...LabelBuilder.buildBucketLabels(bucketName, projectId),
      },
    };
  }

  /**
   * Build complete PV spec based on volume type
   */
  static buildPVSpec(
    storageClass: {
      metadata?: {
        name?: string;
        annotations?: Record<string, string>;
        labels?: Record<string, string>;
      };
    },
    spec: BucketStorageClassSpec,
    endpointInfo: EndpointInfo,
    secretName: string | null,
    namespace: string,
    storageSize: string,
    pvcName: string,
    options?: {
      pvNameOverride?: string;
      claimRef?: k8s.V1ObjectReference;
    }
  ): k8s.V1PersistentVolume {
    const scName = storageClass.metadata?.name;
    if (!scName) {
      throw new Error('StorageClass name is missing');
    }

    const volumeType = spec.volume_info.type.toLowerCase();
    const mountOptions =
      storageClass.metadata?.annotations?.['agentstudio.io/mount-options'] || '';
    const pvcHash = NameGenerator.simpleHash(pvcName).substring(0, 8);
    const pvName = options?.pvNameOverride || NameGenerator.getPVName(scName, pvcName);

    let pvSpec: k8s.V1PersistentVolumeSpec;

    if (volumeType === 'nfs') {
      pvSpec = this.buildNFSPVSpec(
        endpointInfo as NfsEndpointInfo,
        mountOptions,
        storageSize,
        scName
      );
    } else if (volumeType === 'cifs' || volumeType === 'smb') {
      const volumeHandle = `smb-static-${scName}-${pvcHash}`;
      pvSpec = this.buildSMBPVSpec(
        endpointInfo as SmbEndpointInfo,
        mountOptions,
        storageSize,
        scName,
        secretName,
        namespace,
        volumeHandle
      );
    } else {
      throw new Error(`Unsupported volume type for static PV: ${volumeType}`);
    }

    if (options?.claimRef) {
      pvSpec.claimRef = options.claimRef;
    }

    return {
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: this.buildPVMetadata(
        pvName,
        scName,
        spec.bucket_name,
        spec.project_id
      ),
      spec: pvSpec,
    };
  }
}

