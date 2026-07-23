/**
 * Unit tests for the read-only project membership endpoints in config-service
 * (moved from workflow-engine in PR #31 follow-up; see comment r3321434919).
 *
 * Covers:
 *   - parsePolicyName: full equivalent of the Go test suite that previously
 *     lived at internal/server/routes/project_membership_test.go.
 *   - GET /api/v1/projects/:projectId/members: filters policies by project,
 *     ignores foreign-project entries, requires auth.
 *
 * The caller's own project list moved to GET /api/v1/projects
 * (routes/projectRoutes.ts); see tests/projectRoutes.routes.unit.test.ts.
 *
 * Run: node --require ts-node/register --test tests/projectMembership.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
// Pull in @agentstudio/common for its `declare global { Express.Request.user }`
// augmentation so single-file ts-node test runs see the same Request shape as
// the real server build does.
import '@agentstudio/common';

import {
  KeycloakAuthzClient,
  PolicyInfo,
  parsePolicyName,
  _setCachedKeycloakAuthzClientForTests,
} from '../services/KeycloakAuthzClient';
import {
  KeycloakClientService,
  KeycloakUserProfile,
  _setCachedKeycloakUserDirectoryForTests,
} from '../services/KeycloakClientService';
import projectMembershipRoutes from '../routes/projectMembershipRoutes';

// ---------- parsePolicyName ------------------------------------------------

test('parsePolicyName: simple ids', () => {
  assert.deepEqual(parsePolicyName('usr-user1-proj-project-abc-admin'), {
    userId: 'user1', projectId: 'project-abc', role: 'admin',
  });
  assert.deepEqual(parsePolicyName('usr-alice-proj-my-project-member'), {
    userId: 'alice', projectId: 'my-project', role: 'member',
  });
  assert.deepEqual(parsePolicyName('usr-bob-proj-p1-viewer'), {
    userId: 'bob', projectId: 'p1', role: 'viewer',
  });
});

test('parsePolicyName: UUID user and project ids (hyphen-rich)', () => {
  // Role is the segment after the LAST hyphen of the post-`-proj-` portion.
  assert.deepEqual(
    parsePolicyName('usr-550e8400-e29b-41d4-a716-446655440000-proj-660e8400-e29b-41d4-a716-446655440001-admin'),
    { userId: '550e8400-e29b-41d4-a716-446655440000', projectId: '660e8400-e29b-41d4-a716-446655440001', role: 'admin' },
  );
});

test('parsePolicyName: invalid shapes return null', () => {
  for (const bad of [
    'pol-user1-proj-p1-admin',  // wrong prefix
    'usr-user1-p1-admin',       // missing -proj- segment
    '',
    'usr-',
    'usr-user1-proj-p1',        // no role at end (only one segment after -proj-)
    'usr-user1-proj-p1-superuser', // trailing segment is not a known role
    'usr-user1-proj-p1-Admin',     // role is case-sensitive; not a known role
  ]) {
    assert.equal(parsePolicyName(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ---------- Route handlers via a real express server ----------------------

function makeAuthMiddleware(userSub: string | null): express.RequestHandler {
  return (req, _res, next) => {
    if (userSub) {
      (req as any).user = { sub: userSub };
    }
    next();
  };
}

class StubAuthzClient extends KeycloakAuthzClient {
  public calls: Array<{ prefix: string; max: number }> = [];
  constructor(private readonly resp: PolicyInfo[] | Error) {
    super('http://stub/realms/nemo', 'cid', 'csec', 'uuid');
  }
  async listPolicies(prefix: string, max: number): Promise<PolicyInfo[]> {
    this.calls.push({ prefix, max });
    if (this.resp instanceof Error) throw this.resp;
    return this.resp;
  }
}

// Stubs the Keycloak user directory used to enrich members with username/email.
// `users` maps userId -> profile; ids absent from the map resolve to no profile
// (mimicking a deleted user / unresolved lookup). Pass an Error to simulate the
// whole directory being unreachable.
class StubUserDirectory extends KeycloakClientService {
  constructor(private readonly users: Record<string, { username?: string; email?: string }> | Error) {
    super();
  }
  async getUsersByIds(ids: string[]): Promise<Map<string, KeycloakUserProfile>> {
    if (this.users instanceof Error) throw this.users;
    const m = new Map<string, KeycloakUserProfile>();
    for (const id of ids) {
      const u = this.users[id];
      if (u) m.set(id, { id, username: u.username, email: u.email });
    }
    return m;
  }
}

function startTestServer(authMiddleware: express.RequestHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/', projectMembershipRoutes);
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

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const resp = await fetch(url);
  let body: any = null;
  try { body = await resp.json(); } catch { /* tolerate non-JSON 5xx */ }
  return { status: resp.status, body };
}

test('GET /projects/:id/members: 401 when unauthenticated', async () => {
  _setCachedKeycloakAuthzClientForTests(new StubAuthzClient([]));
  const srv = await startTestServer(makeAuthMiddleware(null));
  try {
    const r = await getJson(`${srv.url}/api/v1/projects/proj-x/members`);
    assert.equal(r.status, 401);
  } finally {
    await srv.close();
    _setCachedKeycloakAuthzClientForTests(null);
  }
});

test('GET /projects/:id/members: filters foreign-project policies and enriches with profile', async () => {
  const stub = new StubAuthzClient([
    { id: '1', name: 'usr-user1-proj-proj-x-admin' },
    { id: '2', name: 'usr-user2-proj-proj-x-member' },
    { id: '3', name: 'usr-user3-proj-proj-y-admin' }, // different project, must be filtered out
    { id: '4', name: 'pol-noise' },                     // bad shape, ignored
  ]);
  _setCachedKeycloakAuthzClientForTests(stub);
  _setCachedKeycloakUserDirectoryForTests(
    new StubUserDirectory({
      user1: { username: 'alice', email: 'alice@example.com' },
      user2: { username: 'bob', email: 'bob@example.com' },
    }),
  );
  const srv = await startTestServer(makeAuthMiddleware('caller-sub'));
  try {
    const r = await getJson(`${srv.url}/api/v1/projects/proj-x/members`);
    assert.equal(r.status, 200);
    assert.equal(r.body.projectId, 'proj-x');
    assert.deepEqual(
      [...r.body.members].sort((a: any, b: any) => a.userId.localeCompare(b.userId)),
      [
        { userId: 'user1', role: 'admin', username: 'alice', email: 'alice@example.com' },
        { userId: 'user2', role: 'member', username: 'bob', email: 'bob@example.com' },
      ],
    );
    // Project-scoped search token narrows the server-side query so we don't
    // scan every user policy in the realm.
    assert.equal(stub.calls[0].prefix, '-proj-proj-x-');
  } finally {
    await srv.close();
    _setCachedKeycloakAuthzClientForTests(null);
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('GET /projects/:id/members: returns userId/role without profile when directory lookup misses or fails', async () => {
  _setCachedKeycloakAuthzClientForTests(
    new StubAuthzClient([{ id: '1', name: 'usr-ghost-proj-proj-x-admin' }]),
  );
  // Directory has no entry for `ghost` (e.g. a deleted user / stale policy);
  // the member is still returned, just without username/email.
  _setCachedKeycloakUserDirectoryForTests(new StubUserDirectory({}));
  const srv = await startTestServer(makeAuthMiddleware('caller-sub'));
  try {
    const r = await getJson(`${srv.url}/api/v1/projects/proj-x/members`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members, [{ userId: 'ghost', role: 'admin' }]);
  } finally {
    await srv.close();
    _setCachedKeycloakAuthzClientForTests(null);
    _setCachedKeycloakUserDirectoryForTests(null);
  }

  // And if the directory is entirely unreachable, the listing still succeeds.
  _setCachedKeycloakAuthzClientForTests(
    new StubAuthzClient([{ id: '1', name: 'usr-ghost-proj-proj-x-admin' }]),
  );
  _setCachedKeycloakUserDirectoryForTests(new StubUserDirectory(new Error('keycloak admin unreachable')));
  const srv2 = await startTestServer(makeAuthMiddleware('caller-sub'));
  try {
    const r = await getJson(`${srv2.url}/api/v1/projects/proj-x/members`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.members, [{ userId: 'ghost', role: 'admin' }]);
  } finally {
    await srv2.close();
    _setCachedKeycloakAuthzClientForTests(null);
    _setCachedKeycloakUserDirectoryForTests(null);
  }
});

test('GET /projects/:id/members: surfaces Keycloak errors as 500', async () => {
  _setCachedKeycloakAuthzClientForTests(new StubAuthzClient(new Error('keycloak unreachable')));
  const srv = await startTestServer(makeAuthMiddleware('caller-sub'));
  try {
    const r = await getJson(`${srv.url}/api/v1/projects/proj-x/members`);
    assert.equal(r.status, 500);
    assert.match(r.body.error, /membership/);
  } finally {
    await srv.close();
    _setCachedKeycloakAuthzClientForTests(null);
  }
});
