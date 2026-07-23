/**
 * Unit tests for services/ProjectServiceAccountService.ts. KeycloakClientService
 * is module-mocked; the service-account table flows through the fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/ProjectServiceAccountService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';
let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let ProjectServiceAccountService: any;
let kc: any;

beforeEach(() => {
  handle = installFakeRepositories({});
  kc = {
    createProjectServiceAccountClient: async () => ({ clientId: 'client-1', clientSecret: 'secret-1' }),
    deleteProjectServiceAccountClient: async () => undefined,
  };
  scope = restoreScope();
  scope.add(
    mockModule('services/KeycloakClientService', {
      KeycloakClientService: class {
        createProjectServiceAccountClient(...a: any[]) {
          return kc.createProjectServiceAccountClient(...a);
        }
        deleteProjectServiceAccountClient(...a: any[]) {
          return kc.deleteProjectServiceAccountClient(...a);
        }
      },
    }),
  );
  ProjectServiceAccountService = loadFresh('services/ProjectServiceAccountService').ProjectServiceAccountService;
  mock.method(console, 'error', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/ProjectServiceAccountService');
  handle.restore();
  mock.restoreAll();
});

function seedSA(overrides: Record<string, any>) {
  handle.repos.ProjectServiceAccount = makeFakeRepo(overrides);
}

test('create requires a projectId', async () => {
  await assert.rejects(ProjectServiceAccountService.create(''), /projectId is required/);
});

test('create returns the existing service account when present', async () => {
  const create = mock.fn(async () => ({ clientId: 'x', clientSecret: 'y' }));
  kc.createProjectServiceAccountClient = create;
  seedSA({ findOne: async () => ({ project_id: PROJECT, client_id: 'existing', created_at: new Date() }) });
  const res = await ProjectServiceAccountService.create(PROJECT);
  assert.equal(res.clientId, 'existing');
  assert.equal(create.mock.callCount(), 0);
});

test('create provisions a Keycloak client and persists the record', async () => {
  seedSA({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, created_at: new Date() }),
  });
  const res = await ProjectServiceAccountService.create(PROJECT);
  assert.equal(res.projectId, PROJECT);
  assert.equal(res.clientId, 'client-1');
});

test('getByProjectId requires a projectId', async () => {
  await assert.rejects(ProjectServiceAccountService.getByProjectId(''), /projectId is required/);
});

test('getByProjectId throws NotFoundError when missing', async () => {
  seedSA({ findOne: async () => null });
  await assert.rejects(ProjectServiceAccountService.getByProjectId(PROJECT), /not found/);
});

test('getByProjectId returns the decrypted client secret', async () => {
  const encrypted = Buffer.from('plain-secret').toString('base64');
  seedSA({
    findOne: async () => ({
      project_id: PROJECT,
      client_id: 'client-1',
      client_secret_encrypted: encrypted,
      created_at: new Date(),
    }),
  });
  const res = await ProjectServiceAccountService.getByProjectId(PROJECT);
  assert.equal(res.clientSecret, 'plain-secret');
});

test('delete requires a projectId', async () => {
  await assert.rejects(ProjectServiceAccountService.delete(''), /projectId is required/);
});

test('delete continues even if Keycloak deletion fails', async () => {
  kc.deleteProjectServiceAccountClient = async () => {
    throw new Error('keycloak down');
  };
  seedSA({ delete: async () => ({ affected: 1 }) });
  assert.equal(await ProjectServiceAccountService.delete(PROJECT), true);
});

test('delete returns false when no row was removed', async () => {
  seedSA({ delete: async () => ({ affected: 0 }) });
  assert.equal(await ProjectServiceAccountService.delete(PROJECT), false);
});

test('exists returns false for an empty projectId without touching the repo', async () => {
  assert.equal(await ProjectServiceAccountService.exists(''), false);
});

test('exists reflects the repository count', async () => {
  seedSA({ count: async () => 1 });
  assert.equal(await ProjectServiceAccountService.exists(PROJECT), true);
  seedSA({ count: async () => 0 });
  assert.equal(await ProjectServiceAccountService.exists(PROJECT), false);
});
