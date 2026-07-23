/**
 * Unit tests for services/ProviderCatalogService.ts. Pure: reads the bundled
 * provider-catalog.json from disk (no DB/network) and validates connector
 * configs against the per-scope schema.
 *
 * Run: node --require ts-node/register --test tests/ProviderCatalogService.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getAllProviders,
  getProvider,
  getProviderIds,
  validateConnectorConfig,
  reloadCatalog,
} from '../services/ProviderCatalogService';

test('getAllProviders returns the catalog entries', () => {
  const providers = getAllProviders();
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0);
  const s3 = providers.find((p) => p.id === 's3');
  assert.ok(s3);
  assert.equal(s3?.label, 'Amazon S3');
});

test('getProviderIds lists every provider id', () => {
  const ids = getProviderIds();
  assert.ok(ids.includes('s3'));
  assert.ok(ids.includes('postgresql'));
  assert.equal(ids.length, getAllProviders().length);
});

test('getProvider returns a known provider and undefined for unknown', () => {
  assert.equal(getProvider('postgresql')?.id, 'postgresql');
  assert.equal(getProvider('does-not-exist'), undefined);
});

test('validateConnectorConfig rejects an unknown provider', () => {
  const r = validateConnectorConfig('nope', 'resource', {});
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /Unknown provider: nope/);
});

test('validateConnectorConfig rejects an unsupported scope', () => {
  // s3 supports only the "resource" scope.
  const r = validateConnectorConfig('s3', 'account', { bucket: 'b' });
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /does not support scope account/);
});

test('validateConnectorConfig flags missing required fields', () => {
  const r = validateConnectorConfig('s3', 'resource', {});
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /bucket is required/.test(e)));
});

test('validateConnectorConfig flags unknown fields', () => {
  const r = validateConnectorConfig('s3', 'resource', { bucket: 'b', surprise: 'x' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /Unknown field 'surprise'/.test(e)));
});

test('validateConnectorConfig treats empty-string required values as missing', () => {
  const r = validateConnectorConfig('postgresql', 'resource', { host: '', port: 5432 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /host is required/.test(e)));
});

test('validateConnectorConfig accepts a valid config', () => {
  const r = validateConnectorConfig('s3', 'resource', { bucket: 'my-bucket', region: 'us-east-1' });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateConnectorConfig rejects ontap client_cidrs missing the /prefix', () => {
  const r = validateConnectorConfig('ontap', 'account', {
    cluster_url: 'https://cluster.example.com',
    client_cidrs: ['10.0.0.1'],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /client_cidrs entry '10.0.0.1' is not a valid CIDR/.test(e)));
});

test('validateConnectorConfig accepts ontap IPv4 and IPv6 CIDRs', () => {
  const r = validateConnectorConfig('ontap', 'account', {
    cluster_url: 'https://cluster.example.com',
    client_cidrs: ['10.0.0.0/16', '2001:db8::/48'],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateConnectorConfig accepts a comma-separated client_cidrs string', () => {
  const r = validateConnectorConfig('ontap', 'account', {
    cluster_url: 'https://cluster.example.com',
    client_cidrs: '10.0.0.0/16, 192.168.0.0/24',
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('validateConnectorConfig rejects a non-array/non-string client_cidrs value', () => {
  const r = validateConnectorConfig('ontap', 'account', {
    cluster_url: 'https://cluster.example.com',
    client_cidrs: 123 as unknown as string[],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /client_cidrs must be an array of CIDR strings/.test(e)));
});

test('validateConnectorConfig flags an out-of-range CIDR prefix', () => {
  const r = validateConnectorConfig('ontap', 'account', {
    cluster_url: 'https://cluster.example.com',
    client_cidrs: ['10.0.0.0/33'],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /is not a valid CIDR/.test(e)));
});

test('reloadCatalog re-reads the catalog without throwing and keeps it usable', () => {
  assert.doesNotThrow(() => reloadCatalog());
  assert.ok(getAllProviders().length > 0);
});
