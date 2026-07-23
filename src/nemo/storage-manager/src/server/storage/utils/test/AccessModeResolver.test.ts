import { get_logger } from '@agentstudio/observability-client-runtime';
import { AccessModeResolver } from '../AccessModeResolver';
import * as k8s from '@kubernetes/client-node';

const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

jest.mock('@agentstudio/observability-client-runtime', () => ({
  get_logger: jest.fn().mockReturnValue({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  }),
}));

function makeStorageClass(provisioner: string, name?: string): k8s.V1StorageClass {
  return {
    metadata: { name: name ?? 'test-sc' },
    provisioner,
  } as k8s.V1StorageClass;
}

describe('AccessModeResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSupportedAccessModes', () => {
    it('returns ReadWriteMany + ReadWriteOnce + ReadOnlyMany for nfs.csi.k8s.io', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      const modes = AccessModeResolver.getSupportedAccessModes(sc);
      expect(modes).toContain('ReadWriteMany');
      expect(modes).toContain('ReadWriteOnce');
      expect(modes).toContain('ReadOnlyMany');
    });

    it('returns only ReadWriteOnce for ebs.csi.aws.com', () => {
      const sc = makeStorageClass('ebs.csi.aws.com');
      const modes = AccessModeResolver.getSupportedAccessModes(sc);
      expect(modes).toEqual(['ReadWriteOnce']);
    });

    it('returns ReadWriteMany for cephfs.csi.ceph.com', () => {
      const sc = makeStorageClass('cephfs.csi.ceph.com');
      const modes = AccessModeResolver.getSupportedAccessModes(sc);
      expect(modes).toContain('ReadWriteMany');
    });

    it('returns default modes for unknown provisioner', () => {
      const sc = makeStorageClass('unknown.provisioner.io');
      const modes = AccessModeResolver.getSupportedAccessModes(sc);
      expect(modes).toEqual(['ReadWriteOnce']);
    });

    it('handles missing provisioner gracefully', () => {
      const sc = { metadata: { name: 'test' } } as k8s.V1StorageClass;
      const modes = AccessModeResolver.getSupportedAccessModes(sc);
      expect(Array.isArray(modes)).toBe(true);
    });
  });

  describe('getBestAccessMode', () => {
    it('prefers ReadWriteMany when supported', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      expect(AccessModeResolver.getBestAccessMode(sc)).toBe('ReadWriteMany');
    });

    it('falls back to ReadWriteOnce for block storage', () => {
      const sc = makeStorageClass('ebs.csi.aws.com');
      const mode = AccessModeResolver.getBestAccessMode(sc);
      expect(mode).toBe('ReadWriteOnce');
    });

    it('falls back to ReadWriteOnce for local-path provisioner', () => {
      const sc = makeStorageClass('rancher.io/local-path');
      const mode = AccessModeResolver.getBestAccessMode(sc);
      // ReadWriteMany not supported by local-path → falls back to ReadWriteOnce
      expect(mode).toBe('ReadWriteOnce');
    });

    it('returns ReadWriteMany for smb.csi.k8s.io', () => {
      const sc = makeStorageClass('smb.csi.k8s.io');
      expect(AccessModeResolver.getBestAccessMode(sc)).toBe('ReadWriteMany');
    });
  });

  describe('validateAccessModes', () => {
    it('validates requested modes that are all supported', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      const result = AccessModeResolver.validateAccessModes(sc, ['ReadWriteMany', 'ReadWriteOnce']);
      expect(result.valid).toBe(true);
      expect(result.unsupported).toHaveLength(0);
    });

    it('returns unsupported modes when requested modes not in supported list', () => {
      const sc = makeStorageClass('ebs.csi.aws.com');
      const result = AccessModeResolver.validateAccessModes(sc, ['ReadWriteMany', 'ReadWriteOnce']);
      expect(result.valid).toBe(false);
      expect(result.unsupported).toContain('ReadWriteMany');
    });

    it('returns empty unsupported for empty request', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      const result = AccessModeResolver.validateAccessModes(sc, []);
      expect(result.valid).toBe(true);
      expect(result.unsupported).toHaveLength(0);
    });
  });

  describe('resolveAccessModes', () => {
    it('returns best mode when no requested modes provided', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      const modes = AccessModeResolver.resolveAccessModes(sc);
      expect(modes).toEqual(['ReadWriteMany']);
    });

    it('returns requested modes when they are valid', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      const modes = AccessModeResolver.resolveAccessModes(sc, ['ReadWriteOnce']);
      expect(modes).toEqual(['ReadWriteOnce']);
    });

    it('throws when requested modes are not supported', () => {
      const sc = makeStorageClass('ebs.csi.aws.com');
      expect(() => AccessModeResolver.resolveAccessModes(sc, ['ReadWriteMany'])).toThrow(
        /does not support requested access modes/
      );
    });

    it('returns requested modes when empty array passed', () => {
      const sc = makeStorageClass('nfs.csi.k8s.io');
      // Empty array means "use best mode"
      const modes = AccessModeResolver.resolveAccessModes(sc, []);
      expect(modes).toEqual(['ReadWriteMany']);
    });
  });
});
