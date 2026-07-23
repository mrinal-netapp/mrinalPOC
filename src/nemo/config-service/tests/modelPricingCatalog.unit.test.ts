/**
 * Run: node --require ts-node/register --test tests/modelPricingCatalog.unit.test.ts
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { clearModule, loadFresh } from './helpers/moduleMock';

// Disable the live datasheet fetch so lookups are deterministic and offline.
// Read lazily by the module at call time, so setting it here is sufficient.
process.env.MODEL_PRICING_DATASHEET_URL = 'off';

import {
  EMBEDDED_PRICING_DATASHEET,
  getModelPricingDefault,
  lookupPricingInSheet,
  mapProviderToDatasheet,
  type PricingDatasheet,
} from '../catalog/modelPricingCatalog';

const SHEET: PricingDatasheet = {
  // Bare id, chat model under openai.
  'gpt-4o': {
    provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
  },
  // Provider-prefixed key (as the datasheet keys some entries).
  'anthropic/claude-3-5-sonnet': {
    provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
  },
  // Embedding with zero output cost.
  'text-embedding-3-small': {
    provider: 'openai',
    mode: 'embedding',
    input_cost_per_token: 0.00000002,
    output_cost_per_token: 0,
  },
};

test('lookupPricingInSheet converts per-token cost to per-1M', () => {
  const p = lookupPricingInSheet(SHEET, 'openai', 'gpt-4o', 'datasheet');
  assert.ok(p);
  assert.equal(p!.inputCostPer1M, 2.5);
  assert.equal(p!.outputCostPer1M, 10);
  assert.equal(p!.currency, 'USD');
  assert.equal(p!.source, 'datasheet');
  assert.equal(p!.mode, 'chat');
});

test('lookupPricingInSheet is case-insensitive on the model id', () => {
  const p = lookupPricingInSheet(SHEET, 'openai', 'GPT-4O', 'datasheet');
  assert.ok(p);
  assert.equal(p!.inputCostPer1M, 2.5);
});

test('lookupPricingInSheet resolves provider-prefixed datasheet keys', () => {
  const p = lookupPricingInSheet(SHEET, 'anthropic', 'claude-3-5-sonnet', 'datasheet');
  assert.ok(p);
  assert.equal(p!.inputCostPer1M, 3);
  assert.equal(p!.outputCostPer1M, 15);
});

test('lookupPricingInSheet keeps a zero output cost (embeddings)', () => {
  const p = lookupPricingInSheet(SHEET, 'openai', 'text-embedding-3-small', 'datasheet');
  assert.ok(p);
  assert.equal(p!.inputCostPer1M, 0.02);
  assert.equal(p!.outputCostPer1M, 0);
});

test('lookupPricingInSheet returns null for unknown models', () => {
  assert.equal(lookupPricingInSheet(SHEET, 'openai', 'made-up-model', 'datasheet'), null);
  assert.equal(lookupPricingInSheet(SHEET, 'openai', '', 'datasheet'), null);
});

test('exact matches are flagged non-approximate and report the matched id', () => {
  const p = lookupPricingInSheet(SHEET, 'openai', 'gpt-4o', 'datasheet');
  assert.ok(p);
  assert.equal(p!.approximate, false);
  assert.equal(p!.matchedModel, 'gpt-4o');
});

test('decorated ids resolve to the closest catalog family (approximate)', () => {
  // Dated OpenAI snapshot.
  const dated = lookupPricingInSheet(SHEET, 'openai', 'gpt-4o-2024-08-06', 'datasheet');
  assert.ok(dated);
  assert.equal(dated!.inputCostPer1M, 2.5);
  assert.equal(dated!.matchedModel, 'gpt-4o');
  assert.equal(dated!.approximate, true);

  // Deployment-name style suffix.
  const deploy = lookupPricingInSheet(SHEET, 'openai', 'gpt-4o-realtime-preview', 'datasheet');
  assert.ok(deploy);
  assert.equal(deploy!.matchedModel, 'gpt-4o');
  assert.equal(deploy!.approximate, true);

  // Prefix match against a provider-prefixed datasheet key.
  const anthropic = lookupPricingInSheet(
    SHEET,
    'anthropic',
    'claude-3-5-sonnet-20241022',
    'datasheet',
  );
  assert.ok(anthropic);
  assert.equal(anthropic!.inputCostPer1M, 3);
  assert.equal(anthropic!.matchedModel, 'anthropic/claude-3-5-sonnet');
  assert.equal(anthropic!.approximate, true);
});

test('prefix match respects token boundaries (no partial-word matches)', () => {
  // "gpt-4omini" is not a token-boundary extension of "gpt-4o".
  assert.equal(lookupPricingInSheet(SHEET, 'openai', 'gpt-4omini', 'datasheet'), null);
});

test('getModelPricingDefault resolves an Azure deployment name via prefix match', async () => {
  const p = await getModelPricingDefault('azure', 'gpt-4o-mini-model');
  assert.ok(p);
  assert.equal(p!.source, 'builtin');
  assert.equal(p!.matchedModel, 'gpt-4o-mini');
  assert.equal(p!.approximate, true);
  assert.equal(p!.inputCostPer1M, 0.15);
  assert.equal(p!.outputCostPer1M, 0.6);
});

test('mapProviderToDatasheet normalizes provider aliases', () => {
  assert.equal(mapProviderToDatasheet('azure-openai'), 'azure');
  assert.equal(mapProviderToDatasheet('aws_bedrock'), 'bedrock');
  assert.equal(mapProviderToDatasheet('google'), 'vertex_ai');
  assert.equal(mapProviderToDatasheet('openai_compatible'), 'openai');
  assert.equal(mapProviderToDatasheet(null), null);
});

test('getModelPricingDefault falls back to the embedded datasheet (source=builtin)', async () => {
  // MODEL_PRICING_DATASHEET_URL=off disables the live fetch, so this exercises
  // the embedded sheet.
  const p = await getModelPricingDefault('openai', 'gpt-4o-mini');
  assert.ok(p);
  assert.equal(p!.source, 'builtin');
  assert.equal(p!.inputCostPer1M, 0.15);
  assert.equal(p!.outputCostPer1M, 0.6);
});

test('embedded datasheet exposes common models', () => {
  assert.ok(EMBEDDED_PRICING_DATASHEET['gpt-4o']);
  assert.ok(EMBEDDED_PRICING_DATASHEET['claude-3-5-sonnet']);
  assert.ok(EMBEDDED_PRICING_DATASHEET['gemini-1.5-pro']);
});

test('lookupPricingInSheet: returns null when both token costs are invalid', () => {
  const sheet: PricingDatasheet = {
    'broken-model': { provider: 'openai', mode: 'chat', input_cost_per_token: Number.NaN },
  };
  assert.equal(lookupPricingInSheet(sheet, 'openai', 'broken-model', 'datasheet'), null);
});

test('lookupPricingInSheet: prefers provider-matching bare id over weak mismatch', () => {
  const sheet: PricingDatasheet = {
    'shared-id': {
      provider: 'anthropic',
      mode: 'chat',
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
    },
    'openai/shared-id': {
      provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 0.0000025,
      output_cost_per_token: 0.00001,
    },
  };
  const p = lookupPricingInSheet(sheet, 'openai', 'shared-id', 'datasheet');
  assert.ok(p);
  assert.equal(p!.inputCostPer1M, 2.5);
});

test('mapProviderToDatasheet: returns lowercased provider for unknown ids', () => {
  assert.equal(mapProviderToDatasheet('CustomProvider'), 'customprovider');
});

test('getModelPricingDefault: loads live datasheet on first fetch', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevUrl = process.env.MODEL_PRICING_DATASHEET_URL;
  delete process.env.NODE_ENV;
  process.env.MODEL_PRICING_DATASHEET_URL = 'http://datasheet.test/pricing.json';

  const axiosMock = mock.method(axios, 'get', async () => ({
    data: {
      'gpt-live': {
        provider: 'openai',
        mode: 'chat',
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    },
  }));
  t.after(() => {
    axiosMock.mock.restore();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevUrl === undefined) delete process.env.MODEL_PRICING_DATASHEET_URL;
    else process.env.MODEL_PRICING_DATASHEET_URL = prevUrl;
    clearModule('catalog/modelPricingCatalog');
  });

  clearModule('catalog/modelPricingCatalog');
  const mod = loadFresh<typeof import('../catalog/modelPricingCatalog')>('catalog/modelPricingCatalog');
  mod.__resetPricingDatasheetCacheForTests();

  const live = await mod.getModelPricingDefault('openai', 'gpt-live');
  assert.ok(live);
  assert.equal(live!.source, 'datasheet');
  assert.equal(live!.inputCostPer1M, 1);
});

test('getModelPricingDefault: tolerates live datasheet fetch failures', async (t) => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevUrl = process.env.MODEL_PRICING_DATASHEET_URL;
  delete process.env.NODE_ENV;
  process.env.MODEL_PRICING_DATASHEET_URL = 'http://datasheet.test/pricing.json';

  const axiosMock = mock.method(axios, 'get', async () => {
    throw new Error('network down');
  });
  t.after(() => {
    axiosMock.mock.restore();
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevUrl === undefined) delete process.env.MODEL_PRICING_DATASHEET_URL;
    else process.env.MODEL_PRICING_DATASHEET_URL = prevUrl;
    clearModule('catalog/modelPricingCatalog');
  });

  clearModule('catalog/modelPricingCatalog');
  const mod = loadFresh<typeof import('../catalog/modelPricingCatalog')>('catalog/modelPricingCatalog');
  mod.__resetPricingDatasheetCacheForTests();

  const fallback = await mod.getModelPricingDefault('openai', 'gpt-4o-mini');
  assert.ok(fallback);
  assert.equal(fallback!.source, 'builtin');
});
