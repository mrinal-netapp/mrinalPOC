import { NameGenerator } from '../NameGenerator';

describe('NameGenerator', () => {
  describe('getStorageClassName', () => {
    it('should generate valid StorageClass name', () => {
      const result = NameGenerator.getStorageClassName('ns-123', 'bucket-abc');
      expect(result).toBe('sc-ns-123-bucket-abc');
    });

    it('should sanitize special characters', () => {
      const result = NameGenerator.getStorageClassName('ns_123', 'bucket.abc');
      expect(result).toBe('sc-ns-123-bucket-abc');
    });

    it('should handle uppercase names', () => {
      const result = NameGenerator.getStorageClassName('NS-123', 'BUCKET-ABC');
      expect(result).toBe('sc-ns-123-bucket-abc');
    });

    it('should truncate long names with hash', () => {
      const longNamespace = 'a'.repeat(200);
      const longBucket = 'b'.repeat(200);
      const result = NameGenerator.getStorageClassName(longNamespace, longBucket);
      
      expect(result.length).toBeLessThanOrEqual(253);
      expect(result).toMatch(/^sc-.*-[a-z0-9]{1,8}$/);
    });

    it('should remove leading and trailing hyphens', () => {
      const result = NameGenerator.getStorageClassName('-ns-123-', '-bucket-abc-');
      expect(result).toBe('sc-ns-123-bucket-abc');
    });
  });

  describe('getSecretName', () => {
    it('should generate valid Secret name', () => {
      const result = NameGenerator.getSecretName('ns-123', 'bucket-abc');
      expect(result).toBe('secret-ns-123-bucket-abc');
    });

    it('should sanitize special characters', () => {
      const result = NameGenerator.getSecretName('ns_123', 'bucket.abc');
      expect(result).toBe('secret-ns-123-bucket-abc');
    });

    it('should truncate long names with hash', () => {
      const longNamespace = 'a'.repeat(200);
      const longBucket = 'b'.repeat(200);
      const result = NameGenerator.getSecretName(longNamespace, longBucket);
      
      expect(result.length).toBeLessThanOrEqual(253);
      expect(result).toMatch(/^secret-.*-[a-z0-9]{1,8}$/);
    });
  });

  describe('getPVCName', () => {
    it('should generate valid PVC name', () => {
      const result = NameGenerator.getPVCName('sc-ns-123-bucket', 'bucket-abc');
      expect(result).toMatch(/^pvc-[a-z0-9]{1,8}-bucket-abc$/);
    });

    it('should sanitize bucket name', () => {
      const result = NameGenerator.getPVCName('sc-ns-123', 'bucket_abc.name');
      expect(result).toMatch(/^pvc-[a-z0-9]{1,8}-bucket-abc-name$/);
    });

    it('should handle very long bucket names', () => {
      const longBucket = 'a'.repeat(300);
      const result = NameGenerator.getPVCName('sc-ns-123', longBucket);
      
      expect(result.length).toBeLessThanOrEqual(253);
      expect(result).toMatch(/^pvc-[a-z0-9]{1,8}-.*$/);
    });

    it('should remove multiple consecutive hyphens', () => {
      const result = NameGenerator.getPVCName('sc-ns-123', 'bucket---abc');
      expect(result).toMatch(/^pvc-[a-z0-9]{1,8}-bucket-abc$/);
    });
  });

  describe('getPVName', () => {
    it('should generate valid PV name', () => {
      const result = NameGenerator.getPVName('sc-ns-123-bucket', 'pvc-abc-def');
      expect(result).toMatch(/^pv-sc-ns-123-bucket-[a-z0-9]{1,8}$/);
    });

    it('should use hash of PVC name', () => {
      const result1 = NameGenerator.getPVName('sc-123', 'pvc-abc');
      const result2 = NameGenerator.getPVName('sc-123', 'pvc-abc');
      
      expect(result1).toBe(result2); // Same inputs should produce same hash
    });
  });

  describe('simpleHash', () => {
    it('should generate consistent hash for same input', () => {
      const hash1 = NameGenerator.simpleHash('test-string');
      const hash2 = NameGenerator.simpleHash('test-string');
      expect(hash1).toBe(hash2);
    });

    it('should generate different hash for different input', () => {
      const hash1 = NameGenerator.simpleHash('test-string-1');
      const hash2 = NameGenerator.simpleHash('test-string-2');
      expect(hash1).not.toBe(hash2);
    });

    it('should return 8-character base36 string', () => {
      const hash = NameGenerator.simpleHash('test-string');
      expect(hash).toMatch(/^[a-z0-9]{1,8}$/);
      expect(hash.length).toBeLessThanOrEqual(8);
    });

    it('should handle empty string', () => {
      const hash = NameGenerator.simpleHash('');
      expect(hash).toBeTruthy();
    });

    it('should handle special characters', () => {
      const hash = NameGenerator.simpleHash('test!@#$%^&*()');
      expect(hash).toMatch(/^[a-z0-9]{1,8}$/);
    });
  });
});

