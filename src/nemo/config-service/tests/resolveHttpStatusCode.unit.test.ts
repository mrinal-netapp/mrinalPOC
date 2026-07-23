/**
 * Unit tests for resolveHttpStatusCode / domain error HTTP mapping.
 *
 * Run: node --require ts-node/register --test tests/resolveHttpStatusCode.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  BusinessLogicError,
  PayloadTooLargeError,
  resolveHttpStatusCode,
  type ErrorWithHttpStatus,
} from '../utils/errors';

test('ConflictError maps to 409 without relying on message wording', () => {
  assert.equal(resolveHttpStatusCode(new ConflictError('Name taken')), 409);
});

test('NotFoundError maps to 404', () => {
  assert.equal(resolveHttpStatusCode(new NotFoundError('Widget', 'w-1')), 404);
});

test('ValidationError maps to 400', () => {
  assert.equal(resolveHttpStatusCode(new ValidationError('bad input')), 400);
});

test('BusinessLogicError maps to 400', () => {
  assert.equal(resolveHttpStatusCode(new BusinessLogicError('rule violated')), 400);
});

test('plain Error uses legacy message hints then 500', () => {
  assert.equal(resolveHttpStatusCode(new Error('Resource not found')), 404);
  assert.equal(resolveHttpStatusCode(new Error('Item already exists here')), 409);
  assert.equal(resolveHttpStatusCode(new Error('duplicate row')), 400);
  assert.equal(resolveHttpStatusCode(new Error('Unexpected internal failure')), 500);
});

test('explicit statusCode in 4xx range wins', () => {
  const err = new Error('payload') as Error & { statusCode?: number };
  err.statusCode = 422;
  assert.equal(resolveHttpStatusCode(err), 422);
});

test('invalid explicit statusCode falls through to domain/legacy', () => {
  const err = new Error('not found') as Error & { statusCode?: number };
  err.statusCode = 200;
  assert.equal(resolveHttpStatusCode(err), 404);
});

test('resolveHttpStatusCode: empty message and legacy heuristic branches', () => {
  assert.equal(resolveHttpStatusCode(new Error('')), 500);
  assert.equal(resolveHttpStatusCode(new Error('Cannot deploy while placeholders remain')), 400);
  assert.equal(resolveHttpStatusCode(new Error('Only draft manifests may be edited')), 400);
  assert.equal(
    resolveHttpStatusCode(new Error('draft manifest already exists for this project')),
    409,
  );
});

test('PayloadTooLargeError maps to 413', () => {
  assert.equal(resolveHttpStatusCode(new PayloadTooLargeError('too big')), 413);
});

test('resolveHttpStatusCode: uses domain class when explicit statusCode is invalid', () => {
  const err = new BusinessLogicError('rule violated') as ErrorWithHttpStatus;
  err.statusCode = 999;
  assert.equal(resolveHttpStatusCode(err), 400);
});
