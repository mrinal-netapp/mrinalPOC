/**
 * Orchestration tests for exported async seams in bifrostProjectGovernance.ts.
 *
 * Run: node --require ts-node/register --test tests/bifrostProjectGovernance.orchestration.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { installFakeRepositories, makeFakeRepo, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { mockModule, clearModule, restoreScope, loadFresh } from './helpers/moduleMock';

const PROJECT = 'proj67bqptlb';

type GovernanceModule = typeof import('../services/bifrost/bifrostProjectGovernance');
let governance: GovernanceModule;

function makeBifrostClient(handlers: Record<string, (url: string, body?: unknown) => Promise<any>>): AxiosInstance {
  return {
    get: async (url: string) => handlers.get?.(url) ?? { data: {} },
    put: async (url: string, body?: unknown) => handlers.put?.(url, body) ?? { data: {} },
    post: async (url: string, body?: unknown) => handlers.post?.(url, body) ?? { data: {} },
    delete: async (url: string) => handlers.delete?.(url) ?? { data: {} },
  } as AxiosInstance;
}

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;

beforeEach(() => {
  scope = restoreScope();
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async (name: string) =>
          name === `as-proj-${PROJECT}-vk` ? { virtual_key_token: 'sk-bf-test' } : null,
        writeSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle = installFakeRepositories({
    Project: makeFakeRepo({
      findOneBy: async ({ id }: { id?: string }) => {
        if (id !== PROJECT) return null;
        return {
          id: PROJECT,
          name: 'Test Project',
          metadata: {
            _gateway: {
              teamId: 'team-1',
              teamName: `as-proj-${PROJECT}`,
              virtualKeyId: 'vk-1',
              virtualKeyName: `as-proj-${PROJECT}-vk`,
            },
          },
          created_at: new Date('2024-01-01'),
          updated_at: new Date('2024-01-01'),
          home_dir: '/tmp',
          init_status: 'ready',
          init_error: null,
        };
      },
      update: async () => ({ affected: 1 }),
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/bifrost/bifrostProjectGovernance');
  handle.restore();
});

test('resolveProjectVirtualKeyId: matches canonical project VK name', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              { id: 'vk-other', name: 'as-proj-otherproj-vk' },
              { id: 'vk-1', name: `as-proj-${PROJECT}-vk` },
            ],
          },
        };
      }
      throw new Error(url);
    },
  });
  assert.equal(await governance.resolveProjectVirtualKeyId(PROJECT, client), 'vk-1');
});

test('resolveProjectVirtualKeyId: matches rotated VK suffix', async () => {
  const client = makeBifrostClient({
    get: async () => ({
      data: { keys: [{ virtual_key_id: 'vk-r2', name: `as-proj-${PROJECT}-vk-r2` }] },
    }),
  });
  assert.equal(await governance.resolveProjectVirtualKeyId(PROJECT, client), 'vk-r2');
});

test('resolveProjectVirtualKeyId: undefined when no matching VK', async () => {
  const client = makeBifrostClient({
    get: async () => ({ data: { virtual_keys: [{ id: 'vk-x', name: 'as-proj-other-vk' }] } }),
  });
  assert.equal(await governance.resolveProjectVirtualKeyId(PROJECT, client), undefined);
});

test('loadProjectGateway: returns cached gateway without Bifrost create', async () => {
  const client = makeBifrostClient({
    get: async () => {
      throw new Error('should not call Bifrost when cache is complete');
    },
  });
  const gateway = await governance.loadProjectGateway(PROJECT, client);
  assert.equal(gateway?.virtualKeyId, 'vk-1');
  assert.equal(gateway?.teamId, 'team-1');
});

test('appendMcpClientToProjectVirtualKey: appends mcp client and PUTs write shape', async () => {
  const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              mcp_configs: [
                {
                  mcp_client: { id: 'mc-1', name: 'artifact_store' },
                  tools_to_execute: ['*'],
                },
              ],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (url, body) => {
      puts.push({ url, body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.appendMcpClientToProjectVirtualKey(PROJECT, 'analytics_datasets_mcp', ['search'], client);

  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, '/api/governance/virtual-keys/vk-1');
  const configs = puts[0].body.mcp_configs as Array<Record<string, unknown>>;
  assert.ok(configs.some((c) => c.mcp_client_name === 'artifact_store'));
  assert.ok(configs.some((c) => c.mcp_client_name === 'analytics_datasets_mcp'));
  const added = configs.find((c) => c.mcp_client_name === 'analytics_datasets_mcp');
  assert.deepEqual(added?.tools_to_execute, ['search']);
});

test('ensureProjectGateway: returns cached gateway when team and VK still exist', async () => {
  const posts: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams/team-1') {
        return { data: { team: { id: 'team-1', name: `as-proj-${PROJECT}` } } };
      }
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      posts.push(url);
      return { data: {} };
    },
  });
  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.teamId, 'team-1');
  assert.equal(gateway?.virtualKeyId, 'vk-1');
  assert.deepEqual(posts, []);
});

test('ensureProjectGateway: creates team and VK when project has no cache', async () => {
  const NO_CACHE = 'projnocache1';
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== NO_CACHE) return null;
      return {
        id: NO_CACHE,
        name: 'Fresh Project',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });

  const calls: string[] = [];
  const client = makeBifrostClient({
    post: async (url) => {
      calls.push(`POST ${url}`);
      if (url === '/api/governance/teams') {
        return { data: { team: { id: 'team-new', name: `as-proj-${NO_CACHE}` } } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${NO_CACHE}-vk`,
              token: 'vk-token-new',
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (url) => {
      calls.push(`PUT ${url}`);
      return { data: {} };
    },
    get: async (url) => {
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${NO_CACHE}-vk`,
              team_id: 'team-stale',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      calls.push(`GET ${url}`);
      throw new Error(url);
    },
  });

  const gateway = await governance.ensureProjectGateway(NO_CACHE, client);
  assert.equal(gateway?.teamId, 'team-new');
  assert.equal(gateway?.virtualKeyId, 'vk-new');
  assert.equal(gateway?.virtualKeyName, `as-proj-${NO_CACHE}-vk`);
  assert.ok(calls.some((c) => c === 'POST /api/governance/teams'));
  assert.ok(calls.some((c) => c === 'POST /api/governance/virtual-keys'));
  assert.ok(calls.some((c) => c === 'PUT /api/governance/virtual-keys/vk-new'));
});

function vkGetHandler(
  overrides: Record<string, unknown> = {},
): (url: string) => Promise<{ data: Record<string, unknown> }> {
  return async (url) => {
    if (url === '/api/governance/virtual-keys/vk-1') {
      return {
        data: {
          virtual_key: {
            id: 'vk-1',
            name: `as-proj-${PROJECT}-vk`,
            team_id: 'team-1',
            provider_configs: [],
            mcp_configs: [],
            ...overrides,
          },
        },
      };
    }
    throw new Error(url);
  };
}

test('assignModelToProjectVirtualKey: appends provider_configs binding', async () => {
  const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: vkGetHandler(),
    put: async (url, body) => {
      puts.push({ url, body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.assignModelToProjectVirtualKey(
    PROJECT,
    { provider: 'openai', modelId: 'proj_model_gpt-4o', providerKeyId: 'key-1' },
    client,
  );

  assert.equal(puts.length, 1);
  const configs = puts[0].body.provider_configs as Array<Record<string, unknown>>;
  const openai = configs.find((c) => c.provider === 'openai');
  assert.deepEqual(openai?.allowed_models, ['proj_model_gpt-4o']);
  assert.deepEqual(openai?.key_ids, ['key-1']);
});

test('assignModelToProjectVirtualKey: no-ops when binding already present', async () => {
  const puts: string[] = [];
  const client = makeBifrostClient({
    get: vkGetHandler({
      provider_configs: [
        {
          provider: 'openai',
          allowed_models: ['proj_model_gpt-4o'],
          key_ids: ['key-1'],
        },
      ],
    }),
    put: async (url) => {
      puts.push(url);
      return { data: {} };
    },
  });

  await governance.assignModelToProjectVirtualKey(
    PROJECT,
    { provider: 'openai', modelId: 'proj_model_gpt-4o', providerKeyId: 'key-1' },
    client,
  );
  assert.deepEqual(puts, []);
});

test('unassignModelFromProjectVirtualKey: removes model from provider_configs', async () => {
  const puts: Array<{ body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: vkGetHandler({
      provider_configs: [
        { provider: 'openai', allowed_models: ['keep-me', 'drop-me'], key_ids: ['k1'] },
        { provider: 'azure', allowed_models: ['azure-model'] },
      ],
    }),
    put: async (_url, body) => {
      puts.push({ body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.unassignModelFromProjectVirtualKey(
    PROJECT,
    { provider: 'openai', modelId: 'drop-me' },
    client,
  );

  const configs = puts[0].body.provider_configs as Array<Record<string, unknown>>;
  assert.deepEqual(
    configs.map((c) => c.provider),
    ['openai', 'azure'],
  );
  assert.deepEqual(configs[0].allowed_models, ['keep-me']);
});

test('assignModelGovernance: creates model-config when none exists', async () => {
  const posts: unknown[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/api/governance/model-configs') posts.push(body);
      return { data: { id: 'mc-new' } };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { rpm: 100, tpm: 5000, spendingLimit: 25, spendingLimitPeriod: 'month' },
    client,
  );

  assert.equal(posts.length, 1);
  const body = posts[0] as Record<string, unknown>;
  assert.equal(body.model_name, 'gpt-4o');
  assert.equal(body.scope_id, 'vk-1');
  assert.deepEqual(body.budget, { max_limit: 25, reset_duration: '1M' });
});

test('assignModelGovernance: updates existing model-config', async () => {
  const puts: unknown[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            model_configs: [
              {
                id: 'mc-1',
                model_name: 'gpt-4o',
                provider: 'openai',
                scope: 'virtual_key',
                scope_id: 'vk-1',
              },
            ],
          },
        };
      }
      throw new Error(url);
    },
    put: async (url, body) => {
      if (url === '/api/governance/model-configs/mc-1') puts.push(body);
      return { data: {} };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { rpm: 50 },
    client,
  );

  assert.equal(puts.length, 1);
  const body = puts[0] as Record<string, unknown>;
  assert.deepEqual((body.rate_limit as Record<string, unknown>).request_max_limit, 50);
});

test('assignModelGovernance: recovers from 409 by updating existing config', async () => {
  let listCount = 0;
  const puts: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        listCount += 1;
        if (listCount === 1) return { data: { model_configs: [] } };
        return {
          data: {
            model_configs: [
              {
                id: 'mc-conflict',
                model_name: 'gpt-4o',
                provider: 'openai',
                scope: 'virtual_key',
                scope_id: 'vk-1',
              },
            ],
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/model-configs') {
        const err: any = new Error('conflict');
        err.response = { status: 409 };
        throw err;
      }
      return { data: {} };
    },
    put: async (url) => {
      puts.push(url);
      return { data: {} };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { rpm: 10 },
    client,
  );
  assert.deepEqual(puts, ['/api/governance/model-configs/mc-conflict']);
});

test('removeModelGovernance: deletes matching model-config', async () => {
  const deletes: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            model_configs: [
              {
                id: 'mc-del',
                model_name: 'gpt-4o',
                provider: 'openai',
                scope: 'virtual_key',
                scope_id: 'vk-1',
              },
            ],
          },
        };
      }
      throw new Error(url);
    },
    delete: async (url) => {
      deletes.push(url);
      return { data: {} };
    },
  });

  await governance.removeModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    client,
  );
  assert.deepEqual(deletes, ['/api/governance/model-configs/mc-del']);
});

test('removeMcpClientFromProjectVirtualKey: drops named client from mcp_configs', async () => {
  const puts: Array<{ body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: vkGetHandler({
      mcp_configs: [
        { mcp_client: { id: 'mc-1', name: 'artifact_store' }, tools_to_execute: ['*'] },
        { mcp_client: { id: 'mc-2', name: 'analytics_datasets_mcp' }, tools_to_execute: ['search'] },
      ],
    }),
    put: async (_url, body) => {
      puts.push({ body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.removeMcpClientFromProjectVirtualKey(PROJECT, 'analytics_datasets_mcp', client);

  const configs = puts[0].body.mcp_configs as Array<Record<string, unknown>>;
  assert.deepEqual(
    configs.map((c) => c.mcp_client_name),
    ['artifact_store'],
  );
});

test('attachPlatformMcpServersToProjectVirtualKey: appends platform MCP clients', async () => {
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'plat-1',
        name: 'artifact-store',
        deploymentType: 'platform',
        catalogId: 'artifact_store_mcp',
        llmproxyGatewayServerName: 'artifact_store',
        status: 'connected',
        syncStatus: 'synced',
      },
    ],
  });

  const puts: Array<{ body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: vkGetHandler({ mcp_configs: [] }),
    put: async (_url, body) => {
      puts.push({ body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.attachPlatformMcpServersToProjectVirtualKey(PROJECT, client);

  const configs = puts[0].body.mcp_configs as Array<Record<string, unknown>>;
  assert.ok(configs.some((c) => c.mcp_client_name === 'artifact_store'));
});

test('rotateProjectVirtualKey: native rotate updates K8s secret and metadata', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              value: 'sk-bf-old',
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        return { data: { secondary_key: 'sk-bf-rotated' } };
      }
      throw new Error(url);
    },
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(result.virtualKeyId, 'vk-1');
  assert.equal(result.secondaryKeyIssued, true);
  assert.equal(secretWritten, 'sk-bf-rotated');
});

test('teardownProjectGateway: deletes VK, team, and secret with preloaded gateway', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  let vkDeleted = false;
  let teamDeleted = false;
  let secretDeleted = false;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async (name: string) => {
          if (name === `as-proj-${PROJECT}-vk`) secretDeleted = true;
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') vkDeleted = true;
      if (url === '/api/governance/teams/team-1') teamDeleted = true;
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    {
      teamId: 'team-1',
      teamName: `as-proj-${PROJECT}`,
      virtualKeyId: 'vk-1',
      virtualKeyName: `as-proj-${PROJECT}-vk`,
    },
    client,
  );

  assert.equal(result.virtualKeyDeleted, true);
  assert.equal(result.teamDeleted, true);
  assert.equal(result.tokenSecretDeleted, true);
  assert.equal(vkDeleted, true);
  assert.equal(teamDeleted, true);
  assert.equal(secretDeleted, true);
});

test('teardownProjectGateway: tolerates deleteTeam 404 and deleteVirtualKey errors', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('gone');
        err.response = { status: 500 };
        throw err;
      }
      if (url === '/api/governance/teams/team-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { teamId: 'team-1', virtualKeyId: 'vk-1' },
    client,
  );

  assert.equal(result.virtualKeyDeleted, false);
  assert.equal(result.teamDeleted, true);
});

test('teardownProjectGateway: warns when deleteTeam fails with non-404', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => {
          const err: any = new Error('secret delete failed');
          throw err;
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') return { data: {} };
      if (url === '/api/governance/teams/team-1') {
        const err: any = new Error('team delete failed');
        err.response = { status: 500 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { teamId: 'team-1', virtualKeyId: 'vk-1' },
    client,
  );

  assert.equal(result.virtualKeyDeleted, true);
  assert.equal(result.teamDeleted, false);
  assert.equal(result.tokenSecretDeleted, false);
});

test('teardownProjectGateway: treats deleteVirtualKey 404 as deleted', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { virtualKeyId: 'vk-1' },
    client,
  );

  assert.equal(result.virtualKeyDeleted, true);
  assert.equal(result.teamDeleted, false);
});

test('teardownProjectGateway: deletes models and MCP servers with credential lookup', async () => {
  const deletedModels: string[] = [];
  const removedMcp: string[] = [];
  const gateway = {
    isEnabled: () => true,
    deleteModel: async (id: string) => {
      deletedModels.push(id);
    },
    removeMCPServer: async (serverId: string) => {
      removedMcp.push(serverId);
    },
  };

  scope.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async (_projectId: string, credentialId: string) =>
          credentialId === 'cred-1' ? { api_key: 'sk-from-cred' } : null,
      }),
    }),
  );
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  handle.repos.Model = makeFakeRepo({
    find: async () => [
      {
        id: 'mdl-1',
        projectId: PROJECT,
        name: 'gpt-4o',
        provider: 'openai',
        providerModelId: 'gpt-4o',
        gatewayBindingName: 'proj_cred_gpt-4o',
        credentialId: 'cred-1',
        rateCardOverride: { _gateway: { gatewayProvider: 'openai', keyName: 'as-cred-cred-1' } },
      },
    ],
  });
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'mcp-1',
        projectId: PROJECT,
        name: 'github',
        llmproxyGatewayServerName: `${PROJECT}_github`,
      },
    ],
  });

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return {
          data: {
            clients: [{ config: { id: 'gw-mcp-1', name: `${PROJECT}_github` } }],
          },
        };
      }
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async () => ({ data: {} }),
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.modelsFound, 1);
  assert.equal(result.modelsRemoved, 1);
  assert.equal(result.mcpServersFound, 1);
  assert.equal(result.mcpServersRemoved, 1);
  assert.deepEqual(deletedModels, ['mdl-1']);
  assert.ok(removedMcp.includes('gw-mcp-1'));
});

test('teardownProjectGateway: counts failures and falls back to project metadata cache', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => {
      throw new Error('delete model failed');
    },
    removeMCPServer: async () => {
      throw new Error('remove mcp failed');
    },
  };

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  handle.repos.Model = makeFakeRepo({
    find: async () => [{ id: 'mdl-bad', projectId: PROJECT, name: 'm', provider: 'openai' }],
  });
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'mcp-bad',
        projectId: PROJECT,
        name: 'jira',
        llmproxyGatewayServerId: 'gw-direct',
        llmproxyGatewayServerName: `${PROJECT}_jira`,
      },
    ],
  });
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {
          _gateway: { teamId: 'team-db', virtualKeyId: 'vk-db' },
        },
      };
    },
  });

  let deletedVk = '';
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-db') deletedVk = url;
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.modelsFailed, 1);
  assert.equal(result.mcpServersFailed, 1);
  assert.equal(result.virtualKeyDeleted, true);
  assert.equal(deletedVk, '/api/governance/virtual-keys/vk-db');
});

test('teardownProjectGateway: tolerates model and MCP enumeration failures', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({
    find: async () => {
      throw new Error('model enum failed');
    },
  });
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => {
      throw new Error('mcp enum failed');
    },
  });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { virtualKeyId: 'vk-1' },
    client,
  );
  assert.equal(result.modelsFound, 0);
  assert.equal(result.mcpServersFound, 0);
  assert.equal(result.tokenSecretDeleted, true);
});

test('deleteRetiredProjectVirtualKey: promotes secondary and clears rotation flags', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {
          _gateway: {
            teamId: 'team-1',
            virtualKeyId: 'vk-1',
            vkRotationPending: true,
            pendingRotationOldVirtualKeyId: 'vk-old',
          },
        },
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const posts: string[] = [];
  const client = makeBifrostClient({
    post: async (url) => {
      posts.push(url);
      return { data: {} };
    },
  });

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, client);
  assert.equal(result.deleted, true);
  assert.equal(result.method, 'promote-secondary');
  assert.ok(posts.some((u) => u.includes('/promote-secondary')));
});

test('deleteRetiredProjectVirtualKey: deletes legacy retired VK and clears pending id', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {
          _gateway: {
            virtualKeyId: 'vk-1',
            pendingRotationOldVirtualKeyId: 'vk-old',
          },
        },
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const deleted: string[] = [];
  const client = makeBifrostClient({
    delete: async (url) => {
      deleted.push(url);
      return { data: {} };
    },
  });

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, client);
  assert.equal(result.deleted, true);
  assert.equal(result.method, 'delete-legacy');
  assert.equal(result.retiredVirtualKeyId, 'vk-old');
  assert.ok(deleted.some((u) => u.includes('vk-old')));
});

test('deleteRetiredProjectVirtualKey: tolerates legacy retired VK 404', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: {
          virtualKeyId: 'vk-1',
          pendingRotationOldVirtualKeyId: 'vk-gone',
        },
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    delete: async () => {
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    },
  });

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, client);
  assert.equal(result.deleted, true);
  assert.equal(result.method, 'delete-legacy');
});

test('deleteRetiredProjectVirtualKey: rethrows legacy delete errors other than 404', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: {
          virtualKeyId: 'vk-1',
          pendingRotationOldVirtualKeyId: 'vk-old',
        },
      },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    delete: async () => {
      const err: any = new Error('forbidden');
      err.response = { status: 403 };
      throw err;
    },
  });

  await assert.rejects(
    () => governance.deleteRetiredProjectVirtualKey(PROJECT, client),
    /forbidden/,
  );
});

test('deleteRetiredProjectVirtualKey: returns false when no retired id remains', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: { _gateway: { virtualKeyId: 'vk-1' } },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, makeBifrostClient({}));
  assert.equal(result.deleted, false);
});

test('teardownProjectGateway: skips Bifrost when gateway disabled and deletes token secret', async () => {
  const gateway = { isEnabled: () => false };
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => gateway,
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any);
  assert.equal(result.modelsFound, 0);
  assert.equal(result.tokenSecretDeleted, true);
});

test('teardownProjectGateway: warns when token secret delete fails with gateway disabled', async () => {
  const gateway = { isEnabled: () => false };
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => gateway,
    }),
  );
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async () => {
          throw new Error('secret delete failed');
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any);
  assert.equal(result.tokenSecretDeleted, false);
});

test('deleteRetiredProjectVirtualKey: returns false when project is missing', async () => {
  handle.repos.Project = makeFakeRepo({ findOneBy: async () => null });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, makeBifrostClient({}));
  assert.equal(result.deleted, false);
});

test('deleteRetiredProjectVirtualKey: returns false when gateway has no virtual key', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: { _gateway: { teamId: 'team-1' } },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, makeBifrostClient({}));
  assert.equal(result.deleted, false);
});

test('deleteRetiredProjectVirtualKey: tolerates promote-secondary 404/405', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: { virtualKeyId: 'vk-1', vkRotationPending: true },
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    post: async () => {
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    },
  });

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, client);
  assert.equal(result.deleted, true);
  assert.equal(result.method, 'promote-secondary');
});

test('deleteRetiredProjectVirtualKey: tolerates promote-secondary 409/400', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: { virtualKeyId: 'vk-1', vkRotationPending: true },
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    post: async () => {
      const err: any = new Error('already finalized');
      err.response = { status: 409 };
      throw err;
    },
  });

  const result = await governance.deleteRetiredProjectVirtualKey(PROJECT, client);
  assert.equal(result.deleted, true);
});

test('deleteRetiredProjectVirtualKey: rethrows unexpected promote-secondary errors', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: { virtualKeyId: 'vk-1', vkRotationPending: true },
      },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    post: async () => {
      const err: any = new Error('upstream down');
      err.response = { status: 503 };
      throw err;
    },
  });

  await assert.rejects(
    () => governance.deleteRetiredProjectVirtualKey(PROJECT, client),
    /upstream down/,
  );
});

test('assignBuiltinModelsToProjectVirtualKey: no-ops on empty bindings', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.assignBuiltinModelsToProjectVirtualKey(PROJECT, [], client);
  assert.equal(putCalls, 0);
});

test('assignBuiltinModelsToProjectVirtualKey: no-ops when VK is missing in Bifrost', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: async (url: string) => {
      if (url.startsWith('/api/governance/virtual-keys/')) {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.assignBuiltinModelsToProjectVirtualKey(
    PROJECT,
    [{ provider: 'openai', modelId: 'gpt-4o-mini' }],
    client,
  );
  assert.equal(putCalls, 0);
});

test('assignBuiltinModelsToProjectVirtualKey: appends built-in bindings in one PUT', async () => {
  let lastBody: Record<string, unknown> | undefined;
  const client = makeBifrostClient({
    get: async (url: string) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            id: 'vk-1',
            provider_configs: [{ provider: 'openai', allowed_models: ['existing-model'], keys: [] }],
          },
        };
      }
      return { data: {} };
    },
    put: async (_url: string, body?: unknown) => {
      lastBody = body as Record<string, unknown>;
      return { data: {} };
    },
  });

  await governance.assignBuiltinModelsToProjectVirtualKey(
    PROJECT,
    [{ provider: 'openai', modelId: 'gpt-4o-mini', providerKeyId: 'key-1' }],
    client,
  );

  const configs = lastBody?.provider_configs as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(configs));
  const openai = configs.find((c) => c.provider === 'openai');
  assert.ok((openai?.allowed_models as string[]).includes('gpt-4o-mini'));
});

test('readProjectVirtualKeyToken: returns token from K8s secret', async () => {
  const token = await governance.readProjectVirtualKeyToken(PROJECT);
  assert.equal(token, 'sk-bf-test');
});

test('readProjectVirtualKeyToken: returns undefined when secret missing', async () => {
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const token = await governance.readProjectVirtualKeyToken(PROJECT);
  assert.equal(token, undefined);
});

test('deleteProjectVirtualKeyTokenSecret: swallows 404 and rethrows other errors', async () => {
  await governance.deleteProjectVirtualKeyTokenSecret(PROJECT);

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async () => {
          const err: any = new Error('missing');
          err.code = 404;
          throw err;
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  await governance.deleteProjectVirtualKeyTokenSecret(PROJECT);

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        writeSecret: async () => undefined,
        deleteSecret: async () => {
          throw new Error('delete failed');
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  await assert.rejects(() => governance.deleteProjectVirtualKeyTokenSecret(PROJECT), /delete failed/);
});

test('listProjectsForVirtualKeyRotation: returns only projects with gateway metadata', async () => {
  handle.repos.Project = makeFakeRepo({
    find: async () => [
      { id: 'proj-a', metadata: { _gateway: { teamId: 't1', virtualKeyId: 'vk-1' } } },
      { id: 'proj-b', metadata: { _gateway: { teamId: 't2' } } },
      { id: 'proj-c', metadata: {} },
    ],
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const ids = await governance.listProjectsForVirtualKeyRotation();
  assert.deepEqual(ids, ['proj-a']);
});

test('rotateProjectVirtualKey: skips when project or gateway missing', async () => {
  handle.repos.Project = makeFakeRepo({ findOneBy: async () => null });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  assert.equal((await governance.rotateProjectVirtualKey(PROJECT)).skipReason, 'project_not_found');

  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({ id: PROJECT, metadata: {} }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  assert.equal((await governance.rotateProjectVirtualKey(PROJECT)).skipReason, 'no_gateway');
});

test('assignModelGovernance: no-ops when all limits are zero or unset', async () => {
  let postCalls = 0;
  const client = makeBifrostClient({
    post: async () => {
      postCalls += 1;
      return { data: {} };
    },
  });
  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { rpm: 0, tpm: 0, spendingLimit: 0 },
    client,
  );
  assert.equal(postCalls, 0);
});

test('removeModelGovernance: matches configs without scope fields', async () => {
  let deletedUrl: string | undefined;
  const client = makeBifrostClient({
    get: async (url: string) => {
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            model_configs: [
              { id: 'mc-scopeless', model_name: 'gpt-4o', provider: 'openai' },
            ],
          },
        };
      }
      return { data: {} };
    },
    delete: async (url: string) => {
      deletedUrl = url;
      return { data: {} };
    },
  });
  await governance.removeModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    client,
  );
  assert.match(String(deletedUrl), /mc-scopeless/);
});

test('rotateProjectVirtualKey: retries pending rotation by re-syncing K8s secret', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: {
          teamId: 'team-1',
          virtualKeyId: 'vk-1',
          virtualKeyName: `as-proj-${PROJECT}-vk`,
          vkRotationPending: true,
        },
      },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', value: 'sk-bf-retry' } } };
      }
      throw new Error(url);
    },
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(result.secondaryKeyIssued, false);
  assert.equal(result.virtualKeyId, 'vk-1');
  assert.equal(secretWritten, 'sk-bf-retry');
});

test('assignModelGovernance: creates config when listModelConfigs fails', async () => {
  let postCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        throw new Error('list unavailable');
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/model-configs') postCalls += 1;
      return { data: { id: 'mc-fallback' } };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { rpm: 25 },
    client,
  );
  assert.equal(postCalls, 1);
});

test('removeModelGovernance: swallows deleteModelConfig failure', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            model_configs: [
              {
                id: 'mc-del-fail',
                model_name: 'gpt-4o',
                provider: 'openai',
                scope: 'virtual_key',
                scope_id: 'vk-1',
              },
            ],
          },
        };
      }
      throw new Error(url);
    },
    delete: async () => {
      throw new Error('delete failed');
    },
  });

  await governance.removeModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    client,
  );
});

test('ensureProjectGateway: recreates when cached team or VK is missing in Bifrost', async () => {
  const calls: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams/team-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-new', name: `as-proj-${PROJECT}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              {
                id: 'vk-new',
                name: `as-proj-${PROJECT}-vk`,
                team_id: 'team-stale',
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-stale',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      calls.push(`GET ${url}`);
      throw new Error(url);
    },
    put: async (url) => {
      calls.push(`PUT ${url}`);
      return { data: {} };
    },
  });

  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.teamId, 'team-new');
  assert.equal(gateway?.virtualKeyId, 'vk-new');
  assert.ok(calls.some((c) => c === 'PUT /api/governance/virtual-keys/vk-new'));
});

test('ensureProjectGateway: rebinds existing VK when team binding is stale', async () => {
  const puts: string[] = [];
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        name: 'Test Project',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-1', name: `as-proj-${PROJECT}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              {
                id: 'vk-existing',
                name: `as-proj-${PROJECT}-vk`,
                team_id: 'team-stale',
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-existing') {
        return {
          data: {
            virtual_key: {
              id: 'vk-existing',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-stale',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (url, body) => {
      puts.push(url);
      if (url === '/api/governance/virtual-keys/vk-existing') {
        assert.equal((body as Record<string, unknown>).team_id, 'team-1');
      }
      return { data: {} };
    },
  });

  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.teamId, 'team-1');
  assert.equal(gateway?.virtualKeyId, 'vk-existing');
  assert.ok(puts.some((u) => u === '/api/governance/virtual-keys/vk-existing'));
});

test('filterMcpConfigsToProject: drops cross-project clients and keeps platform ones', () => {
  const configs = [
    { mcp_client_name: `${PROJECT}_github` },
    { mcp_client_name: 'artifact_store' },
    { mcp_client_name: 'projother1_jira' },
  ];
  const filtered = governance.filterMcpConfigsToProject(configs, PROJECT);
  assert.deepEqual(
    filtered.map((c) => c.mcp_client_name),
    [`${PROJECT}_github`, 'artifact_store'],
  );
});

test('filterMcpConfigsToProject: returns configs unchanged when ownerProjectId missing', () => {
  const configs = [{ mcp_client_name: 'projother1_jira' }];
  assert.deepEqual(governance.filterMcpConfigsToProject(configs, undefined), configs);
});

test('computePlatformMcpConfigAdditions: appends missing synced platform clients', () => {
  const { configs, added } = governance.computePlatformMcpConfigAdditions(
    [{ mcp_client_name: 'artifact_store', tools_to_execute: ['*'] }],
    [
      {
        llmproxyGatewayServerName: 'artifact_store',
        syncStatus: 'synced',
        status: 'connected',
        catalogId: 'artifact_store_mcp',
      },
      {
        llmproxyGatewayServerName: 'analytics_datasets_mcp',
        syncStatus: 'synced',
        status: 'connected',
        catalogId: 'analytics_datasets_mcp',
      },
      {
        llmproxyGatewayServerName: 'broken_mcp',
        syncStatus: 'pending',
        status: 'connected',
        catalogId: 'artifact_store_mcp',
      },
    ],
    { webSearch: false, analytics: true },
  );
  assert.deepEqual(added, ['analytics_datasets_mcp']);
  assert.ok(configs.some((c) => c.mcp_client_name === 'analytics_datasets_mcp'));
  assert.equal(configs.length, 2);
});

test('toVkMcpConfigsWriteShape: normalizes GET read-shape and deduplicates names', () => {
  const normalized = governance.toVkMcpConfigsWriteShape([
    { mcp_client: { id: 'mc-1', name: 'artifact_store' }, tools_to_execute: ['search'] },
    { mcp_client_name: 'artifact_store', tools_to_execute: ['*'] },
    { mcp_client: { name: 'analytics_datasets_mcp' } },
  ]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], {
    mcp_client_name: 'artifact_store',
    tools_to_execute: ['search'],
    mcp_client_id: 'mc-1',
  });
});

test('toVkProviderConfigsWriteShape: flattens embedded key objects to key_ids', () => {
  const normalized = governance.toVkProviderConfigsWriteShape([
    {
      provider: 'openai',
      allowed_models: ['gpt-4o'],
      keys: [{ key_id: 'key-1' }, 'key-2'],
    },
  ]);
  assert.deepEqual(normalized[0].key_ids, ['key-1', 'key-2']);
  assert.equal((normalized[0] as Record<string, unknown>).keys, undefined);
});

test('projectIdFromVkName and projectVkNameMatches handle rotated suffixes', () => {
  assert.equal(governance.projectIdFromVkName(`as-proj-${PROJECT}-vk-r2`), PROJECT);
  assert.equal(governance.projectVkNameMatches(`as-proj-${PROJECT}-vk-r2`, PROJECT), true);
  assert.equal(governance.projectVkNameMatches('as-proj-other-vk', PROJECT), false);
});

test('rotateProjectVirtualKey: uses legacy create-and-replace when native rotate unsupported', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-r1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('not supported');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              token: 'sk-bf-legacy',
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(result.virtualKeyId, 'vk-r1');
  assert.equal(result.virtualKeyName, `as-proj-${PROJECT}-vk-r1`);
  assert.equal(result.secondaryKeyIssued, true);
  assert.equal(secretWritten, 'sk-bf-legacy');
});

test('ensureProjectGateway: reuses existing Bifrost team and creates missing VK', async () => {
  const FRESH = 'projreuse001';
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== FRESH) return null;
      return {
        id: FRESH,
        name: 'Reuse Team Project',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });

  const posts: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-existing', name: `as-proj-${FRESH}` }] } };
      }
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/virtual-keys/vk-created') {
        return {
          data: {
            virtual_key: {
              id: 'vk-created',
              name: `as-proj-${FRESH}-vk`,
              team_id: 'team-existing',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      posts.push(url);
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_key: {
              id: 'vk-created',
              name: `as-proj-${FRESH}-vk`,
              token: 'sk-bf-created',
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (url) => {
      posts.push(url);
      return { data: {} };
    },
  });

  const gateway = await governance.ensureProjectGateway(FRESH, client);
  assert.equal(gateway?.teamId, 'team-existing');
  assert.equal(gateway?.virtualKeyId, 'vk-created');
  assert.ok(!posts.some((u) => u === '/api/governance/teams'));
  assert.ok(posts.some((u) => u === '/api/governance/virtual-keys'));
});

test('ensureProjectGateway: reuses existing VK and self-heals K8s secret via update', async () => {
  const FRESH = 'projreuse002';
  let secretUpdated = false;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => {
          const err: any = new Error('already exists');
          err.code = 409;
          throw err;
        },
        updateSecret: async () => {
          secretUpdated = true;
        },
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== FRESH) return null;
      return {
        id: FRESH,
        name: 'Reuse VK Project',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-1', name: `as-proj-${FRESH}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              {
                id: 'vk-existing',
                name: `as-proj-${FRESH}-vk`,
                team_id: 'team-1',
                value: 'sk-bf-existing',
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-existing') {
        return {
          data: {
            virtual_key: {
              id: 'vk-existing',
              name: `as-proj-${FRESH}-vk`,
              team_id: 'team-1',
              value: 'sk-bf-existing',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const gateway = await governance.ensureProjectGateway(FRESH, client);
  assert.equal(gateway?.virtualKeyId, 'vk-existing');
  assert.equal(secretUpdated, true);
});

test('assignModelGovernance: rethrows when 409 conflict config cannot be relisted', async () => {
  let listCount = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        listCount += 1;
        return { data: { model_configs: [] } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/model-configs') {
        const err: any = new Error('conflict');
        err.response = { status: 409 };
        throw err;
      }
      return { data: {} };
    },
  });

  await assert.rejects(
    () =>
      governance.assignModelGovernance(
        PROJECT,
        { provider: 'openai', modelName: 'gpt-4o' },
        { rpm: 10 },
        client,
      ),
    /conflict/,
  );
  assert.equal(listCount, 2);
});

test('rotateProjectVirtualKey: skips when current VK missing in Bifrost', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      throw new Error(url);
    },
  });
  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, true);
  assert.equal(result.skipReason, 'current_vk_missing');
});

test('rotateProjectVirtualKey: throws when native rotate returns no bearer', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') return { data: {} };
      throw new Error(url);
    },
  });
  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /did not return a new sk-bf-/,
  );
});

test('rotateProjectVirtualKey: required K8s write failure fails rotation', async () => {
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => {
          throw new Error('create failed');
        },
        updateSecret: async () => {
          throw new Error('update failed');
        },
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        return { data: { secondary_key: 'sk-bf-rotated' } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /Failed to persist VK token Secret/,
  );
});

test('rotateProjectVirtualKey: falls back on native rotate 405', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-r1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('method not allowed');
        err.response = { status: 405 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              token: 'sk-bf-405-fallback',
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(result.virtualKeyId, 'vk-r1');
  assert.equal(secretWritten, 'sk-bf-405-fallback');
});

test('readProjectVirtualKeyToken: tolerates non-404 readSecret errors', async () => {
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => {
          const err: any = new Error('forbidden');
          err.code = 403;
          throw err;
        },
        writeSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  assert.equal(await governance.readProjectVirtualKeyToken(PROJECT), undefined);
});

test('teardownProjectGateway: sweepBifrostProjectOrphans removes naming-convention leftovers', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => {
      return undefined;
    },
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  scope.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => ({ api_key: 'sk-test' }),
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  let mcpRemoved = 0;
  let modelCfgDeleted = 0;
  let providerKeyPut = 0;
  let vkDeleted = 0;
  let teamDeleted = 0;

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return {
          data: {
            clients: [{ config: { id: 'mcp-orphan', name: `${prefix}github` } }],
          },
        };
      }
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            model_configs: [{ id: 'mc-orphan', model_name: `${prefix}gpt-4o` }],
          },
        };
      }
      if (url === '/api/providers') {
        return { data: { providers: [{ name: 'openai' }] } };
      }
      if (url === '/api/providers/openai/keys') {
        return {
          data: {
            keys: [
              {
                id: 'key-1',
                name: 'as-cred-cred-1',
                models: [`${prefix}gpt-4o`, 'other-model'],
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [{ id: 'vk-orphan', name: `as-proj-${PROJECT}-vk-r2` }],
          },
        };
      }
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-orphan', name: `as-proj-${PROJECT}` }] } };
      }
      throw new Error(url);
    },
    put: async (url) => {
      if (url.includes('/providers/openai/keys/')) providerKeyPut += 1;
      return { data: {} };
    },
    delete: async (url) => {
      if (url.includes('/model-configs/')) modelCfgDeleted += 1;
      if (url.includes('/virtual-keys/')) vkDeleted += 1;
      if (url.includes('/teams/')) teamDeleted += 1;
      return { data: {} };
    },
  });

  gateway.removeMCPServer = async () => {
    mcpRemoved += 1;
  };

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(mcpRemoved, 1);
  assert.equal(modelCfgDeleted, 1);
  assert.equal(providerKeyPut, 1);
  assert.ok(vkDeleted >= 1);
  assert.ok(teamDeleted >= 1);
  assert.equal(result.sweepMcpClientsRemoved, 1);
  assert.equal(result.sweepModelConfigsRemoved, 1);
  assert.equal(result.sweepProviderBindingsRemoved, 1);
  assert.equal(result.sweepVirtualKeysRemoved, 1);
  assert.equal(result.sweepTeamsRemoved, 1);
  assert.equal(result.virtualKeyDeleted, true);
  assert.equal(result.teamDeleted, true);
});

test('appendMcpClientToProjectVirtualKey: updates tools on existing client', async () => {
  const puts: Array<{ body: Record<string, unknown> }> = [];
  const client = makeBifrostClient({
    get: vkGetHandler({
      mcp_configs: [
        { mcp_client: { id: 'mc-1', name: 'artifact_store' }, tools_to_execute: ['*'] },
      ],
    }),
    put: async (_url, body) => {
      puts.push({ body: body as Record<string, unknown> });
      return { data: {} };
    },
  });

  await governance.appendMcpClientToProjectVirtualKey(PROJECT, 'artifact_store', ['search', 'read'], client);

  const configs = puts[0].body.mcp_configs as Array<Record<string, unknown>>;
  assert.deepEqual(configs[0].tools_to_execute, ['search', 'read']);
});

test('appendMcpClientToProjectVirtualKey: no-ops when VK missing in Bifrost', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      throw new Error(url);
    },
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.appendMcpClientToProjectVirtualKey(PROJECT, 'artifact_store', ['*'], client);
  assert.equal(putCalls, 0);
});

test('assignModelToProjectVirtualKey: no-ops when VK missing in Bifrost', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      throw new Error(url);
    },
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.assignModelToProjectVirtualKey(
    PROJECT,
    { provider: 'openai', modelId: 'gpt-4o', providerKeyId: 'key-1' },
    client,
  );
  assert.equal(putCalls, 0);
});

test('loadProjectGateway: ensures gateway when cache is incomplete', async () => {
  const PARTIAL = 'projpartial1';
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PARTIAL) return null;
      return {
        id: PARTIAL,
        name: 'Partial Gateway',
        metadata: { _gateway: { teamId: 'team-1' } },
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams/team-1') {
        return { data: { team: { id: 'team-1', name: `as-proj-${PARTIAL}` } } };
      }
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-1', name: `as-proj-${PARTIAL}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [{ id: 'vk-new', name: `as-proj-${PARTIAL}-vk`, team_id: 'team-1', value: 'sk-bf' }],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${PARTIAL}-vk`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const gateway = await governance.loadProjectGateway(PARTIAL, client);
  assert.equal(gateway?.teamId, 'team-1');
  assert.equal(gateway?.virtualKeyId, 'vk-new');
});

test('attachPlatformMcpServersToProjectVirtualKey: skips synthetic platform project', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.attachPlatformMcpServersToProjectVirtualKey('__platform__', client);
  assert.equal(putCalls, 0);
});

test('attachPlatformMcpServersToProjectVirtualKey: no-ops when no platform servers in DB', async () => {
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  let putCalls = 0;
  const client = makeBifrostClient({
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.attachPlatformMcpServersToProjectVirtualKey(PROJECT, client);
  assert.equal(putCalls, 0);
});

test('attachPlatformMcpServersToProjectVirtualKey: no-ops when platform clients already attached', async () => {
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'plat-1',
        name: 'artifact-store',
        deploymentType: 'platform',
        catalogId: 'artifact_store_mcp',
        llmproxyGatewayServerName: 'artifact_store',
        status: 'connected',
        syncStatus: 'synced',
      },
    ],
  });
  let putCalls = 0;
  const client = makeBifrostClient({
    get: vkGetHandler({
      mcp_configs: [{ mcp_client_name: 'artifact_store', tools_to_execute: ['*'] }],
    }),
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.attachPlatformMcpServersToProjectVirtualKey(PROJECT, client);
  assert.equal(putCalls, 0);
});

test('attachPlatformMcpServersToProjectVirtualKey: warns and skips when VK missing', async () => {
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'plat-1',
        name: 'artifact-store',
        deploymentType: 'platform',
        catalogId: 'artifact_store_mcp',
        llmproxyGatewayServerName: 'artifact_store',
        status: 'connected',
        syncStatus: 'synced',
      },
    ],
  });
  let putCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        const err: any = new Error('not found');
        err.response = { status: 404 };
        throw err;
      }
      throw new Error(url);
    },
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.attachPlatformMcpServersToProjectVirtualKey(PROJECT, client);
  assert.equal(putCalls, 0);
});

test('removeMcpClientFromProjectVirtualKey: no-ops when client not present', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: vkGetHandler({
      mcp_configs: [{ mcp_client_name: 'artifact_store', tools_to_execute: ['*'] }],
    }),
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.removeMcpClientFromProjectVirtualKey(PROJECT, 'missing_mcp', client);
  assert.equal(putCalls, 0);
});

test('removeMcpClientFromProjectVirtualKey: no-ops when mcp_configs is not an array', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: vkGetHandler({ mcp_configs: 'invalid' as unknown as [] }),
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.removeMcpClientFromProjectVirtualKey(PROJECT, 'artifact_store', client);
  assert.equal(putCalls, 0);
});

test('assignModelGovernance: maps day and week spending periods', async () => {
  const posts: unknown[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/api/governance/model-configs') posts.push(body);
      return { data: { id: 'mc-day' } };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { spendingLimit: 10, spendingLimitPeriod: 'day' },
    client,
  );
  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o-mini' },
    { tpm: 2000 },
    client,
  );

  assert.equal(posts.length, 2);
  assert.deepEqual((posts[0] as Record<string, unknown>).budget, { max_limit: 10, reset_duration: '1d' });
  const rateLimit = (posts[1] as Record<string, unknown>).rate_limit as Record<string, unknown>;
  assert.equal(rateLimit.token_max_limit, 2000);
});

test('rotateProjectVirtualKey: retry path without VK token skips K8s write', async () => {
  let secretWritten = false;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => {
          secretWritten = true;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: {
          teamId: 'team-1',
          virtualKeyId: 'vk-1',
          pendingRotationOldVirtualKeyId: 'vk-old',
        },
      },
    }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(result.secondaryKeyIssued, false);
  assert.equal(secretWritten, false);
});

test('rotateProjectVirtualKey: native rotate accepts string bearer response', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        return { data: '  sk-bf-string-bearer  ' };
      }
      throw new Error(url);
    },
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(secretWritten, 'sk-bf-string-bearer');
});

test('rotateProjectVirtualKey: legacy rotation increments r-suffix from r1 to r2', async () => {
  let createdVkName: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async () => ({
      id: PROJECT,
      metadata: {
        _gateway: {
          teamId: 'team-1',
          teamName: `as-proj-${PROJECT}`,
          virtualKeyId: 'vk-r1',
          virtualKeyName: `as-proj-${PROJECT}-vk-r1`,
        },
      },
    }),
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-r1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-r2') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r2',
              name: `as-proj-${PROJECT}-vk-r2`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/api/governance/virtual-keys/vk-r1/rotate') {
        const err: any = new Error('not supported');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        createdVkName = (body as Record<string, unknown>).name as string;
        return {
          data: {
            key: { id: 'vk-r2', name: createdVkName, value: 'sk-bf-r2' },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(createdVkName, `as-proj-${PROJECT}-vk-r2`);
  assert.equal(result.virtualKeyName, `as-proj-${PROJECT}-vk-r2`);
});

test('rotateProjectVirtualKey: legacy rotation throws when createVirtualKey omits bearer', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-r1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('not supported');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_key: { id: 'vk-r1', name: `as-proj-${PROJECT}-vk-r1` } } };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /did not return bearer/,
  );
});

test('teardownProjectGateway: resolves MCP server id from Bifrost client index', async () => {
  const gateway: any = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  const removed: string[] = [];

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({
    find: async () => [
      {
        id: 'mcp-no-id',
        projectId: PROJECT,
        name: 'jira',
        llmproxyGatewayServerName: `${PROJECT}_jira`,
        llmproxyGatewayServerId: null,
      },
    ],
  });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  gateway.removeMCPServer = async (serverId: string) => {
    removed.push(serverId);
  };

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return {
          data: {
            clients: [{ config: { id: 'gw-resolved', name: `${PROJECT}_jira` } }],
          },
        };
      }
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { virtualKeyId: 'vk-1' },
    client,
  );
  assert.ok(removed.includes('gw-resolved'));
  assert.equal(result.mcpServersRemoved, 1);
});

test('teardownProjectGateway: sweep deletes provider key when all models are project-scoped', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  const deletedKeys: string[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url === '/api/providers/openai/keys') {
        return {
          data: {
            keys: [{ id: 'key-only', name: 'as-cred-cred-1', models: [`${prefix}only`] }],
          },
        };
      }
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/keys/key-only')) deletedKeys.push(url);
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(
    PROJECT,
    gateway as any,
    { virtualKeyId: 'vk-1' },
    client,
  );
  assert.ok(deletedKeys.some((u) => u.includes('key-only')));
  assert.equal(result.sweepProviderBindingsRemoved, 1);
});

test('ensureProjectGateway: throws when existing team has no id', async () => {
  const BAD = 'projbadteam1';
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== BAD) return null;
      return {
        id: BAD,
        name: 'Bad Team',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
  });

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ name: `as-proj-${BAD}` }] } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.ensureProjectGateway(BAD, client),
    /exists but has no id/,
  );
});

test('rotateProjectVirtualKey: legacy rotation throws when createVirtualKey omits id', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              mcp_configs: [{ mcp_client_name: `${PROJECT}_github`, tools_to_execute: ['search'] }],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('not supported');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_key: { name: `as-proj-${PROJECT}-vk-r1` } } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /did not return id/,
  );
});

test('rotateProjectVirtualKey: rethrows non-unsupported native rotate errors', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('upstream down');
        err.response = { status: 503 };
        throw err;
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /upstream down/,
  );
});

test('assignModelGovernance: maps week spending period and finds config in data array', async () => {
  const puts: unknown[] = [];
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') {
        return {
          data: {
            data: [
              {
                id: 'mc-data',
                model_name: 'gpt-4o',
                provider: 'openai',
                scope: 'virtual_key',
                scope_id: 'vk-1',
              },
            ],
          },
        };
      }
      throw new Error(url);
    },
    put: async (url, body) => {
      if (url === '/api/governance/model-configs/mc-data') puts.push(body);
      return { data: {} };
    },
  });

  await governance.assignModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    { spendingLimit: 50, spendingLimitPeriod: 'week', rpm: 5 },
    client,
  );

  assert.equal(puts.length, 1);
  const body = puts[0] as Record<string, unknown>;
  assert.deepEqual(body.budget, { max_limit: 50, reset_duration: '1w' });
  assert.deepEqual((body.rate_limit as Record<string, unknown>).request_max_limit, 5);
});

test('removeModelGovernance: returns early when listModelConfigs fails', async () => {
  let deleteCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/model-configs') throw new Error('list down');
      return { data: {} };
    },
    delete: async () => {
      deleteCalls += 1;
      return { data: {} };
    },
  });
  await governance.removeModelGovernance(
    PROJECT,
    { provider: 'openai', modelName: 'gpt-4o' },
    client,
  );
  assert.equal(deleteCalls, 0);
});

test('teardownProjectGateway: sweep tolerates per-item cleanup failures', async () => {
  const gateway: any = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => {
      throw new Error('sweep mcp remove failed');
    },
  };

  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });

  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [{ config: { id: 'mcp-1', name: `${prefix}tool` } }] } };
      }
      if (url === '/api/governance/model-configs') {
        return { data: { model_configs: [{ id: 'mc-404', model_name: `${prefix}model` }] } };
      }
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_keys: [{ id: 'vk-404', name: `as-proj-${PROJECT}-vk` }] } };
      }
      if (url === '/api/governance/teams') return { data: { teams: [{ id: 'team-404', name: `as-proj-${PROJECT}` }] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/model-configs/mc-404')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      if (url.includes('/virtual-keys/vk-404')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      if (url.includes('/teams/team-404')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway, { virtualKeyId: 'vk-main' }, client);
  assert.equal(result.sweepMcpClientsRemoved, 0);
  assert.equal(result.sweepModelConfigsRemoved, 0);
  assert.equal(result.sweepVirtualKeysRemoved, 1);
  assert.equal(result.sweepTeamsRemoved, 1);
});

test('ensureProjectGateway: throws when existing virtual key has no id', async () => {
  const BADVK = 'projbadvk01';
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== BADVK) return null;
      return {
        id: BADVK,
        name: 'Bad VK',
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
  });

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-1', name: `as-proj-${BADVK}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_keys: [{ name: `as-proj-${BADVK}-vk` }] } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.ensureProjectGateway(BADVK, client),
    /exists but has no id/,
  );
});

test('ensureProjectGateway: skips K8s write when secret already populated', async () => {
  const FRESH = 'projsecretok1';
  let createCalls = 0;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => ({ virtual_key_token: 'existing-token' }),
        createSecret: async () => {
          createCalls += 1;
        },
        updateSecret: async () => {
          createCalls += 1;
        },
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== FRESH) return null;
      return {
        id: FRESH,
        metadata: {
          _gateway: { teamId: 'team-1', virtualKeyId: 'vk-1', virtualKeyName: `as-proj-${FRESH}-vk` },
        },
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams/team-1') {
        return { data: { team: { id: 'team-1' } } };
      }
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${FRESH}-vk` } } };
      }
      throw new Error(url);
    },
  });

  await governance.ensureProjectGateway(FRESH, client);
  assert.equal(createCalls, 0);
});

test('unassignModelFromProjectVirtualKey: no-ops when provider_configs missing', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: vkGetHandler({ provider_configs: undefined }),
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.unassignModelFromProjectVirtualKey(
    PROJECT,
    { provider: 'openai', modelId: 'gpt-4o' },
    client,
  );
  assert.equal(putCalls, 0);
});

test('ensureProjectGateway: rebinds VK using nested team object on GET', async () => {
  const puts: Array<Record<string, unknown>> = [];
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ id: 'team-1', name: `as-proj-${PROJECT}` }] } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              {
                id: 'vk-nested',
                name: `as-proj-${PROJECT}-vk`,
                team: { id: 'team-stale' },
                value: 'sk-bf-nested',
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-nested') {
        return {
          data: {
            virtual_key: {
              id: 'vk-nested',
              name: `as-proj-${PROJECT}-vk`,
              team: { id: 'team-stale' },
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (_url, body) => {
      puts.push(body as Record<string, unknown>);
      return { data: {} };
    },
  });

  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.virtualKeyId, 'vk-nested');
  assert.ok(puts.some((b) => b.team_id === 'team-1'));
});

test('rotateProjectVirtualKey: native rotate extracts token from nested virtual_key', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        return { data: { virtual_key: { api_key: 'sk-bf-nested-rotate' } } };
      }
      throw new Error(url);
    },
  });

  const result = await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.equal(result.skipped, false);
  assert.equal(secretWritten, 'sk-bf-nested-rotate');
});

test('rotateProjectVirtualKey: legacy rotation copies provider and mcp bindings', async () => {
  let createBody: Record<string, unknown> | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-1',
              provider_configs: [
                { provider: 'openai', allowed_models: ['m1'], keys: [{ key_id: 'k1' }] },
              ],
              mcp_configs: [
                { mcp_client: { name: `${PROJECT}_github` }, tools_to_execute: ['search'] },
                { mcp_client_name: 'projother1_jira', tools_to_execute: ['*'] },
              ],
            },
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-r1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-r1',
              name: `as-proj-${PROJECT}-vk-r1`,
              team_id: 'team-1',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        const err: any = new Error('not supported');
        err.response = { status: 404 };
        throw err;
      }
      if (url === '/api/governance/virtual-keys') {
        createBody = body as Record<string, unknown>;
        return {
          data: {
            id: 'vk-r1',
            name: `as-proj-${PROJECT}-vk-r1`,
            value: 'sk-bf-copy',
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  await governance.rotateProjectVirtualKey(PROJECT, client);
  assert.ok(createBody);
  const providers = createBody!.provider_configs as Array<Record<string, unknown>>;
  const mcps = createBody!.mcp_configs as Array<Record<string, unknown>>;
  assert.equal(providers[0].provider, 'openai');
  assert.deepEqual(providers[0].keys, [{ key_id: 'k1' }]);
  assert.equal(mcps.length, 1);
  assert.equal(mcps[0].mcp_client_name, `${PROJECT}_github`);
  assert.deepEqual(mcps[0].tools_to_execute, ['search']);
});

test('resolveProjectVirtualKeyId: matches rotated VK suffix', async () => {
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [{ id: 'vk-r2', name: `as-proj-${PROJECT}-vk-r2` }],
          },
        };
      }
      throw new Error(url);
    },
  });
  assert.equal(await governance.resolveProjectVirtualKeyId(PROJECT, client), 'vk-r2');
});

test('removeMcpClientFromProjectVirtualKey: no-ops when mcp client not present', async () => {
  let putCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              mcp_configs: [{ mcp_client_name: `${PROJECT}_other` }],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => {
      putCalls += 1;
      return { data: {} };
    },
  });
  await governance.removeMcpClientFromProjectVirtualKey(PROJECT, `${PROJECT}_missing`, client);
  assert.equal(putCalls, 0);
});

test('teardownProjectGateway: sweep no-ops when gateway disabled', async (t) => {
  const scope2 = restoreScope();
  t.after(() => scope2.restoreAll());
  scope2.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const gateway = { isEnabled: () => false, deleteModel: async () => undefined, removeMCPServer: async () => undefined };
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any);
  assert.equal(result.modelsRemoved, 0);
  assert.equal(result.sweepTeamsRemoved, 0);
});

test('teardownProjectGateway: sweep tolerates removeMCPServer failures', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => {
      throw new Error('mcp remove failed');
    },
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [{ config: { id: 'mcp-1', name: `${prefix}srv` } }] } };
      }
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async () => ({ data: {} }),
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepMcpClientsRemoved, 0);
});

test('teardownProjectGateway: sweep swallows 404 model-config deletes', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  let deleteCalls = 0;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') {
        return { data: { model_configs: [{ id: 'mc-404', model_name: `${prefix}m1` }] } };
      }
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      deleteCalls += 1;
      if (url.includes('/model-configs/')) {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.ok(deleteCalls >= 1);
  assert.equal(result.sweepModelConfigsRemoved, 0);
});

test('teardownProjectGateway: sweep deletes whole provider key when all models are project-scoped', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const prefix = `${PROJECT}_`;
  let keyDeleted = false;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url === '/api/providers/openai/keys') {
        return {
          data: {
            keys: [{ id: 'key-1', name: 'as-cred-cred-1', models: [`${prefix}only`] }],
          },
        };
      }
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/keys/')) keyDeleted = true;
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(keyDeleted, true);
  assert.ok(result.sweepProviderBindingsRemoved >= 1);
});

test('teardownProjectGateway: sweep counts 404 virtual-key delete as removed', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_keys: [{ id: 'vk-1', name: `as-proj-${PROJECT}-vk` }] } };
      }
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/virtual-keys/')) {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepVirtualKeysRemoved, 1);
});

test('teardownProjectGateway: sweep deletes matching team by name', async () => {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  let teamDeleted = false;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ team_id: 'team-1', name: `as-proj-${PROJECT}` }] } };
      }
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/teams/')) teamDeleted = true;
      return { data: {} };
    },
  });

  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(teamDeleted, true);
  assert.equal(result.sweepTeamsRemoved, 1);
});

test('rotateProjectVirtualKey: rejects empty rotated token when K8s write required', async () => {
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1') {
        return { data: { virtual_key: { id: 'vk-1', name: `as-proj-${PROJECT}-vk` } } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys/vk-1/rotate') {
        return { data: { secondary_key: '' } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.rotateProjectVirtualKey(PROJECT, client),
    /did not return a new sk-bf/,
  );
});

test('ensureProjectGateway: creates team and VK when none exist', async () => {
  let secretWritten: string | undefined;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async (_ns: string, _name: string, data: Record<string, string>) => {
          secretWritten = data.virtual_key_token;
        },
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${PROJECT}-vk`,
              team_id: 'team-new',
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url, body) => {
      if (url === '/api/governance/teams') {
        return { data: { team: { id: 'team-new', name: `as-proj-${PROJECT}` } } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_key: {
              id: 'vk-new',
              name: `as-proj-${PROJECT}-vk`,
              value: 'sk-bf-created',
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.teamId, 'team-new');
  assert.equal(gateway?.virtualKeyId, 'vk-new');
  assert.equal(secretWritten, 'sk-bf-created');
});

test('ensureProjectGateway: rebinds stale VK team binding', async () => {
  const puts: Array<Record<string, unknown>> = [];
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => ({ virtual_key_token: 'sk-existing' }),
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {
          _gateway: { teamId: 'team-1', virtualKeyName: `as-proj-${PROJECT}-vk` },
        },
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
    update: async () => ({ affected: 1 }),
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams/team-1') {
        return { data: { team: { id: 'team-1', name: `as-proj-${PROJECT}` } } };
      }
      if (url === '/api/governance/virtual-keys') {
        return {
          data: {
            virtual_keys: [
              {
                id: 'vk-1',
                name: `as-proj-${PROJECT}-vk`,
                team: { id: 'team-stale' },
                value: 'sk-existing',
              },
            ],
          },
        };
      }
      if (url === '/api/governance/virtual-keys/vk-1') {
        return {
          data: {
            virtual_key: {
              id: 'vk-1',
              name: `as-proj-${PROJECT}-vk`,
              team: { id: 'team-stale' },
              provider_configs: [],
              mcp_configs: [],
            },
          },
        };
      }
      throw new Error(url);
    },
    put: async (_url, body) => {
      puts.push(body as Record<string, unknown>);
      return { data: {} };
    },
  });

  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.virtualKeyId, 'vk-1');
  assert.ok(puts.some((b) => b.team_id === 'team-1'));
});

test('ensureProjectGateway: throws when matched team has no id', async () => {
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) => {
      if (id !== PROJECT) return null;
      return {
        id: PROJECT,
        metadata: {},
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-01'),
        home_dir: '/tmp',
        init_status: 'ready',
        init_error: null,
      };
    },
  });
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') {
        return { data: { teams: [{ name: `as-proj-${PROJECT}` }] } };
      }
      throw new Error(url);
    },
  });

  await assert.rejects(
    () => governance.ensureProjectGateway(PROJECT, client),
    /exists but has no id/,
  );
});

test('writeProjectVirtualKeyTokenSecret: updates secret after create 409', async () => {
  let updated = false;
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => {
          const err: any = new Error('exists');
          err.code = 409;
          throw err;
        },
        updateSecret: async () => {
          updated = true;
        },
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');

  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') return { data: { teams: [{ id: 'team-1', name: `as-proj-${PROJECT}` }] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: { id: 'vk-new', name: `as-proj-${PROJECT}-vk`, team_id: 'team-1', provider_configs: [], mcp_configs: [] },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys') {
        return { data: { id: 'vk-new', name: `as-proj-${PROJECT}-vk`, value: 'sk-bf-409-update' } };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });

  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) =>
      id === PROJECT
        ? {
            id: PROJECT,
            metadata: {},
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            home_dir: '/tmp',
            init_status: 'ready',
            init_error: null,
          }
        : null,
    update: async () => ({ affected: 1 }),
  });

  await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(updated, true);
});

function makeSweepGateway() {
  const gateway = {
    isEnabled: () => true,
    deleteModel: async () => undefined,
    removeMCPServer: async () => undefined,
  };
  handle.repos.Model = makeFakeRepo({ find: async () => [] });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => undefined,
        updateSecret: async () => undefined,
        deleteSecret: async () => undefined,
      }),
    }),
  );
  scope.add(
    mockModule('services/CredentialService', {
      getCredentialService: () => ({
        readSecretData: async () => {
          throw new Error('cred unreadable');
        },
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  return gateway;
}

test('teardownProjectGateway: sweep tolerates MCP client list failure', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') throw new Error('mcp list down');
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepMcpClientsRemoved, 0);
});

test('teardownProjectGateway: sweep tolerates removeMCPServer failure', async () => {
  const gateway = makeSweepGateway();
  const prefix = `${PROJECT}_`;
  gateway.removeMCPServer = async () => {
    throw new Error('remove mcp failed');
  };
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') {
        return { data: { clients: [{ config: { id: 'mcp-1', name: `${prefix}srv` } }] } };
      }
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepMcpClientsRemoved, 0);
});

test('teardownProjectGateway: sweep tolerates model-config list failure', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') throw new Error('model configs down');
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepModelConfigsRemoved, 0);
});

test('teardownProjectGateway: sweep ignores deleteModelConfig 404', async () => {
  const gateway = makeSweepGateway();
  const prefix = `${PROJECT}_`;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') {
        return { data: { model_configs: [{ id: 'mc-1', model_name: `${prefix}gpt` }] } };
      }
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/model-configs/')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepModelConfigsRemoved, 0);
});

test('teardownProjectGateway: sweep deletes provider key when all models are project-scoped', async () => {
  const gateway = makeSweepGateway();
  const prefix = `${PROJECT}_`;
  let keyDeleted = false;
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [{ name: 'openai' }] } };
      if (url === '/api/providers/openai/keys') {
        return {
          data: {
            keys: [{ id: 'key-all', name: 'as-cred-c1', models: [`${prefix}gpt-4o`] }],
          },
        };
      }
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/providers/openai/keys/')) keyDeleted = true;
      return { data: {} };
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(keyDeleted, true);
  assert.equal(result.sweepProviderBindingsRemoved, 1);
});

test('teardownProjectGateway: sweep tolerates provider key scan failure', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') throw new Error('providers down');
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepProviderBindingsRemoved, 0);
});

test('teardownProjectGateway: sweep counts VK removed on 404 delete', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') {
        return { data: { virtual_keys: [{ id: 'vk-gone', name: `as-proj-${PROJECT}-vk` }] } };
      }
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
    delete: async (url) => {
      if (url.includes('/virtual-keys/')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      return { data: {} };
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepVirtualKeysRemoved, 1);
});

test('teardownProjectGateway: sweep tolerates virtual-key list failure', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') throw new Error('vk list down');
      if (url === '/api/governance/teams') return { data: { teams: [] } };
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepVirtualKeysRemoved, 0);
});

test('teardownProjectGateway: sweep tolerates team list failure', async () => {
  const gateway = makeSweepGateway();
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/mcp/clients') return { data: { clients: [] } };
      if (url === '/api/governance/model-configs') return { data: { model_configs: [] } };
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/teams') throw new Error('teams down');
      throw new Error(url);
    },
  });
  const result = await governance.teardownProjectGateway(PROJECT, gateway as any, undefined, client);
  assert.equal(result.sweepTeamsRemoved, 0);
});

test('writeProjectVirtualKeyTokenSecret: logs-only when both create and update fail', async () => {
  scope.add(
    mockModule('services/K8sSecretService', {
      getK8sSecretService: () => ({
        readSecret: async () => null,
        createSecret: async () => {
          throw new Error('create failed');
        },
        updateSecret: async () => {
          throw new Error('update failed');
        },
        deleteSecret: async () => undefined,
      }),
    }),
  );
  governance = loadFresh<GovernanceModule>('services/bifrost/bifrostProjectGovernance');
  const client = makeBifrostClient({
    get: async (url) => {
      if (url === '/api/governance/teams') return { data: { teams: [{ id: 'team-1', name: `as-proj-${PROJECT}` }] } };
      if (url === '/api/governance/virtual-keys') return { data: { virtual_keys: [] } };
      if (url === '/api/governance/virtual-keys/vk-new') {
        return {
          data: {
            virtual_key: { id: 'vk-new', name: `as-proj-${PROJECT}-vk`, team_id: 'team-1', provider_configs: [], mcp_configs: [] },
          },
        };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url === '/api/governance/virtual-keys') {
        return { data: { id: 'vk-new', name: `as-proj-${PROJECT}-vk`, value: 'sk-bf-log-only' } };
      }
      throw new Error(url);
    },
    put: async () => ({ data: {} }),
  });
  handle.repos.Project = makeFakeRepo({
    findOneBy: async ({ id }: { id?: string }) =>
      id === PROJECT
        ? {
            id: PROJECT,
            metadata: {},
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            home_dir: '/tmp',
            init_status: 'ready',
            init_error: null,
          }
        : null,
    update: async () => ({ affected: 1 }),
  });
  const gateway = await governance.ensureProjectGateway(PROJECT, client);
  assert.equal(gateway?.virtualKeyId, 'vk-new');
});

