/**
 * Unit tests for services/BaseService.ts (pure helper base class; no DB/network).
 *
 * Run: node --require ts-node/register --test tests/BaseService.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BaseService } from '../services/BaseService';

class TestService extends BaseService {
  reqd<T>(value: T | null | undefined, fieldName: string): T {
    return this.validateRequired(value, fieldName);
  }
  entity<T>(findFn: () => Promise<T | null>, name: string, id: string): Promise<T> {
    return this.validateEntityExists(findFn, name, id);
  }
  rule(condition: boolean, message: string): void {
    this.validateBusinessRule(condition, message);
  }
  wrap<T>(op: () => Promise<T>, msg: string): Promise<T> {
    return this.executeWithErrorHandling(op, msg);
  }
}

const svc = new TestService();

test('validateRequired returns the value when present', () => {
  assert.equal(svc.reqd('hello', 'name'), 'hello');
  assert.equal(svc.reqd(0, 'count'), 0);
  assert.equal(svc.reqd(false, 'flag'), false);
});

test('validateRequired throws for null/undefined', () => {
  assert.throws(() => svc.reqd(null, 'name'), /name is required/);
  assert.throws(() => svc.reqd(undefined, 'other'), /other is required/);
});

test('validateEntityExists returns the entity when found', async () => {
  const entity = { id: 'e1' };
  const result = await svc.entity(async () => entity, 'Thing', 'e1');
  assert.equal(result, entity);
});

test('validateEntityExists throws when entity is null', async () => {
  await assert.rejects(
    svc.entity(async () => null, 'Thing', 'missing'),
    /Thing with identifier missing not found/,
  );
});

test('validateBusinessRule passes when condition is true', () => {
  assert.doesNotThrow(() => svc.rule(true, 'should not throw'));
});

test('validateBusinessRule throws when condition is false', () => {
  assert.throws(() => svc.rule(false, 'broken rule'), /broken rule/);
});

test('executeWithErrorHandling returns the operation result', async () => {
  const value = await svc.wrap(async () => 42, 'op failed');
  assert.equal(value, 42);
});

test('executeWithErrorHandling wraps thrown Error messages', async () => {
  await assert.rejects(
    svc.wrap(async () => {
      throw new Error('inner boom');
    }, 'op failed'),
    /op failed: inner boom/,
  );
});

test('executeWithErrorHandling wraps non-Error throwables', async () => {
  await assert.rejects(
    svc.wrap(async () => {
      throw 'string failure';
    }, 'op failed'),
    /^Error: op failed$/,
  );
});
