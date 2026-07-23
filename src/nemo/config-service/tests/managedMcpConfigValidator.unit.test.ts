/**
 * Unit tests for managed MCP catalog config validation.
 *
 * Run: node --require ts-node/register --test tests/managedMcpConfigValidator.unit.test.ts
 */
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';

function fetchHostname(url: string | URL): string {
  return new URL(String(url)).hostname;
}

let scope: ReturnType<typeof restoreScope>;
let fakeCredSvc: Record<string, any>;
let hadOriginalFetch: boolean;
let originalFetch: typeof fetch;

beforeEach(() => {
  scope = restoreScope();
  fakeCredSvc = {
    getById: async (_p: string, id: string) =>
      id === 'cred-azure'
        ? { id, provider: 'azure_cloud', name: 'Azure SP' }
        : id === 'cred-gcp'
          ? { id, provider: 'gcp', name: 'GCP SA' }
          : null,
    readSecretData: async (_p: string, id: string) =>
      id === 'cred-azure'
        ? { tenant_id: 'tenant-1', client_id: 'client-1', client_secret: 'secret-1' }
        : null,
  };
  scope.add(mockModule('services/CredentialService', { getCredentialService: () => fakeCredSvc }));
  hadOriginalFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
  originalFetch = global.fetch;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/managedMcpConfigValidator');
  if (hadOriginalFetch) {
    global.fetch = originalFetch;
  } else {
    delete (global as Record<string, unknown>).fetch;
  }
});

async function validate(input: Parameters<typeof import('../services/managedMcpConfigValidator').validateManagedMcpConfig>[1]) {
  const { validateManagedMcpConfig } = loadFresh<typeof import('../services/managedMcpConfigValidator')>(
    'services/managedMcpConfigValidator',
  );
  return validateManagedMcpConfig(PROJECT, input);
}

test('validateManagedMcpConfig: rejects unknown catalogId', async () => {
  const result = await validate({ catalogId: 'does_not_exist' });
  assert.equal(result.success, false);
  assert.match(result.message, /Unknown catalog ID/);
});

test('validateManagedMcpConfig: anf_mcp requires runtime credential', async () => {
  const result = await validate({
    catalogId: 'anf_mcp',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /runtimeCredentialId is required/);
});

test('validateManagedMcpConfig: credential provider mismatch', async () => {
  const result = await validate({
    catalogId: 'gcnv_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        GOOGLE_CLOUD_PROJECT: 'my-gcp',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /provider mismatch/);
});

test('validateManagedMcpConfig: missing runtime credential row', async () => {
  const result = await validate({
    catalogId: 'gcnv_mcp',
    runtimeCredentialId: 'missing-cred',
    managedConfig: {
      envOverrides: {
        GOOGLE_CLOUD_PROJECT: 'my-gcp',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /not found in project/);
});

test('validateManagedMcpConfig: schema validation for github_mcp', async () => {
  const missing = await validate({ catalogId: 'github_mcp', managedConfig: { envOverrides: {} } });
  assert.equal(missing.success, false);
  assert.match(missing.message, /GITHUB_PERSONAL_ACCESS_TOKEN is required/);

  const ok = await validate({
    catalogId: 'github_mcp',
    managedConfig: { envOverrides: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test' } },
  });
  assert.equal(ok.success, true);
  assert.equal(ok.status, 'connected');
});

test('validateManagedMcpConfig: filesystem_mcp passes with empty env schema', async () => {
  const result = await validate({ catalogId: 'filesystem_mcp', managedConfig: { envOverrides: {} } });
  assert.equal(result.success, true);
  assert.equal(result.message, 'Configuration validated');
});

test('validateManagedMcpConfig: anf_mcp verifies ARM account on success', async () => {
  global.fetch = (async (url: string | URL) => {
    const host = fetchHostname(url);
    if (host === 'login.microsoftonline.com') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) } as Response;
    }
    if (host === 'management.azure.com') {
      return { ok: true, status: 200, text: async () => '' } as Response;
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;

  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, true);
  assert.match(result.message, /ANF account verified/);
});

test('validateManagedMcpConfig: anf_mcp maps ARM 404 to friendly error', async () => {
  global.fetch = (async (url: string | URL) => {
    const host = fetchHostname(url);
    if (host === 'login.microsoftonline.com') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) } as Response;
    }
    if (host === 'management.azure.com') {
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;

  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'missing-anf',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /ANF account not found/);
});

test('validateManagedMcpConfig: anf_mcp rejects missing secret fields', async () => {
  fakeCredSvc.readSecretData = async () => ({ tenant_id: 't' });
  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /missing tenant_id, client_id, or client_secret/);
});

test('validateManagedMcpConfig: anf_mcp rejects missing AZURE_SUBSCRIPTION_ID', async () => {
  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: { AZURE_RESOURCE_GROUP: 'rg', ANF_ACCOUNT_NAME: 'anf' },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /AZURE_SUBSCRIPTION_ID is required/);
});

test('validateManagedMcpConfig: anf_mcp rejects missing runtime secret', async () => {
  fakeCredSvc.readSecretData = async () => null;
  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /secret not found/);
});

test('validateManagedMcpConfig: anf_mcp maps ARM 403 to access denied', async () => {
  global.fetch = (async (url: string | URL) => {
    const host = fetchHostname(url);
    if (host === 'login.microsoftonline.com') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) } as Response;
    }
    if (host === 'management.azure.com') {
      return { ok: false, status: 403, text: async () => 'forbidden' } as Response;
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;

  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /Access denied/);
});

test('validateManagedMcpConfig: anf_mcp maps generic ARM failure', async () => {
  global.fetch = (async (url: string | URL) => {
    const host = fetchHostname(url);
    if (host === 'login.microsoftonline.com') {
      return { ok: true, json: async () => ({ access_token: 'tok' }) } as Response;
    }
    if (host === 'management.azure.com') {
      return { ok: false, status: 500, text: async () => 'server error' } as Response;
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;

  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /HTTP 500/);
});

test('validateManagedMcpConfig: anf_mcp maps Azure auth invalid_client', async () => {
  global.fetch = (async (url: string | URL) => {
    const host = fetchHostname(url);
    if (host === 'login.microsoftonline.com') {
      return { ok: false, status: 401, text: async () => 'invalid_client' } as Response;
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;

  const result = await validate({
    catalogId: 'anf_mcp',
    runtimeCredentialId: 'cred-azure',
    managedConfig: {
      envOverrides: {
        AZURE_SUBSCRIPTION_ID: 'sub-1',
        AZURE_RESOURCE_GROUP: 'rg-1',
        ANF_ACCOUNT_NAME: 'anf-1',
      },
    },
  });
  assert.equal(result.success, false);
  assert.match(result.message, /Azure authentication failed/);
});

test('validateManagedMcpConfig: gcnv_mcp passes with valid credential', async () => {
  const result = await validate({
    catalogId: 'gcnv_mcp',
    runtimeCredentialId: 'cred-gcp',
    managedConfig: {
      envOverrides: {
        GOOGLE_CLOUD_PROJECT: 'my-gcp',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
      },
    },
  });
  assert.equal(result.success, true);
});
