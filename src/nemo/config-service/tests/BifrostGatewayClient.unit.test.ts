/**
 * Unit tests for BifrostGatewayClient helpers and MCP listing.
 *
 * Run: node --require ts-node/register --test tests/BifrostGatewayClient.unit.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { clearModule, loadFresh, mockModule, restoreScope } from './helpers/moduleMock';

const ORIGINAL_URL = process.env.LLM_GATEWAY_URL;
const ORIGINAL_KEY = process.env.LLM_GATEWAY_API_KEY;

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
): { gw: InstanceType<BifrostGatewayClientCtor>; calls: string[] } {
  const calls: string[] = [];
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = true;
  (gw as any).client = {
    get: async (url: string) => {
      calls.push(`GET ${url}`);
      return handlers.get?.(url) ?? { data: [] };
    },
    post: async (url: string, body?: unknown, config?: unknown) => {
      calls.push(`POST ${url}`);
      return handlers.post?.(url, body, config) ?? { data: {} };
    },
    put: async (url: string, body?: unknown) => {
      calls.push(`PUT ${url}`);
      return handlers.put?.(url, body) ?? { data: {} };
    },
    delete: async (url: string) => {
      calls.push(`DELETE ${url}`);
      return handlers.delete?.(url) ?? { data: {} };
    },
  } as AxiosInstance;
  return { gw, calls };
}

const MCP_CLIENT_ROW = {
  config: { id: 'mc-1', name: 'artifact_store', connection_string: 'http://mcp' },
  connection_type: 'sse',
  auth_type: 'none',
  state: 'connected',
  tools: [{ name: 'search', description: 'Search artifacts' }],
};

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
  clearModule('services/BifrostGatewayClient', 'services/gatewayClient');
});

test('isEnabled: false when gateway URL is unset', () => {
  delete process.env.LLM_GATEWAY_URL;
  reloadGatewayModule();
  const gw = new BifrostGatewayClient();
  assert.equal(gw.isEnabled(), false);
});

test('buildAgentMcpUrl and buildAgentMcpHeaders', () => {
  const { gw } = gatewayWith({});
  assert.equal(gw.buildAgentMcpUrl(), 'http://bifrost.test/mcp');
  const headers = gw.buildAgentMcpHeaders();
  assert.equal(headers.Authorization, 'Bearer test-key');
  assert.equal(headers['x-api-key'], 'test-key');
});

test('listMCPServers: maps Bifrost client rows', async () => {
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
  });
  const servers = await gw.listMCPServers();
  assert.equal(servers.length, 1);
  assert.equal(servers[0].server_id, 'mc-1');
  assert.equal(servers[0].server_name, 'artifact_store');
  assert.equal(servers[0].url, 'http://mcp');
});

test('listMCPServers: returns [] when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  assert.deepEqual(await gw.listMCPServers(), []);
});

test('listMCPTools: parses tools from client list entry', async () => {
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
  });
  const tools = await gw.listMCPTools('artifact_store');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'search');
  assert.equal(tools[0].description, 'Search artifacts');
});

test('testMCPConnection: success when client exists', async () => {
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
    post: async () => ({ data: {} }),
  });
  const result = await gw.testMCPConnection('artifact_store');
  assert.equal(result.success, true);
  assert.match(result.message ?? '', /1 tool\(s\) available/);
  assert.match(result.message ?? '', /state=connected/);
});

test('testMCPConnection: throws when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  await assert.rejects(() => gw.testMCPConnection('artifact_store'), /not configured/);
});

test('addMCPServer: registers client and disables auto-execute', async () => {
  const { gw, calls } = gatewayWith({
    post: async (url) => {
      if (url === '/api/mcp/client') {
        return {
          data: {
            client: {
              config: { id: 'mc-new', name: 'github_mcp' },
            },
          },
        };
      }
      if (url.includes('/reconnect')) return { data: {} };
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });
  const result = await gw.addMCPServer({
    server_name: 'github_mcp',
    url: 'http://github-mcp',
    transport: 'sse',
    auth_type: 'none',
  });
  assert.equal(result.server_id, 'mc-new');
  assert.equal(result.server_name, 'github_mcp');
  assert.ok(calls.some((c) => c === 'POST /api/mcp/client'));
  assert.ok(calls.some((c) => c === 'POST /api/mcp/client/mc-new/reconnect'));
  assert.ok(calls.some((c) => c === 'PUT /api/mcp/client/mc-new'));
});

test('removeMCPServer: swallows 404 on delete', async () => {
  const { gw, calls } = gatewayWith({
    delete: async () => {
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    },
  });
  await gw.removeMCPServer('missing-id');
  assert.deepEqual(calls, ['DELETE /api/mcp/client/missing-id']);
});

test('chatCompletion: maps OpenAI-compatible response', async () => {
  const { gw } = gatewayWith({
    post: async (url, body, config) => {
      if (url === '/litellm/v1/chat/completions') {
        assert.equal((config as any)?.headers?.Authorization, 'Bearer vk-token');
        return {
          data: {
            model: 'gpt-test',
            choices: [{ message: { content: 'hello' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        };
      }
      throw new Error(url);
    },
  });
  const result = await gw.chatCompletion(
    { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] },
    { apiKey: 'vk-token' },
  );
  assert.equal(result.response, 'hello');
  assert.equal(result.modelName, 'gpt-test');
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
});

test('chatCompletion: throws when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  await assert.rejects(
    () => gw.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    /not configured/,
  );
});

test('callMCPTool: executes prefixed tool and returns content', async () => {
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/v1/mcp/tool/execute') {
        return { data: { content: [{ type: 'text', text: 'done' }] } };
      }
      throw new Error(url);
    },
  });
  const result = await gw.callMCPTool('artifact_store', 'search', { q: 'x' });
  assert.deepEqual(result, [{ type: 'text', text: 'done' }]);
});

test('editMCPServer: updates client and reconnects', async () => {
  const { gw, calls } = gatewayWith({
    put: async (url) => {
      if (url.includes('/api/mcp/client/')) return { data: {} };
      throw new Error(url);
    },
    post: async (url) => {
      if (url.includes('/reconnect')) return { data: {} };
      throw new Error(url);
    },
  });
  await gw.editMCPServer({
    server_id: 'mc-1',
    server_name: 'artifact_store',
    url: 'http://mcp-new',
    transport: 'sse',
  });
  assert.ok(calls.some((c) => c.startsWith('PUT /api/mcp/client/mc-1')));
  assert.ok(calls.some((c) => c === 'POST /api/mcp/client/mc-1/reconnect'));
});

test('addModel: no-op when gateway disabled', async () => {
  const gw = new BifrostGatewayClient();
  (gw as any).enabled = false;
  const result = await gw.addModel({
    model_name: 'm1',
    provider_params: { model: 'gpt-4', api_key: 'sk' },
  });
  assert.equal(result, undefined);
});

function installBifrostMocks(
  scope: ReturnType<typeof restoreScope>,
  overrides?: {
    providerOps?: Record<string, unknown>;
    projectGov?: Record<string, unknown>;
  },
): void {
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({
        gatewayProvider: 'openai',
        keyName: 'key-1',
        keyId: 'kid-1',
      }),
      appendBuiltinProviderKey: async () => ({
        providerName: 'as-openai-compat-cred1',
        keyName: 'oc-key',
        keyId: 'oc-kid',
      }),
      buildBuiltinGatewayBindingName: (modelId: string) => modelId.replace(/\//g, '__'),
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => undefined,
      resolveProviderKeyName: () => 'key-1',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
      ...overrides?.providerOps,
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 'team-1', virtualKeyId: 'vk-1' }),
      assignModelToProjectVirtualKey: async () => undefined,
      assignModelGovernance: async () => undefined,
      unassignModelFromProjectVirtualKey: async () => undefined,
      removeModelGovernance: async () => undefined,
      appendMcpClientToProjectVirtualKey: async () => undefined,
      removeMcpClientFromProjectVirtualKey: async () => undefined,
      ...overrides?.projectGov,
    }),
  );
}

function reloadWithBifrostMocks(scope: ReturnType<typeof restoreScope>): void {
  installBifrostMocks(scope);
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;
}

test('addModel: registers provider key and assigns to project VK', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let governanceCalled = false;
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 'team-1', virtualKeyId: 'vk-1' }),
      assignModelToProjectVirtualKey: async () => undefined,
      assignModelGovernance: async () => {
        governanceCalled = true;
      },
      unassignModelFromProjectVirtualKey: async () => undefined,
      removeModelGovernance: async () => undefined,
      appendMcpClientToProjectVirtualKey: async () => undefined,
      removeMcpClientFromProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'proj__cred__gpt-4',
    provider_params: { model: 'gpt-4', api_key: 'sk-test' },
    model_info: {
      provider: 'openai',
      projectId: 'proj-1',
      credentialId: 'cred-1',
      gatewayBindingName: 'binding-1',
      rpm: 100,
      tpm: 1000,
      spendingLimit: 50,
      spendingLimitPeriod: 'monthly',
    },
  });
  assert.equal(result?.gatewayProvider, 'openai');
  assert.equal(result?.keyName, 'key-1');
  assert.equal(governanceCalled, true);
  reloadGatewayModule();
});

test('addModel: openai_compatible with apiBase uses custom provider path', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let usedBuiltinPath = false;
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'k', keyId: 'kid' }),
      appendBuiltinProviderKey: async () => {
        usedBuiltinPath = true;
        return { providerName: 'as-openai-compat-c1', keyName: 'oc-key', keyId: 'oc-kid' };
      },
      buildBuiltinGatewayBindingName: (m: string) => m,
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => undefined,
      resolveProviderKeyName: () => 'key-1',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'proxy-model',
    provider_params: {
      model: 'claude-3',
      api_base: 'http://corp-proxy/v1',
      api_key: 'proxy-key',
    },
    model_info: {
      provider: 'openai_compatible',
      credentialId: 'c1',
      credentialName: 'Corp Proxy',
      projectId: 'proj-1',
      gatewayBindingName: 'corp-claude',
    },
  });
  assert.equal(usedBuiltinPath, true);
  assert.equal(result?.gatewayProvider, 'as-openai-compat-c1');
  reloadGatewayModule();
});

test('addModel: builtin TEI registers provider and assigns VK', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'k', keyId: 'kid' }),
      appendBuiltinProviderKey: async () => ({ keyName: 'tei-key', keyId: 'tei-kid' }),
      buildBuiltinGatewayBindingName: (m: string) => m.replace(/\//g, '__'),
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => undefined,
      resolveProviderKeyName: () => 'key-1',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  const result = await gw.addModel({
    model_name: 'minilm',
    provider_params: {
      model: 'sentence-transformers/all-MiniLM-L6-v2',
      api_base: 'http://tei.svc.cluster.local',
    },
    model_info: {
      isBuiltin: true,
      provider: 'as-tei-minilm',
      projectId: 'proj-1',
      providerModelId: 'sentence-transformers/all-MiniLM-L6-v2',
    },
  });
  assert.equal(result?.gatewayProvider, 'as-tei-minilm');
  assert.equal(result?.keyName, 'tei-key');
  reloadGatewayModule();
});

test('deleteModel: unassigns VK and removes model from provider key', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let unassigned = false;
  let removedFromKey = false;
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'k', keyId: 'kid' }),
      appendBuiltinProviderKey: async () => ({ providerName: 'p', keyName: 'k', keyId: 'kid' }),
      buildBuiltinGatewayBindingName: (m: string) => m,
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => {
        removedFromKey = true;
      },
      resolveProviderKeyName: () => 'key-1',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      ensureProjectGateway: async () => ({ teamId: 't1', virtualKeyId: 'vk1' }),
      assignModelToProjectVirtualKey: async () => undefined,
      assignModelGovernance: async () => undefined,
      unassignModelFromProjectVirtualKey: async () => {
        unassigned = true;
      },
      removeModelGovernance: async () => undefined,
      appendMcpClientToProjectVirtualKey: async () => undefined,
      removeMcpClientFromProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  await gw.deleteModel('model-1', {
    projectId: 'proj-1',
    gatewayProvider: 'openai',
    keyName: 'key-1',
    gatewayBindingName: 'binding-1',
    providerModelId: 'gpt-4',
    currentApiKey: 'sk-live',
  });
  assert.equal(unassigned, true);
  assert.equal(removedFromKey, true);
  reloadGatewayModule();
});

test('deleteModel: preserves shared TEI provider keys', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedFromKey = false;
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'as-tei-x', keyName: 'k', keyId: 'kid' }),
      appendBuiltinProviderKey: async () => ({ providerName: 'as-tei-x', keyName: 'k', keyId: 'kid' }),
      buildBuiltinGatewayBindingName: (m: string) => m,
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => undefined,
      removeProviderModelFromKey: async () => {
        removedFromKey = true;
      },
      resolveProviderKeyName: () => 'tei-key',
      isPlatformTeiProvider: (p: string) => p.startsWith('as-tei'),
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  await gw.deleteModel('embed-1', {
    gatewayProvider: 'as-tei-minilm',
    keyName: 'tei-key',
    gatewayBindingName: 'minilm-binding',
  });
  assert.equal(removedFromKey, false);
  reloadGatewayModule();
});

test('listMCPTools: throws when client is missing', async () => {
  const { gw } = gatewayWith({
    get: async () => ({ data: { clients: [] } }),
  });
  await assert.rejects(() => gw.listMCPTools('missing'), /not found/);
});

test('callMCPTool: retries alternate API path on 404', async () => {
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/v1/mcp/tool/execute') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/mcp/tool/execute') {
        return { data: { content: [{ type: 'text', text: 'retry-ok' }] } };
      }
      throw new Error(url);
    },
  });
  const result = await gw.callMCPTool('artifact_store', 'search', { q: 'x' });
  assert.deepEqual(result, [{ type: 'text', text: 'retry-ok' }]);
});

test('callMCPTool: retries unprefixed tool name when prefixed call fails', async () => {
  let attempts = 0;
  const { gw } = gatewayWith({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [MCP_CLIENT_ROW] } };
      }
      throw new Error(url);
    },
    post: async (url, body) => {
      attempts += 1;
      const name = (body as any)?.function?.name;
      if (name?.startsWith('artifact_store_') && name !== 'search') {
        const err: any = new Error('Tool not found');
        err.response = { data: { error: { message: 'Tool not found' } } };
        throw err;
      }
      if (name === 'search') {
        return { data: { content: [{ type: 'text', text: 'bare-name-ok' }] } };
      }
      throw new Error(`unexpected tool name ${name}`);
    },
  });
  const result = await gw.callMCPTool('artifact_store', 'search', { q: 'x' });
  assert.equal(attempts, 2);
  assert.deepEqual(result, [{ type: 'text', text: 'bare-name-ok' }]);
});

test('chatCompletion: returns empty response when message content is absent', async () => {
  const { gw } = gatewayWith({
    post: async () => ({
      data: {
        model: 'gpt-test',
        choices: [{ message: {} }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      },
    }),
  });
  const result = await gw.chatCompletion({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.response, '');
});

test('deleteModel: removes entire provider key when binding name is absent', async (t) => {
  const scope = restoreScope();
  t.after(() => scope.restoreAll());
  let removedByName = false;
  reloadWithBifrostMocks(scope);
  scope.add(
    mockModule('services/bifrost/bifrostProviderOps', {
      appendProviderKey: async () => ({ gatewayProvider: 'openai', keyName: 'k', keyId: 'kid' }),
      appendBuiltinProviderKey: async () => ({ providerName: 'p', keyName: 'k', keyId: 'kid' }),
      buildBuiltinGatewayBindingName: (m: string) => m,
      buildOpenAICompatibleProviderName: (id: string) => `as-openai-compat-${id}`,
      listProviderKeys: async () => [],
      removeProviderKeyByName: async () => {
        removedByName = true;
      },
      removeProviderModelFromKey: async () => undefined,
      resolveProviderKeyName: () => 'legacy-key',
      isPlatformTeiProvider: () => false,
      mapLlmProviderToBifrost: (p: string) => p,
      getProviderState: async () => ({}),
    }),
  );
  clearModule('services/BifrostGatewayClient');
  BifrostGatewayClient = loadFresh<{ BifrostGatewayClient: BifrostGatewayClientCtor }>(
    'services/BifrostGatewayClient',
  ).BifrostGatewayClient;

  const { gw } = gatewayWith({});
  await gw.deleteModel('model-1', {
    gatewayProvider: 'openai',
    keyName: 'legacy-key',
    currentApiKey: 'sk-live',
  });
  assert.equal(removedByName, true);
  reloadGatewayModule();
});
