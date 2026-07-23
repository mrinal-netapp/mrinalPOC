/**
 * Unit tests for services/DataSetSchemaBuilder.ts. Pure schema generation.
 *
 * Run: node --require ts-node/register --test tests/DataSetSchemaBuilder.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DataSetSchemaBuilder } from '../services/DataSetSchemaBuilder';

test('createDefaultSchema returns a minimal schema for structured datasets', () => {
  const schema = DataSetSchemaBuilder.createDefaultSchema({ kind: 'structured' } as any);
  assert.equal(schema.type, 'struct');
  assert.equal(schema.fields.length, 1);
  assert.equal(schema.fields[0].name, 'data');
  assert.equal(schema.fields[0].type, 'string');
});

test('createDefaultSchema returns the file-metadata schema for unstructured datasets', () => {
  const schema = DataSetSchemaBuilder.createDefaultSchema({ kind: 'unstructured' } as any);
  assert.equal(schema.type, 'struct');
  assert.equal(schema.fields.length, 12);
  const names = schema.fields.map((f) => f.name);
  assert.ok(names.includes('file_path'));
  assert.ok(names.includes('has_pii'));
  assert.ok(names.includes('pii_entities'));
  // Field ids are sequential 1..12.
  assert.deepEqual(
    schema.fields.map((f) => f.id),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
});

test('createDefaultSchema treats any non-structured kind as unstructured', () => {
  const schema = DataSetSchemaBuilder.createDefaultSchema({} as any);
  assert.equal(schema.fields.length, 12);
});
