/**
 * Run: node --require ts-node/register --test tests/platformMcpDefaults.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
  isPlatformMcpAutoAttachable,
  mergePlatformMcpExtraHeaders,
  platformMcpExtraHeadersNeedUpdate,
  readPlatformMcpAutoAttachFlags,
  resolvePlatformMcpExtraHeaders,
} from '../catalog/platformMcpDefaults';

test('mergePlatformMcpExtraHeaders includes all defaults', () => {
  const merged = mergePlatformMcpExtraHeaders(['X-Custom']);
  assert.deepEqual(merged.slice(0, PLATFORM_MCP_DEFAULT_EXTRA_HEADERS.length), [
    ...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
  ]);
  assert.equal(merged[merged.length - 1], 'X-Custom');
});

test('platformMcpExtraHeadersNeedUpdate detects missing defaults', () => {
  assert.equal(platformMcpExtraHeadersNeedUpdate(null), true);
  assert.equal(platformMcpExtraHeadersNeedUpdate([]), true);
  assert.equal(
    platformMcpExtraHeadersNeedUpdate(['Authorization', 'X-Project-ID', 'X-User-ID']),
    true,
  );
  assert.equal(
    platformMcpExtraHeadersNeedUpdate([...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS, 'X-Agent-ID']),
    true,
  );
  assert.equal(
    platformMcpExtraHeadersNeedUpdate([...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS]),
    false,
  );
});

test('resolvePlatformMcpExtraHeaders applies defaults when omitted', () => {
  assert.deepEqual(resolvePlatformMcpExtraHeaders(), [...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS]);
  assert.deepEqual(resolvePlatformMcpExtraHeaders(['Authorization']), [
    ...PLATFORM_MCP_DEFAULT_EXTRA_HEADERS,
  ]);
});

test('isPlatformMcpAutoAttachable: non-gated platform MCP (artifact-store) is always on', () => {
  const flags = { webSearch: false, analytics: false };
  assert.equal(isPlatformMcpAutoAttachable('artifact_store_mcp', flags), true);
  assert.equal(isPlatformMcpAutoAttachable(null, flags), true);
});

test('isPlatformMcpAutoAttachable: analytics gated by analytics flag', () => {
  assert.equal(
    isPlatformMcpAutoAttachable('analytics_datasets_mcp', { webSearch: true, analytics: false }),
    false,
  );
  assert.equal(
    isPlatformMcpAutoAttachable('analytics_datasets_mcp', { webSearch: false, analytics: true }),
    true,
  );
});

test('isPlatformMcpAutoAttachable: web-search variants gated by web-search flag', () => {
  for (const id of ['web_search_mcp', 'searxng_web_search_mcp']) {
    assert.equal(
      isPlatformMcpAutoAttachable(id, { webSearch: false, analytics: true }),
      false,
      `${id} should be gated off when webSearch=false`,
    );
    assert.equal(
      isPlatformMcpAutoAttachable(id, { webSearch: true, analytics: false }),
      true,
      `${id} should be on when webSearch=true`,
    );
  }
});

test('readPlatformMcpAutoAttachFlags reads env case-insensitively', () => {
  const prevWeb = process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP;
  const prevAnalytics = process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP;
  try {
    process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP = 'TRUE';
    delete process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP;
    assert.deepEqual(readPlatformMcpAutoAttachFlags(), { webSearch: true, analytics: false });

    process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP = 'false';
    process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP = 'true';
    assert.deepEqual(readPlatformMcpAutoAttachFlags(), { webSearch: false, analytics: true });
  } finally {
    if (prevWeb === undefined) delete process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP;
    else process.env.AUTO_ATTACH_PLATFORM_WEB_SEARCH_MCP = prevWeb;
    if (prevAnalytics === undefined) delete process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP;
    else process.env.AUTO_ATTACH_PLATFORM_ANALYTICS_MCP = prevAnalytics;
  }
});
