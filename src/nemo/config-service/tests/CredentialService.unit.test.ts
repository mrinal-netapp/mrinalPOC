/**
 * Direct unit tests for services/CredentialService.ts.
 * K8sSecretService is module-mocked; the Credential/MCPServer repos are faked.
 *
 * Run: node --require ts-node/register --test tests/CredentialService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueryFailedError } from 'typeorm';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

const PROJECT = 'projtest0001';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let k8s: any;
let service: any;

beforeEach(() => {
  handle = installFakeRepositories({});
  k8s = {
    createSecret: async () => undefined,
    deleteSecret: async () => undefined,
    updateSecret: async () => undefined,
    readSecret: async () => ({ api_key: 'sk' }),
  };
  scope = restoreScope();
  scope.add(mockModule('services/K8sSecretService', { getK8sSecretService: () => k8s }));
  const mod = loadFresh('services/CredentialService');
  service = mod.getCredentialService();
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/CredentialService');
  handle.restore();
});

const baseInput = () => ({ projectId: PROJECT, name: 'cred', provider: 'openai', secretData: { api_key: 'sk' } });

test('create: stores K8s secret then DB row', async () => {
  handle.repos.Credential = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => ({ ...e, id: 'cred-1' }),
  });
  const cred = await service.create(baseInput());
  assert.equal(cred.id, 'cred-1');
  assert.equal(cred.name, 'cred');
});

test('create: duplicate name throws ConflictError', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1', name: 'cred' }) });
  await assert.rejects(() => service.create(baseInput()), /already exists/);
});

test('create: unique-violation on save maps to ConflictError + cleans up secret', async () => {
  let deleted = false;
  k8s.deleteSecret = async () => {
    deleted = true;
  };
  handle.repos.Credential = makeFakeRepo({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async () => {
      throw new QueryFailedError('insert', [], { code: '23505' } as any);
    },
  });
  await assert.rejects(() => service.create(baseInput()), /already exists/);
  assert.equal(deleted, true);
});

test('list: builds query with provider + label filters', async () => {
  handle.repos.Credential = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'cred-1' }] }),
  });
  const result = await service.list({ projectId: PROJECT, provider: 'openai', labels: ['prod', 'team'] });
  assert.equal(result.length, 1);
});

test('getById: found / null', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1' }) });
  assert.ok(await service.getById(PROJECT, 'cred-1'));
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.equal(await service.getById(PROJECT, 'cred-1'), null);
});

test('update: not found returns null; name conflict throws; success saves', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.equal(await service.update(PROJECT, 'missing', { name: 'x' }), null);

  let cur: any = { id: 'cred-1', name: 'old' };
  handle.repos.Credential = makeFakeRepo({
    findOne: async (q: any) => (q?.where?.id?._type ? { id: 'other' } : cur), // Not(id) name check -> taken
  });
  await assert.rejects(() => service.update(PROJECT, 'cred-1', { name: 'taken' }), /already exists/);

  handle.repos.Credential = makeFakeRepo({
    findOne: async (q: any) => (q?.where?.id?._type ? null : cur),
    save: async (e: any) => e,
  });
  const updated = await service.update(PROJECT, 'cred-1', { description: 'd', labels: ['a'], metadata: { x: 1 } });
  assert.equal(updated.description, 'd');
});

test('rotateSecret: not found null; empty secret throws; success bumps version', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.equal(await service.rotateSecret(PROJECT, 'missing', { api_key: 'x' }), null);

  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1', secretName: 's', rotationVersion: 1 }) });
  await assert.rejects(() => service.rotateSecret(PROJECT, 'cred-1', {}), /at least one non-empty/);

  handle.repos.Credential = makeFakeRepo({
    findOne: async () => ({ id: 'cred-1', secretName: 's', rotationVersion: 1 }),
    save: async (e: any) => e,
  });
  handle.repos.MCPServer = makeFakeRepo({ find: async () => [] });
  const rotated = await service.rotateSecret(PROJECT, 'cred-1', { api_key: 'new' });
  assert.equal(rotated.rotationVersion, 2);
});

test('delete: not found false; success true', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.equal(await service.delete(PROJECT, 'missing'), false);

  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1', secretName: 's' }), remove: async () => undefined });
  assert.equal(await service.delete(PROJECT, 'cred-1'), true);
});

test('readSecretData: null when missing, secret otherwise', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.equal(await service.readSecretData(PROJECT, 'missing'), null);

  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1', secretName: 's' }) });
  assert.deepEqual(await service.readSecretData(PROJECT, 'cred-1'), { api_key: 'sk' });
});

test('validate: not found, valid, and adapter failure', async () => {
  handle.repos.Credential = makeFakeRepo({ findOne: async () => null });
  assert.deepEqual(await service.validate(PROJECT, 'missing', async () => true), { valid: false, error: 'Credential not found' });

  handle.repos.Credential = makeFakeRepo({ findOne: async () => ({ id: 'cred-1', secretName: 's', provider: 'openai' }) });
  assert.deepEqual(await service.validate(PROJECT, 'cred-1', async () => true), { valid: true });

  const res = await service.validate(PROJECT, 'cred-1', async () => {
    throw new Error('nope');
  });
  assert.equal(res.valid, false);
});

test('validate: surfaces the adapter error message verbatim (AIAS-1408)', async () => {
  handle.repos.Credential = makeFakeRepo({
    findOne: async () => ({ id: 'cred-1', secretName: 's', provider: 'ontap' }),
  });
  const adapterMessage =
    'NetApp ONTAP credential requires either (username + password) or (client_cert_pem + client_key_pem)';
  const res = await service.validate(PROJECT, 'cred-1', async () => {
    throw new Error(adapterMessage);
  });
  assert.deepEqual(res, { valid: false, error: adapterMessage });
});

test('validate: maps 401/403, timeout, network code, and secret read failures', async () => {
  handle.repos.Credential = makeFakeRepo({
    findOne: async () => ({ id: 'cred-1', secretName: 's', provider: 'openai' }),
  });
  k8s.readSecret = async () => {
    throw new Error('secret missing');
  };
  assert.deepEqual(await service.validate(PROJECT, 'cred-1', async () => true), {
    valid: false,
    error: 'Could not read the stored credential secret',
  });

  k8s.readSecret = async () => ({ api_key: 'sk' });
  const unauthorized = await service.validate(PROJECT, 'cred-1', async () => {
    throw Object.assign(new Error('nope'), { response: { status: 401 } });
  });
  assert.equal(unauthorized.error, 'Invalid credentials — the provider rejected the key');

  const timeout = await service.validate(PROJECT, 'cred-1', async () => {
    throw new Error('Validation timed out');
  });
  assert.equal(timeout.error, 'Validation timed out — the provider did not respond in time');

  const network = await service.validate(PROJECT, 'cred-1', async () => {
    throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
  });
  assert.equal(network.error, 'Could not reach the provider (ECONNREFUSED)');
});

test('validateDraft: reuses adapter validation branches without touching the database', async () => {
  const timeout = await service.validateDraft('openai', { api_key: 'sk' }, undefined, async () => {
    throw Object.assign(new Error('aborted'), { code: 'ECONNABORTED' });
  });
  assert.equal(timeout.error, 'Validation timed out — the provider did not respond in time');

  const ok = await service.validateDraft('openai', { api_key: 'sk' }, { region: 'us' }, async () => true);
  assert.deepEqual(ok, { valid: true });
});
