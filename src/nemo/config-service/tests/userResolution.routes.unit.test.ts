/**
 * Unit tests for the internal user resolve-or-create endpoint
 * (routes/userResolutionRoutes.ts), used by workflow-engine project-init to
 * turn invitee emails into stable Keycloak user ids.
 *
 * The Keycloak admin directory is stubbed via _setCachedKeycloakUserDirectoryForTests
 * so no real Keycloak is needed.
 *
 * Run: node --require ts-node/register --test tests/userResolution.routes.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import '@agentstudio/common';

import {
  KeycloakClientService,
  _setCachedKeycloakUserDirectoryForTests,
} from '../services/KeycloakClientService';
import userResolutionRoutes from '../routes/userResolutionRoutes';

// Stub directory: `map` is email -> {userId, created}. For resolve-or-create an
// email absent from the map throws (so tests must register every email they send
// on the happy path). For resolve-only, an absent email is treated as "no such
// user" and returns null.
class StubUserDirectory extends KeycloakClientService {
  public calls: string[][] = [];
  public resolveCalls: string[][] = [];
  constructor(private readonly map: Record<string, { userId: string; created: boolean }>) {
    super();
  }
  async resolveOrCreateUsers(
    emails: string[]
  ): Promise<Map<string, { userId: string; created: boolean }>> {
    this.calls.push(emails);
    const m = new Map<string, { userId: string; created: boolean }>();
    for (const e of emails) {
      const r = this.map[e];
      if (!r) throw new Error(`stub: unexpected email ${e}`);
      m.set(e, r);
    }
    return m;
  }
  async resolveUsers(emails: string[]): Promise<Map<string, string | null>> {
    this.resolveCalls.push(emails);
    const m = new Map<string, string | null>();
    for (const e of emails) {
      m.set(e, this.map[e]?.userId ?? null);
    }
    return m;
  }
}

function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/internal/users', userResolutionRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await resp.json();
  } catch {
    /* tolerate non-JSON */
  }
  return { status: resp.status, body: parsed };
}

const PATH = '/api/v1/internal/users/resolve-or-create';

test('resolve-or-create: 400 when emails missing/empty', async () => {
  _setCachedKeycloakUserDirectoryForTests(new StubUserDirectory({}));
  const srv = await startTestServer();
  try {
    assert.equal((await postJson(`${srv.url}${PATH}`, {})).status, 400);
    assert.equal((await postJson(`${srv.url}${PATH}`, { emails: [] })).status, 400);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('resolve-or-create: 400 on invalid email', async () => {
  _setCachedKeycloakUserDirectoryForTests(new StubUserDirectory({}));
  const srv = await startTestServer();
  try {
    const r = await postJson(`${srv.url}${PATH}`, { emails: ['not-an-email'] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /invalid email/);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('resolve-or-create: returns resolved entries (existing + created)', async () => {
  _setCachedKeycloakUserDirectoryForTests(
    new StubUserDirectory({
      'alice@example.com': { userId: 'u-alice', created: false },
      'bob@example.com': { userId: 'u-bob', created: true },
    }),
  );
  const srv = await startTestServer();
  try {
    const r = await postJson(`${srv.url}${PATH}`, {
      emails: ['alice@example.com', 'bob@example.com'],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.resolved, [
      { email: 'alice@example.com', userId: 'u-alice', created: false },
      { email: 'bob@example.com', userId: 'u-bob', created: true },
    ]);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('resolve-or-create: dedupes repeated emails before resolving', async () => {
  const stub = new StubUserDirectory({ 'alice@example.com': { userId: 'u-alice', created: false } });
  _setCachedKeycloakUserDirectoryForTests(stub);
  const srv = await startTestServer();
  try {
    const r = await postJson(`${srv.url}${PATH}`, {
      emails: ['alice@example.com', 'alice@example.com', ' alice@example.com '],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved.length, 1);
    // The directory only ever saw the single deduped+trimmed email.
    assert.deepEqual(stub.calls[0], ['alice@example.com']);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

const RESOLVE_PATH = '/api/v1/internal/users/resolve';

test('resolve: 400 when emails missing/empty or invalid', async () => {
  _setCachedKeycloakUserDirectoryForTests(new StubUserDirectory({}));
  const srv = await startTestServer();
  try {
    assert.equal((await postJson(`${srv.url}${RESOLVE_PATH}`, {})).status, 400);
    assert.equal((await postJson(`${srv.url}${RESOLVE_PATH}`, { emails: [] })).status, 400);
    const bad = await postJson(`${srv.url}${RESOLVE_PATH}`, { emails: ['nope'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /invalid email/);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('resolve: returns userId for known email and null for unknown (never creates)', async () => {
  const stub = new StubUserDirectory({ 'alice@example.com': { userId: 'u-alice', created: false } });
  _setCachedKeycloakUserDirectoryForTests(stub);
  const srv = await startTestServer();
  try {
    const r = await postJson(`${srv.url}${RESOLVE_PATH}`, {
      emails: ['alice@example.com', 'ghost@example.com'],
    });
    assert.equal(r.status, 200);
    // Unknown email yields an empty-string sentinel (not null) so the Go client
    // decoding userId into a string treats it unambiguously as "not found".
    assert.deepEqual(r.body.resolved, [
      { email: 'alice@example.com', userId: 'u-alice' },
      { email: 'ghost@example.com', userId: '' },
    ]);
    // Resolve-only must never invoke the create path.
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(stub.resolveCalls[0], ['alice@example.com', 'ghost@example.com']);
  } finally {
    await srv.close();
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});
