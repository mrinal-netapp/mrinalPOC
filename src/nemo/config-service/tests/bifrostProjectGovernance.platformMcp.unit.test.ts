/**
 * Unit tests for the pure platform-MCP → project-VK attachment seam
 * (`selectPlatformMcpClientNames` + `computePlatformMcpConfigAdditions` in
 * `services/bifrost/bifrostProjectGovernance.ts`).
 *
 * Platform MCP servers (`artifact_store`, `analytics_datasets_mcp`, ...) are
 * registered in Bifrost with `allow_on_all_virtual_keys: false`, so they are
 * only reachable by a project's virtual key when their client name is present
 * in that VK's `mcp_configs`. Nothing added them to real project VKs before;
 * `attachPlatformMcpServersToProjectVirtualKey` (backed by these pure helpers,
 * invoked at project-init `gateway-setup`) now does.
 *
 * These are pure functions (no Bifrost HTTP / DB I/O) so they run without fakes.
 *
 * Run: node --require ts-node/register --test tests/bifrostProjectGovernance.platformMcp.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePlatformMcpConfigAdditions,
  selectPlatformMcpClientNames,
  type PlatformMcpServerRef,
} from '../services/bifrost/bifrostProjectGovernance';

const ALL_ON = { webSearch: true, analytics: true };

const ARTIFACT_STORE: PlatformMcpServerRef = {
  name: 'artifact-store',
  catalogId: 'artifact_store_mcp',
  llmproxyGatewayServerName: 'artifact_store',
  status: 'connected',
  syncStatus: 'synced',
};

const ANALYTICS: PlatformMcpServerRef = {
  name: 'analytics_datasets_mcp',
  catalogId: 'analytics_datasets_mcp',
  llmproxyGatewayServerName: 'analytics_datasets_mcp',
  status: 'connected',
  syncStatus: 'synced',
};

test('selectPlatformMcpClientNames returns synced, permitted client names', () => {
  const names = selectPlatformMcpClientNames([ARTIFACT_STORE, ANALYTICS], ALL_ON);
  assert.deepEqual(names.sort(), ['analytics_datasets_mcp', 'artifact_store']);
});

test('selectPlatformMcpClientNames excludes un-synced and errored servers', () => {
  const pending: PlatformMcpServerRef = { ...ARTIFACT_STORE, syncStatus: 'pending' };
  const errored: PlatformMcpServerRef = { ...ANALYTICS, status: 'error' };
  assert.deepEqual(selectPlatformMcpClientNames([pending, errored], ALL_ON), []);
});

test('selectPlatformMcpClientNames honors rollout gates', () => {
  // analytics gated off → only artifact-store remains.
  assert.deepEqual(
    selectPlatformMcpClientNames([ARTIFACT_STORE, ANALYTICS], { webSearch: true, analytics: false }),
    ['artifact_store'],
  );
});

test('selectPlatformMcpClientNames falls back to the sanitized display name', () => {
  const noGatewayName: PlatformMcpServerRef = {
    name: 'my-platform-mcp',
    catalogId: null,
    llmproxyGatewayServerName: null,
    status: 'connected',
    syncStatus: 'synced',
  };
  assert.deepEqual(selectPlatformMcpClientNames([noGatewayName], ALL_ON), ['my_platform_mcp']);
});

test('computePlatformMcpConfigAdditions appends missing platform clients', () => {
  const { configs, added } = computePlatformMcpConfigAdditions([], [ARTIFACT_STORE, ANALYTICS], ALL_ON);

  assert.deepEqual(added.sort(), ['analytics_datasets_mcp', 'artifact_store']);
  assert.equal(configs.length, 2);
  for (const entry of configs) {
    assert.deepEqual(entry.tools_to_execute, ['*']);
  }
});

test('computePlatformMcpConfigAdditions preserves existing (project-scoped) mcp_configs', () => {
  const existing = [{ mcp_client_name: 'proj67bqptlb_github', tools_to_execute: ['*'] }];
  const { configs, added } = computePlatformMcpConfigAdditions(existing, [ARTIFACT_STORE], ALL_ON);

  assert.deepEqual(added, ['artifact_store']);
  assert.equal(configs.length, 2);
  assert.ok(configs.some((c) => c.mcp_client_name === 'proj67bqptlb_github'));
  assert.ok(configs.some((c) => c.mcp_client_name === 'artifact_store'));
});

test('computePlatformMcpConfigAdditions is idempotent: re-running adds nothing', () => {
  const first = computePlatformMcpConfigAdditions([], [ARTIFACT_STORE, ANALYTICS], ALL_ON);
  const second = computePlatformMcpConfigAdditions(first.configs, [ARTIFACT_STORE, ANALYTICS], ALL_ON);

  assert.deepEqual(second.added, []);
  assert.equal(second.configs.length, first.configs.length);
});

test('selectPlatformMcpClientNames excludes analytics when only webSearch is enabled', () => {
  assert.deepEqual(
    selectPlatformMcpClientNames([ARTIFACT_STORE, ANALYTICS], { webSearch: true, analytics: false }),
    ['artifact_store'],
  );
});

test('computePlatformMcpConfigAdditions returns empty added when platform clients already present', () => {
  const existing = [
    { mcp_client_name: 'artifact_store', tools_to_execute: ['*'] },
    { mcp_client_name: 'analytics_datasets_mcp', tools_to_execute: ['search'] },
  ];
  const { configs, added } = computePlatformMcpConfigAdditions(existing, [ARTIFACT_STORE, ANALYTICS], ALL_ON);
  assert.deepEqual(added, []);
  assert.equal(configs.length, 2);
});
