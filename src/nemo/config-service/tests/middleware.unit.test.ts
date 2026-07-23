/**
 * Hermetic unit tests for middleware/*.ts (no DB, no network).
 *
 * - validateProject: exercised both via a real express mount (buildApp/request)
 *   and via direct fake req/res/next calls. The Project lookup flows through the
 *   AppDataSource fake-repo seam (installFakeRepositories).
 * - projectRoleMiddleware: called directly with fake req/res/next.
 * - errorHandlerMiddleware + notFoundHandler: called directly with a fake res
 *   that records status/json; asserts domain errors map to their statusCode.
 *
 * Run: node --require ts-node/register --test tests/middleware.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';
// Type-only import (elided at runtime) that loads @agentstudio/common's
// `declare global { namespace Express { interface Request { user?: UserClaims } } }`
// into the program so middleware/projectRole.ts (which reads req.user) type-checks.
import type { UserClaims } from '@agentstudio/common';

import { validateProject } from '../middleware/projectValidator';
import { projectRoleMiddleware } from '../middleware/projectRole';
import { errorHandlerMiddleware, notFoundHandler } from '../middleware/errorHandler';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  BusinessLogicError,
  PayloadTooLargeError,
} from '../utils/errors';

import { installFakeRepositories, makeFakeRepo, withFakeRepositories } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';

// ---------------------------------------------------------------- fake req/res/next
function makeRes(): any {
  const res: any = {
    statusCode: undefined as number | undefined,
    body: undefined as any,
    headers: {} as Record<string, any>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(obj: any) {
      this.body = obj;
      return this;
    },
    setHeader(key: string, value: any) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
  };
  return res;
}

function makeNext(): any {
  const next: any = (err?: any) => {
    next.called = true;
    next.calls += 1;
    next.error = err;
  };
  next.called = false;
  next.calls = 0;
  next.error = undefined;
  return next;
}

// =============================================================== validateProject
test('validateProject: 400 when projectId missing (direct call)', async () => {
  const req: any = { params: {} };
  const res = makeRes();
  const next = makeNext();
  await validateProject(req, res as any, next);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'projectId is required' });
  assert.equal(next.called, false);
});

test('validateProject: 404 when project not found (direct call)', async () => {
  await withFakeRepositories(
    { Project: makeFakeRepo({ findOne: async () => null }) },
    async () => {
      const req: any = { params: { projectId: 'proj00000001' } };
      const res = makeRes();
      const next = makeNext();
      await validateProject(req, res as any, next);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { error: 'Project not found' });
      assert.equal(next.called, false);
    },
  );
});

test('validateProject: calls next() when project exists (direct call)', async () => {
  await withFakeRepositories(
    { Project: makeFakeRepo({ findOne: async () => ({ id: 'proj00000001', name: 'P' }) }) },
    async () => {
      const req: any = { params: { projectId: 'proj00000001' } };
      const res = makeRes();
      const next = makeNext();
      await validateProject(req, res as any, next);
      assert.equal(next.called, true);
      assert.equal(res.statusCode, undefined);
    },
  );
});

test('validateProject: 500 when repository throws (direct call)', async () => {
  await withFakeRepositories(
    {
      Project: makeFakeRepo({
        findOne: async () => {
          throw new Error('db unavailable');
        },
      }),
    },
    async () => {
      const req: any = { params: { projectId: 'proj00000001' } };
      const res = makeRes();
      const next = makeNext();
      await validateProject(req, res as any, next);
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'db unavailable' });
      assert.equal(next.called, false);
    },
  );
});

test('validateProject: 200 through a real express mount when project exists', async () => {
  await withFakeRepositories(
    { Project: makeFakeRepo({ findOne: async () => ({ id: 'proj00000001', name: 'P' }) }) },
    async () => {
      const router = Router({ mergeParams: true });
      router.get('/', validateProject, (_req, res) => {
        res.json({ ok: true });
      });
      const app = buildApp({ basePath: '/api/v1/projects/:projectId/things', router });
      const res = await request(app, 'GET', '/api/v1/projects/proj00000001/things');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true });
    },
  );
});

test('validateProject: 404 through a real express mount when project missing', async () => {
  await withFakeRepositories(
    { Project: makeFakeRepo({ findOne: async () => null }) },
    async () => {
      const router = Router({ mergeParams: true });
      router.get('/', validateProject, (_req, res) => {
        res.json({ ok: true });
      });
      const app = buildApp({ basePath: '/api/v1/projects/:projectId/things', router });
      const res = await request(app, 'GET', '/api/v1/projects/proj00000001/things');
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: 'Project not found' });
    },
  );
});

test('validateProject: 400 through a real express mount when no projectId param', async () => {
  // No fake repo needed: the guard returns before touching the data source.
  const handle = installFakeRepositories();
  try {
    const router = Router();
    router.get('/', validateProject, (_req, res) => {
      res.json({ ok: true });
    });
    const app = buildApp({ basePath: '/things', router });
    const res = await request(app, 'GET', '/things');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'projectId is required' });
  } finally {
    handle.restore();
  }
});

// =========================================================== projectRoleMiddleware
test('projectRoleMiddleware: sets x-project-role=member when user + project claim present', async () => {
  const user: UserClaims = { sub: 'user1', 'agentstudio.project_id': 'proj1' };
  const req: any = { user, headers: {} };
  const res = makeRes();
  const next = makeNext();
  await projectRoleMiddleware(req, res as any, next);
  assert.equal(req.headers['x-project-role'], 'member');
  assert.equal(next.called, true);
});

test('projectRoleMiddleware: derives projectId from x-project-id header', async () => {
  const user: UserClaims = { sub: 'user1' };
  const req: any = { user, headers: { 'x-project-id': 'proj1' } };
  const res = makeRes();
  const next = makeNext();
  await projectRoleMiddleware(req, res as any, next);
  assert.equal(req.headers['x-project-role'], 'member');
  assert.equal(next.called, true);
});

test('projectRoleMiddleware: next() without role when no authenticated user', async () => {
  const req: any = { user: undefined, headers: {} };
  const res = makeRes();
  const next = makeNext();
  await projectRoleMiddleware(req, res as any, next);
  assert.equal(req.headers['x-project-role'], undefined);
  assert.equal(next.called, true);
});

test('projectRoleMiddleware: next() without role when user but no project context', async () => {
  const req: any = { user: { sub: 'user1' }, headers: {} };
  const res = makeRes();
  const next = makeNext();
  await projectRoleMiddleware(req, res as any, next);
  assert.equal(req.headers['x-project-role'], undefined);
  assert.equal(next.called, true);
});

// =================================================== errorHandlerMiddleware / 404
/** Silence the middleware's console.error during a callback. */
async function quietConsoleError(fn: () => void | Promise<void>): Promise<void> {
  const original = console.error;
  console.error = () => {};
  try {
    await fn();
  } finally {
    console.error = original;
  }
}

test('errorHandlerMiddleware: maps domain errors to their statusCode', async () => {
  const cases: Array<[Error, number]> = [
    [new NotFoundError('Project', 'p1'), 404],
    [new ValidationError('bad input'), 400],
    [new ConflictError('already exists'), 409],
    [new BusinessLogicError('not allowed'), 400],
    [new PayloadTooLargeError('too big'), 413],
  ];
  await quietConsoleError(() => {
    for (const [err, expected] of cases) {
      const req: any = { path: '/x', method: 'GET' };
      const res = makeRes();
      const next = makeNext();
      errorHandlerMiddleware(err, req, res as any, next);
      assert.equal(res.statusCode, expected, `${err.name} -> ${expected}`);
      assert.deepEqual(res.body, { error: err.message });
    }
  });
});

test('errorHandlerMiddleware: maps unknown errors to 500', async () => {
  await quietConsoleError(() => {
    const req: any = { path: '/x', method: 'POST' };
    const res = makeRes();
    const next = makeNext();
    errorHandlerMiddleware(new Error('boom'), req, res as any, next);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'boom' });
  });
});

test('errorHandlerMiddleware: honors an explicit statusCode property on the error', async () => {
  await quietConsoleError(() => {
    const err = Object.assign(new Error('teapot'), { statusCode: 418 });
    const req: any = { path: '/x', method: 'GET' };
    const res = makeRes();
    const next = makeNext();
    errorHandlerMiddleware(err, req, res as any, next);
    assert.equal(res.statusCode, 418);
    assert.deepEqual(res.body, { error: 'teapot' });
  });
});

test('notFoundHandler: responds 404 with the unmatched route', () => {
  const req: any = { method: 'GET', path: '/api/v1/missing' };
  const res = makeRes();
  notFoundHandler(req, res as any);
  assert.equal(res.statusCode, 404);
  assert.match(String(res.body.error), /not found/);
  assert.match(String(res.body.error), /GET \/api\/v1\/missing/);
});
