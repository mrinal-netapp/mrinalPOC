import {
  EndpointParser,
  NfsEndpointInfo,
  SmbEndpointInfo,
  EndpointInfo,
} from '../EndpointParser';

describe('EndpointParser', () => {
  describe('parseEndpoint', () => {
    describe('NFS endpoints', () => {
      it('should parse NFS endpoint with colon format', () => {
        const result = EndpointParser.parseEndpoint(
          'nfs',
          'nfs-server:/path/to/share'
        );
        expect(EndpointParser.isNfsEndpoint(result)).toBe(true);
        const nfsResult = result as NfsEndpointInfo;
        expect(nfsResult.server).toBe('nfs-server');
        expect(nfsResult.share).toBe('/path/to/share');
      });

      it('should parse NFS endpoint with URL format', () => {
        const result = EndpointParser.parseEndpoint(
          'nfs',
          'nfs://nfs-server/path/to/share'
        );
        expect(EndpointParser.isNfsEndpoint(result)).toBe(true);
        const nfsResult = result as NfsEndpointInfo;
        expect(nfsResult.server).toBe('nfs-server');
        expect(nfsResult.share).toBe('/path/to/share');
      });

      it('should parse NFS endpoint with local path', () => {
        const result = EndpointParser.parseEndpoint('nfs', '/local/path');
        expect(EndpointParser.isNfsEndpoint(result)).toBe(true);
        const nfsResult = result as NfsEndpointInfo;
        expect(nfsResult.share).toBe('/local/path');
        expect(nfsResult.server).toBeUndefined();
      });

      it('should handle NFS endpoint with port in server', () => {
        const result = EndpointParser.parseEndpoint(
          'nfs',
          'nfs-server:2049:/path'
        );
        expect(EndpointParser.isNfsEndpoint(result)).toBe(true);
        const nfsResult = result as NfsEndpointInfo;
        expect(nfsResult.server).toBe('nfs-server');
        expect(nfsResult.share).toBe('2049:/path');
      });

      it('should throw error for invalid NFS endpoint', () => {
        expect(() => {
          EndpointParser.parseEndpoint('nfs', 'invalid-endpoint');
        }).toThrow('Invalid NFS endpoint format');
      });

      it('should handle uppercase NFS type', () => {
        const result = EndpointParser.parseEndpoint('NFS', 'server:/path');
        expect(EndpointParser.isNfsEndpoint(result)).toBe(true);
      });
    });

    describe('SMB/CIFS endpoints', () => {
      it('should parse SMB endpoint with double slash format', () => {
        const result = EndpointParser.parseEndpoint('smb', '//server/share');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('//server/share');
      });

      it('should parse CIFS endpoint with URL format', () => {
        const result = EndpointParser.parseEndpoint(
          'cifs',
          'cifs://server/share'
        );
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('//server/share');
      });

      it('should parse SMB endpoint with URL format', () => {
        const result = EndpointParser.parseEndpoint('smb', 'smb://server/share');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('//server/share');
      });

      it('should add double slash prefix if missing', () => {
        const result = EndpointParser.parseEndpoint('smb', 'server/share');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('//server/share');
      });

      it('should handle subdirectory path', () => {
        const result = EndpointParser.parseEndpoint('smb', '/subdirectory');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('/subdirectory');
      });

      it('should handle uppercase SMB type', () => {
        const result = EndpointParser.parseEndpoint('SMB', '//server/share');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
      });

      it('should trim whitespace', () => {
        const result = EndpointParser.parseEndpoint('smb', '  //server/share  ');
        expect(EndpointParser.isSmbEndpoint(result)).toBe(true);
        const smbResult = result as SmbEndpointInfo;
        expect(smbResult.source).toBe('//server/share');
      });
    });

    it('should throw error for unsupported volume type', () => {
      expect(() => {
        EndpointParser.parseEndpoint('unsupported', 'endpoint');
      }).toThrow('Unsupported volume type');
    });
  });

  describe('isNfsEndpoint', () => {
    it('should return true for NFS endpoint info', () => {
      const info: EndpointInfo = { server: 'server', share: '/path' };
      expect(EndpointParser.isNfsEndpoint(info)).toBe(true);
    });

    it('should return false for SMB endpoint info', () => {
      const info: EndpointInfo = { source: '//server/share' };
      expect(EndpointParser.isNfsEndpoint(info)).toBe(false);
    });
  });

  describe('isSmbEndpoint', () => {
    it('should return true for SMB endpoint info', () => {
      const info: EndpointInfo = { source: '//server/share' };
      expect(EndpointParser.isSmbEndpoint(info)).toBe(true);
    });

    it('should return false for NFS endpoint info', () => {
      const info: EndpointInfo = { server: 'server', share: '/path' };
      expect(EndpointParser.isSmbEndpoint(info)).toBe(false);
    });
  });
});

