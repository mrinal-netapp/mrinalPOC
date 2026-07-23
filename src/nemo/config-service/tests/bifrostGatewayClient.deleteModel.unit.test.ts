/**
 * Regression test for the multi-tenant isolation bug where deleting ONE
 * project tore down the SHARED built-in TEI provider key in Bifrost, breaking
 * embeddings for every other live project.
 *
 * Built-in TEI models (`as-tei-*`) are platform-shared: seeded once and
 * re-asserted idempotently at config-service startup + project init, one
 * `as-tei-*` provider per model, each with a single key holding that one model
 * (`as-tei-minilm-key` -> ["sentence-transformers__all-MiniLM-L6-v2"]). Project
 * teardown iterates the project's Model rows and calls `deleteModel` for each;
 * for the built-ins that used to hit `removeProviderModelFromKey`, which
 * DELETES a key once its last model is gone. So one project's deletion deleted
 * the shared key and every other project's search then 503'd with
 * "no keys found for provider: as-tei-minilm".
 *
 * The fix: `deleteModel` must leave `as-tei-*` shared provider keys untouched
 * (the project-scoped VK unassign is still fine). This test locks that in and
 * proves the guard is specific to platform-TEI (a normal credential key is
 * still trimmed).
 *
 * Run: node --require ts-node/register --test tests/bifrostGatewayClient.deleteModel.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AxiosInstance } from 'axios';
import { BifrostGatewayClient } from '../services/BifrostGatewayClient';

type Call = [method: string, url: string];

function fakeClient(keys: Array<Record<string, unknown>>): {
  client: AxiosInstance;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    get: async (url: string) => {
      calls.push(['get', url]);
      return { data: { keys } };
    },
    put: async (url: string) => {
      calls.push(['put', url]);
      return { data: {} };
    },
    delete: async (url: string) => {
      calls.push(['delete', url]);
      return { data: {} };
    },
    post: async (url: string) => {
      calls.push(['post', url]);
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  return { client, calls };
}

// Build a client with the real constructor, then inject a fake gateway so no
// real HTTP happens and we can inspect exactly which Bifrost calls are made.
function gatewayWith(keys: Array<Record<string, unknown>>): {
  gw: BifrostGatewayClient;
  calls: Call[];
} {
  const gw = new BifrostGatewayClient();
  const { client, calls } = fakeClient(keys);
  (gw as unknown as { enabled: boolean }).enabled = true;
  (gw as unknown as { client: AxiosInstance }).client = client;
  return { gw, calls };
}

test('deleteModel: leaves the shared built-in TEI provider key untouched', async () => {
  const { gw, calls } = gatewayWith([
    {
      id: 'k1',
      name: 'as-tei-minilm-key',
      models: ['sentence-transformers__all-MiniLM-L6-v2'],
    },
  ]);

  await gw.deleteModel('model-builtin', {
    gatewayProvider: 'as-tei-minilm',
    keyName: 'as-tei-minilm-key',
    gatewayBindingName: 'sentence-transformers__all-MiniLM-L6-v2',
  });

  // The shared built-in key must not be read, trimmed, or deleted. Before the
  // fix this made a GET + DELETE that removed the only model and dropped the
  // whole `as-tei-minilm-key`, 503-ing every other project's embeddings.
  assert.deepEqual(
    calls,
    [],
    `expected zero provider-key calls for a platform-TEI provider, saw: ${JSON.stringify(calls)}`,
  );
});

test('deleteModel: still trims a normal (credential) provider key', async () => {
  const { gw, calls } = gatewayWith([
    {
      id: 'k1',
      name: 'as-cred-c1',
      // Two projects share this credential key; deleting one model must trim,
      // not drop the key.
      models: ['projx_ab_gpt-4o', 'projy_cd_gpt-4o'],
    },
  ]);

  await gw.deleteModel('model-cred', {
    gatewayProvider: 'openai',
    keyName: 'as-cred-c1',
    gatewayBindingName: 'projx_ab_gpt-4o',
    currentApiKey: 'sk-real-value',
  });

  assert.ok(
    calls.some(([m]) => m === 'get'),
    'expected the credential key to be read',
  );
  assert.ok(
    calls.some(([m]) => m === 'put'),
    'expected the credential key to be trimmed via PUT (not skipped)',
  );
});
