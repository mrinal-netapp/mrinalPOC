/**
 * Unit tests for the batched built-in VK assignment merge
 * (`applyBuiltinBindingsToProviderConfigs` in
 * `services/bifrost/bifrostProjectGovernance.ts`).
 *
 * This is the pure seam behind `assignBuiltinModelsToProjectVirtualKey`,
 * which replaced the per-model concurrent `assignModelToProjectVirtualKey`
 * fan-out. The old fan-out did N concurrent read-modify-write PUTs of the
 * SAME virtual key's `provider_configs`; concurrent full-replace writes
 * clobbered each other (lost update), so a project VK ended up with only a
 * non-deterministic SUBSET of the built-in catalog — the root cause of the
 * KB-retrieval 403 (`model_blocked`) when the default embedding model was
 * one of the race losers.
 *
 * The invariant locked in here: folding EVERY catalog binding into one
 * provider_configs array yields ALL of them, preserves unrelated provider
 * entries (user-registered azure/openai models), collapses legacy
 * project-scoped built-in aliases to the canonical binding, and is
 * idempotent.
 *
 * Pure function (no Bifrost HTTP / DB I/O) so it runs without fakes.
 *
 * Run: node --require ts-node/register --test tests/bifrostProjectGovernance.builtins.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyBuiltinBindingsToProviderConfigs } from '../services/bifrost/bifrostProjectGovernance';
import { buildBuiltinGatewayBindingName } from '../services/bifrost/bifrostProviderOps';
import { BUILTIN_EMBEDDING_MODELS } from '../services/BuiltinModels';

type ProviderConfig = Record<string, unknown>;
type Binding = { provider: string; modelId: string; providerKeyId?: string };

/** Build the (provider, modelId) binding for a catalog built-in. */
function catalogBinding(
  m: (typeof BUILTIN_EMBEDDING_MODELS)[number],
  providerKeyId?: string,
): Binding {
  return {
    // teiServiceName already carries the `tei-` prefix (e.g. `tei-minilm`),
    // so the Bifrost provider is `as-<teiServiceName>` — mirrors
    // builtinGatewayProviderName() without importing the DB-heavy service.
    provider: `as-${m.teiServiceName}`,
    modelId: buildBuiltinGatewayBindingName(m.providerModelId),
    ...(providerKeyId ? { providerKeyId } : {}),
  };
}

const ALL_BINDINGS: Binding[] = BUILTIN_EMBEDDING_MODELS.map((m, i) =>
  catalogBinding(m, `key-${i}`),
);

function allowedFor(configs: ProviderConfig[], provider: string): string[] {
  const entry = configs.find((c) => c.provider === provider);
  return (entry?.allowed_models as string[]) || [];
}

test('batched assign lands EVERY catalog built-in in one merge (the race fix)', () => {
  const { configs, changed } = applyBuiltinBindingsToProviderConfigs([], ALL_BINDINGS);

  assert.equal(changed, true);
  // One provider_configs entry per catalog model — none dropped.
  assert.equal(configs.length, BUILTIN_EMBEDDING_MODELS.length);
  for (const b of ALL_BINDINGS) {
    assert.deepEqual(
      allowedFor(configs, b.provider),
      [b.modelId],
      `expected ${b.provider} to allow exactly [${b.modelId}]`,
    );
    const entry = configs.find((c) => c.provider === b.provider)!;
    assert.deepEqual(entry.key_ids, [b.providerKeyId]);
  }
});

test('preserves unrelated (user-registered) provider entries and normalizes read-shape keys', () => {
  const raw: ProviderConfig[] = [
    {
      provider: 'azure',
      weight: 1,
      allowed_models: ['projx_cred_gpt-4o'],
      // GET read-shape: full key objects under `keys`; must survive as key_ids.
      keys: [{ key_id: 'azure-key-1' }, 'azure-key-2'],
    },
  ];

  const { configs, changed } = applyBuiltinBindingsToProviderConfigs(raw, ALL_BINDINGS);

  assert.equal(changed, true);
  // azure entry preserved, allowed_models untouched, keys→key_ids normalized.
  const azure = configs.find((c) => c.provider === 'azure')!;
  assert.ok(azure, 'azure entry preserved');
  assert.deepEqual(azure.allowed_models, ['projx_cred_gpt-4o']);
  assert.equal(azure.keys, undefined, 'read-shape keys[] stripped');
  assert.deepEqual(azure.key_ids, ['azure-key-1', 'azure-key-2']);
  // All built-ins added alongside it.
  assert.equal(configs.length, BUILTIN_EMBEDDING_MODELS.length + 1);
});

test('collapses a legacy project-scoped built-in alias to the canonical binding', () => {
  const minilm = BUILTIN_EMBEDDING_MODELS.find(
    (m) => m.providerModelId === 'sentence-transformers/all-MiniLM-L6-v2',
  )!;
  const canonical = buildBuiltinGatewayBindingName(minilm.providerModelId);
  const provider = `as-${minilm.teiServiceName}`;

  const raw: ProviderConfig[] = [
    {
      provider,
      weight: 1,
      // Deprecated per-project alias that the migration must drop.
      allowed_models: [`proj67bqptlb_${canonical}`],
      key_ids: ['kmini'],
    },
  ];

  const { configs, changed } = applyBuiltinBindingsToProviderConfigs(raw, [
    { provider, modelId: canonical, providerKeyId: 'kmini' },
  ]);

  assert.equal(changed, true);
  assert.deepEqual(
    allowedFor(configs, provider),
    [canonical],
    'legacy project-scoped alias replaced by canonical binding',
  );
});

test('is idempotent: re-applying the same bindings is a no-op', () => {
  const first = applyBuiltinBindingsToProviderConfigs([], ALL_BINDINGS);
  assert.equal(first.changed, true);

  const second = applyBuiltinBindingsToProviderConfigs(first.configs, ALL_BINDINGS);
  assert.equal(second.changed, false, 'second merge should report no change');
  assert.equal(second.configs.length, first.configs.length);
});

test('empty bindings never change the configs', () => {
  const raw: ProviderConfig[] = [{ provider: 'azure', allowed_models: ['x'] }];
  const { changed } = applyBuiltinBindingsToProviderConfigs(raw, []);
  assert.equal(changed, false);
});

test('TEI provider collapses legacy aliases via mergeBuiltinVirtualKeyAllowedModels', () => {
  const minilm = BUILTIN_EMBEDDING_MODELS.find(
    (m) => m.providerModelId === 'sentence-transformers/all-MiniLM-L6-v2',
  )!;
  const canonical = buildBuiltinGatewayBindingName(minilm.providerModelId);
  const provider = `as-${minilm.teiServiceName}`;
  const legacy = `proj67bqptlb_${canonical}`;

  const raw: ProviderConfig[] = [
    { provider, allowed_models: [legacy, 'other'], key_ids: ['k1'] },
  ];
  const { configs, changed } = applyBuiltinBindingsToProviderConfigs(raw, [
    { provider, modelId: canonical, providerKeyId: 'k1' },
  ]);
  assert.equal(changed, true);
  const allowed = allowedFor(configs, provider);
  assert.ok(allowed.includes(canonical));
  assert.ok(allowed.includes('other'));
  assert.ok(!allowed.includes(legacy));
});

test('re-applying binding with same providerKeyId is idempotent for key_ids', () => {
  const binding = catalogBinding(BUILTIN_EMBEDDING_MODELS[0], 'key-same');
  const first = applyBuiltinBindingsToProviderConfigs([], [binding]);
  const second = applyBuiltinBindingsToProviderConfigs(first.configs, [binding]);
  assert.equal(second.changed, false);
  const entry = second.configs.find((c) => c.provider === binding.provider)!;
  assert.deepEqual(entry.key_ids, ['key-same']);
});
