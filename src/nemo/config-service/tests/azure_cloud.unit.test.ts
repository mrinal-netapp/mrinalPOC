/**
 * Azure cloud (ANF metrics) provider catalog and credential adapter tests.
 *
 * Provider id is `azure_cloud` to avoid clobbering LLM `azure` (Azure OpenAI).
 *
 * Run: node --require ts-node/register --test tests/azure_cloud.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorAdapters } from '../providers/connector';
import {
  getProvider,
  validateConnectorConfig,
} from '../services/ProviderCatalogService';
import { getProviderRegistry } from '../providers/registry';
import { AzureAdapter } from '../providers/azure';

function azureCloudAdapter() {
  const adapter = createConnectorAdapters().find((a) => a.provider === 'azure_cloud');
  assert.ok(adapter, 'Azure cloud ConnectorCredentialAdapter must be registered');
  return adapter!;
}

test('registry: LLM azure adapter is not overwritten by azure_cloud connector', () => {
  const reg = getProviderRegistry();
  assert.ok(reg.get('azure') instanceof AzureAdapter);
  assert.ok(reg.get('azure_cloud'));
  assert.notEqual(reg.get('azure'), reg.get('azure_cloud'));
});

test('catalog: azure_cloud provider is account-scoped with subscription_id required', () => {
  const entry = getProvider('azure_cloud');
  assert.ok(entry, 'provider-catalog must include azure_cloud');
  assert.equal(entry!.label, 'Microsoft Azure');
  assert.deepEqual(entry!.scopes, ['account']);
  assert.ok(entry!.hasAcquisition);
  assert.equal(entry!.hasRegionSelector, true);
  assert.ok(entry!.supportedActions.includes('listMetricCategories'));
  const account = entry!.connectorConfigSchema.account;
  assert.ok(account);
  assert.deepEqual(account.required, ['subscription_id', 'default_region']);
  assert.ok(account.optional.includes('resource_group'));
});

test('validateConnectorConfig: accepts azure_cloud account config with region', () => {
  const result = validateConnectorConfig('azure_cloud', 'account', {
    subscription_id: '00000000-0000-0000-0000-000000000001',
    default_region: 'eastus',
  });
  assert.equal(result.valid, true);
});

test('validateConnectorConfig: rejects missing default_region', () => {
  const result = validateConnectorConfig('azure_cloud', 'account', {
    subscription_id: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('default_region is required')));
});

test('validateConnectorConfig: rejects missing subscription_id', () => {
  const result = validateConnectorConfig('azure_cloud', 'account', {});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('subscription_id is required')));
});

test('azure_cloud credential adapter: requires tenant_id, client_id, client_secret', async () => {
  const adapter = azureCloudAdapter();
  assert.equal(
    await adapter.validate({
      tenant_id: 't',
      client_id: 'c',
      client_secret: 's',
    }),
    true,
  );
  await assert.rejects(
    () => adapter.validate({ tenant_id: 't', client_id: 'c' }),
    /client_secret/,
  );
});
