/**
 * Branch-coverage tests for services/BifrostGatewayClient.ts error paths and
 * conditional helpers not covered by BifrostGatewayClient.unit.test.ts.
 *
 * Run: node --require ts-node/register --test tests/BifrostGatewayClient.branches.unit.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { clearModule, loadFresh, mockModule, restoreScope } from './helpers/moduleMock';

const ORIGINAL_URL = process.env.LLM_GATEWAY_URL;
const ORIGINAL_KEY = process.env.LLM_GATEWAY_API_KEY;
const ORIGINAL_DEBUG = process.env.DEBUG;

type BifrostGatewayClientCtor = typeof import('../services/BifrostGatewayClient').BifrostGatewayClient;
let BifrostGatewayClient: BifrostGatewayClientCtor;

function reloadGatewayModule(): void {
  clearModule('services/BifrostGatewayClient', 'services/gatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;
}

function gatewayWith(
  handlers: Partial<Record<'get' | 'post' | 'put' | 'delete', (url: string, body?: unknown, config?: unknown) => Promise<any>>>,
): InstanceType<BifrostGatewayClientCtor> {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = true;
  (gw as any).client = {
    get: async (url: string) => handlers.get?.(url) ?? { data: {} },
    post: async (url: string, body?: unknown, config?: unknown) => handlers.post?.(url, body, config) ?? { data: {} },
    put: async (url: string, body?: unknown) => handlers.put?.(url, body) ?? { data: {} },
    delete: async (url: string) => handlers.delete?.(url) ?? { data: {} },
  } as AxiosInstance;
  return gw;
}

const MCP_ROW = {
  config: { id: 'mc-1', name: 'srv_a' },
  connection_type: 'sse',
  auth_type: 'none',
  state: 'connected',
  tools: [{ name: 'tool_a', description: 'A tool' }],
};

function installBifrostMocks(
  scope: ReturnType<typeof restoreScope>,
  overrides?: Record<string, unknown> | { providerOps?: Record<string, unknown>; governance?: Record<string, unknown> },
): void {
  const govKeys = new Set([
    'ensureProjectGateway',
    'assignModelToProjectVirtualKey',
    'assignModelGovernance',
    'unassignModelFromProjectVirtualKey',
    'removeModelGovernance',
    'appendMcpClientToProjectVirtualKey',
    'removeMcpClientFromProjectVirtualKey',
    'readProjectVirtualKeyToken',
    'resolveProjectVirtualKeyId',
  ]);
  const flat = overrides && ('providerOps' in overrides || 'governance' in overrides)
    ? null
    : (overrides as Record<string, unknown> | undefined);
  const providerOps = flat
    ? Object.fromEntries(Object.entries(flat).filter(([k]) => !govKeys.has(k)))
    : (overrides as { providerOps?: Record<string, unknown> })?.providerOps;
  const governance = flat
    ? Object.fromEntries(Object.entries(flat).filter(([k]) => govKeys.has(k)))
    : (overrides as { governance?: Record<string, unknown> })?.governance;

  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'key-1', keyId: undefined }),
      appendBuiltinProviderKey: async () => ({ providerName: 'as-tei-x', keyName: 'k', keyId: 'kid' }),
      buildBuiltinGatewayBindingName: (m: string) => m.replace(/\//g, '__'),
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [{ id: 'recovered-kid', name: 'key-1', models: ['binding-1'] }],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => undefined,
      resolveProviderKeyName: () => 'key-1',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
      ...providerOps,
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 't1', virtualKeyId: 'vk1' }),
      assignModelToProjectVirtualKey: async () => undefined,
      assignModelGovernance: async () => {
        throw Object.assign(new Error('gov down'), { response: { data: { error: { message: 'gov down' } } } });
      },
      unassignModelFromProjectVirtualKey: async () => {
        throw new Error('unassign failed');
      },
      removeModelGovernance: async () => undefined,
      appendMcpClientToProjectVirtualKey: async () => {
        throw new Error('mcp vk write failed');
      },
      removeMcpClientFromProjectVirtualKey: async () => {
        throw new Error('mcp unbind failed');
      },
      ...governance,
    }),
  );
}

beforeEach(() => {
  process.env.LLM_GATEWAY_URL = 'http://bifrost.test';
  process.env.LLM_GATEWAY_API_KEY = 'test-key';
  reloadGatewayModule();
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.LLM_GATEWAY_API_KEY;
  else process.env.LLM_GATEWAY_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_DEBUG === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = ORIGINAL_DEBUG;
  clearModule('services/BifrostGatewayClient', 'services/gatewayClient');
});

test('chatCompletion: uses singleton auth headers and omits usage when absent', async () => {
  delete process.env.LLM_GATEWAY_API_KEY;
  reloadGatewayModule();
  const gw = gatewayWith({
    post: async (_url, _body, config) => {
      assert.equal((config as any)?.headers?.Authorization, undefined);
      return {
        data: {
          model: 'm',
          choices: [{ message: { content: 123 } }],
          usage: {},
        },
      };
    },
  });
  const result = await gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.response, '');
  assert.equal(result.usage, undefined);
});

test('chatCompletion: maps upstream error detail and status', async () => {
  const gw = gatewayWith({
    post: async () => {
      const err: any = new Error('x');
      err.response = { status: 429, data: { detail: 'rate limited' } };
      throw err;
    },
  });
  await assert.rejects(
    () => gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (e: any) => e.status === 429 && /rate limited/.test(e.message),
  );
});

test('addModel: recovers provider key id and tolerates governance write failure', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'proj__cred__gpt-4',
    provider_params: { model: 'gpt-4', api_key: 'sk' },
    model_info: {
      provider: 'openai',
      projectId: 'p1',
      gatewayBindingName: 'binding-1',
      rpm: '100',
      tpm: 1000,
      spendingLimit: '50',
      spendingLimitPeriod: 'monthly',
    },
  });
  assert.equal(result?.keyId, 'recovered-kid');
});

test('addModel: appendProviderKey path without project skips VK assignment', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'k', keyId: 'kid' }),
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'bare-model',
    provider_params: { model: 'gpt-4', api_key: 'sk' },
    model_info: { provider: 'openai', providerModelId: 'gpt-4' },
  });
  assert.equal(result?.keyId, 'kid');
});

test('addBuiltinModel: throws when required fields or gateway setup missing', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendBuiltinProviderKey: async () => ({ keyName: 'k', keyId: undefined }),
  });
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => null,
      assignModelToProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm', api_base: 'http://tei' },
        model_info: { isBuiltin: true, provider: 'as-tei-x', projectId: 'p1' },
      }),
    /ensureProjectGateway returned null/,
  );

  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm' },
        model_info: { isBuiltin: true, provider: 'as-tei-x', projectId: 'p1' },
      }),
    /api_base is required/,
  );
});

test('addBuiltinModel: deferVirtualKeyAssignment skips per-model VK assign', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let assigned = false;
  installBifrostMocks(scope, {
    appendBuiltinProviderKey: async () => ({ keyName: 'tei-key', keyId: 'tei-kid' }),
  });
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 't1', virtualKeyId: 'vk1' }),
      assignModelToProjectVirtualKey: async () => {
        assigned = true;
      },
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.addModel({
    model_name: 'minilm',
    provider_params: { model: 'm', api_base: 'http://tei' },
    model_info: {
      isBuiltin: true,
      provider: 'as-tei-x',
      projectId: 'p1',
      deferVirtualKeyAssignment: true,
    },
  });
  assert.equal(assigned, false);
});

test('deleteModel: VK cleanup failure and removeProviderKeyByName fallback', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedKey = false;
  installBifrostMocks(scope, {
    removeProviderKeyByName: async () => {
      removedKey = true;
    },
    removeProviderModelFromKey: async () => {
      throw new Error('trim failed');
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.deleteModel('m1', {
    projectId: 'p1',
    gatewayProvider: 'openai',
    keyName: 'key-1',
    provider: 'openai',
  });
  assert.equal(removedKey, true);

  await gw.deleteModel('m2', {
    gatewayProvider: 'openai',
    keyName: 'key-1',
    gatewayBindingName: 'binding-2',
    currentApiKey: 'sk',
  });
});

test('removeMCPServer: unbind failure is best-effort; non-404 delete logs error', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  let deleteCalls = 0;
  const gw = gatewayWith({
    delete: async () => {
      deleteCalls += 1;
      const err: any = new Error('server error');
      err.response = { status: 500, data: { error: { message: 'boom' } } };
      throw err;
    },
  });
  // Non-404 delete failure is best-effort: the client attempts the delete,
  // logs the error, and resolves without throwing.
  await assert.doesNotReject(() =>
    gw.removeMCPServer('mc-1', { projectId: 'p1', mcpClientName: 'srv_a' }),
  );
  assert.equal(deleteCalls, 1);
});

test('addMCPServer: stdio transport, bearer auth, DEBUG summary, client id lookup, VK write failure', async (t) => {
  process.env.DEBUG = 'true';
  reloadGatewayModule();
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  let lookupCalls = 0;
  const gw = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        lookupCalls += 1;
        return { data: { clients: [{ config: { id: 'resolved-id', name: 'stdio-srv' } }] } };
      }
      return { data: {} };
    },
    post: async (url) => {
      if (url === '/api/mcp/client') return { data: { name: 'stdio-srv' } };
      if (url.includes('/reconnect')) return { data: {} };
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });

  const created = await gw.addMCPServer({
    server_name: 'stdio-srv',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { TOKEN: 'x' },
    auth_type: 'bearer_token',
    credentials: { token: 'secret-token' },
    projectId: 'p1',
    allowed_tools: ['tool_a'],
    blocked_tools: ['bad_tool'],
    extra_headers: ['x-tenant'],
    description: 'stdio mcp',
  });
  assert.equal(created.server_id, 'resolved-id');
  assert.ok(lookupCalls >= 1);
});

test('addMCPServer and editMCPServer: surface upstream failures', async () => {
  const gw = gatewayWith({
    post: async () => {
      const err: any = new Error('fail');
      err.response = { data: { detail: 'invalid mcp config' } };
      throw err;
    },
  });
  await assert.rejects(
    () =>
      gw.addMCPServer({
        server_name: 'x',
        url: 'http://x',
        transport: 'sse',
      }),
    /invalid mcp config/,
  );

  const gw2 = gatewayWith({
    put: async () => {
      const err: any = new Error('edit fail');
      err.response = { data: { error: { message: 'edit rejected' } } };
      throw err;
    },
  });
  await assert.rejects(
    () =>
      gw2.editMCPServer({
        server_id: 'mc-1',
        server_name: 'renamed',
        url: 'http://new',
        transport: 'http',
      }),
    /edit rejected/,
  );
});

test('testMCPConnection: returns failure when client missing or reconnect throws', async () => {
  const gw = gatewayWith({ get: async () => ({ data: { clients: [] } }) });
  const missing = await gw.testMCPConnection('nope');
  assert.equal(missing.success, false);
  assert.match(String(missing.message), /not found/);

  const gw2 = gatewayWith({
    get: async () => ({ data: { clients: [MCP_ROW] } }),
    post: async () => {
      throw new Error('reconnect failed');
    },
  });
  const failed = await gw2.testMCPConnection('srv_a');
  assert.equal(failed.success, false);
  assert.match(String(failed.message), /reconnect failed/);
});

test('listMCPTools: returns [] when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  assert.deepEqual(await gw.listMCPTools('any'), []);
});

test('callMCPTool: retries on 405, uses forwardHeaders/timeout/string args, retry failure message', async () => {
  let paths: string[] = [];
  const gw = gatewayWith({
    get: async () => ({ data: { clients: [MCP_ROW] } }),
    post: async (url, body, config) => {
      paths.push(url);
      if (url === '/v1/mcp/tool/execute') {
        const err: any = new Error('nope');
        err.response = { status: 405 };
        throw err;
      }
      if (url === '/api/mcp/tool/execute') {
        assert.equal((config as any)?.timeout, 5000);
        assert.equal((config as any)?.headers['x-forward'], '1');
        assert.equal((body as any)?.function?.arguments, 'raw');
        return { data: { content: [{ type: 'text', text: 'ok' }] } };
      }
      throw new Error(url);
    },
  });
  const result = await gw.callMCPTool('srv_a', 'tool_a', 'raw' as any, {
    timeoutMs: 5000,
    forwardHeaders: { 'x-forward': '1' },
  });
  assert.deepEqual(result, [{ type: 'text', text: 'ok' }]);
  assert.ok(paths.includes('/api/mcp/tool/execute'));

  const gw2 = gatewayWith({
    get: async () => ({ data: { clients: [MCP_ROW] } }),
    post: async (_url, body) => {
      const name = (body as any)?.function?.name;
      if (name === 'srv_a_tool_a') {
        const err: any = new Error('Tool not found');
        err.response = { data: { error: { message: 'Tool not found' } } };
        throw err;
      }
      if (name === 'tool_a') {
        const err: any = new Error('still missing');
        err.response = { data: { detail: 'still missing' } };
        throw err;
      }
      throw new Error('unexpected');
    },
  });
  await assert.rejects(() => gw2.callMCPTool('srv_a', 'tool_a', {}), /still missing/);
});

test('buildAgentMcpHeaders: empty when cluster master key unset', async () => {
  delete process.env.LLM_GATEWAY_API_KEY;
  reloadGatewayModule();
  const gw = new BifrostGatewayClient();
  assert.deepEqual(gw.buildAgentMcpHeaders(), {});
});

test('disableMcpClientAutoExecute: swallows PUT failures during addMCPServer', async () => {
  const gw = gatewayWith({
    post: async (url) => {
      if (url === '/api/mcp/client') {
        return { data: { client: { config: { id: 'mc-x', name: 'x' } } } };
      }
      if (url.includes('/reconnect')) return { data: {} };
      return { data: {} };
    },
    put: async () => {
      throw new Error('put failed');
    },
  });
  const out = await gw.addMCPServer({ server_name: 'x', url: 'http://x', transport: 'sse' });
  assert.equal(out.server_id, 'mc-x');
});

test('addModel: throws when project VK binding lacks recovered key id', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'key-1', keyId: undefined }),
    listProviderKeys: async () => [],
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'model-uuid',
        provider_params: { model: 'gpt-4', api_key: 'sk' },
        model_info: {
          provider: 'openai',
          providerModelId: 'gpt-4',
          projectId: 'p1',
          gatewayBindingName: 'binding-1',
        },
      }),
    /provider key id missing/,
  );
});

test('addBuiltinModel: throws when appendBuiltinProviderKey returns no key id', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendBuiltinProviderKey: async () => ({ keyName: 'tei-key', keyId: undefined }),
  });
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 't1', virtualKeyId: 'vk1' }),
      assignModelToProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm', api_base: 'http://tei' },
        model_info: { isBuiltin: true, provider: 'as-tei-x', projectId: 'p1' },
      }),
    /provider key id missing/,
  );
});

test('chatCompletion: forwards per-call apiKey override', async () => {
  let authHeader: string | undefined;
  const gw = gatewayWith({
    post: async (_url, _body, config) => {
      authHeader = (config as any)?.headers?.Authorization;
      return {
        data: {
          model: 'm',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      };
    },
  });
  const result = await gw.chatCompletion(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    { apiKey: 'project-vk-token' },
  );
  assert.equal(result.response, 'ok');
  assert.equal(result.usage?.totalTokens, 3);
  assert.equal(authHeader, 'Bearer project-vk-token');
});

test('chatCompletion: prefers upstream error.message over detail', async () => {
  const gw = gatewayWith({
    post: async () => {
      const err: any = new Error('x');
      err.response = { status: 403, data: { error: { message: 'forbidden model' }, detail: 'ignored' } };
      throw err;
    },
  });
  await assert.rejects(
    () => gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (e: any) => e.status === 403 && /forbidden model/.test(e.message),
  );
});

test('deleteModel: preserves shared built-in TEI provider keys', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedKey = false;
  installBifrostMocks(scope, {
    isPlatformTeiProvider: () => true,
    removeProviderKeyByName: async () => {
      removedKey = true;
    },
    removeProviderModelFromKey: async () => {
      removedKey = true;
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.deleteModel('mdl-builtin', {
    projectId: 'p1',
    gatewayProvider: 'as-tei-minilm',
    keyName: 'tei-key',
    provider: 'as-tei-minilm',
    gatewayBindingName: 'minilm-binding',
  });
  assert.equal(removedKey, false);
});

test('addMCPServer: api_key auth maps credentials into headers', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-api', name: 'api-srv' } } } };
      }
      if (url.includes('/reconnect')) return { data: {} };
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'api-srv',
    url: 'http://mcp.example',
    transport: 'http',
    auth_type: 'api_key',
    credentials: { api_key: 'secret-key' },
  });
  const headers = postedBody?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'secret-key');
});

test('removeMCPServer: 404 delete is treated as already removed', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  let deleteCalls = 0;
  const gw = gatewayWith({
    delete: async () => {
      deleteCalls += 1;
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    },
  });
  // A 404 from the gateway means the client was already removed: the delete is
  // attempted and the 404 is swallowed (treated as success).
  await assert.doesNotReject(() => gw.removeMCPServer('mc-missing'));
  assert.equal(deleteCalls, 1);
});

test('callMCPTool: retries on 404 using /api/mcp/tool/execute', async () => {
  const paths: string[] = [];
  const gw = gatewayWith({
    get: async () => ({ data: { clients: [MCP_ROW] } }),
    post: async (url) => {
      paths.push(url);
      if (url === '/v1/mcp/tool/execute') {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/mcp/tool/execute') {
        return { data: { content: [{ type: 'text', text: 'via-api' }] } };
      }
      throw new Error(url);
    },
  });
  const result = await gw.callMCPTool('srv_a', 'tool_a', { q: 1 });
  assert.deepEqual(result, [{ type: 'text', text: 'via-api' }]);
  assert.ok(paths.includes('/api/mcp/tool/execute'));
});

test('listMCPTools: throws when client is missing', async () => {
  const gw = gatewayWith({ get: async () => ({ data: { clients: [] } }) });
  await assert.rejects(() => gw.listMCPTools('missing-srv'), /not found/);
});

test('buildAgentMcpUrl: returns aggregated /mcp endpoint', () => {
  const gw = new BifrostGatewayClient();
  assert.equal(gw.buildAgentMcpUrl(), 'http://bifrost.test/mcp');
});

test('callMCPTool: throws when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  await assert.rejects(() => gw.callMCPTool('srv', 'tool', {}), /not configured/);
});

test('callMCPTool: retries on not-available-or-not-permitted message', async () => {
  const gw = gatewayWith({
    get: async () => ({ data: { clients: [MCP_ROW] } }),
    post: async (url) => {
      if (url === '/v1/mcp/tool/execute') {
        const err: any = new Error('blocked');
        err.response = { data: { detail: 'not available or not permitted' } };
        throw err;
      }
      if (url === '/api/mcp/tool/execute') {
        return { data: { result: { ok: true } } };
      }
      throw new Error(url);
    },
  });
  const result = await gw.callMCPTool('srv_a', 'tool_a', { q: 1 });
  assert.deepEqual(result, { ok: true });
});

test('addModel: recovers provider key id via model binding match', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'other-key', keyId: undefined }),
    listProviderKeys: async () => [{ id: 'model-bound-kid', name: 'other-key', models: ['binding-1'] }],
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'model-uuid',
    provider_params: { model: 'gpt-4', api_key: 'sk' },
    model_info: {
      provider: 'openai',
      providerModelId: 'gpt-4',
      projectId: 'p1',
      gatewayBindingName: 'binding-1',
    },
  });
  assert.equal(result?.keyId, 'model-bound-kid');
});

test('addBuiltinModel: throws when provider name is missing', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm', api_base: 'http://tei' },
        model_info: { isBuiltin: true, projectId: 'p1' },
      }),
    /model_info.provider is required/,
  );
});

test('deleteModel: no-op when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  await assert.doesNotReject(() => gw.deleteModel('m1', { projectId: 'p1' }));
});

test('addModel: openai_compatible with apiBase uses builtin provider path', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let builtinCalled = false;
  installBifrostMocks(scope, {
    appendBuiltinProviderKey: async () => {
      builtinCalled = true;
      return { keyName: 'compat-key', keyId: 'compat-kid' };
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'proj__cred__proxy-model',
    provider_params: { model: 'gpt-4', api_key: 'sk', api_base: 'https://proxy.example/v1' },
    model_info: {
      provider: 'openai_compatible',
      credentialId: 'cred-uuid-1234',
      credentialName: 'corp-proxy',
      projectId: 'p1',
      gatewayBindingName: 'binding-proxy',
      rpm: 'not-a-number',
      tpm: '',
      spendingLimit: null,
      spendingLimitPeriod: 'yearly',
    },
  });
  assert.equal(builtinCalled, true);
  assert.equal(result?.keyId, 'compat-kid');
});

test('addBuiltinModel: throws when projectId missing', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm', api_base: 'http://tei' },
        model_info: { isBuiltin: true, provider: 'as-tei-x' },
      }),
    /projectId is required/,
  );
});

test('addModel: derives providerModelId from openai/ prefixed wire model', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'binding-1',
    provider_params: { model: 'openai/gpt-4o-mini', api_key: 'sk' },
    model_info: { provider: 'openai', projectId: 'p1', gatewayBindingName: 'binding-1' },
  });
  assert.equal(result?.providerModelId, 'gpt-4o-mini');
});

test('deleteModel: removes whole provider key when no bifrostModelIdent', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedByName = false;
  installBifrostMocks(scope, {
    removeProviderKeyByName: async () => {
      removedByName = true;
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.deleteModel('legacy-model', {
    projectId: 'p1',
    gatewayProvider: 'openai',
    keyName: 'legacy-key',
    provider: 'openai',
  });
  assert.equal(removedByName, true);
});

test('chatCompletion: includes partial usage when only prompt tokens present', async () => {
  const gw = gatewayWith({
    post: async () => ({
      data: {
        model: 'm',
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 5 },
      },
    }),
  });
  const result = await gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.usage?.promptTokens, 5);
  assert.ok(result.usage);
});

test('addMCPServer: bearer_token auth sets Authorization header', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-bearer', name: 'bearer-srv' } } } };
      }
      if (url.includes('/reconnect')) return { data: {} };
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'bearer-srv',
    url: 'http://mcp.example',
    transport: 'sse',
    auth_type: 'bearer_token',
    credentials: { token: 'bearer-token' },
  });
  const headers = postedBody?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer bearer-token');
});

test('addMCPServer: maps client_id and client_secret into headers', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-oauth', name: 'oauth-srv' } } } };
      }
      if (url.includes('/reconnect')) return { data: {} };
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'oauth-srv',
    url: 'http://mcp.example',
    transport: 'http',
    auth_type: 'oauth',
    credentials: { client_id: 'cid-1', client_secret: 'csec-1', auth_value: 'plain-auth' },
  });
  const headers = postedBody?.headers as Record<string, string>;
  assert.equal(headers['x-client-id'], 'cid-1');
  assert.equal(headers['x-client-secret'], 'csec-1');
  assert.equal(headers.Authorization, 'plain-auth');
});

test('chatCompletion: maps completion_tokens-only usage', async () => {
  const gw = gatewayWith({
    post: async () => ({
      data: {
        model: 'm',
        choices: [{ message: { content: 'ok' } }],
        usage: { completion_tokens: 7 },
      },
    }),
  });
  const result = await gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.usage?.completionTokens, 7);
});

test('chatCompletion: prefers error.message over detail in catch', async () => {
  const gw = gatewayWith({
    post: async () => {
      const err: any = new Error('x');
      err.response = { status: 500, data: { error: { message: 'upstream msg' }, detail: 'detail msg' } };
      throw err;
    },
  });
  await assert.rejects(
    () => gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    (e: any) => /upstream msg/.test(e.message),
  );
});

test('addBuiltinModel: defers virtual-key assignment when requested', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let assigned = false;
  installBifrostMocks(scope, {
    assignModelToProjectVirtualKey: async () => {
      assigned = true;
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.addModel({
    model_name: 'minilm',
    provider_params: { model: 'm', api_base: 'http://tei', api_key: 'k' },
    model_info: {
      isBuiltin: true,
      provider: 'as-tei-x',
      projectId: 'p1',
      deferVirtualKeyAssignment: true,
    },
  });
  assert.equal(assigned, false);
});

test('addBuiltinModel: throws when appendBuiltinProviderKey omits key id', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    appendBuiltinProviderKey: async () => ({ keyName: 'k', keyId: undefined }),
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.rejects(
    () =>
      gw.addModel({
        model_name: 'minilm',
        provider_params: { model: 'm', api_base: 'http://tei', api_key: 'k' },
        model_info: { isBuiltin: true, provider: 'as-tei-x', projectId: 'p1' },
      }),
    /provider key id missing/,
  );
});

test('deleteModel: preserves shared TEI provider key', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedModel = false;
  installBifrostMocks(scope, {
    isPlatformTeiProvider: () => true,
    removeProviderModelFromKey: async () => {
      removedModel = true;
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await gw.deleteModel('binding-1', {
    projectId: 'p1',
    gatewayProvider: 'as-tei-minilm',
    gatewayBindingName: 'binding-1',
    keyName: 'tei-key',
    provider: 'as-tei-minilm',
  });
  assert.equal(removedModel, false);
});

test('deleteModel: warns when VK cleanup fails', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  installBifrostMocks(scope, {
    unassignModelFromProjectVirtualKey: async () => {
      throw Object.assign(new Error('vk write failed'), {
        response: { data: { error: { message: 'vk write failed' } } },
      });
    },
  });
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const gw = gatewayWith({});
  await assert.doesNotReject(() =>
    gw.deleteModel('binding-1', {
      projectId: 'p1',
      gatewayProvider: 'openai',
      gatewayBindingName: 'binding-1',
      provider: 'openai',
      keyName: 'key-1',
    }),
  );
});

test('addMCPServer: stdio transport maps command and args', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-stdio', name: 'stdio-srv' } } } };
      }
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'stdio-srv',
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { FOO: 'bar' },
  });
  const stdio = postedBody?.stdio_config as Record<string, unknown>;
  assert.equal(stdio.command, 'node');
  assert.deepEqual(stdio.args, ['server.js']);
});

test('addMCPServer: includes blocked tools in tools_to_exclude', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-block', name: 'block-srv' } } } };
      }
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'block-srv',
    url: 'http://mcp.example',
    transport: 'http',
    blocked_tools: ['danger'],
  });
  assert.deepEqual(postedBody?.tools_to_exclude, ['danger']);
});

test('addMCPServer: tolerates disableMcpClientAutoExecute failure', async () => {
  const gw = gatewayWith({
    post: async (url) => {
      if (url === '/api/mcp/client') {
        return { data: { client: { config: { id: 'mc-put-fail', name: 'srv' } } } };
      }
      return { data: {} };
    },
    put: async (url) => {
      if (url.includes('/api/mcp/client/')) {
        throw new Error('put failed');
      }
      return { data: {} };
    },
  });
  await assert.doesNotReject(() =>
    gw.addMCPServer({
      server_name: 'srv',
      url: 'http://mcp.example',
      transport: 'http',
    }),
  );
});

test('chatCompletion: returns undefined usage when absent', async () => {
  const gw = gatewayWith({
    post: async () => ({
      data: {
        model: 'm',
        choices: [{ message: { content: 'ok' } }],
      },
    }),
  });
  const result = await gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.usage, undefined);
});

test('chatCompletion: uses per-call apiKey headers', async () => {
  let headers: Record<string, string> | undefined;
  const gw = gatewayWith({
    post: async (_url, _body, config) => {
      headers = (config as { headers?: Record<string, string> })?.headers;
      return { data: { model: 'm', choices: [{ message: { content: 'ok' } }] } };
    },
  });
  await gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { apiKey: 'vk-token' });
  assert.equal(headers?.Authorization, 'Bearer vk-token');
  assert.equal(headers?.['x-api-key'], 'vk-token');
});

test('addMCPServer: coerces static_headers and skips null values', async () => {
  let postedBody: Record<string, unknown> | undefined;
  const gw = gatewayWith({
    post: async (url, body) => {
      if (url === '/api/mcp/client') {
        postedBody = body as Record<string, unknown>;
        return { data: { client: { config: { id: 'mc-h', name: 'hdr-srv' } } } };
      }
      return { data: {} };
    },
    put: async () => ({ data: {} }),
  });
  await gw.addMCPServer({
    server_name: 'hdr-srv',
    url: 'http://mcp.example',
    transport: 'http',
    static_headers: { 'X-Custom': 'val', Empty: null as any, Spaced: '  padded  ' },
  });
  const headers = postedBody?.headers as Record<string, string>;
  assert.equal(headers['X-Custom'], 'val');
  assert.equal(headers.Spaced, '  padded  ');
  assert.equal(headers.Empty, undefined);
});

