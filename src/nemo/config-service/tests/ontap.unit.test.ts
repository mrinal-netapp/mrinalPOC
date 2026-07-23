/**
 * Pure unit tests for ONTAP-related glue in config-service.
 *
 *   - OntapCredentialAdapter.validate (basic vs mTLS branches)
 *   - parseEgressPortsFromUrl (cluster URL → NetworkPolicy egress ports)
 *   - checksumSecretData (stable across key ordering, changes on rotation)
 *   - runtimeCredSecretName (deterministic Secret naming)
 *   - mcpServerCatalog Ontap_mcp_logs credentialMapping shape (catalog drift)
 *
 * These avoid TypeORM / express / k8s entirely so the suite stays fast.
 *
 * Run: `node --require ts-node/register --test tests/ontap.unit.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnectorAdapters } from '../providers/connector';
import {
  parseEgressPortsFromUrl,
  checksumSecretData,
  runtimeCredSecretName,
  mergeManagedAllowedToolsEnv,
} from '../services/MCPRuntimeManager';
import { MCP_SERVER_CATALOG } from '../catalog/mcpServerCatalog';

function ontapAdapter() {
  const adapter = createConnectorAdapters().find((a) => a.provider === 'ontap');
  assert.ok(adapter, 'OntapCredentialAdapter must be registered');
  return adapter!;
}

test('OntapCredentialAdapter accepts basic auth credentials', async () => {
  await assert.doesNotReject(() => ontapAdapter().validate({ username: 'admin', password: 'p@ss' }));
});

test('OntapCredentialAdapter accepts mTLS credentials', async () => {
  await assert.doesNotReject(() =>
    ontapAdapter().validate({
      client_cert_pem: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
      client_key_pem: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    }),
  );
});

test('OntapCredentialAdapter accepts mTLS + CA bundle (no basic creds)', async () => {
  await assert.doesNotReject(() =>
    ontapAdapter().validate({
      client_cert_pem: 'cert',
      client_key_pem: 'key',
      ca_bundle_pem: 'ca',
    }),
  );
});

test('OntapCredentialAdapter rejects when no auth mode is fully supplied', async () => {
  await assert.rejects(() => ontapAdapter().validate({}));
  await assert.rejects(() => ontapAdapter().validate({ username: 'u' }));
  await assert.rejects(() => ontapAdapter().validate({ client_cert_pem: 'c' }));
  await assert.rejects(() => ontapAdapter().validate({ username: 'u', password: '   ' }));
});

test('OntapCredentialAdapter exposes union of all 5 keys', () => {
  const a = ontapAdapter();
  assert.deepEqual(
    [...a.expectedSecretKeys].sort(),
    ['ca_bundle_pem', 'client_cert_pem', 'client_key_pem', 'password', 'username'],
  );
});

test('parseEgressPortsFromUrl: defaults to 443 for https', () => {
  assert.deepEqual(parseEgressPortsFromUrl('https://cluster.example.com'), [443]);
});

test('parseEgressPortsFromUrl: explicit port wins', () => {
  assert.deepEqual(parseEgressPortsFromUrl('https://cluster.example.com:8443/api'), [8443]);
});

test('parseEgressPortsFromUrl: http defaults to 80', () => {
  assert.deepEqual(parseEgressPortsFromUrl('http://lab-cluster'), [80]);
});

test('parseEgressPortsFromUrl: custom http port', () => {
  assert.deepEqual(parseEgressPortsFromUrl('http://lab-cluster:8080'), [8080]);
});

test('parseEgressPortsFromUrl: undefined / malformed falls back to [443, 8443]', () => {
  assert.deepEqual(parseEgressPortsFromUrl(undefined), [443, 8443]);
  assert.deepEqual(parseEgressPortsFromUrl(''), [443, 8443]);
  assert.deepEqual(parseEgressPortsFromUrl('not a url'), [443, 8443]);
});

test('checksumSecretData: stable across key ordering', () => {
  const a = checksumSecretData({ username: 'u', password: 'p' });
  const b = checksumSecretData({ password: 'p', username: 'u' });
  assert.equal(a, b);
});

test('checksumSecretData: changes when any value changes (rotation triggers rollout)', () => {
  const before = checksumSecretData({ username: 'u', password: 'p1' });
  const after = checksumSecretData({ username: 'u', password: 'p2' });
  assert.notEqual(before, after);
});

test('runtimeCredSecretName: deterministic per server', () => {
  assert.equal(runtimeCredSecretName('srv-1'), 'mcp-runtime-cred-srv-1');
  assert.equal(runtimeCredSecretName('srv-1'), runtimeCredSecretName('srv-1'));
});

test('catalog: Ontap_mcp_logs credentialMapping is wired correctly', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'Ontap_mcp_logs');
  assert.ok(entry, 'Ontap_mcp_logs catalog entry must exist');
  assert.ok(entry!.credentialMapping, 'Ontap_mcp_logs must declare credentialMapping');
  const cm = entry!.credentialMapping!;
  assert.equal(cm.expectedProvider, 'ontap');
  assert.deepEqual(cm.envFromKeys, {
    username: 'ONTAP_USERNAME',
    password: 'ONTAP_PASSWORD',
  });
  assert.ok(cm.fileFromKeys);
  for (const key of ['client_cert_pem', 'client_key_pem', 'ca_bundle_pem']) {
    assert.ok(cm.fileFromKeys![key], `${key} must be projected as a file`);
    assert.ok(cm.fileFromKeys![key].mountPath.startsWith('/etc/ontap/'));
    assert.ok(cm.fileFromKeys![key].envForPath.startsWith('ONTAP_'));
    assert.ok(typeof cm.fileFromKeys![key].mode === 'number');
  }
});

test('catalog: Ontap_mcp_logs default allowed tools are all read-only', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'Ontap_mcp_logs')!;
  assert.ok((entry.defaultAllowedTools || []).length > 0, 'Ontap_mcp_logs should expose default read tools');
  const writeVerbs = ['create', 'delete', 'update', 'restore', 'resize', 'set_'];
  for (const tool of entry.defaultAllowedTools || []) {
    for (const verb of writeVerbs) {
      assert.ok(
        !tool.startsWith(verb),
        `default allowed tool "${tool}" must not start with write verb "${verb}"`,
      );
    }
  }
});

test('catalog: Ontap_mcp_logs includes log query tools in defaults', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'Ontap_mcp_logs')!;
  const logTools = [
    'query_ems_events',
    'get_ems_event',
    'lookup_ems_message',
    'query_audit_messages',
  ];
  for (const tool of logTools) {
    assert.ok(
      entry.defaultAllowedTools?.includes(tool),
      `defaultAllowedTools must include ${tool}`,
    );
  }
});

test('catalog: Ontap_mcp_logs is defined exactly once', () => {
  const count = MCP_SERVER_CATALOG.filter((e) => e.id === 'Ontap_mcp_logs').length;
  assert.equal(count, 1, 'Ontap_mcp_logs must have exactly one catalog entry');
});

test('mergeManagedAllowedToolsEnv: ontap_mcp sets ONTAP_ALLOWED_TOOLS', () => {
  const out = mergeManagedAllowedToolsEnv('ontap_mcp', { ONTAP_CLUSTER_URL: 'https://c' }, ['list_volumes']);
  assert.equal(out.ONTAP_ALLOWED_TOOLS, 'list_volumes');
});

test('mergeManagedAllowedToolsEnv: unknown catalog leaves env unchanged', () => {
  const base = { FOO: 'bar' };
  assert.deepEqual(mergeManagedAllowedToolsEnv('filesystem_mcp', base, ['x']), base);
});

test('catalog: ontap_mcp_official exists with expected read defaults', () => {
  const entry = MCP_SERVER_CATALOG.find((e) => e.id === 'ontap_mcp_official');
  assert.ok(entry, 'ontap_mcp_official catalog entry must exist');
  assert.equal(entry!.image, 'ghcr.io/netapp/ontap-mcp');
  assert.equal(entry!.mcpPath, '/');
  assert.ok((entry!.args || []).includes('--stateless'));
  assert.equal(entry!.runAsNonRoot, false);
  assert.equal(entry!.runAsUser, 0);
  assert.equal(entry!.runAsGroup, 0);
  const defaultTools = entry!.defaultAllowedTools || [];
  for (const t of ['list_ontap_endpoints', 'search_ontap_endpoints', 'describe_ontap_endpoint', 'ontap_get']) {
    assert.ok(defaultTools.includes(t), `${t} must be enabled by default for ontap_mcp_official`);
  }
});
