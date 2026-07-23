import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import * as k8s from '@kubernetes/client-node';

/**
 * Maps StorageClass provisioners to their supported access modes
 * Based on common Kubernetes CSI drivers and provisioners
 */
const PROVISIONER_ACCESS_MODES: Record<string, string[]> = {
  // NFS CSI drivers - support ReadWriteMany
  'nfs.csi.k8s.io': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  'nfs-subdir-external-provisioner': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  
  // SMB/CIFS CSI drivers - support ReadWriteMany
  'smb.csi.k8s.io': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  'cifs.csi.k8s.io': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  
  // Local storage provisioners - typically ReadWriteOnce only
  'rancher.io/local-path': ['ReadWriteOnce', 'ReadWriteOncePod'],
  'openebs.io/local': ['ReadWriteOnce', 'ReadWriteOncePod'],
  'kubernetes.io/no-provisioner': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'], // Static provisioning
  
  // Block storage (EBS, GCE PD, Azure Disk) - ReadWriteOnce only
  'ebs.csi.aws.com': ['ReadWriteOnce'],
  'pd.csi.storage.gke.io': ['ReadWriteOnce'],
  'disk.csi.azure.com': ['ReadWriteOnce'],
  'cinder.csi.openstack.org': ['ReadWriteOnce'],
  
  // TopoLVM - typically ReadWriteOnce
  'topolvm.cybozu.com': ['ReadWriteOnce'],
  
  // CephFS - supports ReadWriteMany
  'cephfs.csi.ceph.com': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  
  // GlusterFS - supports ReadWriteMany
  'gluster.org/glusterfs': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
  
  // Portworx - supports ReadWriteMany
  'kubernetes.io/portworx-volume': ['ReadWriteMany', 'ReadWriteOnce', 'ReadOnlyMany'],
};

/**
 * Default access modes for unknown provisioners
 * Conservative default: ReadWriteOnce (most common)
 */
const DEFAULT_ACCESS_MODES = ['ReadWriteOnce'];

/**
 * Preferred access mode for Ray deployments (shared access across pods)
 * Falls back to ReadWriteOnce if ReadWriteMany is not supported
 */
const PREFERRED_ACCESS_MODE = 'ReadWriteMany';

/**
 * Resolves supported access modes for a StorageClass based on its provisioner
 */
export class AccessModeResolver {
  /**
   * Get supported access modes for a StorageClass
   */
  static getSupportedAccessModes(storageClass: k8s.V1StorageClass): string[] {
    const provisioner = storageClass.provisioner || '';
    
    // Check if we have a known mapping
    const supportedModes = PROVISIONER_ACCESS_MODES[provisioner];
    if (supportedModes) {
      return supportedModes;
    }
    
    // For unknown provisioners, return conservative default
    logger.warn(
      `[AccessModeResolver] Unknown provisioner: ${provisioner}. ` +
      `Using default access modes: ${DEFAULT_ACCESS_MODES.join(', ')}. ` +
      `Consider adding this provisioner to PROVISIONER_ACCESS_MODES mapping.`
    );
    return DEFAULT_ACCESS_MODES;
  }

  /**
   * Get the best access mode for Ray deployments (prefers ReadWriteMany)
   * Falls back to ReadWriteOnce if ReadWriteMany is not supported
   */
  static getBestAccessMode(storageClass: k8s.V1StorageClass): string {
    const supportedModes = this.getSupportedAccessModes(storageClass);
    
    // Prefer ReadWriteMany for shared access across pods
    if (supportedModes.includes(PREFERRED_ACCESS_MODE)) {
      return PREFERRED_ACCESS_MODE;
    }
    
    // Fall back to ReadWriteOnce (most common)
    if (supportedModes.includes('ReadWriteOnce')) {
      logger.warn(
        `[AccessModeResolver] StorageClass '${storageClass.metadata?.name}' ` +
        `(provisioner: ${storageClass.provisioner}) does not support ReadWriteMany. ` +
        `Using ReadWriteOnce. Note: This limits volume mounting to a single pod.`
      );
      return 'ReadWriteOnce';
    }
    
    // Fall back to first available mode
    if (supportedModes.length > 0) {
      logger.warn(
        `[AccessModeResolver] StorageClass '${storageClass.metadata?.name}' ` +
        `(provisioner: ${storageClass.provisioner}) does not support ReadWriteOnce. ` +
        `Using ${supportedModes[0]}.`
      );
      return supportedModes[0];
    }
    
    // Last resort: return default
    return 'ReadWriteOnce';
  }

  /**
   * Validate that requested access modes are supported by the StorageClass
   */
  static validateAccessModes(
    storageClass: k8s.V1StorageClass,
    requestedModes: string[]
  ): { valid: boolean; supported: string[]; unsupported: string[] } {
    const supportedModes = this.getSupportedAccessModes(storageClass);
    const unsupported = requestedModes.filter(mode => !supportedModes.includes(mode));
    
    return {
      valid: unsupported.length === 0,
      supported: supportedModes,
      unsupported: unsupported
    };
  }

  /**
   * Get access modes for PVC creation
   * Priority:
   * 1. Explicitly requested access modes (from spec)
   * 2. Best access mode based on StorageClass capabilities
   */
  static resolveAccessModes(
    storageClass: k8s.V1StorageClass,
    requestedModes?: string[]
  ): string[] {
    // If access modes are explicitly requested, validate them
    if (requestedModes && requestedModes.length > 0) {
      const validation = this.validateAccessModes(storageClass, requestedModes);
      if (!validation.valid) {
        throw new Error(
          `StorageClass '${storageClass.metadata?.name}' (provisioner: ${storageClass.provisioner}) ` +
          `does not support requested access modes: ${validation.unsupported.join(', ')}. ` +
          `Supported access modes: ${validation.supported.join(', ')}.`
        );
      }
      return requestedModes;
    }
    
    // Use best access mode based on StorageClass capabilities
    return [this.getBestAccessMode(storageClass)];
  }
}

