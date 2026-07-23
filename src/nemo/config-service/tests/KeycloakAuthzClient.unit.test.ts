/**
 * Unit tests for KeycloakAuthzClient HTTP surface (beyond parsePolicyName).
 *
 * Run: node --require ts-node/register --test tests/KeycloakAuthzClient.unit.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KeycloakAuthzClient,
  getRouteKeycloakAuthzClient,
  _setCachedKeycloakAuthzClientForTests,
} from '../services/KeycloakAuthzClient';

const ISSUER = 'http://keycloak.test/realms/nemo';

afterEach(() => {
  _setCachedKeycloakAuthzClientForTests(null);
});

test('constructor: rejects missing config', () => {
  assert.throws(
    () => new KeycloakAuthzClient('', 'id', 'secret', 'uuid'),
    /issuer, clientId, clientSecret, and resourceServerUUID are required/,
  );
});

test('listPolicies: fetches token then queries authz policies', async () => {
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const client = new KeycloakAuthzClient(ISSUER, 'svc-config', 'secret', 'rs-uuid');
  (client as any).httpClient = {
    post: async (url: string) => {
      requests.push({ url });
      return {
        status: 200,
        data: { access_token: 'tok-abc', expires_in: 300 },
      };
    },
    get: async (url: string, opts?: { headers?: Record<string, string> }) => {
      requests.push({ url, headers: opts?.headers });
      return {
        status: 200,
        data: [{ id: 'pol-1', name: 'usr-u1-proj-p1-admin', type: 'user' }],
      };
    },
  };

  const policies = await client.listPolicies('usr-u1-proj-p1', 50);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].name, 'usr-u1-proj-p1-admin');
  assert.match(requests[0].url, /\/token$/);
  assert.match(requests[1].url, /\/policy\?/);
  assert.equal(requests[1].headers?.Authorization, 'Bearer tok-abc');
});

test('listPolicies: reuses cached access token', async () => {
  let tokenPosts = 0;
  const client = new KeycloakAuthzClient(ISSUER, 'svc-config', 'secret', 'rs-uuid');
  (client as any).httpClient = {
    post: async () => {
      tokenPosts += 1;
      return { status: 200, data: { access_token: 'tok-1', expires_in: 3600 } };
    },
    get: async () => ({ status: 200, data: [] }),
  };
  await client.listPolicies('usr-');
  await client.listPolicies('usr-');
  assert.equal(tokenPosts, 1);
});

test('listPolicies: throws on non-200 policy response', async () => {
  const client = new KeycloakAuthzClient(ISSUER, 'svc-config', 'secret', 'rs-uuid');
  (client as any).accessToken = 'tok';
  (client as any).tokenExpiresAt = Date.now() + 60_000;
  (client as any).httpClient = {
    get: async () => ({ status: 500, data: { error: 'boom' } }),
  };
  await assert.rejects(() => client.listPolicies('usr-'), /status 500/);
});

test('getRouteKeycloakAuthzClient: builds client from env', () => {
  const prev = {
    issuer: process.env.KEYCLOAK_INTERNAL_ISSUER,
    clientId: process.env.KEYCLOAK_AUTHZ_CLIENT_ID,
    secret: process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET,
    uuid: process.env.KEYCLOAK_RESOURCE_SERVER_UUID,
  };
  process.env.KEYCLOAK_INTERNAL_ISSUER = ISSUER;
  process.env.KEYCLOAK_AUTHZ_CLIENT_ID = 'svc-config';
  process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET = 'secret';
  process.env.KEYCLOAK_RESOURCE_SERVER_UUID = 'rs-uuid';
  try {
    const c = getRouteKeycloakAuthzClient();
    assert.ok(c instanceof KeycloakAuthzClient);
    assert.equal(getRouteKeycloakAuthzClient(), c);
  } finally {
    if (prev.issuer === undefined) delete process.env.KEYCLOAK_INTERNAL_ISSUER;
    else process.env.KEYCLOAK_INTERNAL_ISSUER = prev.issuer;
    if (prev.clientId === undefined) delete process.env.KEYCLOAK_AUTHZ_CLIENT_ID;
    else process.env.KEYCLOAK_AUTHZ_CLIENT_ID = prev.clientId;
    if (prev.secret === undefined) delete process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET;
    else process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET = prev.secret;
    if (prev.uuid === undefined) delete process.env.KEYCLOAK_RESOURCE_SERVER_UUID;
    else process.env.KEYCLOAK_RESOURCE_SERVER_UUID = prev.uuid;
  }
});

test('getAccessToken: throws when token endpoint returns non-2xx', async () => {
  const client = new KeycloakAuthzClient(ISSUER, 'svc-config', 'secret', 'rs-uuid');
  (client as any).httpClient = {
    post: async () => ({ status: 401, data: { error: 'invalid_client' } }),
  };
  await assert.rejects(() => client.listPolicies('usr-'), /token request failed/);
});

test('listPolicies: returns [] for non-array body and uses fallback max', async () => {
  const client = new KeycloakAuthzClient(ISSUER, 'svc-config', 'secret', 'rs-uuid');
  (client as any).accessToken = 'tok';
  (client as any).tokenExpiresAt = Date.now() + 60_000;
  (client as any).httpClient = {
    get: async (url: string) => {
      assert.match(url, /max=200/);
      return { status: 200, data: { unexpected: true } };
    },
  };
  assert.deepEqual(await client.listPolicies('usr-', 0), []);
});

test('adminAuthzBaseURL: throws for malformed issuer', async () => {
  const client = new KeycloakAuthzClient('http://bad-host/no-realm-segment', 'id', 'secret', 'uuid');
  (client as any).accessToken = 'tok';
  (client as any).tokenExpiresAt = Date.now() + 60_000;
  await assert.rejects(() => client.listPolicies('x'), /cannot derive admin base/);
});

test('getRouteKeycloakAuthzClient: throws when env incomplete', () => {
  const prev = {
    issuer: process.env.KEYCLOAK_INTERNAL_ISSUER,
    clientId: process.env.KEYCLOAK_AUTHZ_CLIENT_ID,
    secret: process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET,
    uuid: process.env.KEYCLOAK_RESOURCE_SERVER_UUID,
  };
  delete process.env.KEYCLOAK_INTERNAL_ISSUER;
  delete process.env.KEYCLOAK_AUTHZ_CLIENT_ID;
  delete process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET;
  delete process.env.KEYCLOAK_RESOURCE_SERVER_UUID;
  _setCachedKeycloakAuthzClientForTests(null);
  try {
    assert.throws(() => getRouteKeycloakAuthzClient(), /must be set/);
  } finally {
    if (prev.issuer === undefined) delete process.env.KEYCLOAK_INTERNAL_ISSUER;
    else process.env.KEYCLOAK_INTERNAL_ISSUER = prev.issuer;
    if (prev.clientId === undefined) delete process.env.KEYCLOAK_AUTHZ_CLIENT_ID;
    else process.env.KEYCLOAK_AUTHZ_CLIENT_ID = prev.clientId;
    if (prev.secret === undefined) delete process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET;
    else process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET = prev.secret;
    if (prev.uuid === undefined) delete process.env.KEYCLOAK_RESOURCE_SERVER_UUID;
    else process.env.KEYCLOAK_RESOURCE_SERVER_UUID = prev.uuid;
    _setCachedKeycloakAuthzClientForTests(null);
  }
});
