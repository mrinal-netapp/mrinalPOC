/**
 * S3 provider catalog, validateConnectorConfig, and credential adapter tests.
 *
 * Dataset / data-source validator and route tests live in sibling files:
 *   s3.dataSource.unit.test.ts, s3.dataSet.unit.test.ts, s3.routes.unit.test.ts
 *
 * Run: `npm run test:s3`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorAdapters } from '../providers/connector';
import {
  getProvider,
  validateConnectorConfig,
} from '../services/ProviderCatalogService';

function s3Adapter() {
  const adapter = createConnectorAdapters().find((a) => a.provider === 's3');
  assert.ok(adapter, 'S3 ConnectorCredentialAdapter must be registered');
  return adapter!;
}

test('catalog: s3 provider is object-store with resource scope and bucket in schema', () => {
  const entry = getProvider('s3');
  assert.ok(entry, 'provider-catalog must include s3');
  assert.equal(entry!.label, 'Amazon S3');
  assert.deepEqual(entry!.scopes, ['resource']);
  assert.ok(entry!.hasAcquisition);
  const resource = entry!.connectorConfigSchema.resource;
  assert.ok(resource);
  assert.deepEqual(resource.required, ['bucket']);
  assert.ok(resource.optional.includes('prefix'));
  assert.ok(resource.optional.includes('endpoint'));
  assert.ok(resource.properties.bucket);
});

test('validateConnectorConfig: accepts minimal S3 resource config', () => {
  const result = validateConnectorConfig('s3', 'resource', { bucket: 'my-bucket' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateConnectorConfig: accepts optional prefix, region, endpoint', () => {
  const result = validateConnectorConfig('s3', 'resource', {
    bucket: 'b',
    prefix: 'logs/2026/',
    region: 'us-east-1',
    endpoint: 'https://minio.example.com:9000',
  });
  assert.equal(result.valid, true);
});

test('validateConnectorConfig: rejects missing bucket', () => {
  const result = validateConnectorConfig('s3', 'resource', { prefix: 'only-prefix' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('bucket is required')));
});

test('validateConnectorConfig: rejects empty bucket string', () => {
  const result = validateConnectorConfig('s3', 'resource', { bucket: '' });
  assert.equal(result.valid, false);
});

test('validateConnectorConfig: rejects unknown connector fields', () => {
  const result = validateConnectorConfig('s3', 'resource', {
    bucket: 'b',
    host: 'should-not-be-here',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unknown field 'host'")));
});

test('validateConnectorConfig: rejects account scope (S3 is resource-only)', () => {
  const result = validateConnectorConfig('s3', 'account', { bucket: 'b' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not support scope account')));
});

test('S3 credential adapter requires access_key_id and secret_access_key', async () => {
  const a = s3Adapter();
  assert.deepEqual([...a.expectedSecretKeys].sort(), [
    'access_key_id',
    'secret_access_key',
    'session_token',
  ]);
  await assert.doesNotReject(() =>
    a.validate({ access_key_id: 'AKIA', secret_access_key: 'secret' }),
  );
});

test('S3 credential adapter accepts optional session_token (STS / SSO)', async () => {
  const a = s3Adapter();
  await assert.doesNotReject(() =>
    a.validate({
      access_key_id: 'AKIA',
      secret_access_key: 'secret',
      session_token: 'IQoJb3JpZ2luX2VjE...',
    }),
  );
});

test('S3 credential adapter rejects missing or blank keys', async () => {
  const a = s3Adapter();
  await assert.rejects(() => a.validate({}));
  await assert.rejects(() => a.validate({ access_key_id: 'AKIA' }));
  await assert.rejects(() => a.validate({ access_key_id: '  ', secret_access_key: 'x' }));
});
