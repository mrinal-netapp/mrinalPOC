/**
 * Branch-coverage tests for validators/jsonSchemaValidation.ts
 *
 * Run: node --require ts-node/register --test tests/jsonSchemaValidation.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidJsonSchemaString } from '../validators/jsonSchemaValidation';

test('isValidJsonSchemaString: rejects empty and whitespace-only input', () => {
  assert.equal(isValidJsonSchemaString(''), false);
  assert.equal(isValidJsonSchemaString('   '), false);
});

test('isValidJsonSchemaString: rejects invalid JSON', () => {
  assert.equal(isValidJsonSchemaString('{not json'), false);
});

test('isValidJsonSchemaString: rejects non-object JSON values', () => {
  assert.equal(isValidJsonSchemaString('"string"'), false);
  assert.equal(isValidJsonSchemaString('42'), false);
  assert.equal(isValidJsonSchemaString('true'), false);
  assert.equal(isValidJsonSchemaString('null'), false);
  assert.equal(isValidJsonSchemaString('[]'), false);
});

test('isValidJsonSchemaString: accepts a minimal valid JSON Schema object', () => {
  assert.equal(
    isValidJsonSchemaString(JSON.stringify({ type: 'object', properties: { name: { type: 'string' } } })),
    true,
  );
});

test('isValidJsonSchemaString: accepts schema with explicit $id', () => {
  assert.equal(
    isValidJsonSchemaString(
      JSON.stringify({
        $id: 'https://example.com/schema/user',
        type: 'object',
        properties: { id: { type: 'string' } },
      }),
    ),
    true,
  );
});

test('isValidJsonSchemaString: rejects schema that fails meta-schema compile', () => {
  assert.equal(
    isValidJsonSchemaString(JSON.stringify({ type: 'not-a-valid-type-keyword' })),
    false,
  );
});

test('isValidJsonSchemaString: reuses existing registered $id on subsequent compiles', () => {
  const schema = JSON.stringify({
    $id: 'https://example.com/schema/reused-id',
    type: 'object',
    properties: { name: { type: 'string' } },
  });
  assert.equal(isValidJsonSchemaString(schema), true);
  assert.equal(isValidJsonSchemaString(schema), true);
});
