/**
 * Unit tests for services/KeycloakClientService.ts (Admin API surface).
 *
 * Run: node --require ts-node/register --test tests/KeycloakClientService.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { KeycloakClientService } from '../services/KeycloakClientService';

type Handler = (url: string, opts?: any) => Promise<any>;

function makeService(handlers: Partial<Record<'get' | 'post' | 'delete', Handler>>): KeycloakClientService {
  const svc = new KeycloakClientService();
  (svc as any).accessToken = 'test-token';
  (svc as any).tokenExpiry = new Date(Date.now() + 3_600_000);
  (svc as any).adminClient = {
    get: async (url: string, opts?: any) => handlers.get?.(url, opts) ?? { data: [] },
    post: async (url: string, _body?: unknown, opts?: any) =>
      handlers.post?.(url, opts) ?? { status: 201, data: {}, headers: {} },
    delete: async (url: string, opts?: any) => handlers.delete?.(url, opts) ?? { status: 204 },
  } as AxiosInstance;
  return svc;
}

test('clientExists: true when clients array is non-empty', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/clients')) return { data: [{ id: 'uuid-1', clientId: 'project-p1-service' }] };
      throw new Error(url);
    },
  });
  assert.equal(await svc.clientExists('project-p1-service'), true);
});

test('clientExists: false on 404', async () => {
  const svc = makeService({
    get: async () => {
      const err: any = new Error('not found');
      err.response = { status: 404 };
      throw err;
    },
  });
  assert.equal(await svc.clientExists('missing'), false);
});

test('getClientUuid and getClientSecret round-trip', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/clients')) return { data: [{ id: 'uuid-abc', clientId: 'project-x-service' }] };
      if (url.endsWith('/client-secret')) return { data: { value: 'secret-value' } };
      throw new Error(url);
    },
  });
  assert.equal(await svc.getClientUuid('project-x-service'), 'uuid-abc');
  assert.equal(await svc.getClientSecret('uuid-abc'), 'secret-value');
});

test('realmExists: true on 200 and false on 404', async () => {
  const ok = makeService({ get: async () => ({ data: { realm: 'nemo' } }) });
  assert.equal(await ok.realmExists(), true);

  const missing = makeService({
    get: async () => {
      const err: any = new Error('missing');
      err.response = { status: 404 };
      throw err;
    },
  });
  assert.equal(await missing.realmExists(), false);
});

test('getUserCount: excludes service accounts and returns 0 on 404', async () => {
  const svc = makeService({
    get: async (url, opts) => {
      if (url.endsWith('/users')) {
        return {
          data: [
            { id: 'u1', username: 'alice' },
            { id: 'sa1', serviceAccountClientId: 'project-p1-service' },
          ],
        };
      }
      throw new Error(url);
    },
  });
  assert.equal(await svc.getUserCount(), 1);

  const noRealm = makeService({
    get: async () => {
      const err: any = new Error('missing realm');
      err.response = { status: 404 };
      throw err;
    },
  });
  assert.equal(await noRealm.getUserCount(), 0);
});

test('getUsersByIds: resolves profiles and skips missing users', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/users/u1')) return { data: { id: 'u1', username: 'alice', email: 'a@x.com' } };
      if (url.endsWith('/users/u2')) {
        const err: any = new Error('gone');
        err.response = { status: 404 };
        throw err;
      }
      throw new Error(url);
    },
  });
  const map = await svc.getUsersByIds(['u1', 'u2', 'u1']);
  assert.equal(map.size, 1);
  assert.equal(map.get('u1')?.id, 'u1');
  assert.equal(map.get('u1')?.username, 'alice');
  assert.equal(map.get('u1')?.email, 'a@x.com');
});

test('getUserIdByEmail: exact match and null when absent', async () => {
  const svc = makeService({
    get: async (_url, opts) => {
      const email = opts?.params?.email;
      if (email === 'found@x.com') return { data: [{ id: 'uid-1', email }] };
      return { data: [] };
    },
  });
  assert.equal(await svc.getUserIdByEmail('found@x.com'), 'uid-1');
  assert.equal(await svc.getUserIdByEmail('missing@x.com'), null);
});

test('createUser: reads id from Location header', async () => {
  const svc = makeService({
    post: async () => ({
      status: 201,
      headers: { location: 'http://kc/admin/realms/nemo/users/new-user-id' },
      data: {},
    }),
  });
  assert.equal(await svc.createUser('new@x.com'), 'new-user-id');
});

test('resolveOrCreateUser: returns existing without create', async () => {
  const calls: string[] = [];
  const svc = makeService({
    get: async (_url, opts) => {
      calls.push('get');
      if (opts?.params?.email === 'exists@x.com') return { data: [{ id: 'u-existing' }] };
      return { data: [] };
    },
    post: async () => {
      calls.push('post');
      return { status: 201, headers: { location: '/users/u-new' }, data: {} };
    },
  });
  const existing = await svc.resolveOrCreateUser('exists@x.com');
  assert.deepEqual(existing, { userId: 'u-existing', created: false });
  assert.deepEqual(calls, ['get']);
});

test('deleteProjectServiceAccountClient: false when client missing', async () => {
  const svc = makeService({
    get: async () => ({ data: [] }),
  });
  assert.equal(await svc.deleteProjectServiceAccountClient('proj1'), false);
});

test('getAdminCredentials exposes configured username/password', () => {
  const svc = new KeycloakClientService();
  const creds = svc.getAdminCredentials();
  assert.ok(typeof creds.username === 'string');
  assert.ok(typeof creds.password === 'string');
});

test('createProjectServiceAccountClient: returns existing client secret', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/clients')) {
        return { data: [{ id: 'uuid-existing', clientId: 'project-proj1-service' }] };
      }
      if (url.endsWith('/client-secret')) {
        return { data: { value: 'existing-secret' } };
      }
      throw new Error(url);
    },
  });
  const result = await svc.createProjectServiceAccountClient('proj1');
  assert.equal(result.clientId, 'project-proj1-service');
  assert.equal(result.clientSecret, 'existing-secret');
});

test('createProjectServiceAccountClient: handles 409 conflict without re-creating', async () => {
  let clientListCalls = 0;
  const svc = makeService({
    get: async (url, opts) => {
      if (url.endsWith('/clients')) {
        clientListCalls += 1;
        if (clientListCalls === 1) return { data: [] };
        return { data: [{ id: 'uuid-conflict', clientId: 'project-proj2-service' }] };
      }
      if (url.endsWith('/client-secret')) {
        return { data: { value: 'conflict-secret' } };
      }
      throw new Error(url);
    },
    post: async (url) => {
      if (url.endsWith('/clients')) {
        const err: any = new Error('conflict');
        err.response = { status: 409 };
        throw err;
      }
      throw new Error(url);
    },
  });
  const result = await svc.createProjectServiceAccountClient('proj2');
  assert.equal(result.clientSecret, 'conflict-secret');
});

test('deleteProjectServiceAccountClient: deletes when client exists', async () => {
  let deleted = false;
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/clients')) {
        return { data: [{ id: 'uuid-del', clientId: 'project-proj3-service' }] };
      }
      throw new Error(url);
    },
    delete: async () => {
      deleted = true;
      return { status: 204 };
    },
  });
  assert.equal(await svc.deleteProjectServiceAccountClient('proj3'), true);
  assert.equal(deleted, true);
});

test('resolveOrCreateUser: creates when email is missing', async () => {
  const svc = makeService({
    get: async (_url, opts) => {
      if (opts?.params?.email === 'new@x.com') return { data: [] };
      return { data: [{ id: 'u-existing' }] };
    },
    post: async () => ({
      status: 201,
      headers: { location: 'http://kc/admin/realms/nemo/users/u-created' },
      data: {},
    }),
  });
  const created = await svc.resolveOrCreateUser('new@x.com');
  assert.deepEqual(created, { userId: 'u-created', created: true });
});

test('resolveOrCreateUsers and resolveUsers: batch email lookups', async () => {
  const svc = makeService({
    get: async (_url, opts) => {
      const email = opts?.params?.email;
      if (email === 'a@x.com') return { data: [{ id: 'u-a' }] };
      if (email === 'b@x.com') return { data: [] };
      return { data: [] };
    },
    post: async () => ({
      status: 201,
      headers: { location: '/users/u-b' },
      data: {},
    }),
  });
  const createdMap = await svc.resolveOrCreateUsers(['a@x.com', 'b@x.com', 'a@x.com']);
  assert.equal(createdMap.get('a@x.com')?.created, false);
  assert.equal(createdMap.get('b@x.com')?.created, true);

  const resolveOnly = await svc.resolveUsers(['a@x.com', 'missing@x.com']);
  assert.equal(resolveOnly.get('a@x.com'), 'u-a');
  assert.equal(resolveOnly.get('missing@x.com'), null);
});

test('getUsersByIds: returns empty map for empty input', async () => {
  const svc = makeService({});
  const map = await svc.getUsersByIds([]);
  assert.equal(map.size, 0);
});

test('getUsersByIds: logs but continues on non-404 lookup errors', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/users/u-ok')) return { data: { id: 'u-ok', username: 'ok' } };
      if (url.endsWith('/users/u-bad')) {
        const err: any = new Error('server error');
        err.response = { status: 500 };
        throw err;
      }
      throw new Error(url);
    },
  });
  const map = await svc.getUsersByIds(['u-ok', 'u-bad']);
  assert.equal(map.size, 1);
  assert.equal(map.get('u-ok')?.username, 'ok');
});

test('getUserIdByEmail: warns and uses first when duplicates exist', async () => {
  const svc = makeService({
    get: async (_url, opts) => {
      if (opts?.params?.email === 'dup@x.com') {
        return { data: [{ id: 'u-first' }, { id: 'u-second' }] };
      }
      return { data: [] };
    },
  });
  assert.equal(await svc.getUserIdByEmail('dup@x.com'), 'u-first');
});

test('createUser: falls back to email lookup when Location header missing', async () => {
  const svc = makeService({
    post: async () => ({ status: 201, headers: {}, data: {} }),
    get: async (_url, opts) => {
      if (opts?.params?.email === 'no-location@x.com') return { data: [{ id: 'u-lookup' }] };
      return { data: [] };
    },
  });
  assert.equal(await svc.createUser('no-location@x.com'), 'u-lookup');
});

test('createUser: resolves id after 409 conflict', async () => {
  const svc = makeService({
    post: async () => {
      const err: any = new Error('conflict');
      err.response = { status: 409 };
      throw err;
    },
    get: async (_url, opts) => {
      if (opts?.params?.email === 'race@x.com') return { data: [{ id: 'u-race' }] };
      return { data: [] };
    },
  });
  assert.equal(await svc.createUser('race@x.com'), 'u-race');
});

test('realmExists: rethrows non-404 errors', async () => {
  const svc = makeService({
    get: async () => {
      const err: any = new Error('forbidden');
      err.response = { status: 403 };
      throw err;
    },
  });
  await assert.rejects(() => svc.realmExists());
});

test('getRouteKeycloakUserDirectory: returns singleton instance', async () => {
  const { getRouteKeycloakUserDirectory, _setCachedKeycloakUserDirectoryForTests } = await import(
    '../services/KeycloakClientService'
  );
  _setCachedKeycloakUserDirectoryForTests(null);
  const a = getRouteKeycloakUserDirectory();
  const b = getRouteKeycloakUserDirectory();
  assert.equal(a, b);
  _setCachedKeycloakUserDirectoryForTests(null);
});

test('getUserCount: returns 0 when response is not an array', async () => {
  const svc = makeService({
    get: async () => ({ data: { total: 5 } }),
  });
  assert.equal(await svc.getUserCount(), 0);
});

test('getUserCount: rethrows non-404 errors', async () => {
  const svc = makeService({
    get: async () => {
      const err: any = new Error('forbidden');
      err.response = { status: 403 };
      throw err;
    },
  });
  await assert.rejects(() => svc.getUserCount());
});

test('createUser: throws when id cannot be resolved after create', async () => {
  const svc = makeService({
    post: async () => ({ status: 201, headers: {}, data: {} }),
    get: async () => ({ data: [] }),
  });
  await assert.rejects(() => svc.createUser('ghost@x.com'), /id could not be resolved/);
});

test('createUser: rethrows 409 when lookup still fails', async () => {
  const svc = makeService({
    post: async () => {
      const err: any = new Error('conflict');
      err.response = { status: 409 };
      throw err;
    },
    get: async () => ({ data: [] }),
  });
  await assert.rejects(() => svc.createUser('race@x.com'));
});

test('getUsersByIds: skips users without an id field', async () => {
  const svc = makeService({
    get: async (url) => {
      if (url.endsWith('/users/u-empty')) return { data: { username: 'empty' } };
      throw new Error(url);
    },
  });
  const map = await svc.getUsersByIds(['u-empty']);
  assert.equal(map.size, 0);
});
