/**
 * Unit tests for the guardrails catalog validators and the reworked agent
 * `guardrails` structural validation.
 *
 * Run: node --require ts-node/register --test tests/guardrails.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGuardrailCatalogValidator,
  updateGuardrailCatalogValidator,
  listGuardrailCatalogValidator,
} from '../validators/guardrailCatalogValidator';
import { validateConfigSchemaShape } from '../validators/guardrailConfigSchemaMeta';
import { createAgentValidator, updateAgentValidator } from '../validators/agentValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

function validCatalogBody() {
  return {
    key: 'pii_masker',
    stage: 'output',
    display_name: 'PII Masking',
    description: 'Masks personally identifiable information in model output.',
    type: 'privacy',
    supported_actions: ['block', 'modify', 'warn'],
    default_action: 'modify',
    message: 'Output contained PII and was masked.',
    config: { mask_email: true },
    config_schema: {
      type: 'object',
      properties: {
        mask_email: { type: 'boolean', is_required: true, can_override: true },
      },
    },
  };
}

// ------------------------------------------------------------ catalog create
test('createGuardrailCatalogValidator: accepts a valid body', async () => {
  const res = await runValidators(createGuardrailCatalogValidator, { body: validCatalogBody() });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('createGuardrailCatalogValidator: rejects missing required fields', async () => {
  const res = await runValidators(createGuardrailCatalogValidator, { body: { key: 'x' } });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects invalid stage', async () => {
  const res = await runValidators(createGuardrailCatalogValidator, {
    body: { ...validCatalogBody(), stage: 'nope' },
  });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects default_action not in supported_actions', async () => {
  const res = await runValidators(createGuardrailCatalogValidator, {
    body: { ...validCatalogBody(), default_action: 'delete', supported_actions: ['block', 'warn'] },
  });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects missing default_action', async () => {
  const { default_action, ...rest } = validCatalogBody();
  const res = await runValidators(createGuardrailCatalogValidator, { body: rest });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects legacy action field (no default_action)', async () => {
  const { default_action, ...rest } = validCatalogBody();
  const res = await runValidators(createGuardrailCatalogValidator, {
    body: { ...rest, action: 'modify' },
  });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects missing description', async () => {
  const { description, ...rest } = validCatalogBody();
  const res = await runValidators(createGuardrailCatalogValidator, { body: rest });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects missing message', async () => {
  const { message, ...rest } = validCatalogBody();
  const res = await runValidators(createGuardrailCatalogValidator, { body: rest });
  assert.equal(res.isEmpty(), false);
});

test('createGuardrailCatalogValidator: rejects empty supported_actions', async () => {
  const res = await runValidators(createGuardrailCatalogValidator, {
    body: { ...validCatalogBody(), supported_actions: [] },
  });
  assert.equal(res.isEmpty(), false);
});

// ------------------------------------------------------------ catalog update
test('updateGuardrailCatalogValidator: allows partial body', async () => {
  const res = await runValidators(updateGuardrailCatalogValidator, {
    body: { display_name: 'Renamed', enabled: false },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('updateGuardrailCatalogValidator: rejects bad stage', async () => {
  const res = await runValidators(updateGuardrailCatalogValidator, { body: { stage: 'bogus' } });
  assert.equal(res.isEmpty(), false);
});

// ------------------------------------------------------------ list filters
test('listGuardrailCatalogValidator: accepts valid filters', async () => {
  const res = await runValidators(listGuardrailCatalogValidator, {
    query: { id: UUID, key: 'pii_masker', stage: 'input', type: 'privacy', enabled: 'true' },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('listGuardrailCatalogValidator: accepts no filters', async () => {
  const res = await runValidators(listGuardrailCatalogValidator, { query: {} });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('listGuardrailCatalogValidator: rejects non-uuid id', async () => {
  const res = await runValidators(listGuardrailCatalogValidator, { query: { id: 'not-a-uuid' } });
  assert.equal(res.isEmpty(), false);
});

// ----------------------------------------------------- agent guardrails shape
const baseAgent = { name: 'A', role: 'r', systemPrompt: 's', modelId: 'm1' };

test('createAgentValidator: accepts unified guardrails with lean rules', async () => {
  const res = await runValidators(createAgentValidator, {
    body: {
      ...baseAgent,
      guardrails: {
        enabled: true,
        input_guardrails: [{ guardrail_id: '11111111-1111-4111-8111-111111111111', config: { a: 1 } }],
        output_guardrails: [{ guardrail_id: '22222222-2222-4222-8222-222222222222', action: 'warn' }],
        tool_guardrails: [],
      },
    },
  });
  assert.equal(res.isEmpty(), true, validationMessages(res));
});

test('createAgentValidator: rejects guardrail rule missing guardrail_id', async () => {
  const res = await runValidators(createAgentValidator, {
    body: { ...baseAgent, guardrails: { input_guardrails: [{ action: 'block' }] } },
  });
  assert.equal(res.isEmpty(), false);
});

test('createAgentValidator: rejects non-UUID guardrail_id', async () => {
  const res = await runValidators(createAgentValidator, {
    body: { ...baseAgent, guardrails: { input_guardrails: [{ guardrail_id: 'gr-1' }] } },
  });
  assert.equal(res.isEmpty(), false);
});

test('createAgentValidator: rejects non-array rule bucket', async () => {
  const res = await runValidators(createAgentValidator, {
    body: { ...baseAgent, guardrails: { input_guardrails: 'nope' } },
  });
  assert.equal(res.isEmpty(), false);
});

test('createAgentValidator: rejects any tool_policy (no longer supported)', async () => {
  const res = await runValidators(createAgentValidator, {
    body: {
      ...baseAgent,
      guardrails: { tool_policy: { mode: 'denylist', tools: ['x'], max_calls_per_request: 5 } },
    },
  });
  assert.equal(res.isEmpty(), false);
});

test('updateAgentValidator: rejects any tool_policy (no longer supported)', async () => {
  const res = await runValidators(updateAgentValidator, {
    body: {
      guardrails: { tool_policy: { mode: 'allowlist', tools: ['y'], max_calls_per_request: 3 } },
    },
  });
  assert.equal(res.isEmpty(), false);
});

test('createAgentValidator: rejects non-boolean suite flag', async () => {
  const res = await runValidators(createAgentValidator, {
    body: { ...baseAgent, guardrails: { enabled: 'yes' } },
  });
  assert.equal(res.isEmpty(), false);
});

// --------------------------------------------------- config_schema meta-schema
test('validateConfigSchemaShape: accepts a flat object with both flags', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      mask_email: { type: 'boolean', is_required: true, can_override: false },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfigSchemaShape: accepts an array-of-scalars property', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      allowed_tags: {
        type: 'array',
        items: { type: 'string' },
        is_required: false,
        can_override: true,
      },
    },
  });
  assert.deepEqual(errors, []);
});

test('validateConfigSchemaShape: rejects a property missing can_override', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: { mask_email: { type: 'boolean', is_required: true } },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects a nested object property', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      nested: { type: 'object', is_required: true, can_override: true },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects an unknown per-property keyword', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      name: { type: 'string', is_required: true, can_override: true, minLength: 3 },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects a top-level $schema', () => {
  const errors = validateConfigSchemaShape({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: {
      mask_email: { type: 'boolean', is_required: true, can_override: true },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects a top-level required array', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    required: ['mask_email'],
    properties: {
      mask_email: { type: 'boolean', is_required: true, can_override: true },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects empty properties', () => {
  const errors = validateConfigSchemaShape({ type: 'object', properties: {} });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects an array property without items', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      allowed_tags: { type: 'array', is_required: false, can_override: true },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects array items without a type', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      allowed_tags: { type: 'array', items: {}, is_required: false, can_override: true },
    },
  });
  assert.equal(errors.length > 0, true);
});

test('validateConfigSchemaShape: rejects an unknown keyword inside items', () => {
  const errors = validateConfigSchemaShape({
    type: 'object',
    properties: {
      allowed_tags: {
        type: 'array',
        items: { type: 'string', minItems: 1 },
        is_required: false,
        can_override: true,
      },
    },
  });
  assert.equal(errors.length > 0, true);
});
