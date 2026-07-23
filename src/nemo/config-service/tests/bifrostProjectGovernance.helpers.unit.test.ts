/**
 * Unit tests for pure helpers and K8s VK-token seams in
 * `services/bifrost/bifrostProjectGovernance.ts`.
 *
 * Run: node --require ts-node/register --test tests/bifrostProjectGovernance.helpers.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import {
  projectTeamName,
  projectVirtualKeyName,
  projectVirtualKeySecretName,
  toVkProviderConfigsWriteShape,
  toVkMcpConfigsWriteShape,
  projectIdFromVkName,
  filterMcpConfigsToProject,
  projectMcpClientPrefix,
  projectVkNameMatches,
} from '../services/bifrost/bifrostProjectGovernance';

const PROJECT = 'proj67bqptlb';

// ─── naming helpers ───────────────────────────────────────────────────────────

test('project naming helpers follow as-proj-{id} convention', () => {
  assert.equal(projectTeamName(PROJECT), `as-proj-${PROJECT}`);
  assert.equal(projectVirtualKeyName(PROJECT), `as-proj-${PROJECT}-vk`);
  assert.equal(projectVirtualKeySecretName(PROJECT), projectVirtualKeyName(PROJECT));
});

test('projectIdFromVkName parses base and rotated VK names', () => {
  assert.equal(projectIdFromVkName(`as-proj-${PROJECT}-vk`), PROJECT);
  assert.equal(projectIdFromVkName(`as-proj-${PROJECT}-vk-r2`), PROJECT);
  assert.equal(projectIdFromVkName('as-proj-other-vk'), 'other');
  assert.equal(projectIdFromVkName('random-name'), undefined);
  assert.equal(projectIdFromVkName(null), undefined);
});

test('projectVkNameMatches accepts rotated suffixes and escapes regex chars', () => {
  const dotted = 'proj.with+chars';
  assert.equal(projectVkNameMatches(`as-proj-${dotted}-vk`, dotted), true);
  assert.equal(projectVkNameMatches(`as-proj-${dotted}-vk-r3`, dotted), true);
  assert.equal(projectVkNameMatches(`as-proj-${PROJECT}-vk`, 'other'), false);
  assert.equal(projectVkNameMatches(undefined, PROJECT), false);
});

test('projectMcpClientPrefix is projectId underscore', () => {
  assert.equal(projectMcpClientPrefix(PROJECT), `${PROJECT}_`);
});

// ─── VK write-shape normalization ─────────────────────────────────────────────

test('toVkProviderConfigsWriteShape converts embedded keys to key_ids', () => {
  const out = toVkProviderConfigsWriteShape([
    {
      provider: 'openai',
      keys: [{ key_id: 'k1' }, { key_id: 'k2' }],
      weight: 1,
    },
    {
      provider: 'azure',
      key_ids: ['k3', 'k1'],
    },
  ]);
  assert.deepEqual(out[0].key_ids, ['k1', 'k2']);
  assert.equal(out[0].keys, undefined);
  assert.deepEqual(out[1].key_ids, ['k3', 'k1']);
});

test('toVkProviderConfigsWriteShape returns [] for non-array input', () => {
  assert.deepEqual(toVkProviderConfigsWriteShape(null), []);
});

test('toVkMcpConfigsWriteShape normalizes read shape to write shape', () => {
  const out = toVkMcpConfigsWriteShape([
    {
      id: 7,
      mcp_client: { id: 'mc-1', name: 'artifact_store' },
      tools_to_execute: ['search'],
    },
    {
      mcp_client_name: 'analytics_datasets_mcp',
      mcp_client_id: 'mc-2',
    },
    {
      mcp_client_name: 'artifact_store',
    },
  ]);
  assert.deepEqual(out, [
    {
      id: 7,
      mcp_client_name: 'artifact_store',
      mcp_client_id: 'mc-1',
      tools_to_execute: ['search'],
    },
    {
      mcp_client_name: 'analytics_datasets_mcp',
      mcp_client_id: 'mc-2',
      tools_to_execute: ['*'],
    },
  ]);
});

test('toVkMcpConfigsWriteShape skips unnamed and duplicate entries', () => {
  const out = toVkMcpConfigsWriteShape([
    { tools_to_execute: ['*'] },
    { mcp_client_name: 'dup' },
    { mcp_client_name: 'dup', mcp_client_id: 'x' },
  ]);
  assert.deepEqual(out, [{ mcp_client_name: 'dup', tools_to_execute: ['*'] }]);
});

test('toVkProviderConfigsWriteShape deduplicates mixed key_ids and keys shapes', () => {
  const out = toVkProviderConfigsWriteShape([
    {
      provider: 'azure',
      key_ids: ['k1', 42, ''],
      keys: [{ key_id: 'k2' }, { id: 'k3' }, 'k1'],
    },
  ]);
  assert.deepEqual(out[0].key_ids, ['k1', 'k2']);
});

test('toVkMcpConfigsWriteShape preserves id and falls back to entry.name', () => {
  const out = toVkMcpConfigsWriteShape([
    { id: 9, name: 'legacy_name', tools_to_execute: [] },
    { mcp_client_name: 'artifact_store', mcp_client_id: 'mc-1' },
  ]);
  assert.deepEqual(out[0], {
    id: 9,
    mcp_client_name: 'legacy_name',
    tools_to_execute: ['*'],
  });
  assert.deepEqual(out[1], {
    mcp_client_name: 'artifact_store',
    mcp_client_id: 'mc-1',
    tools_to_execute: ['*'],
  });
});

// ─── filterMcpConfigsToProject ────────────────────────────────────────────────

test('filterMcpConfigsToProject keeps own and platform clients, drops other projects', () => {
  const configs = [
    { mcp_client_name: `${PROJECT}_github` },
    { mcp_client_name: 'artifact_store' },
    { mcp_client_name: 'projother1_jira' },
    { mcp_client_name: '' },
  ];
  const kept = filterMcpConfigsToProject(configs, PROJECT);
  assert.deepEqual(
    kept.map((c) => c.mcp_client_name),
    [`${PROJECT}_github`, 'artifact_store', ''],
  );
});

test('filterMcpConfigsToProject is a no-op without ownerProjectId', () => {
  const configs = [{ mcp_client_name: 'projother1_jira' }];
  assert.deepEqual(filterMcpConfigsToProject(configs, undefined), configs);
});

// ─── K8s VK token read/delete ─────────────────────────────────────────────────

let scope: ReturnType<typeof restoreScope>;
let k8s: Record<string, any>;

beforeEach(() => {
  scope = restoreScope();
  k8s = {
    readSecret: async (name: string) =>
      name === `as-proj-${PROJECT}-vk` ? { virtual_key_token: 'sk-bf-test' } : null,
    deleteSecret: async () => undefined,
  };
  scope.add(mockModule('services/K8sSecretService', { getK8sSecretService: () => k8s }));
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/bifrost/bifrostProjectGovernance');
});

test('readProjectVirtualKeyToken reads token from K8s secret', async () => {
  const { readProjectVirtualKeyToken } = loadFresh<typeof import('../services/bifrost/bifrostProjectGovernance')>(
    'services/bifrost/bifrostProjectGovernance',
  );
  assert.equal(await readProjectVirtualKeyToken(PROJECT), 'sk-bf-test');
});

test('readProjectVirtualKeyToken returns undefined when secret has no token key', async () => {
  k8s.readSecret = async () => ({ other_field: 'x' });
  const { readProjectVirtualKeyToken } = loadFresh<typeof import('../services/bifrost/bifrostProjectGovernance')>(
    'services/bifrost/bifrostProjectGovernance',
  );
  assert.equal(await readProjectVirtualKeyToken(PROJECT), undefined);
});

test('readProjectVirtualKeyToken returns undefined when secret missing', async () => {
  k8s.readSecret = async () => {
    const err: any = new Error('not found');
    err.code = 404;
    throw err;
  };
  const { readProjectVirtualKeyToken } = loadFresh<typeof import('../services/bifrost/bifrostProjectGovernance')>(
    'services/bifrost/bifrostProjectGovernance',
  );
  assert.equal(await readProjectVirtualKeyToken(PROJECT), undefined);
});

test('deleteProjectVirtualKeyTokenSecret swallows 404', async () => {
  k8s.deleteSecret = async () => {
    const err: any = new Error('not found');
    err.code = 'NotFound';
    throw err;
  };
  const { deleteProjectVirtualKeyTokenSecret } = loadFresh<typeof import('../services/bifrost/bifrostProjectGovernance')>(
    'services/bifrost/bifrostProjectGovernance',
  );
  await deleteProjectVirtualKeyTokenSecret(PROJECT);
});

test('deleteProjectVirtualKeyTokenSecret rethrows non-404 errors', async () => {
  k8s.deleteSecret = async () => {
    throw new Error('forbidden');
  };
  const { deleteProjectVirtualKeyTokenSecret } = loadFresh<typeof import('../services/bifrost/bifrostProjectGovernance')>(
    'services/bifrost/bifrostProjectGovernance',
  );
  await assert.rejects(() => deleteProjectVirtualKeyTokenSecret(PROJECT), /forbidden/);
});

test('toVkProviderConfigsWriteShape keeps entries without key ids', () => {
  const out = toVkProviderConfigsWriteShape([{ provider: 'ollama', weight: 1 }]);
  assert.equal(out[0].provider, 'ollama');
  assert.equal(out[0].key_ids, undefined);
});

test('toVkMcpConfigsWriteShape preserves explicit empty tools array as wildcard default', () => {
  const out = toVkMcpConfigsWriteShape([{ mcp_client_name: 'srv', tools_to_execute: [] }]);
  assert.deepEqual(out[0].tools_to_execute, ['*']);
});
