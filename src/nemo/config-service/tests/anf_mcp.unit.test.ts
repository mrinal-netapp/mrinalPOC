/**
 * Unit tests for anf_mcp catalog entry (credentialMapping, defaultAllowedTools).
 *
 * Run: node --require ts-node/register --test tests/anf_mcp.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MCP_SERVER_CATALOG } from '../catalog/mcpServerCatalog';
import { mergeManagedAllowedToolsEnv } from '../services/MCPRuntimeManager';

test('catalog: anf_mcp credentialMapping uses azure_cloud', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'anf_mcp');
  assert.ok(entry, 'anf_mcp catalog entry must exist');
  assert.equal(entry!.image, 'nemo/mcp-server-anf');
  assert.equal(entry!.healthProbe, 'http');
  assert.deepEqual(entry!.egressPorts, [443]);
  const cm = entry!.credentialMapping!;
  assert.equal(cm.expectedProvider, 'azure_cloud');
  assert.deepEqual(cm.envFromKeys, {
    tenant_id: 'AZURE_TENANT_ID',
    client_id: 'AZURE_CLIENT_ID',
    client_secret: 'AZURE_CLIENT_SECRET',
  });
});

test('catalog: anf_mcp envSchema requires subscription and region', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'anf_mcp')!;
  const names = (entry.envSchema || []).map((f) => f.name);
  assert.ok(names.includes('AZURE_SUBSCRIPTION_ID'));
  assert.ok(names.includes('AZURE_DEFAULT_REGION'));
});

test('catalog: anf_mcp default allowed tools include read and write tools', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'anf_mcp')!;
  assert.deepEqual(entry.defaultAllowedTools, [
    'anf_capacity_pool_list',
    'anf_capacity_pool_get',
    'anf_volume_list',
    'anf_volume_get',
    'anf_resize_capacity_pool',
    'anf_resize_volume',
  ]);
});

test('mergeManagedAllowedToolsEnv: anf_mcp sets ANF_ALLOWED_TOOLS', () => {
  const out = mergeManagedAllowedToolsEnv(
    'anf_mcp',
    { AZURE_SUBSCRIPTION_ID: 'sub', AZURE_DEFAULT_REGION: 'eastus' },
    ['anf_volume_get', 'anf_resize_volume'],
  );
  assert.equal(out.AZURE_SUBSCRIPTION_ID, 'sub');
  assert.equal(out.ANF_ALLOWED_TOOLS, 'anf_volume_get,anf_resize_volume');
});

test('mergeManagedAllowedToolsEnv: empty allowedTools is a no-op for anf_mcp', () => {
  const base = { AZURE_SUBSCRIPTION_ID: 'sub' };
  assert.deepEqual(mergeManagedAllowedToolsEnv('anf_mcp', base, []), base);
  assert.deepEqual(mergeManagedAllowedToolsEnv('anf_mcp', base, undefined), base);
});

test('provision deploy env: anf_mcp allowedTools projected to ANF_ALLOWED_TOOLS', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'anf_mcp');
  assert.ok(entry);
  const deployEnv = mergeManagedAllowedToolsEnv(
    entry!.id,
    { AZURE_SUBSCRIPTION_ID: 'sub', AZURE_DEFAULT_REGION: 'eastus' },
    ['anf_volume_get', 'anf_resize_volume'],
  );
  assert.equal(deployEnv.ANF_ALLOWED_TOOLS, 'anf_volume_get,anf_resize_volume');
});
