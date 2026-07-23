/**
 * Utility for generating Kubernetes-compliant resource names
 * Ensures RFC 1123 subdomain compliance (lowercase alphanumeric and hyphens only)
 * 
 * @example
 * ```typescript
 * const scName = NameGenerator.getStorageClassName('my-namespace', 'my-bucket');
 * // Returns: 'sc-my-namespace-my-bucket'
 * ```
 */
export class NameGenerator {
  /**
   * Generate StorageClass name from project_id and bucket_name
   * 
   * @param projectId - The project identifier
   * @param bucketName - The bucket name
   * @returns A Kubernetes-compliant StorageClass name in format: sc-{namespace-id}-{bucket-name}
   * 
   * @example
   * ```typescript
   * NameGenerator.getStorageClassName('ns-123', 'bucket-abc')
   * // Returns: 'sc-ns-123-bucket-abc'
   * ```
   */
  static getStorageClassName(projectId: string, bucketName: string): string {
    const safeProjectId = this.sanitizeName(projectId);
    const safeBucketName = this.sanitizeName(bucketName);
    
    let name = `sc-${safeProjectId}-${safeBucketName}`;
    name = this.trimHyphens(name);
    
    if (name.length > 253) {
      const hash = this.simpleHash(`${projectId}:${bucketName}`);
      name = `sc-${name.substring(3, 220)}-${hash}`;
    }
    
    return name;
  }

  /**
   * Generate Secret name for bucket authentication
   * 
   * @param projectId - The project identifier
   * @param bucketName - The bucket name
   * @returns A Kubernetes-compliant Secret name in format: secret-{project-id}-{bucket-name}
   * 
   * @example
   * ```typescript
   * NameGenerator.getSecretName('ns-123', 'bucket-abc')
   * // Returns: 'secret-ns-123-bucket-abc'
   * ```
   */
  static getSecretName(projectId: string, bucketName: string): string {
    const safeProjectId = this.sanitizeName(projectId);
    const safeBucketName = this.sanitizeName(bucketName);
    
    let name = `secret-${safeProjectId}-${safeBucketName}`;
    name = this.trimHyphens(name);
    
    if (name.length > 253) {
      const hash = this.simpleHash(`${projectId}:${bucketName}`);
      name = `secret-${name.substring(7, 220)}-${hash}`;
    }
    
    return name;
  }

  /**
   * Generate PVC name from StorageClass name and bucket name
   * Sanitizes bucket name to ensure RFC 1123 compliance
   * 
   * @param storageClassName - The StorageClass name
   * @param bucketName - The bucket name (will be sanitized)
   * @returns A Kubernetes-compliant PVC name in format: pvc-{hash-of-sc-name}-{sanitized-bucket-name}
   * 
   * @example
   * ```typescript
   * NameGenerator.getPVCName('sc-ns-123-bucket', 'my_bucket.name')
   * // Returns: 'pvc-{hash}-my-bucket-name' (sanitized)
   * ```
   */
  static getPVCName(storageClassName: string, bucketName: string): string {
    // Sanitize bucket name to RFC 1123 subdomain format
    const safeBucketName = bucketName.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')  // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '')      // Remove leading/trailing hyphens
      .replace(/-+/g, '-');          // Replace multiple consecutive hyphens with single hyphen
    
    // Use consistent naming convention for PVCs
    const hash = this.simpleHash(storageClassName);
    let pvcName = `pvc-${hash}-${safeBucketName}`;
    
    // Ensure total length doesn't exceed 253 characters (Kubernetes limit)
    if (pvcName.length > 253) {
      const maxBucketLength = 253 - `pvc-${hash}-`.length;
      const truncatedBucket = safeBucketName.substring(0, maxBucketLength);
      pvcName = `pvc-${hash}-${truncatedBucket}`;
    }
    
    return pvcName;
  }

  /**
   * Generate PV name from StorageClass name and PVC name
   * 
   * @param storageClassName - The StorageClass name
   * @param pvcName - The PVC name (will be hashed)
   * @returns A Kubernetes-compliant PV name in format: pv-{storageClassName}-{pvcName-hash}
   * 
   * @example
   * ```typescript
   * NameGenerator.getPVName('sc-ns-123-bucket', 'pvc-abc-def')
   * // Returns: 'pv-sc-ns-123-bucket-{hash}'
   * ```
   */
  static getPVName(storageClassName: string, pvcName: string): string {
    const pvcHash = this.simpleHash(pvcName).substring(0, 8);
    return `pv-${storageClassName}-${pvcHash}`;
  }

  /**
   * New PV name after endpoint drift — avoids kubelet reusing stale mount state.
   */
  static getPVNameWithGeneration(storageClassName: string, pvcName: string): string {
    const gen = this.simpleHash(`${Date.now()}:${pvcName}:${Math.random()}`).substring(0, 6);
    return `${this.getPVName(storageClassName, pvcName)}-g${gen}`;
  }

  /**
   * Sanitize a name to RFC 1123 subdomain format
   * Converts to lowercase and replaces invalid characters with hyphens
   */
  private static sanitizeName(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Remove leading and trailing hyphens
   */
  private static trimHyphens(name: string): string {
    return name.replace(/^-+|-+$/g, '');
  }

  /**
   * Simple hash function for generating short identifiers
   * Uses a simple string hash algorithm and converts to base36
   * 
   * @param str - The string to hash
   * @returns An 8-character base36 hash string
   * 
   * @example
   * ```typescript
   * NameGenerator.simpleHash('my-string')
   * // Returns: 'abc12345' (8-character hash)
   * ```
   */
  static simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substring(0, 8);
  }
}

