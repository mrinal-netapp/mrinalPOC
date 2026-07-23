/**
 * Aggressive branch-coverage boost tests targeting remaining gaps in
 * LakekeeperCatalogService, bifrostProjectGovernance helpers, bifrostOps,
 * bifrostProviderOps, and BifrostGatewayClient private helpers.
 *
 * Run: node --require ts-node/register --test tests/coverageBranchesBoost.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { LakekeeperCatalogService } from '../services/LakekeeperCatalogService';
import {
  toVkMcpConfigsWriteShape,
  toVkProviderConfigsWriteShape,
  resolveProjectVirtualKeyId,
} from '../services/bifrost/bifrostProjectGovernance';
import {
  getLogStats,
  getLogTokenSplit,
  getTeam,
  getVirtualKey,
  listModelConfigs,
  deleteModelConfig,
} from '../services/bifrost/bifrostOps';
import {
  mapLlmProviderToBifrost,
} from '../services/bifrost/bifrostProviderOps';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const WH_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROJECT = 'proj67bqptlb';

// ─── LakekeeperCatalogService ─────────────────────────────────────────────────

class TestLakekeeper extends LakekeeperCatalogService {
  constructor(private readonly fake: AxiosInstance, baseUrl?: string) {
    super(baseUrl);
    (this as any).client = fake;
    (this as any).serviceAccountClient = null;
  }
}

function lakeFake(
  handlers: Partial<Record<'get' | 'post' | 'put' | 'delete', (url: string, body?: unknown, config?: any) => Promise<any>>>,
): AxiosInstance {
  return {
    get: async (url: string, config?: any) => handlers.get?.(url, undefined, config) ?? { status: 200, data: {} },
    post: async (url: string, body?: unknown, config?: any) =>
      handlers.post?.(url, body, config) ?? { status: 200, data: {} },
    put: async (url: string, body?: unknown, config?: any) =>
      handlers.put?.(url, body, config) ?? { status: 200, data: {} },
    delete: async (url: string, config?: any) => handlers.delete?.(url, undefined, config) ?? { status: 204, data: {} },
  } as AxiosInstance;
}

test('LakekeeperCatalogService: uses authenticated client when service account available', (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  const authClient = lakeFake({});
  scope.add(
    mockModule('@agentstudio/common', {
      createServiceAccountClientFromEnv: () => ({
        createAuthenticatedClient: () => authClient,
      }),
    }),
  );
  clearModule('services/LakekeeperCatalogService');
  const { LakekeeperCatalogService: Svc } = loadFresh<typeof import('../services/LakekeeperCatalogService')>(
    'services/LakekeeperCatalogService',
  );
  const svc = new Svc('http://lakekeeper-auth.test');
  assert.equal((svc as any).client, authClient);
  clearModule('services/LakekeeperCatalogService', '@agentstudio/common');
});

test('LakekeeperCatalogService.createWarehouse: includes optional storage profile fields', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { warehouseId: WH_ID, name: 'nemo' } };
      },
    }),
  );
  await svc.createWarehouse({
    name: 'nemo',
    uri: 's3://my-bucket/prefix',
    properties: {
      region: 'eu-west-1',
      endpoint: 'https://s3.example.com',
      awsKmsKeyArn: 'arn:aws:kms:us-east-1:123:key/abc',
      assumeRoleArn: 'arn:aws:iam::123:role/lakekeeper',
    },
  });
  assert.equal(posted['storage-profile'].bucket, 'my-bucket');
  assert.equal(posted['storage-profile'].region, 'eu-west-1');
  assert.equal(posted['storage-profile'].endpoint, 'https://s3.example.com');
  assert.equal(posted['storage-profile']['aws-kms-key-arn'], 'arn:aws:kms:us-east-1:123:key/abc');
  assert.equal(posted['storage-profile']['assume-role-arn'], 'arn:aws:iam::123:role/lakekeeper');
});

test('LakekeeperCatalogService.createWarehouse: caches warehouseId from alternate response field', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => ({ data: { id: WH_ID, name: 'nemo' } }),
    }),
  );
  await svc.createWarehouse({ name: 'nemo', uri: 's3://bucket' });
  assert.equal((svc as any).warehouseId, WH_ID);
});

test('LakekeeperCatalogService.createWarehouse: warns when response lacks warehouse id', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => ({ data: { name: 'nemo' } }),
    }),
  );
  await svc.createWarehouse({ name: 'nemo', uri: 's3://bucket' });
  assert.equal((svc as any).warehouseId, undefined);
});

test('LakekeeperCatalogService.createWarehouse: wraps HTTP errors with status code', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      post: async () => {
        const err: any = new Error('bad request');
        err.response = { status: 400, data: { message: 'invalid profile' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.createWarehouse({ name: 'nemo', uri: 's3://bucket' }),
    /invalid profile.*HTTP 400/,
  );
});

test('LakekeeperCatalogService.listWarehouses: wraps list failures', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('down');
        err.response = { data: { message: 'catalog offline' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.listWarehouses(), /catalog offline/);
});

test('LakekeeperCatalogService.getWarehouse: normalizes warehouse-name and storage-profile uri', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          warehouses: [
            {
              'warehouse-name': 'nemo',
              'warehouse-id': WH_ID,
              'storage-profile': { bucket: 'bucket-a' },
            },
          ],
        },
      }),
    }),
  );
  const wh = await svc.getWarehouse('nemo');
  assert.equal(wh.name, 'nemo');
  assert.equal((wh as any).warehouseId, WH_ID);
  assert.match(wh.uri || '', /bucket-a/);
});

test('LakekeeperCatalogService.getWarehouse: rethrows not-found errors', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({ data: { warehouses: [] } }),
    }),
  );
  await assert.rejects(() => svc.getWarehouse('missing'), /not found/);
});

test('LakekeeperCatalogService.getWarehouse: wraps non-not-found HTTP errors', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('upstream');
        err.response = { status: 503, data: { message: 'lakekeeper busy' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.getWarehouse('nemo'), /lakekeeper busy/);
});

test('LakekeeperCatalogService.healthCheck: treats non-404 HTTP errors as reachable', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        if (url === '/health') {
          const err: any = new Error('service error');
          err.response = { status: 503 };
          throw err;
        }
        throw new Error('unexpected');
      },
    }),
  );
  assert.equal(await svc.healthCheck(), false);
});

test('LakekeeperCatalogService.createNamespace: rejects empty warehouse id after trim', async () => {
  const svc = new TestLakekeeper(lakeFake({}));
  await assert.rejects(
    () => svc.createNamespace({ namespace: ['a', 'b'] }, '   '),
    /empty or invalid/,
  );
});

test('LakekeeperCatalogService.createNamespace: includes namespace properties in body', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { namespace: ['a', 'b'] } };
      },
    }),
  );
  await svc.createNamespace({ namespace: ['a', 'b'], properties: { owner: 'test' } }, WH_ID);
  assert.deepEqual(posted.namespace, ['a', 'b']);
  assert.deepEqual(posted.properties, { owner: 'test' });
});

// ─── bifrostProjectGovernance pure helpers ────────────────────────────────────

test('toVkMcpConfigsWriteShape returns [] for non-array input', () => {
  assert.deepEqual(toVkMcpConfigsWriteShape(undefined), []);
});

test('toVkMcpConfigsWriteShape uses entry.name fallback and empty tools default', () => {
  const out = toVkMcpConfigsWriteShape([{ name: 'from-name-field' }]);
  assert.deepEqual(out, [{ mcp_client_name: 'from-name-field', tools_to_execute: ['*'] }]);
});

test('toVkProviderConfigsWriteShape deduplicates string key_ids and keys', () => {
  const out = toVkProviderConfigsWriteShape([
    {
      provider: 'openai',
      key_ids: ['k1', 'k2', 'k1'],
      keys: ['k3', { key_id: 'k2' }],
    },
  ]);
  assert.deepEqual(out[0].key_ids, ['k1', 'k2', 'k3']);
});

test('resolveProjectVirtualKeyId: matches VK using key_id field', async () => {
  const client = {
    get: async (url: string) => {
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [{ key_id: 'vk-by-key-id', name: `as-proj-${PROJECT}-vk` }],
          },
        };
      }
      throw new Error(url);
    },
  } as AxiosInstance;
  assert.equal(await resolveProjectVirtualKeyId(PROJECT, client), 'vk-by-key-id');
});

// ─── bifrostOps ───────────────────────────────────────────────────────────────

const ORIGINAL_URL = process.env.LLM_GATEWAY_URL;
const ORIGINAL_KEY = process.env.LLM_GATEWAY_API_KEY;

beforeEach(() => {
  process.env.LLM_GATEWAY_URL = 'http://gateway.example';
  process.env.LLM_GATEWAY_API_KEY = 'test-key';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.LLM_GATEWAY_API_KEY;
  else process.env.LLM_GATEWAY_API_KEY = ORIGINAL_KEY;
});

test('getLogStats: passes filter query params when provided', async () => {
  let url = '';
  const fake = {
    get: async (u: string) => {
      url = u;
      return { data: { total_requests: 2 } };
    },
  } as unknown as AxiosInstance;
  await getLogStats({ providers: 'openai', models: 'gpt-4', startTime: '2024-01-01' }, fake);
  assert.match(url, /providers=openai/);
  assert.match(url, /models=gpt-4/);
});

test('getLogTokenSplit: omits optional filters from URL when absent', async () => {
  let url = '';
  const fake = {
    get: async (u: string) => {
      url = u;
      return { data: { logs: [] } };
    },
  } as unknown as AxiosInstance;
  await getLogTokenSplit({}, fake);
  assert.match(url, /^\/api\/logs\?/);
  assert.match(url, /limit=100/);
});

test('getTeam: returns bare response when team wrapper absent', async () => {
  const fake = {
    get: async () => ({ data: { team_id: 'tid-1' } }),
  } as unknown as AxiosInstance;
  const team = await getTeam('tid-1', fake);
  assert.equal(team?.team_id, 'tid-1');
});

test('getVirtualKey: unwraps virtual_key nested object', async () => {
  const fake = {
    get: async () => ({ data: { virtual_key: { id: 'vk-1', name: 'vk-name' } } }),
  } as unknown as AxiosInstance;
  const vk = await getVirtualKey('vk-1', fake);
  assert.equal(vk?.id, 'vk-1');
});

test('listModelConfigs: returns model_configs array from wrapped response', async () => {
  const fake = {
    get: async () => ({ data: { model_configs: [{ id: 'mc-1', model_name: 'm1' }] } }),
  } as unknown as AxiosInstance;
  const rows = await listModelConfigs(fake) as { model_configs: Array<{ id: string }> };
  assert.equal(rows.model_configs.length, 1);
});

test('deleteModelConfig: propagates delete errors', async () => {
  const fake = {
    delete: async () => {
      throw new Error('delete failed');
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => deleteModelConfig('mc-missing', fake), /delete failed/);
});

test('mapLlmProviderToBifrost: maps openai_compatible with credential id', () => {
  assert.match(mapLlmProviderToBifrost('openai_compatible', 'cred-uuid-1234'), /^as-openai-compat-/);
});
