/**
 * PostgreSQL provider catalog, validateConnectorConfig, and credential adapter tests.
 *
 * Dataset / data-source validator tests: postgresql.dataSource.unit.test.ts, postgresql.dataSet.unit.test.ts
 *
 * Run: `npm run test:postgresql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorAdapters } from '../providers/connector';
import {
  getProvider,
  validateConnectorConfig,
} from '../services/ProviderCatalogService';

function postgresqlAdapter() {
  const adapter = createConnectorAdapters().find((a) => a.provider === 'postgresql');
  assert.ok(adapter, 'PostgreSQL ConnectorCredentialAdapter must be registered');
  return adapter!;
}

test('catalog: postgresql provider is database with resource scope and schema in schema', () => {
  const entry = getProvider('postgresql');
  assert.ok(entry, 'provider-catalog must include postgresql');
  assert.equal(entry!.label, 'PostgreSQL');
  assert.deepEqual(entry!.scopes, ['resource']);
  assert.ok(entry!.hasAcquisition);
  assert.ok(entry!.supportedActions.includes('listDatabases'));
  const resource = entry!.connectorConfigSchema.resource;
  assert.ok(resource);
  assert.deepEqual(resource.required, ['host', 'port']);
  assert.ok(resource.optional.includes('database'));
  assert.ok(resource.optional.includes('schema'));
  assert.ok(resource.optional.includes('ssl_mode'));
  assert.ok(resource.properties.schema);
});

test('validateConnectorConfig: accepts minimal PostgreSQL resource config', () => {
  const result = validateConnectorConfig('postgresql', 'resource', {
    host: 'postgres.example.com',
    port: 5432,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateConnectorConfig: accepts schema and ssl_mode', () => {
  const result = validateConnectorConfig('postgresql', 'resource', {
    host: 'h',
    port: 5432,
    database: 'appdb',
    schema: 'public',
    ssl_mode: 'verify-full',
  });
  assert.equal(result.valid, true);
});

test('validateConnectorConfig: rejects missing host', () => {
  const result = validateConnectorConfig('postgresql', 'resource', { port: 5432 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('host is required')));
});

test('validateConnectorConfig: rejects unknown connector fields', () => {
  const result = validateConnectorConfig('postgresql', 'resource', {
    host: 'h',
    port: 5432,
    bucket: 'not-for-postgresql',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unknown field 'bucket'")));
});

test('validateConnectorConfig: rejects account scope (PostgreSQL is resource-only)', () => {
  const result = validateConnectorConfig('postgresql', 'account', { host: 'h', port: 5432 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not support scope account')));
});

test('PostgreSQL credential adapter requires username and password', async () => {
  const a = postgresqlAdapter();
  assert.deepEqual([...a.expectedSecretKeys].sort(), ['password', 'username']);
  await assert.doesNotReject(() =>
    a.validate({ username: 'app', password: 'secret' }),
  );
});

test('PostgreSQL credential adapter rejects missing or blank keys', async () => {
  const a = postgresqlAdapter();
  await assert.rejects(() => a.validate({}));
  await assert.rejects(() => a.validate({ username: 'app' }));
  await assert.rejects(() => a.validate({ username: '  ', password: 'x' }));
});
