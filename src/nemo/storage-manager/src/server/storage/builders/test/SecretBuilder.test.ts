import * as k8s from '@kubernetes/client-node';
import { SecretBuilder } from '../SecretBuilder';
import { BucketStorageClassSpec } from '../../types';

describe('SecretBuilder', () => {
  const mockSpec: BucketStorageClassSpec = {
    project_id: 'p-123',
    bucket_name: 'bucket-abc',
    volume_info: {
      type: 'nfs',
      endpoint: 'nfs-server:/path',
    },
    auth_info: {
      type: 'basic',
      username: 'user',
      password_encrypted: 'encrypted-password',
    },
    protocol: 's3',
    role: 'primary',
  };

  describe('buildSecretSpec', () => {
    it('should build secret spec with username and password', () => {
      const secret = SecretBuilder.buildSecretSpec(mockSpec, 'test-namespace');

      expect(secret).not.toBeNull();
      expect(secret!.metadata!.name).toBeTruthy();
      expect(secret!.metadata!.namespace).toBe('test-namespace');
      expect(secret!.type).toBe('Opaque');
      expect(secret!.data).toBeDefined();
      expect(secret!.data!['username']).toBeDefined();
      expect(secret!.data!['password']).toBeDefined();
    });

    it('should return null when no auth info provided', () => {
      const specWithoutAuth: BucketStorageClassSpec = {
        ...mockSpec,
        auth_info: {
          type: 'none',
        },
      };

      const secret = SecretBuilder.buildSecretSpec(
        specWithoutAuth,
        'test-namespace'
      );
      expect(secret).toBeNull();
    });

    it('should build secret with only username', () => {
      const specWithUsernameOnly: BucketStorageClassSpec = {
        ...mockSpec,
        auth_info: {
          type: 'basic',
          username: 'user',
        },
      };

      const secret = SecretBuilder.buildSecretSpec(
        specWithUsernameOnly,
        'test-namespace'
      );

      expect(secret).not.toBeNull();
      expect(secret!.data!['username']).toBeDefined();
      expect(secret!.data!['password']).toBeUndefined();
    });

    it('should build secret with only password', () => {
      const specWithPasswordOnly: BucketStorageClassSpec = {
        ...mockSpec,
        auth_info: {
          type: 'basic',
          password_encrypted: 'encrypted-password',
        },
      };

      const secret = SecretBuilder.buildSecretSpec(
        specWithPasswordOnly,
        'test-namespace'
      );

      expect(secret).not.toBeNull();
      expect(secret!.data!['username']).toBeUndefined();
      expect(secret!.data!['password']).toBeDefined();
    });

    it('should encode secret data as base64', () => {
      const secret = SecretBuilder.buildSecretSpec(mockSpec, 'test-namespace');

      expect(secret).not.toBeNull();
      const username = Buffer.from(secret!.data!['username'], 'base64').toString(
        'utf-8'
      );
      const password = Buffer.from(secret!.data!['password'], 'base64').toString(
        'utf-8'
      );

      expect(username).toBe('user');
      expect(password).toBe('encrypted-password');
    });

    it('should include correct labels', () => {
      const secret = SecretBuilder.buildSecretSpec(mockSpec, 'test-namespace');

      expect(secret).not.toBeNull();
      expect(secret!.metadata!.labels).toBeDefined();
      expect(secret!.metadata!.labels!['agentstudio.io/bucket-name']).toBe(
        'bucket-abc'
      );
      expect(secret!.metadata!.labels!['agentstudio.io/project-id']).toBe(
        'p-123'
      );
      expect(secret!.metadata!.labels!['agentstudio.io/managed-by']).toBe('storage-manager');
    });
  });
});

