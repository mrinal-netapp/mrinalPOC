/**
 * Unit tests for the Bifrost provider-name resolution pieces of
 * `services/bifrost/bifrostProviderOps.ts`. These are pure functions
 * (no Bifrost HTTP I/O) so they run without any fakes.
 *
 * Locked-in invariants: `openai_compatible` must NOT collapse onto
 * Bifrost's native `openai` provider whenever a credential is available,
 * because that provider has its base URL hardcoded to api.openai.com and
 * ignores per-key `api_base`. Each credential must instead get its own
 * `as-openai-compat-<short>` Bifrost custom provider so the upstream URL from
 * `credential.metadata.endpoint` actually takes effect.
 *
 * Run: node --require ts-node/register --test tests/bifrostProviderOps.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AxiosInstance } from 'axios';
import {
  appendBuiltinProviderKey,
  buildBuiltinGatewayBindingName,
  buildGatewayBindingName,
  buildGatewayModelId,
  buildKeyPayload,
  buildOpenAICompatibleProviderName,
  mapLlmProviderToBifrost,
  mergeBuiltinProviderKeyModels,
  updateProviderProxyOnGateway,
  appendProviderKey,
  removeProviderModelFromKey,
  removeProviderKeyByName,
  deleteProviderKeyById,
  listGatewayModels,
} from '../services/bifrost/bifrostProviderOps';

// --------------------------- buildOpenAICompatibleProviderName
// The credentialShortId convention takes the first 12 hex chars of the
// credential UUID (dashes stripped). 12 chars gives a birthday-collision
// boundary of ~16M credentials per scope — comfortably above any realistic
// project's credential set. Bumped from 8 chars after review feedback.
test('buildOpenAICompatibleProviderName: derives as-openai-compat-<short> from credentialId', () => {
  assert.equal(
    buildOpenAICompatibleProviderName('dee9b9f3-1c72-42c4-84b4-eeee85044eab'),
    'as-openai-compat-dee9b9f31c72',
  );
});

test('buildOpenAICompatibleProviderName: returns undefined without credentialId', () => {
  assert.equal(buildOpenAICompatibleProviderName(undefined), undefined);
  assert.equal(buildOpenAICompatibleProviderName(''), undefined);
});

test('buildOpenAICompatibleProviderName: handles credentialId without dashes', () => {
  assert.equal(
    buildOpenAICompatibleProviderName('dee9b9f31c7242c484b4eeee85044eab'),
    'as-openai-compat-dee9b9f31c72',
  );
});

// --------------------------- mapLlmProviderToBifrost
test('mapLlmProviderToBifrost: openai_compatible with credentialId returns as-openai-compat-<short>', () => {
  // CRITICAL: the old behavior was `openai_compatible: 'openai'` which made
  // Bifrost route to api.openai.com regardless of the user's endpoint. The
  // fix routes per-credential through a custom Bifrost provider with the
  // right network_config.base_url. See bifrostProviderOps.ts for the rationale.
  assert.equal(
    mapLlmProviderToBifrost('openai_compatible', 'dee9b9f3-1c72-42c4-84b4-eeee85044eab'),
    'as-openai-compat-dee9b9f31c72',
  );
});

test('mapLlmProviderToBifrost: openai_compatible without credentialId falls back to openai', () => {
  // Legacy callers (list endpoints, direct-gateway-route callers) that don't
  // have a credentialId in hand still need a defined return so the lookup
  // doesn't throw. They get the pre-fix mapping; the only callers that MUST
  // pass credentialId are the addModel / deleteModel / gatewayModelId paths.
  assert.equal(mapLlmProviderToBifrost('openai_compatible'), 'openai');
  assert.equal(mapLlmProviderToBifrost('openai_compatible', undefined), 'openai');
});

test('mapLlmProviderToBifrost: native openai is unchanged', () => {
  assert.equal(mapLlmProviderToBifrost('openai'), 'openai');
  assert.equal(mapLlmProviderToBifrost('openai', 'any-cred'), 'openai');
});

test('mapLlmProviderToBifrost: aws_bedrock/azure/google/gemini/ollama', () => {
  assert.equal(mapLlmProviderToBifrost('aws_bedrock'), 'bedrock');
  assert.equal(mapLlmProviderToBifrost('azure'), 'azure');
  // "Google Vertex AI" (google) -> Bifrost `vertex`; the API-key Gemini path
  // is the separate `gemini` provider -> Bifrost `gemini`.
  assert.equal(mapLlmProviderToBifrost('google'), 'vertex');
  assert.equal(mapLlmProviderToBifrost('gemini'), 'gemini');
  assert.equal(mapLlmProviderToBifrost('ollama'), 'ollama');
});

test('mapLlmProviderToBifrost: undefined provider defaults to openai', () => {
  assert.equal(mapLlmProviderToBifrost(undefined), 'openai');
  assert.equal(mapLlmProviderToBifrost(), 'openai');
});

test('mapLlmProviderToBifrost: unknown provider passes through verbatim', () => {
  // Bifrost custom-provider names (`as-tei-minilm`, etc.) pass through this
  // function unchanged so callers that already have a Bifrost-side name
  // (e.g. listGatewayModels filters) keep working.
  assert.equal(mapLlmProviderToBifrost('as-tei-minilm'), 'as-tei-minilm');
});

// --------------------------- buildKeyPayload (Vertex)
test('buildKeyPayload: google builds vertex_key_config and drops the top-level value', () => {
  const payload = buildKeyPayload({
    llmProvider: 'google',
    modelId: 'model-uuid',
    providerModelId: 'gemini-1.5-pro',
    authCredentials: '{"type":"service_account"}',
    credentialMetadata: {
      project_id: 'my-gcp-project',
      region: 'us-central1',
      project_number: '123456789012',
    },
  });

  const cfg = payload.vertex_key_config as Record<string, { value: string }>;
  assert.ok(cfg, 'expected vertex_key_config');
  assert.equal(cfg.project_id.value, 'my-gcp-project');
  assert.equal(cfg.region.value, 'us-central1');
  assert.equal(cfg.project_number.value, '123456789012');
  assert.equal(cfg.auth_credentials.value, '{"type":"service_account"}');
  // Vertex auth lives in vertex_key_config; the top-level key value is dropped.
  assert.equal(payload.value, undefined);
});

test('buildKeyPayload: google auth_credentials falls back to service_account_json metadata; region defaults', () => {
  const payload = buildKeyPayload({
    llmProvider: 'google',
    modelId: 'model-uuid',
    providerModelId: 'gemini-1.5-pro',
    credentialMetadata: {
      project_id: 'p',
      service_account_json: '{"type":"service_account","x":1}',
    },
  });
  const cfg = payload.vertex_key_config as Record<string, { value: string }>;
  assert.equal(cfg.auth_credentials.value, '{"type":"service_account","x":1}');
  assert.equal(cfg.region.value, 'us-central1');
  // project_number omitted when not supplied.
  assert.equal(cfg.project_number, undefined);
});

test('buildKeyPayload: aws_bedrock includes session token and retains top-level value when secret_key is provided', () => {
  const payload = buildKeyPayload({
    llmProvider: 'aws_bedrock',
    modelId: 'model-uuid',
    providerModelId: 'anthropic.claude-v2',
    apiKey: 'AKIA',
    credentialMetadata: {
      secret_key: 'secret',
      session_token: 'token',
      region: 'eu-west-1',
    },
  });
  const cfg = payload.bedrock_key_config as Record<string, { value: string }>;
  assert.equal(cfg.region.value, 'eu-west-1');
  assert.equal(cfg.access_key.value, 'AKIA');
  assert.equal(cfg.secret_key.value, 'secret');
  assert.equal(cfg.session_token.value, 'token');
  assert.ok(payload.value);
});

test('buildKeyPayload: aws_bedrock drops top-level value when only access key provided', () => {
  const payload = buildKeyPayload({
    llmProvider: 'aws_bedrock',
    modelId: 'model-uuid',
    providerModelId: 'anthropic.claude-v2',
    apiKey: 'AKIA',
    credentialMetadata: { region: 'us-east-1' },
  });
  assert.equal(payload.value, undefined);
});

test('buildKeyPayload: azure deployment map when provider uses deployment config', () => {
  const payload = buildKeyPayload({
    llmProvider: 'azure',
    modelId: 'model-uuid',
    providerModelId: 'gpt-4o',
    providerDeploymentName: 'my-deploy',
    gatewayBindingName: 'binding-1',
    apiKey: 'sk',
    credentialMetadata: { api_version: '2024-02-01', endpoint: 'https://x.openai.azure.com' },
  });
  assert.ok(payload.azure_key_config);
});

// --------------------------- buildGatewayBindingName
test('buildGatewayBindingName: openai_compatible returns bare providerModelId', () => {
  // CRITICAL: Bifrost forwards the binding name verbatim to the upstream
  // proxy after stripping the `as-openai-compat-<short>/` prefix. The upstream
  // expects e.g. `claude-opus-4.7`, NOT `projyvm9qey7_dee9b9f3_claude-opus-4.7`.
  // The project__cred__ scoping is only needed for native Bifrost providers
  // where one provider is shared across all credentials.
  assert.equal(
    buildGatewayBindingName('projyvm9qey7', 'dee9b9f3-1c72-42c4', 'claude-opus-4.7', 'openai_compatible'),
    'claude-opus-4.7',
  );
});

test('buildGatewayBindingName: native openai keeps project__cred__ scoping', () => {
  assert.equal(
    buildGatewayBindingName('projyvm9qey7', 'dee9b9f3-1c72-42c4', 'gpt-4o', 'openai'),
    'projyvm9qey7_dee9b9f31c72_gpt-4o',
  );
});

test('buildGatewayBindingName: azure keeps project__cred__ scoping', () => {
  assert.equal(
    buildGatewayBindingName('projx', 'cred-uuid-12345', 'gpt-4o', 'azure'),
    'projx_creduuid1234_gpt-4o',
  );
});

test('buildGatewayBindingName: no llmProvider keeps project__cred__ scoping for shared providers', () => {
  // Credentialed cloud models on shared Bifrost providers (azure/openai) still
  // need the project__cred__ prefix. Built-in TEI uses buildBuiltinGatewayBindingName
  // instead — see tests below.
  assert.equal(
    buildGatewayBindingName('projx', 'credxxx', 'sentence-transformers__all-MiniLM-L6-v2'),
    'projx_credxxx_sentence-transformers__all-MiniLM-L6-v2',
  );
});

test('buildBuiltinGatewayBindingName: platform TEI bindings are not project-scoped', () => {
  assert.equal(
    buildBuiltinGatewayBindingName('sentence-transformers/all-MiniLM-L6-v2'),
    'sentence-transformers__all-MiniLM-L6-v2',
  );
  assert.equal(
    buildBuiltinGatewayBindingName('BAAI/bge-small-en-v1.5'),
    'BAAI__bge-small-en-v1.5',
  );
});

test('mergeBuiltinProviderKeyModels: collapses legacy per-project aliases', () => {
  const canonical = 'sentence-transformers__all-MiniLM-L6-v2';
  assert.deepEqual(
    mergeBuiltinProviderKeyModels(
      [
        'projx3stlz05_sentence-transformers__all-MiniLM-L6-v2',
        'projyvm9qey7_sentence-transformers__all-MiniLM-L6-v2',
      ],
      canonical,
    ),
    [canonical],
  );
});

test('buildGatewayBindingName: no projectId / no credentialId fallbacks', () => {
  assert.equal(buildGatewayBindingName(undefined, undefined, 'gpt-4o'), 'gpt-4o');
  assert.equal(buildGatewayBindingName('projx', undefined, 'gpt-4o'), 'projx_gpt-4o');
});

// --------------------------- buildGatewayModelId
test('buildGatewayModelId: openai_compatible composes as-openai-compat-<short>/<binding>', () => {
  assert.equal(
    buildGatewayModelId('openai_compatible', 'claude-opus-4.7', 'dee9b9f3-1c72-42c4'),
    'as-openai-compat-dee9b9f31c72/claude-opus-4.7',
  );
});

test('buildGatewayModelId: openai_compatible without credentialId falls back to openai/<binding>', () => {
  // This is the legacy fallback. Runtime calls under this prefix WILL
  // mis-route to api.openai.com (which is exactly the bug we're fixing
  // for the credentialed path), but for legacy callers that never had
  // a credentialId, preserving the existing shape is the safe default.
  assert.equal(
    buildGatewayModelId('openai_compatible', 'gpt-4o'),
    'openai/gpt-4o',
  );
});

test('buildGatewayModelId: native openai unchanged', () => {
  assert.equal(buildGatewayModelId('openai', 'gpt-4o'), 'openai/gpt-4o');
  assert.equal(buildGatewayModelId('openai', 'gpt-4o', 'irrelevant-cred'), 'openai/gpt-4o');
});

test('buildGatewayModelId: pre-prefixed model ids pass through unchanged', () => {
  // Operator-managed routes that already carry a `/` opt out of remapping.
  assert.equal(buildGatewayModelId('openai_compatible', 'custom/my-model', 'cred-1'), 'custom/my-model');
});

// --------------------------- appendBuiltinProviderKey (v1.5 keys subresource)
// Regression guard for the Bifrost v1.5 break: the embedded `keys[]` on
// `PUT /api/providers/{name}` was removed and is silently ignored, which left
// built-in TEI providers key-less (GET .../keys -> {keys:null}). The key MUST
// be created via the dedicated `POST /api/providers/{name}/keys` subresource so
// a real keyId comes back and the caller can bind the model to the project VK.
test('appendBuiltinProviderKey: creates the key via the /keys subresource and returns keyId', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return {
          data: {
            providers: [
              {
                name: 'as-tei-minilm',
                // base_url already matches the (stripped) apiBase, so the
                // provider-level PUT is skipped — isolates the key path.
                network_config: {
                  base_url:
                    'http://tei-minilm.agentstudio-services.svc.cluster.local:80',
                },
              },
            ],
          },
        };
      }
      if (url === '/api/providers/as-tei-minilm/keys') {
        return { data: { keys: [] } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      if (url === '/api/providers/as-tei-minilm/keys') {
        return { data: { id: 'key-123' } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-minilm',
      modelId: 'sentence-transformers__all-MiniLM-L6-v2',
      apiBase: 'http://tei-minilm.agentstudio-services.svc.cluster.local:80/v1',
      apiKey: 'tei-no-auth',
      description: 'AgentStudio built-in: sentence-transformers/all-MiniLM-L6-v2',
    },
    fake,
  );

  assert.equal(result.keyId, 'key-123');

  const keyPost = calls.find(
    (c) => c.method === 'post' && c.url === '/api/providers/as-tei-minilm/keys',
  );
  assert.ok(keyPost, 'expected POST to /api/providers/as-tei-minilm/keys');
  assert.deepEqual((keyPost!.body as Record<string, unknown>).models, [
    'sentence-transformers__all-MiniLM-L6-v2',
  ]);

  // Must NOT smuggle keys through the removed embedded provider PUT.
  const embeddedKeysPut = calls.find(
    (c) =>
      c.method === 'put' &&
      c.url === '/api/providers/as-tei-minilm' &&
      (c.body as Record<string, unknown>)?.keys !== undefined,
  );
  assert.equal(
    embeddedKeysPut,
    undefined,
    'must not write keys via the embedded provider PUT (removed in Bifrost v1.5)',
  );
});

// Bifrost v1.5.9+ blocks RFC1918 private IPs unless the provider sets
// network_config.allow_private_network. Built-in TEI resolves to a ClusterIP,
// so it must opt in; user-supplied openai_compatible URLs must NOT (SSRF).
async function captureProviderPost(allowPrivateNetwork?: boolean) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let providerExists = false;
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return {
          data: {
            providers: providerExists
              ? [{ name: 'as-tei-x', network_config: { base_url: 'http://svc:80' } }]
              : [],
          },
        };
      }
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      if (url === '/api/providers') {
        providerExists = true;
        return { data: {} };
      }
      if (url.endsWith('/keys')) return { data: { id: 'k1' } };
      throw new Error(`unexpected POST ${url}`);
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-x',
      modelId: 'm1',
      apiBase: 'http://svc:80',
      apiKey: 'tei-no-auth',
      ...(allowPrivateNetwork !== undefined ? { allowPrivateNetwork } : {}),
    },
    fake,
  );
  const post = calls.find((c) => c.method === 'post' && c.url === '/api/providers');
  return (post!.body as { network_config: { allow_private_network: boolean } })
    .network_config.allow_private_network;
}

test('appendBuiltinProviderKey: opts into allow_private_network only when requested', async () => {
  assert.equal(await captureProviderPost(true), true, 'built-in TEI must opt in');
  assert.equal(await captureProviderPost(false), false, 'explicit false stays off');
  assert.equal(await captureProviderPost(undefined), false, 'default is off (no SSRF relaxation)');
});

test('appendBuiltinProviderKey: skips key PUT when models are unchanged', async () => {
  const calls: { method: string; url: string }[] = [];
  const modelId = 'sentence-transformers__all-MiniLM-L6-v2';
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return {
          data: {
            providers: [{ name: 'as-tei-minilm', network_config: { base_url: 'http://svc' } }],
          },
        };
      }
      if (url.endsWith('/keys')) {
        return {
          data: {
            keys: [
              {
                id: 'key-1',
                name: 'as-tei-minilm-key',
                models: [modelId],
                weight: 1,
                enabled: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    put: async (url: string) => {
      calls.push({ method: 'put', url });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-minilm',
      modelId,
      apiBase: 'http://svc',
      apiKey: 'k',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-1');
  assert.equal(
    calls.filter((c) => c.method === 'put' && c.url.includes('/keys/')).length,
    0,
    'unchanged models should not trigger key PUT',
  );
});

test('appendBuiltinProviderKey: re-reads key id when POST returns empty body', async () => {
  let listedAfterPost = false;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return {
          data: {
            providers: [{ name: 'as-tei-new', network_config: { base_url: 'http://svc' } }],
          },
        };
      }
      if (url.endsWith('/keys')) {
        if (listedAfterPost) {
          return {
            data: {
              keys: [{ id: 'key-from-list', name: 'as-tei-new-key', models: ['m1'] }],
            },
          };
        }
        return { data: { keys: [] } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (url.endsWith('/keys')) {
        listedAfterPost = true;
        return { data: {} };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    put: async () => ({ data: {} }),
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-new',
      modelId: 'm1',
      apiBase: 'http://svc',
      apiKey: 'k',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-from-list');
});

test('appendBuiltinProviderKey: non-TEI provider skips PUT when model already listed', async () => {
  const calls: { method: string; url: string }[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return {
          data: {
            providers: [{ name: 'custom-provider', network_config: { base_url: 'http://svc' } }],
          },
        };
      }
      if (url.endsWith('/keys')) {
        return {
          data: {
            keys: [
              {
                id: 'key-custom',
                name: 'custom-provider-key',
                models: ['already-there'],
                weight: 1,
                enabled: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    put: async (url: string) => {
      calls.push({ method: 'put', url });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'custom-provider',
      modelId: 'already-there',
      apiBase: 'http://svc',
      apiKey: 'k',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-custom');
  assert.equal(
    calls.filter((c) => c.method === 'put' && c.url.includes('/keys/')).length,
    0,
  );
});

test('appendBuiltinProviderKey: swallows provider config PUT failures', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return {
          data: {
            providers: [{ name: 'as-tei-warn', network_config: { base_url: 'http://old' } }],
          },
        };
      }
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(`unexpected GET ${url}`);
    },
    put: async (url: string) => {
      if (url === '/api/providers/as-tei-warn') {
        throw new Error('provider PUT rejected');
      }
      return { data: {} };
    },
    post: async (url: string) => {
      if (url.endsWith('/keys')) return { data: { id: 'k-warn' } };
      throw new Error(`unexpected POST ${url}`);
    },
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-warn',
      modelId: 'm1',
      apiBase: 'http://new',
      apiKey: 'k',
      allowPrivateNetwork: true,
    },
    fake,
  );
  assert.equal(result.keyId, 'k-warn');
});

test('appendBuiltinProviderKey: throws when auto-create leaves provider missing', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [] } };
      if (url === '/api/providers/missing-provider') return { data: null };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (url === '/api/providers') return { data: {} };
      throw new Error(`unexpected POST ${url}`);
    },
  } as unknown as AxiosInstance;

  await assert.rejects(
    () =>
      appendBuiltinProviderKey(
        {
          providerName: 'missing-provider',
          modelId: 'm1',
          apiBase: 'http://svc',
          apiKey: 'k',
        },
        fake,
      ),
    /Failed to auto-create Bifrost provider 'missing-provider'/,
  );
});

test('appendBuiltinProviderKey: merges model onto existing provider key', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return { data: { providers: [{ name: 'as-tei-x', network_config: { base_url: 'http://svc' } }] } };
      }
      if (url.endsWith('/keys')) {
        return {
          data: {
            keys: [
              {
                id: 'key-1',
                name: 'as-tei-x-key',
                models: ['existing-model'],
                weight: 1,
                enabled: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-x',
      modelId: 'new-model',
      apiBase: 'http://svc',
      apiKey: 'k',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-1');
  const keyPut = calls.find((c) => c.method === 'put' && c.url.includes('/keys/key-1'));
  assert.ok(keyPut);
  assert.deepEqual((keyPut!.body as Record<string, unknown>).models, ['existing-model', 'new-model']);
});

// --------------------------- updateProviderProxyOnGateway
// The provider proxy-edit route reuses this key-free provider PUT to push the
// operator's concurrency + buffer-size to Bifrost. It must PUT only the
// concurrency_and_buffer_size block (a full-object PUT would clobber keys /
// network_config), against the encoded provider name.
test('updateProviderProxyOnGateway: PUTs only concurrency_and_buffer_size to /api/providers/{name}', async () => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = {
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      return { data: {} };
    },
  } as unknown as AxiosInstance;

  await updateProviderProxyOnGateway('vertex', 250, 900, fake);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'put');
  assert.equal(calls[0].url, '/api/providers/vertex');
  assert.deepEqual(calls[0].body, {
    concurrency_and_buffer_size: { concurrency: 250, buffer_size: 900 },
  });
});

// --------------------------- appendProviderKey / removeProviderKey helpers
function providerClient(handlers: {
  providers?: Array<Record<string, unknown>>;
  keys?: Array<Record<string, unknown>>;
  onPut?: (url: string, body: unknown) => void;
  onPost?: (url: string, body: unknown) => void;
  onDelete?: (url: string) => void;
  putError?: Error;
}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fake = {
    get: async (url: string) => {
      calls.push({ method: 'get', url });
      if (url === '/api/providers') {
        return { data: { providers: handlers.providers ?? [{ name: 'openai' }] } };
      }
      if (url.endsWith('/keys')) {
        return { data: { keys: handlers.keys ?? [] } };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string, body: unknown) => {
      calls.push({ method: 'post', url, body });
      handlers.onPost?.(url, body);
      if (url.endsWith('/keys')) return { data: { id: 'key-new' } };
      if (url === '/api/providers') return { data: {} };
      throw new Error(`unexpected POST ${url}`);
    },
    put: async (url: string, body: unknown) => {
      calls.push({ method: 'put', url, body });
      handlers.onPut?.(url, body);
      if (handlers.putError) throw handlers.putError;
      return { data: {} };
    },
    delete: async (url: string) => {
      calls.push({ method: 'delete', url });
      handlers.onDelete?.(url);
      return { data: {} };
    },
  } as unknown as AxiosInstance;
  return { fake, calls };
}

test('appendProviderKey: creates a new provider key via POST', async () => {
  const { fake } = providerClient({ keys: [] });
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o',
      gatewayBindingName: 'proj_cred_gpt-4o',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(result.gatewayProvider, 'openai');
  assert.equal(result.keyName, 'as-cred-cred-1');
  assert.equal(result.keyId, 'key-new');
});

test('appendProviderKey: merges models onto an existing credential key', async () => {
  let putBody: Record<string, unknown> | undefined;
  const { fake } = providerClient({
    keys: [
      {
        id: 'key-dup',
        name: 'as-cred-cred-1',
        models: ['existing-model'],
        aliases: { 'existing-model': 'alias-a' },
      },
    ],
    onPut: (_url, body) => {
      putBody = body as Record<string, unknown>;
    },
  });
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-2',
      providerModelId: 'gpt-4o-mini',
      gatewayBindingName: 'proj_cred_gpt-4o-mini',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-dup');
  assert.deepEqual(putBody?.models, ['existing-model', 'proj_cred_gpt-4o-mini']);
});

test('appendProviderKey: applies proxy tuning best-effort', async () => {
  const { fake } = providerClient({
    keys: [],
    putError: new Error('proxy PUT failed'),
  });
  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o',
      apiKey: 'sk-test',
      concurrency: 200,
      bufferSize: 800,
    },
    fake,
  );
  assert.equal(result.keyId, 'key-new');
});

test('removeProviderModelFromKey: deletes key when last model is removed', async () => {
  const deletes: string[] = [];
  const { fake } = providerClient({
    keys: [{ id: 'key-1', name: 'as-cred-cred-1', models: ['only-model'] }],
    onDelete: (url) => deletes.push(url),
  });
  const removed = await removeProviderModelFromKey('openai', 'as-cred-cred-1', 'only-model', fake);
  assert.equal(removed, true);
  assert.ok(deletes.some((u) => u.includes('/keys/key-1')));
});

test('removeProviderModelFromKey: returns false without api key to preserve secret', async () => {
  const { fake } = providerClient({
    keys: [{ id: 'key-1', name: 'as-cred-cred-1', models: ['m1', 'm2'] }],
  });
  const removed = await removeProviderModelFromKey('openai', 'as-cred-cred-1', 'm1', fake);
  assert.equal(removed, false);
});

test('removeProviderModelFromKey: trims model with api key re-sent', async () => {
  let putBody: Record<string, unknown> | undefined;
  const { fake } = providerClient({
    keys: [
      {
        id: 'key-1',
        name: 'as-cred-cred-1',
        models: ['m1', 'm2'],
        aliases: { m1: 'alias-1' },
      },
    ],
    onPut: (_url, body) => {
      putBody = body as Record<string, unknown>;
    },
  });
  const removed = await removeProviderModelFromKey(
    'openai',
    'as-cred-cred-1',
    'm1',
    fake,
    'sk-preserve',
  );
  assert.equal(removed, true);
  assert.deepEqual(putBody?.models, ['m2']);
  assert.equal((putBody?.aliases as Record<string, string>)?.m1, undefined);
});

test('removeProviderKeyByName and deleteProviderKeyById remove keys', async () => {
  const deletes: string[] = [];
  const { fake } = providerClient({
    keys: [{ id: 'key-x', name: 'as-model-1' }],
    onDelete: (url) => deletes.push(url),
  });
  assert.equal(await removeProviderKeyByName('openai', 'as-model-1', fake), true);
  assert.equal(await removeProviderKeyByName('openai', 'missing', fake), false);
  await deleteProviderKeyById('openai', 'key-direct', fake);
  assert.ok(deletes.some((u) => u.includes('/keys/key-x')));
  assert.ok(deletes.some((u) => u.includes('/keys/key-direct')));
});

test('listGatewayModels: skips providers with empty names and tolerates key-list failures', async () => {
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return {
          data: {
            providers: [{ name: '' }, { name: 'openai' }, { name: 'broken' }],
            total: 3,
          },
        };
      }
      if (url.includes('/openai/keys')) {
        return {
          data: {
            keys: [
              {
                id: 'k1',
                name: 'key-1',
                models: ['gpt-4', ''],
                enabled: true,
                status: 'active',
                description: 'primary',
                weight: 1,
              },
            ],
          },
        };
      }
      if (url.includes('/broken/keys')) {
        throw new Error('keys unavailable');
      }
      throw new Error(url);
    },
  } as unknown as AxiosInstance;

  const out = await listGatewayModels(fake);
  assert.equal(out.total, 1);
  assert.deepEqual(out.providers, ['openai', 'broken']);
  assert.equal(out.models[0].provider, 'openai');
  assert.equal(out.models[0].modelId, 'gpt-4');
});

test('buildKeyPayload: includes credential description with project hint', () => {
  const payload = buildKeyPayload({
    llmProvider: 'openai',
    modelId: 'model-uuid',
    providerModelId: 'gpt-4o',
    gatewayBindingName: 'binding-1',
    credentialId: 'cred-1',
    credentialName: 'Corp Key',
    projectId: 'proj-abc',
    apiKey: 'sk',
  });
  assert.match(String(payload.description), /Corp Key/);
  assert.match(String(payload.description), /project=proj-abc/);
});

test('buildKeyPayload: google includes project_number and authCredentials override', () => {
  const payload = buildKeyPayload({
    llmProvider: 'google',
    modelId: 'model-uuid',
    providerModelId: 'gemini-1.5-pro',
    authCredentials: '{"type":"service_account","client":"x"}',
    credentialMetadata: {
      project_id: 'my-gcp-project',
      project_number: '999',
      region: 'europe-west1',
    },
  });
  const cfg = payload.vertex_key_config as Record<string, { value: string }>;
  assert.equal(cfg.project_number.value, '999');
  assert.equal(cfg.auth_credentials.value, '{"type":"service_account","client":"x"}');
  assert.equal(cfg.region.value, 'europe-west1');
});

test('appendProviderKey: ensureProviderConfigured tolerates 409 on auto-create', async () => {
  let providerExists = false;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return {
          data: {
            providers: providerExists ? [{ name: 'openai' }] : [],
          },
        };
      }
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (url === '/api/providers') {
        const err: any = new Error('already exists');
        err.response = { status: 409 };
        providerExists = true;
        throw err;
      }
      if (url.endsWith('/keys')) return { data: { id: 'key-after-409' } };
      throw new Error(`unexpected POST ${url}`);
    },
  } as unknown as AxiosInstance;

  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-after-409');
});

test('appendBuiltinProviderKey: tolerates 409 when provider is created concurrently', async () => {
  let providerExists = false;
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') {
        return {
          data: {
            providers: providerExists
              ? [{ name: 'as-tei-concurrent', network_config: { base_url: 'http://svc' } }]
              : [],
          },
        };
      }
      if (url.endsWith('/keys')) return { data: { keys: [] } };
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
      if (url === '/api/providers') {
        providerExists = true;
        const err: any = new Error('already exists');
        err.response = { status: 409 };
        throw err;
      }
      if (url.endsWith('/keys')) return { data: { id: 'key-concurrent' } };
      throw new Error(`unexpected POST ${url}`);
    },
    put: async () => ({ data: {} }),
  } as unknown as AxiosInstance;

  const result = await appendBuiltinProviderKey(
    {
      providerName: 'as-tei-concurrent',
      modelId: 'm1',
      apiBase: 'http://svc',
      apiKey: 'k',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-concurrent');
});

test('normalizeBifrostKeyValue: flattens env-aware value objects', () => {
  const { normalizeBifrostKeyValue } = require('../services/bifrost/bifrostProviderOps') as typeof import('../services/bifrost/bifrostProviderOps');
  const flattened = normalizeBifrostKeyValue({
    id: 'k1',
    value: { value: 'sk-real', env_var: '', from_env: false },
  });
  assert.equal(flattened.value, 'sk-real');
  const passthrough = normalizeBifrostKeyValue({ id: 'k2', value: 'plain' });
  assert.equal(passthrough.value, 'plain');
});

test('isPlatformTeiProvider and builtin merge helpers', () => {
  const {
    isPlatformTeiProvider,
    isLegacyProjectScopedBuiltinBinding,
    mergeBuiltinProviderKeyModels,
    mergeBuiltinVirtualKeyAllowedModels,
    buildBuiltinGatewayBindingName,
  } = require('../services/bifrost/bifrostProviderOps') as typeof import('../services/bifrost/bifrostProviderOps');

  assert.equal(isPlatformTeiProvider('as-tei-minilm'), true);
  assert.equal(isPlatformTeiProvider('openai'), false);

  const canonical = buildBuiltinGatewayBindingName('sentence-transformers/all-MiniLM-L6-v2');
  const legacy = `proj67bqptlb_${canonical}`;
  assert.equal(isLegacyProjectScopedBuiltinBinding(legacy, canonical), true);
  assert.equal(isLegacyProjectScopedBuiltinBinding(canonical, canonical), false);

  assert.deepEqual(
    mergeBuiltinProviderKeyModels([legacy, 'other'], canonical).sort(),
    [canonical, 'other'].sort(),
  );
  assert.deepEqual(
    mergeBuiltinVirtualKeyAllowedModels([legacy], canonical),
    [canonical],
  );
});

test('buildGatewayBindingName: openai_compatible and local provider scoping', () => {
  const { buildGatewayBindingName } = require('../services/bifrost/bifrostProviderOps') as typeof import('../services/bifrost/bifrostProviderOps');
  assert.equal(
    buildGatewayBindingName('proj1', 'cred-uuid', 'gpt-4o', 'openai_compatible'),
    'gpt-4o',
  );
  assert.equal(
    buildGatewayBindingName('proj1', undefined, 'local-model', 'ollama'),
    'proj1_local-model',
  );
  assert.equal(buildGatewayBindingName(undefined, undefined, 'bare'), 'bare');
});

test('buildKeyPayload: azure includes AAD client credentials when present', () => {
  const payload = buildKeyPayload({
    llmProvider: 'azure',
    modelId: 'model-uuid',
    providerModelId: 'gpt-4o',
    gatewayBindingName: 'binding-1',
    providerDeploymentName: 'my-deploy',
    apiKey: 'sk',
    credentialMetadata: {
      endpoint: 'https://x.openai.azure.com',
      client_id: 'cid',
      client_secret: 'csec',
      tenant_id: 'tid',
    },
  });
  const azureCfg = payload.azure_key_config as Record<string, { value: string }>;
  assert.equal(azureCfg.client_id.value, 'cid');
  assert.equal(azureCfg.client_secret.value, 'csec');
  assert.equal(azureCfg.tenant_id.value, 'tid');
  assert.deepEqual(azureCfg.scopes, ['https://cognitiveservices.azure.com/.default']);
});

test('appendProviderKey: merges aliases onto duplicate credential key', async () => {
  let putBody: Record<string, unknown> | undefined;
  const { fake } = providerClient({
    providers: [{ name: 'openai' }],
    keys: [
      {
        id: 'key-dup',
        name: 'as-cred-cred-1',
        models: ['existing-binding'],
        aliases: { 'existing-binding': 'gpt-4' },
      },
    ],
    onPut: (_url, body) => {
      putBody = body as Record<string, unknown>;
    },
  });

  const result = await appendProviderKey(
    {
      llmProvider: 'openai',
      modelId: 'model-1',
      providerModelId: 'gpt-4o-mini',
      gatewayBindingName: 'new-binding',
      providerDeploymentName: 'gpt-4o-mini',
      credentialId: 'cred-1',
      apiKey: 'sk-test',
    },
    fake,
  );
  assert.equal(result.keyId, 'key-dup');
  assert.deepEqual(putBody?.models, ['existing-binding', 'new-binding']);
  assert.deepEqual((putBody?.aliases as Record<string, string>)['new-binding'], 'gpt-4o-mini');
});

test('ensureProviderConfigured: throws when auto-create leaves provider missing', async () => {
  const { ensureProviderConfigured } = require('../services/bifrost/bifrostProviderOps') as typeof import('../services/bifrost/bifrostProviderOps');
  const fake = {
    get: async (url: string) => {
      if (url === '/api/providers') return { data: { providers: [] } };
      throw new Error(url);
    },
    post: async (url: string) => {
      if (url === '/api/providers') return { data: {} };
      throw new Error(url);
    },
  } as unknown as AxiosInstance;

  await assert.rejects(
    () => ensureProviderConfigured('ghost-provider', fake),
    /Failed to auto-create Bifrost provider 'ghost-provider'/,
  );
});

test('buildKeyPayload: omits aliases when binding equals upstream id', () => {
  const payload = buildKeyPayload({
    llmProvider: 'openai',
    modelId: 'model-uuid',
    providerModelId: 'gpt-4o',
    apiKey: 'sk',
  });
  assert.equal(payload.aliases, undefined);
});

test('buildGatewayModelId: returns empty string for empty modelIdent', () => {
  assert.equal(buildGatewayModelId('openai', ''), '');
});
