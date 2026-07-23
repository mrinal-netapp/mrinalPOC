/**
 * Unit tests for providers/embeddingDimensions.ts — the static catalog
 * + fuzzy-rule resolver used at model-registration time and by the KB
 * route to look up vector dimensions for embedding models.
 *
 * Run: node --require ts-node/register --test tests/embeddingDimensions.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getKnownEmbeddingModelInfo,
  getKnownEmbeddingDimensions,
  enrichModelInfoFromCatalog,
} from '../providers/embeddingDimensions';

// --------------------------------------------------------------- exact match
test('embeddingDimensions: exact match per provider for OpenAI/Azure/openai_compatible', () => {
  assert.equal(getKnownEmbeddingDimensions('openai', 'text-embedding-3-small'), 1536);
  assert.equal(getKnownEmbeddingDimensions('openai', 'text-embedding-3-large'), 3072);
  assert.equal(getKnownEmbeddingDimensions('openai', 'text-embedding-ada-002'), 1536);

  // Azure deployments use the same model ids under exact lookup.
  assert.equal(getKnownEmbeddingDimensions('azure', 'text-embedding-3-small'), 1536);
  assert.equal(getKnownEmbeddingDimensions('azure', 'text-embedding-3-large'), 3072);

  // openai_compatible mirrors the OpenAI table plus Cohere/Voyage.
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'text-embedding-3-small'), 1536);
});

test('embeddingDimensions: exact match for Cohere direct (via openai_compatible)', () => {
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-english-v3.0'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-multilingual-v3.0'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-english-light-v3.0'), 384);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-multilingual-light-v3.0'), 384);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-english-v2.0'), 4096);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'embed-multilingual-v2.0'), 768);
});

test('embeddingDimensions: exact match for Voyage family', () => {
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-3'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-3-lite'), 512);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-3-large'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-2'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-large-2'), 1536);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-code-3'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-code-2'), 1536);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-finance-2'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-law-2'), 1024);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'voyage-multilingual-2'), 1024);
});

test('embeddingDimensions: exact match for Bedrock embeddings', () => {
  assert.equal(getKnownEmbeddingDimensions('aws_bedrock', 'amazon.titan-embed-text-v1'), 1536);
  assert.equal(getKnownEmbeddingDimensions('aws_bedrock', 'amazon.titan-embed-text-v2:0'), 1024);
  assert.equal(getKnownEmbeddingDimensions('aws_bedrock', 'amazon.titan-embed-image-v1'), 1024);
  assert.equal(getKnownEmbeddingDimensions('aws_bedrock', 'cohere.embed-english-v3'), 1024);
  assert.equal(getKnownEmbeddingDimensions('aws_bedrock', 'cohere.embed-multilingual-v3'), 1024);
});

test('embeddingDimensions: exact match for Google text/gemini embeddings', () => {
  assert.equal(getKnownEmbeddingDimensions('google', 'text-embedding-004'), 768);
  assert.equal(getKnownEmbeddingDimensions('google', 'text-embedding-005'), 768);
  assert.equal(getKnownEmbeddingDimensions('google', 'embedding-001'), 768);
  assert.equal(getKnownEmbeddingDimensions('google', 'text-multilingual-embedding-002'), 768);
  assert.equal(getKnownEmbeddingDimensions('google', 'gemini-embedding-001'), 3072);
  assert.equal(getKnownEmbeddingDimensions('google', 'gemini-embedding-exp-03-07'), 3072);
});

// ------------------------------------------------------------- fuzzy fallback
test('embeddingDimensions: fuzzy match for Azure-style deployment names', () => {
  // Azure deployment names commonly look like `prod-text-embedding-3-large`.
  assert.equal(getKnownEmbeddingDimensions('azure', 'prod-text-embedding-3-large'), 3072);
  assert.equal(getKnownEmbeddingDimensions('azure', 'corp-text-embedding-3-small-v2'), 1536);
  // Provider hint isn't required when the model id is unambiguous.
  assert.equal(getKnownEmbeddingDimensions(undefined, 'prod-text-embedding-ada-002'), 1536);
});

test('embeddingDimensions: fuzzy match for Voyage variants — specific beats generic', () => {
  // The fuzzy rules are ordered so voyage-3-lite matches its own rule
  // before the generic /voyage-3/ rule (which would return 1024).
  assert.equal(getKnownEmbeddingDimensions(undefined, 'voyage-3-lite-2024'), 512);
  assert.equal(getKnownEmbeddingDimensions(undefined, 'voyage-3-large-prod'), 1024);
  assert.equal(getKnownEmbeddingDimensions(undefined, 'voyage-3-stable'), 1024);
  // light variant beats generic v3
  assert.equal(getKnownEmbeddingDimensions(undefined, 'cohere-embed-english-light-v3'), 384);
  assert.equal(getKnownEmbeddingDimensions(undefined, 'cohere-embed-english-v3-prod'), 1024);
});

test('embeddingDimensions: fuzzy match for Bedrock model variants', () => {
  assert.equal(getKnownEmbeddingDimensions(undefined, 'us.amazon.titan-embed-text-v2-fast'), 1024);
  assert.equal(getKnownEmbeddingDimensions(undefined, 'amazon.titan-embed-image-v1-mm'), 1024);
});

// -------------------------------------------------------------------- unknown
test('embeddingDimensions: unknown providerModelId returns undefined (no provider fallback)', () => {
  // Critical: there is NO provider-level fallback. Wrong dimensions
  // corrupt the LanceDB index, so returning undefined and letting the
  // caller 400 is the safe behavior.
  assert.equal(getKnownEmbeddingDimensions('openai', 'totally-made-up-embed'), undefined);
  assert.equal(getKnownEmbeddingDimensions('openai_compatible', 'mystery-vendor-1'), undefined);
  assert.equal(getKnownEmbeddingDimensions('google', 'some-unreleased-model'), undefined);
});

test('embeddingDimensions: null/undefined inputs return undefined', () => {
  assert.equal(getKnownEmbeddingDimensions(null, null), undefined);
  assert.equal(getKnownEmbeddingDimensions(undefined, undefined), undefined);
  assert.equal(getKnownEmbeddingDimensions('openai', null), undefined);
  assert.equal(getKnownEmbeddingDimensions('openai', ''), undefined);
});

// ------------------------------------------------------ getKnownEmbeddingModelInfo
test('getKnownEmbeddingModelInfo: returns full metadata bundle for known models', () => {
  const info = getKnownEmbeddingModelInfo('openai', 'text-embedding-3-large');
  assert.ok(info);
  assert.equal(info!.dimensions, 3072);
  assert.equal(info!.recommendedChunkSize, 1024);
  assert.equal(info!.category, 'quality');
  assert.ok(typeof info!.description === 'string' && info!.description.length > 0);
});

// ------------------------------------------------------ enrichModelInfoFromCatalog
test('enrichModelInfoFromCatalog: fills missing fields, preserves caller-set values', () => {
  // No prior model_info — catalog values are stamped wholesale.
  const enriched1 = enrichModelInfoFromCatalog(undefined, 'openai', 'text-embedding-3-small') as Record<string, unknown>;
  assert.equal(enriched1.dimensions, 1536);
  assert.equal(enriched1.recommendedChunkSize, 1024);
  assert.equal(enriched1.category, 'balanced');

  // Caller provides an explicit dimensions override — must NOT be clobbered
  // (this is the downsized-OpenAI-deployment story).
  const enriched2 = enrichModelInfoFromCatalog(
    { dimensions: 512 },
    'openai',
    'text-embedding-3-small',
  ) as Record<string, unknown>;
  assert.equal(enriched2.dimensions, 512, 'user override must win');
  assert.equal(enriched2.recommendedChunkSize, 1024, 'other catalog fields still fill in');

  // Caller provides a non-catalog key — must be preserved.
  const enriched3 = enrichModelInfoFromCatalog(
    { description: 'team-specific note', somethingElse: 'x' },
    'openai',
    'text-embedding-3-small',
  ) as Record<string, unknown>;
  assert.equal(enriched3.dimensions, 1536);
  assert.equal(enriched3.description, 'team-specific note');
  assert.equal(enriched3.somethingElse, 'x');
});

test('enrichModelInfoFromCatalog: returns the original object unchanged when no catalog entry', () => {
  const original = { dimensions: 999, custom: 'keep me' };
  const result = enrichModelInfoFromCatalog(original, 'openai', 'totally-unknown-embed');
  assert.equal(result, original, 'should return the very same reference, not a copy');
});

test('enrichModelInfoFromCatalog: treats empty string / null as missing for set-if-missing semantics', () => {
  const result = enrichModelInfoFromCatalog(
    { description: '', category: null },
    'openai',
    'text-embedding-3-small',
  ) as Record<string, unknown>;
  // Both should be replaced by catalog values because empty / null is treated as unset.
  assert.equal(typeof result.description === 'string' && (result.description as string).length > 0, true);
  assert.equal(result.category, 'balanced');
});
