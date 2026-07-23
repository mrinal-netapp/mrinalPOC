/**
 * Unit tests for services/K8sSecretService.ts.
 *
 * Run: node --require ts-node/register --test tests/K8sSecretService.unit.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';

let scope: ReturnType<typeof restoreScope>;
let apiCalls: Array<{ op: string; args: unknown }>;
let K8sSecretService: typeof import('../services/K8sSecretService').K8sSecretService;
let getK8sSecretService: typeof import('../services/K8sSecretService').getK8sSecretService;

function makeFakeCoreApi() {
  return {
    createNamespacedSecret: async (args: unknown) => {
      apiCalls.push({ op: 'create', args });
    },
    readNamespacedSecret: async () => ({
      data: { api_key: Buffer.from('secret-value', 'utf-8').toString('base64') },
    }),
    replaceNamespacedSecret: async (args: unknown) => {
      apiCalls.push({ op: 'replace', args });
    },
    deleteNamespacedSecret: async (args: unknown) => {
      apiCalls.push({ op: 'delete', args });
    },
  };
}

beforeEach(() => {
  scope = restoreScope();
  apiCalls = [];
  scope.add(
    mockModule('@kubernetes/client-node', {
      KubeConfig: class {
        loadFromFile() {}
        loadFromCluster() {}
        makeApiClient() {
          return makeFakeCoreApi();
        }
      },
      CoreV1Api: class {},
    }),
  );
  const mod = loadFresh<typeof import('../services/K8sSecretService')>('services/K8sSecretService');
  K8sSecretService = mod.K8sSecretService;
  getK8sSecretService = mod.getK8sSecretService;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/K8sSecretService', '@kubernetes/client-node');
});

test('createSecret: writes opaque secret with project labels', async () => {
  const svc = new K8sSecretService();
  await svc.createSecret(PROJECT, 'cred-secret', { api_key: 'sk-test' });
  assert.equal(apiCalls.length, 1);
  const body = (apiCalls[0].args as any).body;
  assert.equal(body.metadata.name, 'cred-secret');
  assert.equal(body.metadata.labels['agentstudio/project-id'], PROJECT);
  assert.equal(body.stringData.api_key, 'sk-test');
});

test('readSecret: decodes base64 secret data', async () => {
  const svc = new K8sSecretService();
  const data = await svc.readSecret('cred-secret');
  assert.equal(data.api_key, 'secret-value');
});

test('updateSecret: replaces secret payload', async () => {
  const svc = new K8sSecretService();
  await svc.updateSecret(PROJECT, 'cred-secret', { api_key: 'rotated' });
  assert.equal(apiCalls[0].op, 'replace');
  assert.equal((apiCalls[0].args as any).body.stringData.api_key, 'rotated');
});

test('deleteSecret: swallows 404', async () => {
  const svc = new K8sSecretService();
  let called = 0;
  (svc as any).coreApi.deleteNamespacedSecret = async () => {
    called += 1;
    const err: any = new Error('not found');
    err.code = 404;
    throw err;
  };
  // A 404 (already deleted) is attempted and swallowed, not rethrown.
  await assert.doesNotReject(() => svc.deleteSecret('missing'));
  assert.equal(called, 1);
});

test('deleteSecret: swallows 404 from response.status shape', async () => {
  const svc = new K8sSecretService();
  let called = 0;
  (svc as any).coreApi.deleteNamespacedSecret = async () => {
    called += 1;
    const err: any = new Error('not found');
    err.response = { status: 404 };
    throw err;
  };
  // Same benign-404 contract, but surfaced via `err.response.status`.
  await assert.doesNotReject(() => svc.deleteSecret('missing'));
  assert.equal(called, 1);
});

test('constructor: loads kubeconfig from file when KUBECONFIG is set', () => {
  const prev = process.env.KUBECONFIG;
  process.env.KUBECONFIG = '/tmp/fake-kubeconfig';
  let localScope: ReturnType<typeof restoreScope> | undefined;
  try {
    clearModule('services/K8sSecretService', '@kubernetes/client-node');
    let loadedFromFile = false;
    localScope = restoreScope();
    localScope.add(
      mockModule('@kubernetes/client-node', {
        KubeConfig: class {
          loadFromFile() {
            loadedFromFile = true;
          }
          loadFromCluster() {}
          makeApiClient() {
            return makeFakeCoreApi();
          }
        },
        CoreV1Api: class {},
      }),
    );
    const mod = loadFresh<typeof import('../services/K8sSecretService')>('services/K8sSecretService');
    // Instantiate directly so constructor runs against the fresh mock.
    new mod.K8sSecretService();
    assert.equal(loadedFromFile, true);
  } finally {
    localScope?.restoreAll();
    if (prev === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = prev;
    clearModule('services/K8sSecretService', '@kubernetes/client-node');
  }
});

test('deleteSecret: rethrows non-404 errors', async () => {
  const svc = new K8sSecretService();
  (svc as any).coreApi.deleteNamespacedSecret = async () => {
    throw new Error('forbidden');
  };
  await assert.rejects(() => svc.deleteSecret('cred-secret'), /forbidden/);
});

test('getK8sSecretService: returns singleton', () => {
  assert.equal(getK8sSecretService(), getK8sSecretService());
});
