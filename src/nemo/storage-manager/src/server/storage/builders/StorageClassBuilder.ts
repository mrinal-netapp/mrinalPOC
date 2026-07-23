import * as k8s from '@kubernetes/client-node';
import { BucketStorageClassSpec } from '../types';
import { EndpointParser, EndpointInfo } from '../utils/EndpointParser';
import { LabelBuilder } from '../utils/LabelBuilder';

/**
 * Builder for Kubernetes StorageClass resources
 */
export class StorageClassBuilder {
  /**
   * Determine if StorageClass should be created based on provisioning mode
   */
  static shouldCreateStorageClass(spec: BucketStorageClassSpec): boolean {
    // Create StorageClass only for static provisioning
    return (spec.provisioning_mode || 'static') === 'static';
  }

  /**
   * Validate dynamic provisioning requirements
   */
  static validateDynamicProvisioning(spec: BucketStorageClassSpec): void {
    if (spec.provisioning_mode === 'dynamic') {
      if (!spec.storage_class_name) {
        throw new Error(
          `storage_class_name is required for dynamic provisioning mode. ` +
          `Bucket: ${spec.project_id}/${spec.bucket_name}`
        );
      }
    }
  }

  /**
   * Validate static provisioning requirements
   */
  static validateStaticProvisioning(spec: BucketStorageClassSpec): void {
    if ((spec.provisioning_mode || 'static') === 'static') {
      if (!spec.volume_info.endpoint) {
        throw new Error(
          `volume_info.endpoint is required for static provisioning mode. ` +
          `Bucket: ${spec.project_id}/${spec.bucket_name}`
        );
      }
    }
  }

  /**
   * Build StorageClass parameters based on volume type
   */
  static buildStorageClassParameters(
    volumeType: string,
    endpointInfo: EndpointInfo,
    secretName: string | null,
    namespace: string
  ): Record<string, string> {
    const parameters: Record<string, string> = {};
    const normalizedType = volumeType.toLowerCase();

    if (normalizedType === 'nfs') {
      const nfsInfo = endpointInfo as { server?: string; share?: string };
      if (nfsInfo.server) {
        parameters['server'] = nfsInfo.server;
      }
      if (nfsInfo.share) {
        parameters['share'] = nfsInfo.share;
      }
      // Note: mountOptions cannot be set as StorageClass parameter for NFS CSI driver
      // Mount options must be specified at PVC level via annotation: nfs.csi.k8s.io/mountOptions
    } else if (normalizedType === 'cifs' || normalizedType === 'smb') {
      const smbInfo = endpointInfo as { source: string };
      if (smbInfo.source) {
        parameters['source'] = smbInfo.source;
      }

      // Add secret references for SMB
      if (secretName) {
        parameters['csi.storage.k8s.io/provisioner-secret-name'] = secretName;
        parameters['csi.storage.k8s.io/provisioner-secret-namespace'] = namespace;
        parameters['csi.storage.k8s.io/node-stage-secret-name'] = secretName;
        parameters['csi.storage.k8s.io/node-stage-secret-namespace'] = namespace;
      }
    }

    return parameters;
  }

  /**
   * Build StorageClass spec
   */
  static buildStorageClassSpec(
    scName: string,
    spec: BucketStorageClassSpec,
    endpointInfo: EndpointInfo,
    secretName: string | null,
    namespace: string
  ): k8s.V1StorageClass {
    const volumeType = spec.volume_info.type.toLowerCase();
    const protocol = spec.protocol.toLowerCase();

    const parameters = this.buildStorageClassParameters(
      volumeType,
      endpointInfo,
      secretName,
      namespace
    );

    return {
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: {
        name: scName,
        labels: LabelBuilder.buildStorageClassLabels(
          spec.bucket_name,
          spec.project_id,
          volumeType
        ),
        annotations: LabelBuilder.buildStorageClassAnnotations(
          spec.volume_info.endpoint || '',
          protocol,
          spec.role,
          spec.volume_info.mount_options,
          volumeType
        ),
      },
      provisioner: 'kubernetes.io/no-provisioner', // Static provisioning
      // Note: parameters field is omitted for kubernetes.io/no-provisioner (Kubernetes forbids parameters)
      allowVolumeExpansion: false, // Static PVs cannot be expanded
      volumeBindingMode: 'Immediate', // Static no-provisioner: bind as soon as PV exists
      reclaimPolicy: 'Retain', // Retain PVs when PVCs are deleted - preserves existing storage
    };
  }
}

