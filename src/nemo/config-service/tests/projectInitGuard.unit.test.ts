/**
 * Unit tests for utils/projectInitGuard.ts.
 *
 * Run: node --require ts-node/register --test tests/projectInitGuard.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { installFakeRepositories, makeFakeRepo, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const READY = 'projready001';
const NO_GATEWAY = 'projnogw0001';
const MISSING = 'missing00001';

function makeRes() {
  let status = 0;
  let body: any = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(obj: any) {
      body = obj;
      return this;
    },
  } as unknown as Response;
  return {
    res,
    snapshot: () => ({ status, body }),
  };
}

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let keycloakReady: boolean;

beforeEach(() => {
  handle = installFakeRepositories({
    Project: makeFakeRepo({
      findOne: async ({ where }: { where?: { id?: string } }) => {
        const id = where?.id;
        if (id === MISSING) return null;
        if (id === NO_GATEWAY) {
          return {
            id,
            name: 'No Gateway',
            metadata: {},
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            home_dir: '/tmp',
            init_status: 'provisioning',
            init_error: null,
          };
        }
        if (id === READY) {
          return {
            id,
            name: 'Ready',
            metadata: { _gateway: { virtualKeyId: 'vk-abc', teamId: 'team-1' } },
            created_at: new Date('2024-01-01'),
            updated_at: new Date('2024-01-01'),
            home_dir: '/tmp',
            init_status: 'ready',
            init_error: null,
          };
        }
        return null;
      },
    }),
  });
  scope = restoreScope();
  keycloakReady = true;
  scope.add(
    mockModule('services/ProjectServiceAccountService', {
      ProjectServiceAccountService: {
        exists: async (projectId: string) => keycloakReady && projectId === READY,
      },
    }),
  );
});

afterEach(() => {
  scope.restoreAll();
  clearModule('utils/projectInitGuard');
  handle.restore();
});

async function runGuard(projectId?: string) {
  const { requireProjectInitForCreate } = loadFresh<{ requireProjectInitForCreate: typeof import('../utils/projectInitGuard').requireProjectInitForCreate }>(
    'utils/projectInitGuard',
  );
  const { res, snapshot } = makeRes();
  const req = { params: projectId === undefined ? {} : { projectId } } as Request;
  const ok = await requireProjectInitForCreate(req, res);
  return { ok, ...snapshot() };
}

test('requireProjectInitForCreate: missing projectId returns 400', async () => {
  const out = await runGuard();
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.body.error, /projectId is required/);
});

test('requireProjectInitForCreate: unknown project returns 404', async () => {
  const out = await runGuard(MISSING);
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.match(out.body.error, /not found/);
});

test('requireProjectInitForCreate: gateway not ready returns 409', async () => {
  const out = await runGuard(NO_GATEWAY);
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.match(out.body.error, /gateway setup is not complete/);
});

test('requireProjectInitForCreate: keycloak not provisioned returns 409', async () => {
  keycloakReady = false;
  const out = await runGuard(READY);
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.match(out.body.error, /Keycloak client is not provisioned/);
});

test('requireProjectInitForCreate: fully initialized project returns true', async () => {
  const out = await runGuard(READY);
  assert.equal(out.ok, true);
  assert.equal(out.status, 0);
});
