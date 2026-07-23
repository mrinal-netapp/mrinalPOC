/**
 * Unit tests for {@link normalizeMemoryContextInput}, exercising the
 * PR-feedback fixes:
 *
 *   - Partial bodies are accepted (`{ type: 'window' }` alone).
 *   - Missing `enabled` defaults to `true` (NOT `false` — a missing
 *     field must not silently disable memory).
 *   - Both new and legacy shape inputs round-trip to the same new shape.
 *   - Unknown / non-object inputs return `undefined` so the route layer
 *     surfaces a 400 instead of corrupting the column.
 *
 * Run: node --require ts-node/register --test tests/MemoryContextDerivation.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMemoryContextInput,
  deriveLegacyFromContext,
} from '../services/MemoryContextDerivation';

// ---------------------------------------------------------------------------
// normalizeMemoryContextInput — accepting partial bodies
// ---------------------------------------------------------------------------

test('normalize: { type: "window" } alone is accepted; enabled defaults to true', () => {
  const out = normalizeMemoryContextInput({ type: 'window' });
  assert.deepEqual(out, { enabled: true, type: 'window' });
});

test('normalize: { enabled: true } alone defaults type to "window"', () => {
  const out = normalizeMemoryContextInput({ enabled: true });
  assert.deepEqual(out, { enabled: true, type: 'window' });
});

test('normalize: { enabled: false } alone defaults type to "none"', () => {
  const out = normalizeMemoryContextInput({ enabled: false });
  assert.deepEqual(out, { enabled: false, type: 'none' });
});

test('normalize: missing enabled does NOT silently disable memory', () => {
  // The pre-fix bug: `enabled: Boolean(v.enabled)` flipped a missing
  // input into `false`. Pin the corrected behavior.
  const out = normalizeMemoryContextInput({ type: 'summary_buffer' });
  assert.ok(out, 'expected a normalized object');
  assert.equal(out.enabled, true);
  assert.equal(out.type, 'summary_buffer');
});

test('normalize: explicit enabled=false is honored', () => {
  const out = normalizeMemoryContextInput({ enabled: false, type: 'window' });
  assert.deepEqual(out, { enabled: false, type: 'window' });
});

test('normalize: full new-shape body round-trips its optional fields', () => {
  const out = normalizeMemoryContextInput({
    type: 'summary_buffer',
    enabled: true,
    message_window_limit: 5,
    message_token_limit: 4096,
    summary_token_limit: 2000,
    summary_refresh_every_turns: 0,
    summary_model: 'azure/gpt-4o-mini',
    adaptive_summarize: { overflow_threshold: 0.3 },
    budget: { tool_round_reservation: 1024, output_reservation: 2048, safety_buffer_pct: 0.05 },
    iAmAnUnknownKey: 'dropped',
  });
  assert.deepEqual(out, {
    enabled: true,
    type: 'summary_buffer',
    message_window_limit: 5,
    message_token_limit: 4096,
    summary_token_limit: 2000,
    summary_refresh_every_turns: 0,
    summary_model: 'azure/gpt-4o-mini',
    adaptive_summarize: { overflow_threshold: 0.3 },
    budget: {
      tool_round_reservation: 1024,
      output_reservation: 2048,
      safety_buffer_pct: 0.05,
    },
  });
});

// ---------------------------------------------------------------------------
// Legacy AgentMemoryContext shape coercion
// ---------------------------------------------------------------------------

test('normalize: legacy sliding_window policy with limit', () => {
  const out = normalizeMemoryContextInput({
    enabled: true,
    message_retention_policy: 'sliding_window',
    message_history_limit: 9,
  });
  assert.deepEqual(out, { enabled: true, type: 'window', message_window_limit: 9 });
});

test('normalize: legacy summarize policy maps to summary_buffer', () => {
  const out = normalizeMemoryContextInput({
    enabled: true,
    message_retention_policy: 'summarize',
    message_history_limit: 12,
  });
  assert.deepEqual(out, { enabled: true, type: 'summary_buffer', message_window_limit: 12 });
});

test('normalize: legacy policy="none" or limit=0 disables', () => {
  const a = normalizeMemoryContextInput({
    enabled: true,
    message_retention_policy: 'none',
  });
  assert.deepEqual(a, { enabled: false, type: 'none' });

  const b = normalizeMemoryContextInput({
    enabled: true,
    message_retention_policy: 'sliding_window',
    message_history_limit: 0,
  });
  assert.deepEqual(b, { enabled: false, type: 'none' });
});

// ---------------------------------------------------------------------------
// Boundary inputs
// ---------------------------------------------------------------------------

test('normalize: null / undefined return undefined', () => {
  assert.equal(normalizeMemoryContextInput(null), undefined);
  assert.equal(normalizeMemoryContextInput(undefined), undefined);
});

test('normalize: non-object inputs return undefined', () => {
  assert.equal(normalizeMemoryContextInput('window'), undefined);
  assert.equal(normalizeMemoryContextInput(42), undefined);
  assert.equal(normalizeMemoryContextInput(true), undefined);
});

test('normalize: object with no recognisable shape returns undefined', () => {
  // Has neither `type`/`enabled` (new) nor legacy policy/limit fields.
  assert.equal(normalizeMemoryContextInput({ randomKey: 'value' }), undefined);
});

test('normalize: garbage `type` string alone returns undefined (enum-validated)', () => {
  // Previously a `type: 'foobar'` would have been cast as MemoryType and
  // persisted as-is. Now the enum check rejects it; without any other
  // recognisable shape field the normaliser returns undefined so the
  // route layer surfaces a 400.
  assert.equal(normalizeMemoryContextInput({ type: 'foobar' }), undefined);
  assert.equal(normalizeMemoryContextInput({ type: '' }), undefined);
  assert.equal(normalizeMemoryContextInput({ type: 42 }), undefined);
});

test('normalize: garbage `type` with explicit enabled drops the bad type', () => {
  // `enabled: true` keeps the payload in the new-shape branch, but the
  // bad `type` is replaced by the enabled-derived default so the column
  // never carries `type: 'foobar'`.
  const out = normalizeMemoryContextInput({ enabled: true, type: 'foobar' });
  assert.deepEqual(out, { enabled: true, type: 'window' });

  const outDisabled = normalizeMemoryContextInput({ enabled: false, type: 'foobar' });
  assert.deepEqual(outDisabled, { enabled: false, type: 'none' });
});

test('normalize: legacy detector ignores garbage `type` (lets legacy fields win)', () => {
  // A row that mixes a bad `type` string with valid legacy fields lands
  // in the legacy branch instead of being misclassified as new-shape
  // and dropped. Pin that interleaving.
  const out = normalizeMemoryContextInput({
    type: 'foobar',
    enabled: true,
    message_retention_policy: 'sliding_window',
    message_history_limit: 4,
  });
  assert.deepEqual(out, { enabled: true, type: 'window', message_window_limit: 4 });
});

// ---------------------------------------------------------------------------
// deriveLegacyFromContext — sanity tying it to a partial normalize result
// ---------------------------------------------------------------------------

test('deriveLegacyFromContext: partial normalize → window with defaulted limit', () => {
  // Default-filled normalization → derivation defaults message_window_limit
  // to 20 because the field was omitted on the wire.
  const normalized = normalizeMemoryContextInput({ type: 'window' });
  assert.ok(normalized);
  const legacy = deriveLegacyFromContext(normalized);
  assert.equal(legacy.memoryType, 'sliding_window');
  assert.equal(legacy.memoryConfig.windowSize, 20);
});

test('deriveLegacyFromContext: enabled=false → memoryType=none, empty config', () => {
  const legacy = deriveLegacyFromContext({ enabled: false, type: 'none' });
  assert.deepEqual(legacy, { memoryType: 'none', memoryConfig: {} });
});
