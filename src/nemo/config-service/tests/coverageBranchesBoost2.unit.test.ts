/**
 * Second wave of aggressive branch-coverage tests for remaining gaps in
 * bifrostOps, bifrostProviderOps, LakekeeperCatalogService, and KeycloakClientService.
 *
 * Run: node --require ts-node/register --test tests/coverageBranchesBoost2.unit.test.ts
 */
import 'reflect-metadata';
import axios from 'axios';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { LakekeeperCatalogService } from '../services/LakekeeperCatalogService';
import { KeycloakClientService } from '../services/KeycloakClientService';
import {
  createBifrostClient,
  listTeams,
  listVirtualKeys,
  deleteTeam,
  deleteVirtualKey,
} from '../services/bifrost/bifrostOps';
import {
  appendProviderKey,
  listProviderKeys,
  deleteProviderKeyById,
} from '../services/bifrost/bifrostProviderOps';

const WH_ID = '123e4567-e89b-12d3-a456-426614174000';
const PROJECT = 'proj67bqptlb';

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

// ─── LakekeeperCatalogService ─────────────────────────────────────────────────

test('LakekeeperCatalogService.createWarehouse: includes optional storage profile properties', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    lakeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { 'warehouse-id': WH_ID } };
      },
    }),
  );
  await svc.createWarehouse({
    name: 'my-wh',
    uri: 's3://my-bucket/prefix',
    properties: {
      region: 'eu-west-1',
      endpoint: 'https://s3.example',
      awsKmsKeyArn: 'arn:aws:kms:eu-west-1:123:key/abc',
      assumeRoleArn: 'arn:aws:iam::123:role/lake',
    },
  });
  assert.equal(posted['storage-profile'].region, 'eu-west-1');
  assert.equal(posted['storage-profile'].endpoint, 'https://s3.example');
  assert.equal(posted['storage-profile']['aws-kms-key-arn'], 'arn:aws:kms:eu-west-1:123:key/abc');
  assert.equal(posted['storage-profile']['assume-role-arn'], 'arn:aws:iam::123:role/lake');
});

test('LakekeeperCatalogService.listTables: retries with unit-separator namespace on 404', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    lakeFake({
      get: async (url) => {
        calls.push(url);
        if (url.includes('proj1.datasets')) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        if (url.includes('proj1\x1Fdatasets')) {
          return { data: { identifiers: [{ name: 'events' }] } };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const tables = await svc.listTables(['proj1', 'datasets']);
  assert.deepEqual(tables, ['events']);
  assert.ok(calls.some((u) => u.includes('\x1F')));
});

test('LakekeeperCatalogService.listTables: wraps retry failure message', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(() => svc.listTables(['a', 'b']), /Failed to list tables/);
});

test('LakekeeperCatalogService.getTableSchema: returns null when table has no schemas', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      get: async () => ({
        data: {
          metadata: {
            'current-schema-id': 1,
            schemas: [],
          },
        },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const schema = await svc.getTableSchema(['proj1', 'datasets'], 'events');
  assert.equal(schema, null);
});

test('LakekeeperCatalogService.deleteNamespace: wraps retry failure message', async () => {
  const svc = new TestLakekeeper(
    lakeFake({
      delete: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.deleteNamespace(['ghost', 'ns']), /Failed to delete namespace/);
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

test('listTeams: unwraps teams array from wrapped response', async () => {
  const fake = {
    get: async () => ({ data: { teams: [{ id: 't1', name: 'team-a' }] } }),
  } as unknown as AxiosInstance;
  const teams = await listTeams(fake);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].id, 't1');
});

test('listVirtualKeys: returns bare array when response is array', async () => {
  const fake = {
    get: async () => ({ data: [{ id: 'vk-1', name: 'vk-a' }] }),
  } as unknown as AxiosInstance;
  const keys = (await listVirtualKeys(fake)) as Array<{ id: string }>;
  assert.equal(keys.length, 1);
});

test('deleteVirtualKey: propagates non-404 delete errors', async () => {
  const fake = {
    delete: async () => {
      const err: any = new Error('forbidden');
      err.response = { status: 403 };
      throw err;
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => deleteVirtualKey('vk-1', fake), /forbidden/);
});

test('deleteTeam: propagates non-404 delete errors', async () => {
  const fake = {
    delete: async () => {
      const err: any = new Error('locked');
      err.response = { status: 423 };
      throw err;
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => deleteTeam('team-1', fake), /locked/);
});

test('createBifrostClient: attaches api key header from env', () => {
  const client = createBifrostClient();
  assert.equal((client.defaults.headers as any)['x-api-key'], 'test-key');
});

// ─── bifrostProviderOps ───────────────────────────────────────────────────────

test('listProviderKeys: returns keys array from wrapped response', async () => {
  const fake = {
    get: async () => ({ data: { keys: [{ id: 'k1', name: 'key-a', models: [] }] } }),
  } as unknown as AxiosInstance;
  const keys = await listProviderKeys('openai', fake);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, 'key-a');
});

test('deleteProviderKeyById: calls delete endpoint', async () => {
  let deletedUrl = '';
  const fake = {
    delete: async (url: string) => {
      deletedUrl = url;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  await deleteProviderKeyById('openai', 'kid-1', fake);
  assert.match(deletedUrl, /\/providers\/openai\/keys\/kid-1/);
});

test('appendProviderKey: creates provider when missing then appends key', async () => {
  let providerCreated = false;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers/openai/keys') return { data: { keys: [] } };
      if (url === '/api/providers') {
        return { data: { providers: providerCreated ? [{ name: 'openai' }] : [] } };
      }
      throw new Error(url);
    },
    post: async (url: string) => {
      if (url === '/api/providers') {
        providerCreated = true;
        return { data: { name: 'openai' } };
      }
      return { data: { id: 'kid-new', name: 'as-cred-c1', models: [`${PROJECT}_c1_gpt-4o`] } };
    },
  } as unknown as AxiosInstance;
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: `${PROJECT}_c1_gpt-4o`,
      providerModelId: 'gpt-4o',
      apiKey: 'sk-test',
      credentialId: 'c1',
      projectId: PROJECT,
    },
    fake,
  );
  assert.equal(providerCreated, true);
  assert.equal(result.keyId, 'kid-new');
});

// ─── KeycloakClientService ────────────────────────────────────────────────────

test('getAdminToken: reuses cached token without calling axios', async () => {
  let axiosPosts = 0;
  mock.method(axios, 'post', async () => {
    axiosPosts += 1;
    return { data: { access_token: 'fresh', expires_in: 60 } };
  });
  const svc = new KeycloakClientService();
  (svc as any).accessToken = 'cached-token';
  (svc as any).tokenExpiry = new Date(Date.now() + 120_000);
  (svc as any).adminClient = {
    defaults: { baseURL: 'http://keycloak.test' },
    get: async () => ({ data: [] }),
  } as unknown as AxiosInstance;
  assert.equal(await svc.clientExists('any-client'), false);
  assert.equal(axiosPosts, 0);
  mock.restoreAll();
});

test('getAdminToken: fetches token when cache expired', async () => {
  mock.method(axios, 'post', async () => ({
    data: { access_token: 'fresh-token', expires_in: 300 },
  }));
  const svc = new KeycloakClientService();
  (svc as any).accessToken = undefined;
  (svc as any).tokenExpiry = undefined;
  (svc as any).adminClient = {
    defaults: { baseURL: 'http://keycloak.test' },
    get: async () => ({ data: [{ clientId: 'c1' }] }),
  } as unknown as AxiosInstance;
  assert.equal(await svc.clientExists('c1'), true);
  assert.equal((svc as any).accessToken, 'fresh-token');
  mock.restoreAll();
});

test('getAdminToken: throws when token response omits access_token', async () => {
  mock.method(axios, 'post', async () => ({ data: { expires_in: 60 } }));
  const svc = new KeycloakClientService();
  (svc as any).accessToken = undefined;
  (svc as any).tokenExpiry = undefined;
  (svc as any).adminClient = {
    defaults: { baseURL: 'http://keycloak.test' },
    get: async () => ({ data: [] }),
  } as unknown as AxiosInstance;
  await assert.rejects(() => svc.clientExists('x'), /Failed to authenticate with Keycloak/);
  mock.restoreAll();
});

test('getAdminToken: wraps axios authentication failures', async () => {
  mock.method(axios, 'post', async () => {
    throw new Error('connection refused');
  });
  const svc = new KeycloakClientService();
  (svc as any).accessToken = undefined;
  (svc as any).tokenExpiry = undefined;
  (svc as any).adminClient = {
    defaults: { baseURL: 'http://keycloak.test' },
    get: async () => ({ data: [] }),
  } as unknown as AxiosInstance;
  await assert.rejects(() => svc.clientExists('x'), /connection refused/);
  mock.restoreAll();
});
