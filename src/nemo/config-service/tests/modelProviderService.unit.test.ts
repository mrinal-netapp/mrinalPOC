/**
 * Unit tests for the Models > Providers overview filtering.
 *
 * Regression guard: data-source connector credentials (GCNV/GCP, ONTAP, S3,
 * ...) share the `credentials` table with LLM credentials but are never
 * registered on the Bifrost gateway, so they must NOT appear as model
 * providers. `selectOverviewProviderIds` is the pure seam behind
 * `listProjectProviders`.
 */
import 'reflect-metadata';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  providerDisplayName,
  selectOverviewProviderIds,
} from '../services/ModelProviderService';
import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/ModelProviderService');
  handle.restore();
});

async function loadModelProviderService() {
  return loadFresh<typeof import('../services/ModelProviderService')>('services/ModelProviderService');
}

test('providerDisplayName: known and unknown providers', () => {
  assert.equal(providerDisplayName('openai'), 'OpenAI');
  assert.equal(providerDisplayName('made_up'), 'made_up');
});

test('excludes a GCNV/GCP credential (stored as provider "gcp")', () => {
  const ids = selectOverviewProviderIds(['gcp', 'openai'], [], []);
  assert.deepEqual(ids, ['openai']);
});

test('excludes every data-source connector provider', () => {
  const ids = selectOverviewProviderIds(
    ['gcp', 'gcs', 's3', 'ontap', 'azure_cloud', 'postgresql', 'mysql', 'redash'],
    [],
    [],
  );
  assert.deepEqual(ids, []);
});

test('keeps LLM credential providers (configurable on Bifrost)', () => {
  const ids = selectOverviewProviderIds(
    ['openai', 'openai_compatible', 'aws_bedrock', 'azure', 'google', 'ollama'],
    [],
    [],
  );
  assert.deepEqual(ids, [
    'aws_bedrock',
    'azure',
    'google',
    'ollama',
    'openai',
    'openai_compatible',
  ]);
});

test('always includes providers wired into Bifrost (registered model or cache row)', () => {
  const ids = selectOverviewProviderIds([], ['azure'], ['openai']);
  assert.deepEqual(ids, ['azure', 'openai']);
});

test('drops unknown/custom credential provider strings', () => {
  const ids = selectOverviewProviderIds(['made_up_provider', 'openai'], [], []);
  assert.deepEqual(ids, ['openai']);
});

test('de-duplicates, trims and sorts', () => {
  const ids = selectOverviewProviderIds([' openai ', 'openai', 'gcp'], ['openai'], ['openai']);
  assert.deepEqual(ids, ['openai']);
});

test('ignores empty / whitespace-only ids', () => {
  const ids = selectOverviewProviderIds(['', '   '], ['', 'azure'], ['']);
  assert.deepEqual(ids, ['azure']);
});

test('listProjectProviders: merges credentials, models, and cache rows', async () => {
  handle.repos.Credential = makeFakeRepo({
    find: async () => [{ provider: 'openai' }, { provider: 'gcp' }],
  });
  handle.repos.Model = makeFakeRepo({
    find: async () => [{ provider: 'azure' }],
  });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [
      {
        projectId: PROJECT,
        providerId: 'openai',
        name: 'OpenAI',
        concurrency: 100,
        bufferSize: 200,
        connectionStatus: 'connected',
        statusMessage: null,
      },
    ],
    create: (d: any) => d,
  });

  const { listProjectProviders } = await loadModelProviderService();
  const rows = await listProjectProviders(PROJECT);
  const ids = rows.map((r) => r.providerId).sort();
  assert.deepEqual(ids, ['azure', 'openai']);
  const openai = rows.find((r) => r.providerId === 'openai');
  assert.equal(openai?.connectionStatus, 'connected');
  const azure = rows.find((r) => r.providerId === 'azure');
  assert.equal(azure?.connectionStatus, 'disconnected');
});

test('refreshProjectProvidersFromBifrost: persists connected health from Bifrost keys', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  const saved: any[] = [];
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => {
      const list = Array.isArray(rows) ? rows : [rows];
      saved.push(...list);
      return list;
    },
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({
        providers: [{ name: 'openai', keys: [{ status: 'success' }] }],
      }),
      listProviderKeys: async () => [{ status: 'success' }],
      mapLlmProviderToBifrost: (id: string) => id,
      updateProviderProxyOnGateway: async () => undefined,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'connected');
  assert.equal(saved.length, 1);
});

test('updateProviderProxyConfig: upserts cache and best-effort gateway push', async () => {
  handle.repos.ModelProvider = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ id: 'mp-1', ...d }),
    save: async (row: any) => row,
  });
  let gatewayUpdated = false;
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      updateProviderProxyOnGateway: async () => {
        gatewayUpdated = true;
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { updateProviderProxyConfig } = await loadModelProviderService();
  const row = await updateProviderProxyConfig(PROJECT, 'openai', 250, 900);
  assert.equal(row.concurrency, 250);
  assert.equal(row.bufferSize, 900);
  assert.equal(gatewayUpdated, true);
});

test('upsertProvider: updates existing cache row', async () => {
  const existing = {
    id: 'mp-1',
    projectId: PROJECT,
    providerId: 'azure',
    name: 'Azure OpenAI',
    concurrency: 1000,
    bufferSize: 5000,
    connectionStatus: 'degraded',
    statusMessage: 'partial',
  };
  handle.repos.ModelProvider = makeFakeRepo({
    findOne: async () => existing,
    save: async (row: any) => row,
  });

  const { upsertProvider } = await loadModelProviderService();
  const row = await upsertProvider({
    projectId: PROJECT,
    providerId: 'azure',
    name: 'Azure OpenAI',
    concurrency: 120,
    bufferSize: 480,
    connectionStatus: 'connected',
    statusMessage: null,
  });
  assert.equal(row.concurrency, 120);
  assert.equal(row.connectionStatus, 'connected');
});

test('listProjectProviders: credential-only provider shows no-models message', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
  });

  const { listProjectProviders } = await loadModelProviderService();
  const rows = await listProjectProviders(PROJECT);
  const openai = rows.find((r) => r.providerId === 'openai');
  assert.equal(openai?.statusMessage, 'No models registered yet');
  assert.equal(openai?.connectionStatus, 'disconnected');
});

test('refreshProjectProvidersFromBifrost: returns early when gateway disabled', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.ModelProvider = makeFakeRepo({ find: async () => [], create: (d: any) => d });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => false }) }));

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].connectionStatus, 'disconnected');
});

test('refreshProjectProvidersFromBifrost: returns rows when listGatewayProviders fails', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.ModelProvider = makeFakeRepo({ find: async () => [], create: (d: any) => d });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => {
        throw new Error('gateway down');
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'disconnected');
});

test('refreshProjectProvidersFromBifrost: degraded when keys partially healthy', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  const saved: any[] = [];
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => {
      const list = Array.isArray(rows) ? rows : [rows];
      saved.push(...list);
      return list;
    },
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({
        providers: [{ name: 'openai', keys: [{ status: 'success' }, { status: 'auth_failed' }] }],
      }),
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'degraded');
  assert.equal(rows[0].statusMessage, 'auth_failed');
});

test('refreshProjectProvidersFromBifrost: error when all keys unhealthy', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => (Array.isArray(rows) ? rows : [rows]),
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({
        providers: [{ name: 'openai', keys: [{ status: 'invalid_key' }] }],
      }),
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'error');
  assert.equal(rows[0].statusMessage, 'invalid_key');
});

test('refreshProjectProvidersFromBifrost: degraded when provider has no keys', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => (Array.isArray(rows) ? rows : [rows]),
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({ providers: [{ name: 'openai', keys: [] }] }),
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'degraded');
  assert.match(rows[0].statusMessage ?? '', /no keys configured/i);
});

test('refreshProjectProvidersFromBifrost: fetches keys when not embedded on provider', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  let keysFetched = false;
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => (Array.isArray(rows) ? rows : [rows]),
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({ providers: [{ name: 'openai' }] }),
      listProviderKeys: async () => {
        keysFetched = true;
        return [{ status: 'success' }];
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(keysFetched, true);
  assert.equal(rows[0].connectionStatus, 'connected');
});

test('refreshProjectProvidersFromBifrost: skips provider when listProviderKeys fails', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async () => [],
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({ providers: [{ name: 'openai' }] }),
      listProviderKeys: async () => {
        throw new Error('keys unavailable');
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'disconnected');
});

test('refreshProjectProvidersFromBifrost: returns empty list without gateway calls', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.ModelProvider = makeFakeRepo({ find: async () => [] });
  let gatewayCalled = false;
  scope.add(mockModule('services/gatewayClient', {
    getLLMGatewayClient: () => ({
      isEnabled: () => {
        gatewayCalled = true;
        return true;
      },
    }),
  }));

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.deepEqual(rows, []);
  assert.equal(gatewayCalled, false);
});

test('updateProviderProxyConfig: skips gateway push for openai_compatible', async () => {
  handle.repos.ModelProvider = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ id: 'mp-1', ...d }),
    save: async (row: any) => row,
  });
  let gatewayUpdated = false;
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      updateProviderProxyOnGateway: async () => {
        gatewayUpdated = true;
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { updateProviderProxyConfig } = await loadModelProviderService();
  await updateProviderProxyConfig(PROJECT, 'openai_compatible', 100, 200);
  assert.equal(gatewayUpdated, false);
});

test('updateProviderProxyConfig: persists cache when gateway push fails', async () => {
  handle.repos.ModelProvider = makeFakeRepo({
    findOne: async () => ({
      projectId: PROJECT,
      providerId: 'openai',
      name: 'OpenAI',
      concurrency: 1000,
      bufferSize: 5000,
      connectionStatus: 'connected',
      statusMessage: null,
    }),
    create: (d: any) => d,
    save: async (row: any) => row,
  });
  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      updateProviderProxyOnGateway: async () => {
        throw new Error('gateway push failed');
      },
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { updateProviderProxyConfig } = await loadModelProviderService();
  const row = await updateProviderProxyConfig(PROJECT, 'openai', 333, 444);
  assert.equal(row.concurrency, 333);
  assert.equal(row.bufferSize, 444);
});

test('upsertProvider: creates new row with defaults', async () => {
  handle.repos.ModelProvider = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => d,
    save: async (row: any) => row,
  });

  const { upsertProvider } = await loadModelProviderService();
  const row = await upsertProvider({
    projectId: PROJECT,
    providerId: 'cohere',
    name: 'Cohere',
    concurrency: 500,
    bufferSize: 1000,
  });
  assert.equal(row.connectionStatus, 'connected');
  assert.equal(row.statusMessage, null);
});

test('refreshProjectProvidersFromBifrost: treats blank key status as healthy', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [],
    create: (d: any) => d,
    save: async (rows: any) => (Array.isArray(rows) ? rows : [rows]),
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({
        providers: [{ name: 'openai', keys: [{ status: '' }] }],
      }),
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'connected');
});

test('refreshProjectProvidersFromBifrost: skips save when health is unchanged', async () => {
  handle.repos.Credential = makeFakeRepo({ find: async () => [] });
  handle.repos.Model = makeFakeRepo({ find: async () => [{ provider: 'openai' }] });
  let saveCalls = 0;
  handle.repos.ModelProvider = makeFakeRepo({
    find: async () => [
      {
        projectId: PROJECT,
        providerId: 'openai',
        name: 'OpenAI',
        concurrency: 1000,
        bufferSize: 5000,
        connectionStatus: 'connected',
        statusMessage: null,
      },
    ],
    create: (d: any) => d,
    save: async (rows: any) => {
      saveCalls += 1;
      return Array.isArray(rows) ? rows : [rows];
    },
  });

  scope.add(mockModule('services/gatewayClient', { getLLMGatewayClient: () => ({ isEnabled: () => true }) }));
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      listGatewayProviders: async () => ({
        providers: [{ name: 'openai', keys: [{ status: 'success' }] }],
      }),
      mapLlmProviderToBifrost: (id: string) => id,
    }),
  );

  const { refreshProjectProvidersFromBifrost } = await loadModelProviderService();
  const rows = await refreshProjectProvidersFromBifrost(PROJECT);
  assert.equal(rows[0].connectionStatus, 'connected');
  assert.equal(saveCalls, 0);
});
