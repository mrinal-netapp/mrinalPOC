/**
 * Parses volume endpoints and extracts server/share information
 * Supports NFS, CIFS, and SMB volume types
 * 
 * @example
 * ```typescript
 * const nfsInfo = EndpointParser.parseEndpoint('nfs', 'nfs-server:/path/to/share');
 * // Returns: { server: 'nfs-server', share: '/path/to/share' }
 * 
 * const smbInfo = EndpointParser.parseEndpoint('smb', '//smb-server/share');
 * // Returns: { source: '//smb-server/share' }
 * ```
 */

/**
 * NFS endpoint information
 */
export interface NfsEndpointInfo {
  server?: string;
  share?: string;
}

/**
 * SMB/CIFS endpoint information
 */
export interface SmbEndpointInfo {
  source: string;
}

/**
 * Union type for endpoint information (NFS or SMB)
 */
export type EndpointInfo = NfsEndpointInfo | SmbEndpointInfo;

export class EndpointParser {
  /**
   * Parse endpoint and extract server/share information based on volume type
   */
  static parseEndpoint(type: string, endpoint: string): EndpointInfo {
    const normalizedType = type.toLowerCase();
    
    if (normalizedType === 'nfs') {
      return this.parseNFSEndpoint(endpoint);
    } else if (normalizedType === 'cifs' || normalizedType === 'smb') {
      return this.parseSmbEndpoint(endpoint);
    } else {
      throw new Error(`Unsupported volume type: ${type}`);
    }
  }

  /**
   * Parse NFS endpoint
   * Supports formats:
   * - nfs://server/path
   * - server:/path
   * - /path (local path)
   */
  private static parseNFSEndpoint(endpoint: string): NfsEndpointInfo {
    const result: NfsEndpointInfo = {};
    const trimmed = endpoint.trim();
    
    if (trimmed.includes('://')) {
      // URL format: nfs://server/path
      const url = new URL(trimmed);
      result.server = url.hostname;
      result.share = url.pathname;
    } else if (trimmed.includes(':')) {
      // Standard format: server:/path
      const parts = trimmed.split(':');
      result.server = parts[0];
      result.share = parts.slice(1).join(':');
    } else if (trimmed.startsWith('/')) {
      // Local path format: /path
      result.share = trimmed;
    } else {
      throw new Error(`Invalid NFS endpoint format: "${endpoint}"`);
    }
    
    return result;
  }

  /**
   * Parse SMB/CIFS endpoint
   * Supports formats:
   * - cifs://server/share
   * - smb://server/share
   * - //server/share
   * - /subdirectory (subdirectory within share)
   */
  private static parseSmbEndpoint(endpoint: string): SmbEndpointInfo {
    let source = endpoint.trim();
    
    if (source.startsWith('cifs://') || source.startsWith('smb://')) {
      // URL format: cifs://server/share or smb://server/share
      const url = new URL(source);
      source = `//${url.hostname}${url.pathname}`;
    } else if (!source.startsWith('//')) {
      if (source.startsWith('/')) {
        // Subdirectory format: /subdirectory (source should be in StorageClass)
        source = source;
      } else {
        // Assume missing // prefix: server/share -> //server/share
        source = `//${source}`;
      }
    }
    
    return { source };
  }

  /**
   * Type guard to check if endpoint info is NFS type
   * 
   * @param info - The endpoint info to check
   * @returns True if the endpoint info is NFS type
   */
  static isNfsEndpoint(info: EndpointInfo): info is NfsEndpointInfo {
    return 'server' in info || 'share' in info;
  }

  /**
   * Type guard to check if endpoint info is SMB type
   * 
   * @param info - The endpoint info to check
   * @returns True if the endpoint info is SMB type
   */
  static isSmbEndpoint(info: EndpointInfo): info is SmbEndpointInfo {
    return 'source' in info;
  }
}

