/**
 * Unit tests for the static MCP server catalog lookups + defaultEnvFn closures.
 *
 * Run: node --require ts-node/register --test tests/mcpServerCatalog.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_SERVER_CATALOG,
  RESOURCE_PRESETS,
  getCatalogEntry,
  getCatalogEntryIds,
  WEB_SEARCH_CATALOG_ID,
  SEARXNG_WEB_SEARCH_CATALOG_ID,
  ANALYTICS_DATASETS_CATALOG_ID,
  ARTIFACT_STORE_CATALOG_ID,
} from '../catalog/mcpServerCatalog';

test('getCatalogEntry: returns known entries and undefined otherwise', () => {
  const web = getCatalogEntry(WEB_SEARCH_CATALOG_ID);
  assert.ok(web);
  assert.equal(web!.name, 'Tavily Web Search');
  assert.equal(getCatalogEntry(SEARXNG_WEB_SEARCH_CATALOG_ID)?.category, 'general');
  assert.equal(getCatalogEntry(ANALYTICS_DATASETS_CATALOG_ID)?.category, 'database');
  assert.equal(getCatalogEntry('no-such-id'), undefined);
  assert.equal(ARTIFACT_STORE_CATALOG_ID, 'artifact_store_mcp');
});

test('getCatalogEntryIds: matches catalog length and entry ids', () => {
  const ids = getCatalogEntryIds();
  assert.equal(ids.length, MCP_SERVER_CATALOG.length);
  assert.ok(ids.includes(WEB_SEARCH_CATALOG_ID));
});

test('RESOURCE_PRESETS: small/medium/large defined with cpu+memory', () => {
  for (const preset of ['small', 'medium', 'large']) {
    assert.ok(RESOURCE_PRESETS[preset].cpu);
    assert.ok(RESOURCE_PRESETS[preset].memoryLimit);
  }
});

test('catalog: every entry is internally consistent and defaultEnvFn runs', () => {
  for (const entry of MCP_SERVER_CATALOG) {
    assert.ok(entry.id && entry.name && entry.image);
    assert.ok(['strict', 'network-access'].includes(entry.securityProfile));
    assert.ok(['small', 'medium', 'large'].includes(entry.resourcePreset));
    assert.ok(Array.isArray(entry.envSchema));
    if (entry.defaultEnvFn) {
      const env = entry.defaultEnvFn();
      assert.equal(typeof env, 'object');
      for (const [k, v] of Object.entries(env)) {
        assert.equal(typeof k, 'string');
        assert.equal(typeof v, 'string');
      }
    }
  }
});
