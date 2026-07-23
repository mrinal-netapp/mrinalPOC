/**
 * Unit tests for services/ProjectInitService.ts. The workflow-engine axios
 * client is replaced with a fake (no network).
 *
 * Run: node --require ts-node/register --test tests/ProjectInitService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { ProjectInitService } from '../services/ProjectInitService';

const USER_AUTH = 'Bearer test-user-token';

beforeEach(() => {
  mock.method(console, 'log', () => undefined);
  mock.method(console, 'warn', () => undefined);
  mock.method(console, 'error', () => undefined);
});
afterEach(() => mock.restoreAll());

test('initializeProject posts to the init endpoint and resolves on success', async () => {
  const post = mock.fn(async () => ({ status: 200, data: { workflowId: 'wf-1' } }));
  mock.method(axios, 'create', () => ({ post }) as any);
  const svc = new ProjectInitService();
  await svc.initializeProject('proj1', USER_AUTH);
  const [url, body] = post.mock.calls[0].arguments as any[];
  assert.match(url, /\/projects\/proj1\/init$/);
  assert.ok(body.region);
});

test('initializeProject resolves even without a workflow id', async () => {
  mock.method(axios, 'create', () => ({ post: mock.fn(async () => ({ status: 202, data: {} })) }) as any);
  const svc = new ProjectInitService();
  await assert.doesNotReject(svc.initializeProject('proj1', USER_AUTH));
});

test('initializeProject rethrows workflow-engine errors', async () => {
  mock.method(axios, 'create', () => ({
    post: mock.fn(async () => {
      throw Object.assign(new Error('engine down'), { response: { status: 500, data: { error: 'x' } } });
    }),
  }) as any);
  const svc = new ProjectInitService();
  await assert.rejects(svc.initializeProject('proj1', USER_AUTH), /engine down/);
});

test('initializeProject requires an Authorization header', async () => {
  const svc = new ProjectInitService();
  await assert.rejects(svc.initializeProject('proj1', ''), /Authorization header/);
});

test('initializeProject surfaces response error message in logs path', async () => {
  mock.method(axios, 'create', () => ({
    post: mock.fn(async () => {
      throw Object.assign(new Error('bad gateway'), {
        response: { status: 502, data: { error: 'upstream unavailable' } },
      });
    }),
  }) as any);
  const svc = new ProjectInitService();
  await assert.rejects(svc.initializeProject('proj1', USER_AUTH), /bad gateway/);
});
