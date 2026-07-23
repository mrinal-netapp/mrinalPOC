/**
 * Unit tests for provider adapters + registry + static metadata.
 * axios is stubbed via the test-context mock (auto-restored per test).
 *
 * Run: node --require ts-node/register --test tests/providers.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { getProviderRegistry, ProviderRegistry } from '../providers/registry';
import { OpenAIAdapter } from '../providers/openai';
import { OpenAICompatibleAdapter } from '../providers/openai_compatible';
import { AWSBedrockAdapter } from '../providers/aws_bedrock';
import { AzureAdapter } from '../providers/azure';
import { GoogleAdapter } from '../providers/google';
import { GeminiAdapter } from '../providers/gemini';
import { AnthropicAdapter } from '../providers/anthropic';
import { OllamaAdapter } from '../providers/ollama';
import { CohereAdapter } from '../providers/cohere';
import { PerplexityAdapter } from '../providers/perplexity';
import { HuggingFaceAdapter } from '../providers/huggingface';
import { FireworksAdapter } from '../providers/fireworks';
import { createConnectorAdapters } from '../providers/connector';
import { getStaticModelMetadata } from '../providers/staticMetadata';

function okResponse(data: any) {
  return { status: 200, data } as any;
}

// --------------------------------------------------------------- registry
test('registry: singleton + provider listing + has/get', () => {
  const reg = getProviderRegistry();
  assert.equal(reg, getProviderRegistry());
  const providers = reg.listProviders();
  for (const p of ['openai', 'openai_compatible', 'aws_bedrock', 'azure', 'google', 'gemini', 'anthropic', 'ollama', 'cohere', 'perplexity', 'huggingface', 'fireworks', 's3', 'postgresql', 'mysql', 'ontap']) {
    assert.ok(providers.includes(p), `expected provider ${p}`);
  }
  assert.equal(reg.has('openai'), true);
  assert.equal(reg.has('does_not_exist'), false);
  assert.ok(reg.get('openai') instanceof OpenAIAdapter);
  assert.equal(reg.get('does_not_exist'), undefined);
});

test('registry: validate unknown provider passes, listModels unknown throws', async () => {
  const reg = new ProviderRegistry();
  assert.equal(await reg.validate('totally_unknown', {}), true);
  await assert.rejects(() => reg.listModels('totally_unknown', {}), /Unknown provider/);
});

test('registry: validate delegates to adapter', async (t) => {
  t.mock.method(axios, 'get', async () => okResponse({ data: [] }));
  const reg = new ProviderRegistry();
  assert.equal(await reg.validate('openai', { api_key: 'sk-test' }), true);
});

// --------------------------------------------------------------- OpenAI
test('OpenAIAdapter: validate requires api_key and 200 response', async (t) => {
  const a = new OpenAIAdapter();
  assert.equal(await a.validate({}), false);
  t.mock.method(axios, 'get', async () => okResponse({ data: [] }));
  assert.equal(await a.validate({ api_key: 'sk' }, { endpoint: 'https://x' }), true);
});

test('OpenAIAdapter: listModels maps + filters; missing key throws', async (t) => {
  const a = new OpenAIAdapter();
  await assert.rejects(() => a.listModels({}), /Missing api_key/);
  t.mock.method(axios, 'get', async () =>
    okResponse({ data: [{ id: 'gpt-4o', owned_by: 'openai' }, { id: 'text-embedding-3', owned_by: 'openai' }] }),
  );
  const all = await a.listModels({ api_key: 'sk' });
  assert.equal(all.length, 2);
  const emb = await a.listModels({ api_key: 'sk' }, {}, 'embedding');
  assert.equal(emb.length, 1);
  assert.equal(emb[0].type, 'embedding');
});

// --------------------------------------------------------- OpenAI-compatible
test('OpenAICompatibleAdapter: endpoint required, optional key', async (t) => {
  const a = new OpenAICompatibleAdapter();
  await assert.rejects(() => a.validate({}, {}), /endpoint is required/);
  await assert.rejects(() => a.listModels({}, {}), /endpoint is required/);
  t.mock.method(axios, 'get', async () => okResponse({ data: [{ id: 'llm-1' }] }));
  assert.equal(await a.validate({}, { endpoint: 'http://host' }), true);
  const models = await a.listModels({ api_key: 'k' }, { endpoint: 'http://host' }, 'llm');
  assert.equal(models[0].id, 'llm-1');
});

test('OpenAICompatibleAdapter: validate/listModels without api key omit Authorization header', async (t) => {
  const a = new OpenAICompatibleAdapter();
  let capturedHeaders: Record<string, string> | undefined;
  t.mock.method(axios, 'get', async (_url: string, opts: { headers?: Record<string, string> }) => {
    capturedHeaders = opts?.headers;
    return okResponse({ data: [{ id: 'llm-1' }, { id: 'text-embedding-3-small' }] });
  });
  assert.equal(await a.validate({}, { endpoint: 'http://host' }), true);
  assert.equal(capturedHeaders?.Authorization, undefined);
  capturedHeaders = undefined as Record<string, string> | undefined;
  const all = await a.listModels({}, { endpoint: 'http://host' });
  assert.equal(all.length, 2);
  assert.equal(capturedHeaders?.Authorization, undefined);
});

// --------------------------------------------------------------- Bedrock
test('AWSBedrockAdapter: static catalog + validate truthy', async () => {
  const a = new AWSBedrockAdapter();
  const all = await a.listModels({}, {});
  assert.ok(all.length > 5);
  const emb = await a.listModels({}, {}, 'embedding');
  assert.ok(emb.every((m) => m.type === 'embedding'));
  assert.equal(await a.validate({ aws_access_key_id: 'x', aws_secret_access_key: 'y' }), true);
});

// --------------------------------------------------------------- Google (Vertex)
test('GoogleAdapter: Vertex service-account validation + static catalog', async () => {
  const a = new GoogleAdapter();
  assert.equal(a.provider, 'google');
  assert.deepEqual([...a.expectedSecretKeys], ['service_account_json']);

  // project_id (metadata) is required for Vertex.
  assert.equal(await a.validate({ service_account_json: '{"type":"service_account"}' }, {}), false);
  // Valid: project_id present + parseable SA JSON declaring a `type`.
  assert.equal(
    await a.validate(
      { service_account_json: '{"type":"service_account"}' },
      { project_id: 'my-proj' },
    ),
    true,
  );
  // Empty credentials are allowed (ADC / IAM role auth) as long as project_id is set.
  assert.equal(await a.validate({}, { project_id: 'my-proj' }), true);
  // Malformed SA JSON (or one without a `type`) is rejected.
  assert.equal(await a.validate({ service_account_json: 'not-json' }, { project_id: 'p' }), false);
  assert.equal(await a.validate({ service_account_json: '{"no":"type"}' }, { project_id: 'p' }), false);

  // listModels returns a static Vertex catalog (no live call / no api_key).
  const all = await a.listModels({}, { project_id: 'p' });
  assert.ok(all.length > 0);
  assert.ok(all.some((m) => m.id === 'gemini-1.5-pro'));
  const emb = await a.listModels({}, { project_id: 'p' }, 'embedding');
  assert.ok(emb.length > 0 && emb.every((m) => m.type === 'embedding'));
});

// --------------------------------------------------------------- Gemini
test('GeminiAdapter: provider key is gemini; validate + listModels with fallback', async (t) => {
  const a = new GeminiAdapter();
  assert.equal(a.provider, 'gemini');
  assert.equal(await a.validate({}), false);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const okMock = t.mock.method(axios, 'get', async () =>
    okResponse({ models: [{ name: 'models/gemini-1.5-pro', displayName: 'Gemini', inputTokenLimit: 100 }] }),
  );
  assert.equal(await a.validate({ api_key: 'k' }), true);
  const models = await a.listModels({ api_key: 'k' });
  assert.equal(models[0].id, 'gemini-1.5-pro');
  okMock.mock.restore();

  // On listing failure, fall back to the static catalog (LLM + embeddings).
  t.mock.method(axios, 'get', async () => {
    throw new Error('network down');
  });
  assert.equal(await a.validate({ api_key: 'k' }), false);
  const emb = await a.listModels({ api_key: 'k' }, {}, 'embedding');
  assert.ok(emb.length > 0 && emb.every((m) => m.type === 'embedding'));
});

test('GeminiAdapter: maps embedding models and displayName/description fallbacks', async (t) => {
  const a = new GeminiAdapter();
  t.mock.method(axios, 'get', async () =>
    okResponse({
      models: [
        { name: 'gemini-embedding-001', displayName: 'Gemini Embed' },
        { name: 'plain-id-without-prefix' },
        { name: 'text-embedding-004', description: 'Embedding model' },
      ],
    }),
  );
  const all = await a.listModels({ api_key: 'k' });
  assert.ok(all.some((m) => m.id === 'plain-id-without-prefix' && m.name === 'plain-id-without-prefix'));
  assert.ok(all.some((m) => m.id === 'text-embedding-004' && m.description === 'Embedding model'));
  const emb = await a.listModels({ api_key: 'k' }, {}, 'embedding');
  assert.ok(emb.length >= 2 && emb.every((m) => m.type === 'embedding'));
});

// --------------------------------------------------------------- Anthropic
test('AnthropicAdapter: validate + listModels (chat-only) with static fallback', async (t) => {
  const a = new AnthropicAdapter();
  assert.equal(a.provider, 'anthropic');
  assert.equal(await a.validate({}), false);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const okMock = t.mock.method(axios, 'get', async () =>
    okResponse({ data: [{ id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' }] }),
  );
  assert.equal(await a.validate({ api_key: 'sk-ant' }), true);
  const models = await a.listModels({ api_key: 'sk-ant' });
  assert.equal(models[0].id, 'claude-3-5-sonnet-20241022');
  assert.equal(models[0].type, 'llm');
  // Anthropic serves chat models only — the embedding filter is empty.
  assert.equal((await a.listModels({ api_key: 'sk-ant' }, {}, 'embedding')).length, 0);
  okMock.mock.restore();

  // On listing failure, fall back to the curated Claude catalog (all LLM).
  t.mock.method(axios, 'get', async () => {
    throw new Error('boom');
  });
  assert.equal(await a.validate({ api_key: 'sk-ant' }), false);
  const fallback = await a.listModels({ api_key: 'sk-ant' });
  assert.ok(fallback.length > 0 && fallback.every((m) => m.type === 'llm'));
});

// --------------------------------------------------------------- Azure
test('AzureAdapter: validate needs key+endpoint; listModels maps + fallback', async (t) => {
  const a = new AzureAdapter();
  assert.equal(await a.validate({}, {}), false);
  await assert.rejects(() => a.listModels({}, {}), /Missing api_key or endpoint/);

  const okMock = t.mock.method(axios, 'get', async () => okResponse({ data: [{ id: 'gpt-4o' }] }));
  assert.equal(await a.validate({ api_key: 'k' }, { endpoint: 'https://az' }), true);
  const models = await a.listModels({ api_key: 'k' }, { endpoint: 'https://az' });
  assert.equal(models[0].id, 'gpt-4o');
  okMock.mock.restore();

  t.mock.method(axios, 'get', async () => {
    throw new Error('boom');
  });
  assert.equal(await a.validate({ api_key: 'k' }, { endpoint: 'https://az' }), false);
  // AzureAdapter intentionally does NOT provide a static catalog fallback:
  // when the deployments / catalog endpoint fails (no listing
  // permissions, network error, etc.) we surface the error to the
  // caller so the UI can show a real diagnostic instead of silently
  // offering models the project may not actually have access to. Users
  // who want exact-match can provide manual `deployments` metadata
  // (parsed earlier in `listModels`).
  await assert.rejects(
    () => a.listModels({ api_key: 'k' }, { endpoint: 'https://az' }, 'llm'),
    /Failed to list models from https:\/\/az/,
  );
});

test('AzureAdapter: manual deployment_names and embedding filter', async () => {
  const a = new AzureAdapter();
  const manual = await a.listModels(
    { api_key: 'k' },
    { endpoint: 'https://az', deployment_names: 'gpt-4o,my-embedding-deploy' },
    'embedding',
  );
  assert.equal(manual.length, 1);
  assert.equal(manual[0].type, 'embedding');
});

test('AzureAdapter: validate succeeds with manual deploymentNames array', async () => {
  const a = new AzureAdapter();
  assert.equal(
    await a.validate({ api_key: 'k' }, { endpoint: 'https://az', deploymentNames: ['gpt-4o'] }),
    true,
  );
});

test('AzureAdapter: uses deployments API then catalog with apiVersion metadata', async (t) => {
  const a = new AzureAdapter();
  let lastUrl = '';
  t.mock.method(axios, 'get', async (url: string) => {
    lastUrl = url;
    if (url.includes('/openai/deployments')) {
      return okResponse({ data: [{ id: 'dep1', model: 'gpt-4o', status: 'succeeded' }] });
    }
    return okResponse({ data: [{ id: 'gpt-4o-catalog' }] });
  });
  const deployed = await a.listModels(
    { api_key: 'k' },
    { endpoint: 'https://az', apiVersion: '2024-01-01' },
  );
  assert.equal(deployed[0].id, 'dep1');
  assert.match(lastUrl, /api-version=2024-01-01/);

  t.mock.method(axios, 'get', async (url: string) => {
    if (url.includes('/openai/deployments')) {
      return okResponse({ data: [{ id: 'failed-dep', status: 'failed' }] });
    }
    return okResponse({ data: [{ id: 'catalog-only' }] });
  });
  const catalog = await a.listModels({ api_key: 'k' }, { endpoint: 'https://az' });
  assert.equal(catalog[0].id, 'catalog-only');
});

test('AzureAdapter: tryListDeployments returns null on non-array response', async (t) => {
  const a = new AzureAdapter();
  t.mock.method(axios, 'get', async (url: string) => {
    if (url.includes('/openai/deployments')) {
      return okResponse({ data: null });
    }
    return okResponse({ data: [{ id: 'catalog-only' }] });
  });
  const models = await a.listModels({ api_key: 'k' }, { endpoint: 'https://az' });
  assert.equal(models[0].id, 'catalog-only');
});

test('AzureAdapter: validate falls back to catalog when deployments are empty', async (t) => {
  const a = new AzureAdapter();
  t.mock.method(axios, 'get', async (url: string) => {
    if (url.includes('/openai/deployments')) {
      return okResponse({ data: [] });
    }
    return okResponse({ data: [{ id: 'gpt-4o' }] });
  });
  assert.equal(await a.validate({ api_key: 'k' }, { endpoint: 'https://az' }), true);
});

// --------------------------------------------------------------- Ollama
test('OllamaAdapter: always validates and returns LLM-only static catalog', async () => {
  const a = new OllamaAdapter();
  assert.equal(await a.validate({}), true);
  const all = await a.listModels({});
  // Catalog deliberately contains LLMs only (Llama 3.2 1B/3B, Mistral
  // 7B); the sentence-transformer embeddings that used to live on the
  // old `local` provider are not served by Ollama and were dropped.
  assert.ok(all.length >= 3);
  assert.ok(all.every((m) => m.type === 'llm'));
  assert.equal((await a.listModels({}, {}, 'embedding')).length, 0);
});

// --------------------------------------------------------------- Cohere
test('CohereAdapter: validate + listModels types from endpoints, with fallback', async (t) => {
  const a = new CohereAdapter();
  assert.equal(a.provider, 'cohere');
  assert.equal(await a.validate({}), false);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const okMock = t.mock.method(axios, 'get', async () =>
    okResponse({
      models: [
        { name: 'command-r-plus', endpoints: ['chat'], context_length: 128000 },
        { name: 'embed-english-v3.0', endpoints: ['embed'] },
        { name: 'rerank-v3.5', endpoints: ['rerank'] },
      ],
    }),
  );
  assert.equal(await a.validate({ api_key: 'co-test' }), true);
  const all = await a.listModels({ api_key: 'co-test' });
  // rerank-only model is dropped; chat + embed remain.
  assert.equal(all.length, 2);
  const emb = await a.listModels({ api_key: 'co-test' }, {}, 'embedding');
  assert.equal(emb.length, 1);
  assert.equal(emb[0].id, 'embed-english-v3.0');
  okMock.mock.restore();

  // On listing failure, fall back to the curated static catalog.
  t.mock.method(axios, 'get', async () => {
    throw new Error('boom');
  });
  assert.equal(await a.validate({ api_key: 'co-test' }), false);
  const fallback = await a.listModels({ api_key: 'co-test' });
  assert.ok(fallback.some((m) => m.id === 'command-r-plus'));
  assert.ok(fallback.some((m) => m.type === 'embedding'));
});

// --------------------------------------------------------------- Perplexity
test('PerplexityAdapter: key-only validate + chat-only static catalog', async () => {
  const a = new PerplexityAdapter();
  assert.equal(a.provider, 'perplexity');
  // No /models endpoint: validate is a plain key-presence check (no live call).
  assert.equal(await a.validate({}), false);
  assert.equal(await a.validate({ api_key: 'pplx-x' }), true);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const all = await a.listModels({ api_key: 'pplx-x' });
  assert.ok(all.length > 0 && all.every((m) => m.type === 'llm'));
  assert.equal((await a.listModels({ api_key: 'pplx-x' }, {}, 'embedding')).length, 0);
});

// --------------------------------------------------------------- Hugging Face
test('HuggingFaceAdapter: validate + listModels (chat) with static fallback', async (t) => {
  const a = new HuggingFaceAdapter();
  assert.equal(a.provider, 'huggingface');
  assert.equal(await a.validate({}), false);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const okMock = t.mock.method(axios, 'get', async () =>
    okResponse({ data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct' }] }),
  );
  assert.equal(await a.validate({ api_key: 'hf_x' }), true);
  const models = await a.listModels({ api_key: 'hf_x' });
  assert.equal(models[0].id, 'meta-llama/Llama-3.3-70B-Instruct');
  assert.equal(models[0].type, 'llm');
  okMock.mock.restore();

  t.mock.method(axios, 'get', async () => {
    throw new Error('boom');
  });
  assert.equal(await a.validate({ api_key: 'hf_x' }), false);
  const fallback = await a.listModels({ api_key: 'hf_x' });
  assert.ok(fallback.length > 0 && fallback.every((m) => m.type === 'llm'));
});

// --------------------------------------------------------------- Fireworks
test('FireworksAdapter: validate + listModels maps embeddings, with fallback', async (t) => {
  const a = new FireworksAdapter();
  assert.equal(a.provider, 'fireworks');
  assert.equal(await a.validate({}), false);
  await assert.rejects(() => a.listModels({}), /Missing api_key/);

  const okMock = t.mock.method(axios, 'get', async () =>
    okResponse({
      data: [
        { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct' },
        { id: 'nomic-ai/nomic-embed-text-v1.5' },
      ],
    }),
  );
  assert.equal(await a.validate({ api_key: 'fw_x' }), true);
  const all = await a.listModels({ api_key: 'fw_x' });
  assert.equal(all.length, 2);
  const emb = await a.listModels({ api_key: 'fw_x' }, {}, 'embedding');
  assert.equal(emb.length, 1);
  assert.equal(emb[0].type, 'embedding');
  okMock.mock.restore();

  t.mock.method(axios, 'get', async () => {
    throw new Error('boom');
  });
  assert.equal(await a.validate({ api_key: 'fw_x' }), false);
  const fallback = await a.listModels({ api_key: 'fw_x' });
  assert.ok(fallback.some((m) => m.id.startsWith('accounts/fireworks/models/')));
});

// ----------------------------------------------------------- connector adapters
test('connector adapters: generic, S3 and ONTAP validation rules', async () => {
  const adapters = createConnectorAdapters();
  const byProvider = new Map(adapters.map((a) => [a.provider, a]));

  for (const p of ['s3', 'gcs', 'gcp', 'azure_cloud', 'postgresql', 'mysql', 'redash', 'ontap']) {
    assert.ok(byProvider.has(p), `expected connector adapter ${p}`);
    assert.deepEqual(await byProvider.get(p)!.listModels({}), []);
  }

  const pg = byProvider.get('postgresql')!;
  assert.equal(await pg.validate({ username: 'u', password: 'p' }), true);
  await assert.rejects(() => pg.validate({ username: 'u' }), /Missing required secret key "password"/);

  const s3 = byProvider.get('s3')!;
  assert.equal(await s3.validate({ access_key_id: 'a', secret_access_key: 'b' }), true);
  await assert.rejects(() => s3.validate({ access_key_id: 'a' }), /secret_access_key/);
  await assert.rejects(() => s3.validate({ secret_access_key: 'b' }), /access_key_id/);

  const ontap = byProvider.get('ontap')!;
  assert.equal(await ontap.validate({ username: 'u', password: 'p' }), true);
  assert.equal(await ontap.validate({ client_cert_pem: 'cert', client_key_pem: 'key' }), true);
  await assert.rejects(() => ontap.validate({ username: 'u' }), /username \+ password.*client_cert_pem/);
});

// ----------------------------------------------------------- static metadata
test('getStaticModelMetadata: exact, fuzzy, fallback, undefined', () => {
  assert.equal(getStaticModelMetadata(null, 'gpt-4o'), undefined);
  assert.equal(getStaticModelMetadata('openai', 'gpt-4o')!.contextWindow, 128000);
  // gemini provider key resolves via its own static catalog + fallback
  assert.equal(getStaticModelMetadata('gemini', 'gemini-1.5-pro')!.contextWindow, 2097152);
  assert.equal(getStaticModelMetadata('gemini', 'unknown-gemini-model')!.contextWindow, 1048576);
  // fuzzy: not an exact catalog key but matches a rule
  assert.equal(getStaticModelMetadata('anthropic', 'claude-3-5-sonnet-unknown-date')!.maxOutputTokens, 8192);
  assert.equal(getStaticModelMetadata('anthropic', 'claude-3-opus-unknown')!.supportsExtendedOutput, false);
  // provider-level fallback for unknown model id
  assert.equal(getStaticModelMetadata('openai_compatible', 'mystery-model')!.contextWindow, 32000);
  // unknown provider with no fallback
  assert.equal(getStaticModelMetadata('nonexistent', 'x'), undefined);
});
