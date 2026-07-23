/**
 * MySQL provider catalog, validateConnectorConfig, and credential adapter tests.
 *
 * Dataset / data-source validator tests: mysql.dataSource.unit.test.ts, mysql.dataSet.unit.test.ts
 *
 * Run: `npm run test:mysql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorAdapters } from '../providers/connector';
import {
  getProvider,
  validateConnectorConfig,
} from '../services/ProviderCatalogService';

function mysqlAdapter() {
  const adapter = createConnectorAdapters().find((a) => a.provider === 'mysql');
  assert.ok(adapter, 'MySQL ConnectorCredentialAdapter must be registered');
  return adapter!;
}

test('catalog: mysql provider is database with resource scope and schema in schema', () => {
  const entry = getProvider('mysql');
  assert.ok(entry, 'provider-catalog must include mysql');
  assert.equal(entry!.label, 'MySQL');
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

test('validateConnectorConfig: accepts minimal MySQL resource config', () => {
  const result = validateConnectorConfig('mysql', 'resource', {
    host: 'mysql.example.com',
    port: 3306,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('validateConnectorConfig: accepts schema and ssl_mode', () => {
  const result = validateConnectorConfig('mysql', 'resource', {
    host: 'h',
    port: 3306,
    database: 'sakila',
    schema: 'sakila',
    ssl_mode: 'require',
  });
  assert.equal(result.valid, true);
});

test('validateConnectorConfig: rejects missing host', () => {
  const result = validateConnectorConfig('mysql', 'resource', { port: 3306 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('host is required')));
});

test('validateConnectorConfig: rejects unknown connector fields', () => {
  const result = validateConnectorConfig('mysql', 'resource', {
    host: 'h',
    port: 3306,
    bucket: 'not-for-mysql',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unknown field 'bucket'")));
});

test('validateConnectorConfig: rejects account scope (MySQL is resource-only)', () => {
  const result = validateConnectorConfig('mysql', 'account', { host: 'h', port: 3306 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('does not support scope account')));
});

test('MySQL credential adapter requires username and password', async () => {
  const a = mysqlAdapter();
  assert.deepEqual([...a.expectedSecretKeys].sort(), ['password', 'username']);
  await assert.doesNotReject(() =>
    a.validate({ username: 'app', password: 'secret' }),
  );
});

test('MySQL credential adapter rejects missing or blank keys', async () => {
  const a = mysqlAdapter();
  await assert.rejects(() => a.validate({}));
  await assert.rejects(() => a.validate({ username: 'app' }));
  await assert.rejects(() => a.validate({ username: '  ', password: 'x' }));
});
