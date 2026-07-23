/**
 * Unit tests for MCPRuntimeManager class methods (K8s API mocked).
 *
 * Run: node --require ts-node/register --test tests/MCPRuntimeManager.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, makeFakeRepo, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import {
  runtimeCredSecretName,
  parseEgressPortsFromUrl,
  mergeManagedAllowedToolsEnv,
  checksumSecretData,
} from '../services/MCPRuntimeManager';

let scope: ReturnType<typeof restoreScope>;
let deleteCalls: string[];
let handle: FakeDataSourceHandle | undefined;
let MCPRuntimeManager: typeof import('../services/MCPRuntimeManager').MCPRuntimeManager;

function makeManager() {
  const mgr = new MCPRuntimeManager();
  deleteCalls = [];
  (mgr as any).appsApi = {
    deleteNamespacedDeployment: async ({ name }: { name: string }) => {
      deleteCalls.push(`deployment:${name}`);
    },
    listNamespacedDeployment: async () => ({ items: [] }),
    patchNamespacedDeployment: async () => ({}),
  };
  (mgr as any).coreApi = {
    deleteNamespacedService: async ({ name }: { name: string }) => {
      deleteCalls.push(`service:${name}`);
    },
    deleteNamespacedSecret: async ({ name }: { name: string }) => {
      deleteCalls.push(`secret:${name}`);
    },
    deleteNamespacedServiceAccount: async ({ name }: { name: string }) => {
      deleteCalls.push(`sa:${name}`);
    },
    listNamespacedPod: async () => ({
      items: [
        {
          status: {
            phase: 'Running',
            containerStatuses: [
              {
                ready: true,
                restartCount: 1,
                state: { waiting: { reason: 'ContainerCreating' } },
              },
            ],
          },
        },
      ],
    }),
  };
  (mgr as any).networkingApi = {
    deleteNamespacedNetworkPolicy: async ({ name }: { name: string }) => {
      deleteCalls.push(`netpol:${name}`);
    },
  };
  (mgr as any).rbacApi = {
    deleteClusterRoleBinding: async ({ name }: { name: string }) => {
      deleteCalls.push(`crb:${name}`);
    },
  };
  return mgr;
}

beforeEach(() => {
  scope = restoreScope();
  scope.add(
    mockModule('@kubernetes/client-node', {
      KubeConfig: class {
        loadFromFile() {}
        loadFromCluster() {}
        makeApiClient() {
          return {};
        }
      },
      AppsV1Api: class {},
      CoreV1Api: class {},
      NetworkingV1Api: class {},
      RbacAuthorizationV1Api: class {},
    }),
  );
  MCPRuntimeManager = loadFresh<typeof import('../services/MCPRuntimeManager')>(
    'services/MCPRuntimeManager',
  ).MCPRuntimeManager;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/MCPRuntimeManager', '@kubernetes/client-node');
});

test('deprovision: deletes deployment, service, netpol, and secrets', async () => {
  const mgr = makeManager();
  await mgr.deprovision({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    catalogId: 'ontap_mcp',
  } as any);
  assert.ok(deleteCalls.includes('deployment:mcp-srv-1'));
  assert.ok(deleteCalls.includes('service:mcp-srv-1'));
  assert.ok(deleteCalls.includes('netpol:mcp-srv-1'));
  assert.ok(deleteCalls.includes('secret:mcp-srv-1-env'));
  assert.ok(deleteCalls.includes(`secret:${runtimeCredSecretName('srv-1')}`));
  assert.ok(deleteCalls.includes('sa:mcp-srv-1-sa'));
  assert.ok(deleteCalls.includes('crb:mcp-srv-1-crb'));
});

test('deprovision: no-op without k8sResourceName', async () => {
  const mgr = makeManager();
  await mgr.deprovision({ id: 'srv-1', projectId: 'proj1' } as any);
  assert.deepEqual(deleteCalls, []);
});

test('getStatus: returns unknown when runtime not provisioned', async () => {
  const mgr = makeManager();
  const status = await mgr.getStatus({ id: 'srv-1', projectId: 'proj1' } as any);
  assert.equal(status.runtimeStatus, 'unknown');
  assert.equal(status.ready, false);
});

test('getStatus: inspects pod readiness', async () => {
  const mgr = makeManager();
  const status = await mgr.getStatus({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    runtimeStatus: 'running',
  } as any);
  assert.equal(status.runtimeStatus, 'running');
  assert.equal(status.phase, 'Running');
  assert.equal(status.ready, true);
  assert.equal(status.restartCount, 1);
  assert.equal(status.message, 'ContainerCreating');
});

test('getStatus: handles empty pod list', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.listNamespacedPod = async () => ({ items: [] });
  const status = await mgr.getStatus({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    runtimeStatus: 'provisioning',
  } as any);
  assert.equal(status.message, 'No pods found');
  assert.equal(status.ready, false);
});

test('syncRuntimeSecret: no-op without credential mapping prerequisites', async () => {
  const mgr = makeManager();
  await mgr.syncRuntimeSecret(
    { id: 'srv-1', projectId: 'proj1', k8sResourceName: 'mcp-srv-1' } as any,
    { id: 'catalog-1' } as any,
  );
  assert.deepEqual(deleteCalls, []);
});

test('reconcileOrphans: deletes deployments missing from DB', async () => {
  const mgr = makeManager();
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      find: async () => [{ id: 'srv-known', deploymentType: 'managed', runtimeStatus: 'running', k8sResourceName: 'mcp-known' }],
      update: async () => ({ affected: 1 }),
    }),
  });
  (mgr as any).appsApi.listNamespacedDeployment = async () => ({
    items: [
      {
        metadata: {
          name: 'mcp-orphan',
          labels: { 'mcp-server-id': 'srv-orphan' },
        },
      },
      {
        metadata: {
          name: 'mcp-known',
          labels: { 'mcp-server-id': 'srv-known' },
        },
      },
    ],
  });
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  const freshMgr = loadFresh<typeof import('../services/MCPRuntimeManager')>(
    'services/MCPRuntimeManager',
  ).MCPRuntimeManager;
  const reconciler = new freshMgr();
  deleteCalls = [];
  (reconciler as any).appsApi = (mgr as any).appsApi;
  (reconciler as any).coreApi = (mgr as any).coreApi;
  (reconciler as any).networkingApi = (mgr as any).networkingApi;
  (reconciler as any).rbacApi = (mgr as any).rbacApi;

  await reconciler.reconcileOrphans();
  assert.ok(deleteCalls.includes('deployment:mcp-orphan'));
  assert.ok(!deleteCalls.includes('deployment:mcp-known'));
  handle?.restore();
  handle = undefined;
});

test('patchConfig: replaces secret and patches deployment env', async () => {
  const mgr = makeManager();
  let secretReplaced = false;
  let deploymentPatched = false;
  (mgr as any).coreApi.replaceNamespacedSecret = async () => {
    secretReplaced = true;
  };
  (mgr as any).appsApi.patchNamespacedDeployment = async () => {
    deploymentPatched = true;
  };
  await mgr.patchConfig(
    {
      id: 'srv-1',
      projectId: 'proj1',
      k8sResourceName: 'mcp-srv-1',
      managedConfig: { resourcePreset: 'small' },
    } as any,
    { resourcePreset: 'small', image: 'mcp:latest' } as any,
    { API_KEY: 'secret-val' },
    { LOG_LEVEL: 'debug' },
  );
  assert.equal(secretReplaced, true);
  assert.equal(deploymentPatched, true);
});

test('patchConfig: creates secret when replace returns 404', async () => {
  const mgr = makeManager();
  let secretCreated = false;
  (mgr as any).coreApi.replaceNamespacedSecret = async () => {
    const err: any = new Error('not found');
    err.response = { status: 404 };
    throw err;
  };
  (mgr as any).coreApi.createNamespacedSecret = async () => {
    secretCreated = true;
  };
  (mgr as any).appsApi.patchNamespacedDeployment = async () => ({});
  await mgr.patchConfig(
    {
      id: 'srv-1',
      projectId: 'proj1',
      k8sResourceName: 'mcp-srv-1',
      managedConfig: { resourcePreset: 'small' },
    } as any,
    { resourcePreset: 'small', image: 'mcp:latest' } as any,
    { TOKEN: 't1' },
    {},
  );
  assert.equal(secretCreated, true);
});

test('getStatus: reports terminated container reason', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.listNamespacedPod = async () => ({
    items: [
      {
        status: {
          phase: 'Failed',
          containerStatuses: [
            {
              ready: false,
              restartCount: 3,
              state: { terminated: { reason: 'Error', message: 'exit 1' } },
            },
          ],
        },
      },
    ],
  });
  const status = await mgr.getStatus({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    runtimeStatus: 'error',
  } as any);
  assert.equal(status.message, 'Error');
  assert.equal(status.ready, false);
  assert.equal(status.restartCount, 3);
});

test('getStatus: returns error message when pod list fails', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.listNamespacedPod = async () => {
    throw new Error('k8s unavailable');
  };
  const status = await mgr.getStatus({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    runtimeStatus: 'running',
  } as any);
  assert.equal(status.message, 'k8s unavailable');
  assert.equal(status.ready, false);
});

test('reconcileOrphans: removes stale gateway MCP servers and marks desynced DB rows pending', async () => {
  const removed: string[] = [];
  let updated: any = null;
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      find: async () => [
        {
          id: 'srv-known',
          deploymentType: 'managed',
          runtimeStatus: 'running',
          k8sResourceName: 'mcp-known',
          name: 'known',
          projectId: 'proj1',
          llmproxyGatewayServerName: 'proj1_known',
          llmproxyGatewayServerId: 'gw-canonical',
          syncStatus: 'synced',
        },
        {
          id: 'srv-desync',
          deploymentType: 'remote',
          name: 'desync',
          projectId: 'proj1',
          llmproxyGatewayServerName: 'proj1_desync',
          llmproxyGatewayServerId: 'gw-missing',
          syncStatus: 'synced',
        },
      ],
      update: async (id: string, patch: Record<string, unknown>) => {
        updated = { id, patch };
        return { affected: 1 };
      },
    }),
  });

  scope.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({
        isEnabled: () => true,
        listMCPServers: async () => [
          { server_id: 'gw-stale', server_name: 'proj1_stale' },
          { server_id: 'gw-canonical', server_name: 'proj1_known' },
          { server_id: 'gw-dup', server_name: 'proj1_known' },
        ],
        removeMCPServer: async (id: string) => {
          removed.push(id);
        },
      }),
    }),
  );

  const freshMgr = loadFresh<typeof import('../services/MCPRuntimeManager')>(
    'services/MCPRuntimeManager',
  ).MCPRuntimeManager;
  const reconciler = new freshMgr();
  (reconciler as any).appsApi = {
    listNamespacedDeployment: async () => ({ items: [] }),
  };

  await reconciler.reconcileOrphans();

  assert.ok(removed.includes('gw-stale'));
  assert.ok(removed.includes('gw-dup'));
  assert.equal(updated?.id, 'srv-desync');
  assert.equal(updated?.patch.syncStatus, 'pending');
  handle?.restore();
  handle = undefined;
});

test('deprovision: logs non-404 errors from auxiliary deletes', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.deleteNamespacedSecret = async () => {
    throw new Error('secret delete failed');
  };
  (mgr as any).coreApi.deleteNamespacedServiceAccount = async () => {
    throw new Error('sa delete failed');
  };
  (mgr as any).rbacApi.deleteClusterRoleBinding = async () => {
    throw new Error('crb delete failed');
  };
  await mgr.deprovision({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    catalogId: 'ontap_mcp',
  } as any);
  assert.ok(deleteCalls.includes('deployment:mcp-srv-1'));
});

test('getMCPRuntimeManager: returns singleton instance', async () => {
  const mod = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager');
  const a = mod.getMCPRuntimeManager();
  const b = mod.getMCPRuntimeManager();
  assert.equal(a, b);
});

test('delete helpers: log and swallow non-404 K8s delete failures', async () => {
  const mgr = makeManager();
  let failCalls = 0;
  const fail = async () => {
    failCalls += 1;
    const err: any = new Error('delete failed');
    err.statusCode = 500;
    throw err;
  };
  (mgr as any).appsApi.deleteNamespacedDeployment = fail;
  (mgr as any).coreApi.deleteNamespacedService = fail;
  (mgr as any).networkingApi.deleteNamespacedNetworkPolicy = fail;

  // Each helper must swallow the non-404 failure (log and continue) rather
  // than rejecting, so all three awaits resolve and every path is exercised.
  await assert.doesNotReject((mgr as any).deleteDeployment('mcp-a'));
  await assert.doesNotReject((mgr as any).deleteService('mcp-a'));
  await assert.doesNotReject((mgr as any).deleteNetworkPolicy('mcp-a'));
  assert.equal(failCalls, 3);
});

test('pollReadiness: returns true when deployment has ready replicas', async () => {
  const mgr = makeManager();
  (mgr as any).appsApi.readNamespacedDeployment = async () => ({
    status: { readyReplicas: 1 },
  });
  const ready = await (mgr as any).pollReadiness('mcp-ready');
  assert.equal(ready, true);
});

test('pollReadiness: tolerates missing deployment while polling', async () => {
  const mgr = makeManager();
  let calls = 0;
  (mgr as any).appsApi.readNamespacedDeployment = async () => {
    calls += 1;
    if (calls < 2) {
      throw new Error('not found yet');
    }
    return { status: { readyReplicas: 1 } };
  };
  const ready = await (mgr as any).pollReadiness('mcp-warmup');
  assert.equal(ready, true);
  assert.ok(calls >= 2);
});

test('pollReadiness: returns false when readiness deadline expires', async () => {
  const mgr = makeManager();
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  (mgr as any).appsApi.readNamespacedDeployment = async () => {
    now += 130_000;
    return { status: { readyReplicas: 0 } };
  };
  try {
    const ready = await (mgr as any).pollReadiness('mcp-timeout');
    assert.equal(ready, false);
  } finally {
    Date.now = realNow;
  }
});

test('materializeRuntimeCredential: creates secret from credential mapping', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ API_TOKEN: 'secret-token', IGNORED: 'x' }),
      }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );

  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  let createdSecret: Record<string, unknown> | undefined;
  (mgr as any).coreApi = {
    replaceNamespacedSecret: async () => {
      const err: any = new Error('not found');
      err.statusCode = 404;
      throw err;
    },
    createNamespacedSecret: async (req: { body: Record<string, unknown> }) => {
      createdSecret = req.body;
    },
  };

  const out = await (mgr as any).materializeRuntimeCredential(
    'srv-1',
    'proj1',
    'mcp-srv-1',
    { 'mcp-server-id': 'srv-1' },
    {
      envFromKeys: { API_TOKEN: 'API_TOKEN' },
      fileFromKeys: {},
    },
    'cred-1',
  );

  assert.ok(out?.secretName);
  assert.equal((createdSecret as any)?.stringData?.API_TOKEN, 'secret-token');
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('materializeRuntimeCredential: returns undefined when no mapped keys match', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ OTHER: 'value' }),
      }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  const out = await (mgr as any).materializeRuntimeCredential(
    'srv-1',
    'proj1',
    'mcp-srv-1',
    { 'mcp-server-id': 'srv-1' },
    { envFromKeys: { API_TOKEN: 'API_TOKEN' }, fileFromKeys: {} },
    'cred-1',
  );
  assert.equal(out, undefined);
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('materializeRuntimeCredential: uses replace path when secret already exists', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ API_TOKEN: 'secret-token' }),
      }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  let replaced = false;
  (mgr as any).coreApi = {
    replaceNamespacedSecret: async () => {
      replaced = true;
    },
    createNamespacedSecret: async () => {
      throw new Error('should not create');
    },
  };
  const out = await (mgr as any).materializeRuntimeCredential(
    'srv-1',
    'proj1',
    'mcp-srv-1',
    { 'mcp-server-id': 'srv-1' },
    { envFromKeys: { API_TOKEN: 'API_TOKEN' }, fileFromKeys: {} },
    'cred-1',
  );
  assert.equal(replaced, true);
  assert.ok(out?.checksum);
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('materializeRuntimeCredential: rethrows non-404 replace failures', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ API_TOKEN: 'secret-token' }),
      }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  (mgr as any).coreApi = {
    replaceNamespacedSecret: async () => {
      const err: any = new Error('replace failed');
      err.statusCode = 500;
      throw err;
    },
  };
  await assert.rejects(
    () =>
      (mgr as any).materializeRuntimeCredential(
        'srv-1',
        'proj1',
        'mcp-srv-1',
        { 'mcp-server-id': 'srv-1' },
        { envFromKeys: { API_TOKEN: 'API_TOKEN' }, fileFromKeys: {} },
        'cred-1',
      ),
    /replace failed/,
  );
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('attachOwnerRefToSecret: patches secret when deployment has uid', async () => {
  const mgr = makeManager();
  let patched = false;
  (mgr as any).appsApi.readNamespacedDeployment = async () => ({
    metadata: { uid: 'dep-uid-1' },
  });
  (mgr as any).coreApi.patchNamespacedSecret = async () => {
    patched = true;
  };
  await (mgr as any).attachOwnerRefToSecret('mcp-runtime-cred-srv-1', 'mcp-srv-1');
  assert.equal(patched, true);
});

test('attachOwnerRefToSecret: no-op when deployment uid is missing', async () => {
  const mgr = makeManager();
  let patched = false;
  (mgr as any).appsApi.readNamespacedDeployment = async () => ({ metadata: {} });
  (mgr as any).coreApi.patchNamespacedSecret = async () => {
    patched = true;
  };
  await (mgr as any).attachOwnerRefToSecret('mcp-runtime-cred-srv-1', 'mcp-srv-1');
  assert.equal(patched, false);
});

test('createServiceAccountAndRBAC: creates SA and cluster role binding', async () => {
  const mgr = makeManager();
  let saCreated = false;
  let crbCreated = false;
  (mgr as any).coreApi.createNamespacedServiceAccount = async () => {
    saCreated = true;
  };
  (mgr as any).rbacApi.createClusterRoleBinding = async () => {
    crbCreated = true;
  };
  const { getCatalogEntry } = await import('../catalog/mcpServerCatalog');
  const catalog = getCatalogEntry('kubernetes_mcp')!;
  await (mgr as any).createServiceAccountAndRBAC('mcp-srv-1', 'mcp-srv-1-sa', { 'mcp-server-id': 'srv-1' }, catalog);
  assert.equal(saCreated, true);
  assert.equal(crbCreated, true);
});

test('createServiceAccountAndRBAC: skips binding when clusterRoleName is missing', async () => {
  const mgr = makeManager();
  let crbCreated = false;
  (mgr as any).coreApi.createNamespacedServiceAccount = async () => undefined;
  (mgr as any).rbacApi.createClusterRoleBinding = async () => {
    crbCreated = true;
  };
  await (mgr as any).createServiceAccountAndRBAC(
    'mcp-srv-1',
    'mcp-srv-1-sa',
    { 'mcp-server-id': 'srv-1' },
    { id: 'custom', requiresRBAC: true } as any,
  );
  assert.equal(crbCreated, false);
});

test('parseEgressPortsFromUrl: parses http/https ports and fallbacks', () => {
  assert.deepEqual(parseEgressPortsFromUrl(undefined), [443, 8443]);
  assert.deepEqual(parseEgressPortsFromUrl('http://lab-cluster:8080'), [8080]);
  assert.deepEqual(parseEgressPortsFromUrl('https://cluster.example.com'), [443]);
  assert.deepEqual(parseEgressPortsFromUrl('https://cluster.example.com:8443/api'), [8443]);
  assert.deepEqual(parseEgressPortsFromUrl('not-a-url'), [443, 8443]);
  assert.deepEqual(parseEgressPortsFromUrl('http://bad:0'), [443, 8443]);
});

test('mergeManagedAllowedToolsEnv: maps allowedTools per catalog id', () => {
  assert.deepEqual(
    mergeManagedAllowedToolsEnv('anf_mcp', { BASE: '1' }, ['list_volumes']),
    { BASE: '1', ANF_ALLOWED_TOOLS: 'list_volumes' },
  );
  assert.deepEqual(
    mergeManagedAllowedToolsEnv('ontap_mcp', {}, ['list_pods', 'get_volume']),
    { ONTAP_ALLOWED_TOOLS: 'list_pods,get_volume' },
  );
  assert.deepEqual(mergeManagedAllowedToolsEnv('prometheus_mcp', { X: 'y' }, []), { X: 'y' });
  assert.deepEqual(mergeManagedAllowedToolsEnv('prometheus_mcp', { X: 'y' }, undefined), { X: 'y' });
});

test('checksumSecretData: is stable and order-independent', () => {
  const a = checksumSecretData({ b: '2', a: '1' });
  const b = checksumSecretData({ a: '1', b: '2' });
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{16}$/);
});

test('materializeRuntimeCredential: returns undefined when credential read fails', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => {
          throw new Error('vault unavailable');
        },
      }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  const out = await (mgr as any).materializeRuntimeCredential(
    'srv-1',
    'proj1',
    'mcp-srv-1',
    { 'mcp-server-id': 'srv-1' },
    { envFromKeys: { API_TOKEN: 'API_TOKEN' }, fileFromKeys: {} },
    'cred-1',
  );
  assert.equal(out, undefined);
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('patchConfig: rethrows non-404 secret replace failures', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.replaceNamespacedSecret = async () => {
    const err: any = new Error('forbidden');
    err.statusCode = 403;
    throw err;
  };
  await assert.rejects(
    () =>
      mgr.patchConfig(
        {
          id: 'srv-1',
          projectId: 'proj1',
          k8sResourceName: 'mcp-srv-1',
          managedConfig: { resourcePreset: 'small' },
        } as any,
        { resourcePreset: 'small', image: 'mcp:latest' } as any,
        { TOKEN: 't1' },
        {},
      ),
    /forbidden/,
  );
});

test('syncRuntimeSecret: patches deployment checksum after credential rotation', async () => {
  scope.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ username: 'admin', password: 'secret' }),
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  let patched = false;
  (mgr as any).coreApi = {
    replaceNamespacedSecret: async () => undefined,
    createNamespacedSecret: async () => undefined,
  };
  (mgr as any).appsApi = {
    patchNamespacedDeployment: async () => {
      patched = true;
    },
  };
  const { getCatalogEntry } = await import('../catalog/mcpServerCatalog');
  const catalog = getCatalogEntry('Ontap_mcp_logs');
  assert.ok(catalog?.credentialMapping);
  await mgr.syncRuntimeSecret(
    {
      id: 'srv-1',
      projectId: 'proj1',
      k8sResourceName: 'mcp-srv-1',
      runtimeCredentialId: 'cred-1',
    } as any,
    catalog!,
  );
  assert.equal(patched, true);
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
});

test('reconcileOrphans: marks stuck provisioning rows failed when deployment missing', async () => {
  let updated: any = null;
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      find: async () => [
        {
          id: 'srv-stuck',
          deploymentType: 'managed',
          runtimeStatus: 'provisioning',
          k8sResourceName: 'mcp-stuck',
        },
      ],
      update: async (_id: string, patch: Record<string, unknown>) => {
        updated = patch;
        return { affected: 1 };
      },
    }),
  });
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  const freshMgr = loadFresh<typeof import('../services/MCPRuntimeManager')>(
    'services/MCPRuntimeManager',
  ).MCPRuntimeManager;
  const reconciler = new freshMgr();
  (reconciler as any).appsApi = {
    listNamespacedDeployment: async () => ({ items: [] }),
  };

  await reconciler.reconcileOrphans();
  assert.equal(updated?.runtimeStatus, 'failed');
  handle.restore();
  handle = undefined;
});

test('getStatus: prefers terminated message when reason absent', async () => {
  const mgr = makeManager();
  (mgr as any).coreApi.listNamespacedPod = async () => ({
    items: [
      {
        status: {
          phase: 'Failed',
          containerStatuses: [
            {
              ready: false,
              restartCount: 1,
              state: { terminated: { message: 'OOMKilled details' } },
            },
          ],
        },
      },
    ],
  });
  const status = await mgr.getStatus({
    id: 'srv-1',
    projectId: 'proj1',
    k8sResourceName: 'mcp-srv-1',
    runtimeStatus: 'error',
  } as any);
  assert.equal(status.message, 'OOMKilled details');
});

test('doProvision: provisions official ONTAP MCP with init container and file mounts', async (t) => {
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      findOneBy: async () => ({ id: 'srv-ontap', allowedTools: ['list_ontap_endpoints'] }),
      update: async () => ({ affected: 1 }),
    }),
  });
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({
          username: 'admin',
          password: 'secret',
          client_cert_pem: 'cert',
          client_key_pem: 'key',
          ca_bundle_pem: 'ca',
        }),
      }),
    }),
  );
  scope2.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  scope2.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  let deploymentBody: any = null;
  let netpolBody: any = null;
  (mgr as any).coreApi = {
    replaceNamespacedSecret: async () => undefined,
    createNamespacedSecret: async () => undefined,
    createNamespacedService: async () => undefined,
  };
  (mgr as any).networkingApi = {
    createNamespacedNetworkPolicy: async (req: { body: unknown }) => {
      netpolBody = req.body;
    },
  };
  (mgr as any).appsApi = {
    createNamespacedDeployment: async (req: { body: unknown }) => {
      deploymentBody = req.body;
    },
    readNamespacedDeployment: async () => ({ status: { readyReplicas: 1 }, metadata: { uid: 'uid-1' } }),
    patchNamespacedDeployment: async () => undefined,
  };

  const { getCatalogEntry } = await import('../catalog/mcpServerCatalog');
  await (mgr as any).doProvision(
    'srv-ontap',
    'proj1',
    'ontap-official',
    'mcp-srv-ontap',
    getCatalogEntry('ontap_mcp_official')!,
    {},
    { ONTAP_URL: 'https://ontap.example.com:8443', ONTAP_VERIFY_TLS: 'false' },
    'cred-ontap',
  );

  const initContainers = deploymentBody?.spec?.template?.spec?.initContainers ?? [];
  assert.ok(initContainers.some((c: any) => c.name === 'write-ontap-config'));
  const egressPorts = (netpolBody?.spec?.egress ?? []).flatMap((r: any) => r.ports?.map((p: any) => p.port) ?? []);
  assert.ok(egressPorts.includes(8443));
  clearModule('services/MCPRuntimeManager', 'services/CredentialService');
  handle.restore();
  handle = undefined;
});

test('doProvision: provisions kubernetes MCP with RBAC resources', async () => {
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      findOneBy: async () => ({ id: 'srv-k8s', allowedTools: ['list_pods'] }),
      update: async () => ({ affected: 1 }),
    }),
  });
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  const calls: string[] = [];
  (mgr as any).coreApi = {
    createNamespacedSecret: async () => calls.push('secret'),
    createNamespacedService: async () => calls.push('service'),
    createNamespacedServiceAccount: async () => calls.push('sa'),
  };
  (mgr as any).networkingApi = {
    createNamespacedNetworkPolicy: async () => calls.push('netpol'),
  };
  (mgr as any).appsApi = {
    createNamespacedDeployment: async () => calls.push('deployment'),
    readNamespacedDeployment: async () => ({ status: { readyReplicas: 1 }, metadata: { uid: 'uid-1' } }),
  };
  (mgr as any).rbacApi = {
    createClusterRoleBinding: async () => calls.push('crb'),
  };

  const { getCatalogEntry } = await import('../catalog/mcpServerCatalog');
  await (mgr as any).doProvision(
    'srv-k8s',
    'proj1',
    'k8s',
    'mcp-srv-k8s',
    getCatalogEntry('kubernetes_mcp')!,
    {},
    {},
    undefined,
  );

  assert.ok(calls.includes('sa'));
  assert.ok(calls.includes('crb'));
  assert.ok(calls.includes('deployment'));
  handle.restore();
  handle = undefined;
});

test('doProvision: adds catalog volumeMounts and network-access egress rules', async () => {
  handle = installFakeRepositories({
    MCPServer: makeFakeRepo({
      findOneBy: async () => ({ id: 'srv-vol', allowedTools: ['list_pods'] }),
      update: async () => ({ affected: 1 }),
    }),
  });
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  const Mgr = loadFresh<typeof import('../services/MCPRuntimeManager')>('services/MCPRuntimeManager').MCPRuntimeManager;
  const mgr = new Mgr();
  let deploymentBody: any = null;
  let netpolBody: any = null;
  (mgr as any).coreApi = {
    createNamespacedSecret: async () => undefined,
    createNamespacedService: async () => undefined,
  };
  (mgr as any).networkingApi = {
    createNamespacedNetworkPolicy: async (req: { body: unknown }) => {
      netpolBody = req.body;
    },
  };
  (mgr as any).appsApi = {
    createNamespacedDeployment: async (req: { body: unknown }) => {
      deploymentBody = req.body;
    },
    readNamespacedDeployment: async () => ({ status: { readyReplicas: 1 }, metadata: { uid: 'uid-1' } }),
  };

  const { getCatalogEntry } = await import('../catalog/mcpServerCatalog');
  const catalog = getCatalogEntry('prometheus_mcp')!;
  await (mgr as any).doProvision(
    'srv-vol',
    'proj1',
    'prometheus',
    'mcp-srv-vol',
    { ...catalog, volumeMounts: [{ mountPath: '/data' }], egressPorts: [9090] },
    {},
    { PROMETHEUS_URL: 'http://prom.example.com:9090' },
    undefined,
  );

  const volumes = deploymentBody?.spec?.template?.spec?.volumes ?? [];
  assert.ok(volumes.some((v: any) => v.name === 'data'));
  const egressPorts = (netpolBody?.spec?.egress ?? []).flatMap((r: any) => r.ports?.map((p: any) => p.port) ?? []);
  assert.ok(egressPorts.includes(9090));
  assert.ok(egressPorts.includes(443));
  handle.restore();
  handle = undefined;
});
