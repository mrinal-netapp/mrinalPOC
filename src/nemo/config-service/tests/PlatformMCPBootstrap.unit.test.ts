/**
 * Unit tests for services/PlatformMCPBootstrap.ts. The bootstrap reads/writes
 * the MCPServer repo through the injected DataSource, so we pass a fake one
 * (no DB/network).
 *
 * Run: node --require ts-node/register --test tests/PlatformMCPBootstrap.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapPlatformMcpServers } from '../services/PlatformMCPBootstrap';
import {
  ANALYTICS_DATASETS_CATALOG_ID,
  ARTIFACT_STORE_CATALOG_ID,
} from '../catalog/mcpServerCatalog';
import { PLATFORM_MCP_DEFAULT_EXTRA_HEADERS } from '../catalog/platformMcpDefaults';
import { makeFakeRepo } from './helpers/appDataSourceMock';

const ARTIFACT_URL = 'http://artifact-service:8080/mcp';
const ANALYTICS_URL = 'http://analytics-mcp-server:8000/mcp';

function fakeDataSource(repo: Record<string, any>) {
  return { getRepository: () => repo } as any;
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp-artifact',
    name: 'artifact-store',
    url: ARTIFACT_URL,
    catalogId: ARTIFACT_STORE_CATALOG_ID,
    extraHeaders: [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS],
    ...overrides,
  };
}

function analyticsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp-analytics',
    name: 'analytics_datasets_mcp',
    url: ANALYTICS_URL,
    catalogId: ANALYTICS_DATASETS_CATALOG_ID,
    extraHeaders: [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS],
    ...overrides,
  };
}

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  delete process.env.ARTIFACT_SERVICE_URL;
  delete process.env.ANALYTICS_MCP_URL;
});
afterEach(() => mock.restoreAll());

test('registers both platform MCPs when none exist', async () => {
  const save = mock.fn(async (e: any) => e);
  const repo = makeFakeRepo({ findOne: async () => null, create: (d: any) => ({ ...d }), save, find: async () => [] });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.deepEqual(result, { registered: 2, updated: 0, skipped: 0 });
  assert.equal(save.mock.callCount(), 2);
  for (const call of save.mock.calls) {
    assert.deepEqual(call.arguments[0].extraHeaders, [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS]);
  }
});

test('updates the artifact-store MCP when the url drifted', async () => {
  const update = mock.fn(async () => ({ affected: 1 }));
  const repo = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.name === 'artifact-store') {
        return artifactRow({ url: 'http://old-url/mcp' });
      }
      return null;
    },
    create: (d: any) => ({ ...d }),
    save: async (row: any) => row,
    update,
    find: async () => [],
  });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.equal(result.updated, 1);
  assert.equal(result.registered, 1);
});

test('backfills extraHeaders on platform MCP rows with stale allowlists', async () => {
  const update = mock.fn(async () => ({ affected: 1 }));
  const repo = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.name === 'artifact-store') return artifactRow();
      if (where.name === 'analytics_datasets_mcp') return analyticsRow();
      return null;
    },
    find: async () => [
      analyticsRow({
        extraHeaders: ['Authorization', 'X-Project-ID', 'X-User-ID', 'X-Agent-ID'],
      }),
    ],
    update,
  });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.equal(result.skipped, 2);
  assert.equal(result.updated, 1);
  const patch = (update.mock.calls[0].arguments as unknown[])[1] as { extraHeaders: string[] };
  assert.deepEqual(patch.extraHeaders, [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS]);
});

test('skips when both platform MCPs are already up to date', async () => {
  const repo = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.name === 'artifact-store') return artifactRow();
      if (where.name === 'analytics_datasets_mcp') return analyticsRow();
      return null;
    },
    find: async () => [],
  });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.deepEqual(result, { registered: 0, updated: 0, skipped: 2 });
});

test('converges on a concurrent unique-violation insert', async () => {
  let artifactLookups = 0;
  const repo = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.name === 'artifact-store') {
        artifactLookups += 1;
        return artifactLookups === 1
          ? null
          : artifactRow({ url: 'http://old/mcp' });
      }
      return null;
    },
    create: (d: any) => ({ ...d }),
    save: async ({ name }: any) => {
      if (name === 'artifact-store') {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      return { name };
    },
    update: async () => ({ affected: 1 }),
    find: async () => [],
  });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.equal(result.updated, 1);
  assert.equal(result.registered, 1);
});

test('rethrows non-unique-violation save errors', async () => {
  const repo = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async () => {
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    },
    find: async () => [],
  });
  await assert.rejects(bootstrapPlatformMcpServers(fakeDataSource(repo)), /connection reset/);
});

test('platformMcpExtraHeadersNeedUpdate flags legacy agent/team headers', async () => {
  const update = mock.fn(async () => ({ affected: 1 }));
  const repo = makeFakeRepo({
    findOne: async ({ where }: any) => {
      if (where.name === 'artifact-store') {
        return artifactRow({
          extraHeaders: [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS, 'X-Agent-ID', 'X-Team-ID'],
        });
      }
      if (where.name === 'analytics_datasets_mcp') return analyticsRow();
      return null;
    },
    find: async () => [],
    update,
  });
  const result = await bootstrapPlatformMcpServers(fakeDataSource(repo));
  assert.equal(result.updated, 1);
  assert.equal(result.skipped, 1);
});
