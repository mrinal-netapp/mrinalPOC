/**
 * Unit tests for `services/bifrost/bifrostOps.ts`.
 *
 * Run: node --require ts-node/register --test tests/bifrostOps.unit.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import {
  listTeams,
  createTeam,
  getTeam,
  listVirtualKeys,
  getVirtualKey,
  listVirtualKeysArray,
  createVirtualKey,
  updateVirtualKey,
  deleteVirtualKey,
  rotateVirtualKey,
  promoteSecondaryVirtualKey,
  deleteTeam,
  listBudgets,
  listRateLimits,
  listModelConfigs,
  createModelConfig,
  updateModelConfig,
  deleteModelConfig,
  getLogStats,
  getLogTokenSplit,
  createBifrostClient,
} from '../services/bifrost/bifrostOps';

function makeErr(status: number, message = 'error') {
  const err: any = new Error(message);
  err.response = { status };
  return err;
}

// ─── listVirtualKeysArray ─────────────────────────────────────────────────────

test('listVirtualKeysArray: unwraps array and object shapes', () => {
  assert.deepEqual(listVirtualKeysArray([{ id: '1' }]), [{ id: '1' }]);
  assert.deepEqual(listVirtualKeysArray({ virtual_keys: [{ id: 'vk' }] }), [{ id: 'vk' }]);
  assert.deepEqual(listVirtualKeysArray({ keys: [{ id: 'k' }] }), [{ id: 'k' }]);
  assert.deepEqual(listVirtualKeysArray({}), []);
});

// ─── teams / virtual keys ─────────────────────────────────────────────────────

test('listTeams: unwraps teams array', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/governance/teams') return { data: { teams: [{ id: 't1' }] } };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await listTeams(fake), [{ id: 't1' }]);
});

test('listTeams: returns [] when response has no teams array', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/governance/teams') return { data: { count: 0 } };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await listTeams(fake), []);
});

test('listTeams: returns bare array when response is already an array', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/governance/teams') return { data: [{ id: 't-array' }] };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await listTeams(fake), [{ id: 't-array' }]);
});

test('getTeam: unwraps bare team object without team wrapper', async () => {
  const fake = {
    get: async () => ({ data: { id: 't-bare', name: 'as-proj-x' } }),
  } as unknown as AxiosInstance;
  const team = await getTeam('t-bare', fake);
  assert.equal(team?.id, 't-bare');
  assert.equal(team?.name, 'as-proj-x');
});

test('getVirtualKey: unwraps bare VK object without virtual_key wrapper', async () => {
  const fake = {
    get: async () => ({ data: { id: 'vk-bare', name: 'proj-vk', value: 'sk-bf-x' } }),
  } as unknown as AxiosInstance;
  const vk = await getVirtualKey('vk-bare', fake);
  assert.equal(vk?.id, 'vk-bare');
  assert.equal(vk?.value, 'sk-bf-x');
});

test('createTeam: unwraps team object', async () => {
  const fake = {
    post: async (url: string, body: unknown) => {
      if (url === '/api/governance/teams') return { data: { team: { id: 't-new', ...(body as object) } } };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  const team = await createTeam({ name: 'as-proj-x' }, fake);
  assert.equal(team.id, 't-new');
  assert.equal(team.name, 'as-proj-x');
});

test('getTeam: returns null on 404 and rethrows other errors', async () => {
  const fake404 = {
    get: async () => {
      throw makeErr(404);
    },
  } as unknown as AxiosInstance;
  assert.equal(await getTeam('missing', fake404), null);

  const fake500 = {
    get: async () => {
      throw makeErr(500);
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => getTeam('x', fake500));
});

test('getVirtualKey: unwraps virtual_key and returns null on 404', async () => {
  const fake = {
    get: async (url: string) => {
      if (url.startsWith('/api/governance/virtual-keys/vk-1')) {
        return { data: { virtual_key: { id: 'vk-1', name: 'proj-vk' } } };
      }
      throw makeErr(404);
    },
  } as unknown as AxiosInstance;
  const vk = await getVirtualKey('vk-1', fake);
  assert.equal(vk?.id, 'vk-1');
  assert.equal(await getVirtualKey('missing', fake), null);
});

test('getVirtualKey: unwraps data.key and rethrows non-404 errors', async () => {
  const keyShape = {
    get: async () => ({ data: { key: { id: 'vk-key', name: 'from-key' } } }),
  } as unknown as AxiosInstance;
  const vk = await getVirtualKey('vk-key', keyShape);
  assert.equal(vk?.id, 'vk-key');

  const errShape = {
    get: async () => {
      throw makeErr(503);
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => getVirtualKey('vk-x', errShape));
});

test('virtual key CRUD and rotation helpers hit expected paths', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      return { data: { keys: [{ id: 'vk-1' }] } };
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      return { data: { ok: true } };
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: { ok: true } };
    },
    delete: async (url: string) => {
      calls.push({ method: 'delete', url });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  await listVirtualKeys(fake);
  await createVirtualKey({ name: 'vk' }, fake);
  await updateVirtualKey('vk-1', { name: 'renamed' }, fake);
  await deleteVirtualKey('vk-1', fake);
  await rotateVirtualKey('vk-1', { grace_hours: 24 }, fake);
  await promoteSecondaryVirtualKey('vk-1', fake);

  assert.ok(calls.some((c) => c.method === 'get' && c.url === '/api/governance/virtual-keys'));
  assert.ok(calls.some((c) => c.method === 'post' && c.url === '/api/governance/virtual-keys'));
  assert.ok(calls.some((c) => c.method === 'put' && c.url === '/api/governance/virtual-keys/vk-1'));
  assert.ok(calls.some((c) => c.method === 'delete' && c.url === '/api/governance/virtual-keys/vk-1'));
  assert.ok(
    calls.some((c) => c.method === 'post' && c.url === '/api/governance/virtual-keys/vk-1/rotate'),
  );
  assert.ok(
    calls.some(
      (c) => c.method === 'post' && c.url === '/api/governance/virtual-keys/vk-1/promote-secondary',
    ),
  );
});

test('deleteTeam: 404-tolerant', async () => {
  const fake404 = {
    delete: async () => {
      throw makeErr(404);
    },
  } as unknown as AxiosInstance;
  await deleteTeam('gone', fake404);

  const fake500 = {
    delete: async () => {
      throw makeErr(500);
    },
  } as unknown as AxiosInstance;
  await assert.rejects(() => deleteTeam('x', fake500));
});

// ─── budgets / rate limits / model configs ────────────────────────────────────

test('listBudgets, listRateLimits, listModelConfigs return response data', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/governance/budgets') return { data: { budgets: [{ id: 'b1' }] } };
      if (url === '/api/governance/rate-limits') return { data: [{ id: 'rl1' }] };
      if (url === '/api/governance/model-configs') return { data: { configs: [{ id: 'mc1' }] } };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;
  assert.deepEqual(await listBudgets(fake), { budgets: [{ id: 'b1' }] });
  assert.deepEqual(await listRateLimits(fake), [{ id: 'rl1' }]);
  assert.deepEqual(await listModelConfigs(fake), { configs: [{ id: 'mc1' }] });
});

test('model config CRUD hits expected paths', async () => {
  const calls: string[] = [];
  const fake = {
    post: async (url: string) => {
      calls.push(`post ${url}`);
      return { data: { id: 'mc-new' } };
    },
    put: async (url: string) => {
      calls.push(`put ${url}`);
      return { data: { id: 'mc-1' } };
    },
    delete: async (url: string) => {
      calls.push(`delete ${url}`);
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  await createModelConfig({ model: 'gpt-4' }, fake);
  await updateModelConfig('mc-1', { model: 'gpt-4o' }, fake);
  await deleteModelConfig('mc-1', fake);

  assert.deepEqual(calls, [
    'post /api/governance/model-configs',
    'put /api/governance/model-configs/mc-1',
    'delete /api/governance/model-configs/mc-1',
  ]);
});

// ─── log stats / token split ──────────────────────────────────────────────────

test('getLogStats: builds query string and coerces numeric fields', async () => {
  let captured = '';
  const fake = {
    get: async (url: string) => {
      captured = url;
      return {
        data: {
          total_requests: '42',
          total_tokens: 1000,
          total_cost: '1.5',
          average_latency: '120',
          success_rate: 98,
          user_facing_success_rate: '97',
          user_facing_total_requests: '40',
        },
      };
    },
  } as unknown as AxiosInstance;

  const stats = await getLogStats(
    {
      providers: 'openai,azure',
      models: 'gpt-4',
      virtualKeyIds: 'vk-1',
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2024-01-02T00:00:00Z',
    },
    fake,
  );

  assert.match(captured, /^\/api\/logs\/stats\?/);
  assert.match(captured, /providers=openai%2Cazure/);
  assert.match(captured, /virtual_key_ids=vk-1/);
  assert.deepEqual(stats, {
    total_requests: 42,
    total_tokens: 1000,
    total_cost: 1.5,
    average_latency: 120,
    success_rate: 98,
    user_facing_success_rate: 97,
    user_facing_total_requests: 40,
  });
});

test('getLogStats: invalid numbers become zero', async () => {
  const fake = {
    get: async () => ({ data: { total_requests: 'n/a', total_tokens: null } }),
  } as unknown as AxiosInstance;
  const stats = await getLogStats({}, fake);
  assert.equal(stats.total_requests, 0);
  assert.equal(stats.total_tokens, 0);
  assert.equal(stats.user_facing_success_rate, undefined);
});

test('getLogTokenSplit: sums prompt and completion tokens from sampled logs', async () => {
  let captured = '';
  const fake = {
    get: async (url: string) => {
      captured = url;
      return {
        data: {
          logs: [
            { token_usage: { prompt_tokens: 10, completion_tokens: 5 } },
            { token_usage: { prompt_tokens: '3', completion_tokens: 2 } },
            { token_usage: {} },
          ],
        },
      };
    },
  } as unknown as AxiosInstance;

  const split = await getLogTokenSplit({ models: 'gpt-4', limit: 50 }, fake);
  assert.match(captured, /\/api\/logs\?/);
  assert.match(captured, /limit=50/);
  assert.deepEqual(split, { promptTokens: 13, completionTokens: 7, sampledRequests: 3 });
});

test('getLogTokenSplit: defaults limit to 100 when missing or invalid', async () => {
  const fake = {
    get: async (url: string) => {
      assert.match(url, /limit=100/);
      return { data: { logs: [] } };
    },
  } as unknown as AxiosInstance;
  await getLogTokenSplit({}, fake);
});

// ─── createBifrostClient ────────────────────────────────────────────────────

const ORIGINAL_URL = process.env.LLM_GATEWAY_URL;
const ORIGINAL_KEY = process.env.LLM_GATEWAY_API_KEY;

beforeEach(() => {
  process.env.LLM_GATEWAY_URL = 'http://gateway.example/';
  process.env.LLM_GATEWAY_API_KEY = 'test-key';
});

afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.LLM_GATEWAY_URL;
  else process.env.LLM_GATEWAY_URL = ORIGINAL_URL;
  if (ORIGINAL_KEY === undefined) delete process.env.LLM_GATEWAY_API_KEY;
  else process.env.LLM_GATEWAY_API_KEY = ORIGINAL_KEY;
});

test('createBifrostClient: strips trailing slash and attaches auth headers', () => {
  const client = createBifrostClient(5000);
  assert.equal((client.defaults as any).baseURL, 'http://gateway.example');
  assert.equal((client.defaults as any).timeout, 5000);
  assert.equal((client.defaults as any).headers.Authorization, 'Bearer test-key');
  assert.equal((client.defaults as any).headers['x-api-key'], 'test-key');
});

test('createBifrostClient: omits auth headers when API key unset', () => {
  delete process.env.LLM_GATEWAY_API_KEY;
  const client = createBifrostClient();
  assert.equal((client.defaults as any).headers.Authorization, undefined);
});

test('getLogStats: hits bare path when no filters provided', async () => {
  let url = '';
  const fake = {
    get: async (u: string) => {
      url = u;
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  await getLogStats({}, fake);
  assert.equal(url, '/api/logs/stats');
});

test('getLogTokenSplit: applies all filter params and custom limit', async () => {
  let captured = '';
  const fake = {
    get: async (url: string) => {
      captured = url;
      return { data: { logs: [{ token_usage: { prompt_tokens: 1, completion_tokens: 2 } }] } };
    },
  } as unknown as AxiosInstance;
  const split = await getLogTokenSplit(
    {
      providers: 'openai',
      models: 'gpt-4',
      virtualKeyIds: 'vk-1',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
      limit: 25,
    },
    fake,
  );
  assert.match(captured, /providers=openai/);
  assert.match(captured, /virtual_key_ids=vk-1/);
  assert.match(captured, /limit=25/);
  assert.equal(split.sampledRequests, 1);
});

test('getLogTokenSplit: treats non-array logs as empty sample', async () => {
  const fake = {
    get: async () => ({ data: { logs: null } }),
  } as unknown as AxiosInstance;
  const split = await getLogTokenSplit({}, fake);
  assert.equal(split.promptTokens, 0);
  assert.equal(split.completionTokens, 0);
  assert.equal(split.sampledRequests, 0);
});

test('getTeam: parses team_id field from response', async () => {
  const fake = {
    get: async () => ({ data: { team: { team_id: 'tid-1', name: 'as-proj-x' } } }),
  } as unknown as AxiosInstance;
  const team = await getTeam('tid-1', fake);
  assert.equal(team?.team_id, 'tid-1');
});

test('getVirtualKey: unwraps key_id field from bare response', async () => {
  const fake = {
    get: async () => ({ data: { key_id: 'vk-kid', name: 'from-key-id' } }),
  } as unknown as AxiosInstance;
  const vk = await getVirtualKey('vk-kid', fake);
  assert.equal(vk?.key_id, 'vk-kid');
});

test('getLogStats: coerces invalid user_facing fields to undefined', async () => {
  const fake = {
    get: async () => ({
      data: {
        total_requests: 1,
        user_facing_success_rate: 'n/a',
        user_facing_total_requests: null,
      },
    }),
  } as unknown as AxiosInstance;
  const stats = await getLogStats({}, fake);
  assert.equal(stats.user_facing_success_rate, 0);
  assert.equal(stats.user_facing_total_requests, undefined);
});
