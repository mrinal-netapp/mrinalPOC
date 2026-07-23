/**
 * Unit tests for middleware/unifiedGuard.ts — the merged single guard.
 *
 * Pattern follows tests/middleware.unit.test.ts + tests/helpers/httpApp.ts:
 * build a tiny express app around a router that runs guard() then a 200
 * handler, and issue real loopback requests. JWTs are minted as raw base64url
 * envelopes (no Keycloak) — the guard is decode-only; the sidecar validates
 * signatures in production.
 *
 * Run: node --require ts-node/register --test tests/unifiedGuard.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from 'express';

import { guard, unifiedGuardGlobal, __testing, type RoutePolicy } from '../middleware/unifiedGuard';
import { buildApp, request } from './helpers/httpApp';

// --------------------------------------------------------------- JWT minting
/** Mint a `header.payload.sig` JWT envelope (signature is a placeholder). */
function mintJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${b64(payload)}.c2ln`;
}

/** A user token: has sub + email (and preferred_username). */
function userToken(extra: Record<string, unknown> = {}): string {
  return mintJwt({
    sub: 'user-uuid-1',
    email: 'alice@example.com',
    preferred_username: 'alice',
    ...extra,
  });
}

/** A service-account / machine token: sub but NO email. */
function saToken(): string {
  return mintJwt({ sub: 'service-account-workflow-engine', preferred_username: 'service-account-wfe' });
}

/** RPT permission entry shape for a project. */
function rptWith(projectId: string, scopes: string[]): Record<string, unknown> {
  return { authorization: { permissions: [{ rsname: `project:${projectId}`, scopes }] } };
}

// --------------------------------------------------------------- app builder
/**
 * Build an app that runs guard(policy) then a 200 handler echoing the context.
 * Default basePath carries `:projectId` so project-kind policies can resolve it
 * from the URL.
 */
function guardedApp(policy: RoutePolicy, basePath = '/api/v1/projects/:projectId/datasets') {
  const router = Router({ mergeParams: true });
  router.all('/', guard(policy), (req, res) => {
    res.json({
      ok: true,
      ctx: (req as any).agentStudioContext ?? null,
      user: (req as any).user ?? null,
    });
  });
  return buildApp({ basePath, router });
}

// ============================================================= public
test('public route → 200 regardless of token', async () => {
  const app = guardedApp({ public: true }, '/x');
  const res = await request(app, 'GET', '/x');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

// ============================================================= user · context
test('user kind=context with email → 200 and agentStudioContext set', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `Bearer ${userToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.user_id, 'user-uuid-1');
  assert.equal(res.body.ctx.user_email, 'alice@example.com');
});

test('user kind=context with SA token (no email) → 200 (non-user caller passes via !email)', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `Bearer ${saToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx, null);
});

test('user kind=context with no token → 200 (mesh gates token-less callers in prod)', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x');
  assert.equal(res.status, 200);
});

// ============================================================= user · roles
test('user kind=roles with a matching realm role → 200', async () => {
  const app = guardedApp({ user: { kind: 'roles', roles: ['platform-member'] } }, '/x');
  const token = userToken({ realm_access: { roles: ['platform-member'] } });
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
});

test('user kind=roles without the role → 403 role_insufficient', async () => {
  const app = guardedApp({ user: { kind: 'roles', roles: ['platform-admin'] } }, '/x');
  const token = userToken({ realm_access: { roles: ['some-other-role'] } });
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'role_insufficient');
});

// ============================================================= user · project
test('user kind=project member, matching project & scope → 200', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('proj1', ['member']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

test('user kind=project, admin satisfies member requirement → 200', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('proj1', ['admin']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
});

test('user kind=project, viewer scope when member required → 403 scope_insufficient', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('proj1', ['viewer']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'scope_insufficient');
});

test('user kind=project, RPT scoped to a different project → 403 context_project_id_missing', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('other-project', ['admin']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'context_project_id_missing');
});

test('user kind=project, projectId resolved from header (from.header) → 200', async () => {
  const app = guardedApp(
    { user: { kind: 'project', scope: 'member', from: { header: 'x-project-id' } } },
    '/x',
  );
  const token = userToken(rptWith('proj1', ['member']));
  const res = await request(app, 'GET', '/x', {
    headers: { Authorization: `Bearer ${token}`, 'x-project-id': 'proj1' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

// ============================================================= mesh-first non-user lane
test('empty policy, no token → 200 (mesh is the gate for token-less callers)', async () => {
  const app = guardedApp({}, '/x');
  const res = await request(app, 'POST', '/x');
  assert.equal(res.status, 200);
});

test('empty policy, user JWT → 403 user_not_allowed', async () => {
  const app = guardedApp({}, '/x');
  const res = await request(app, 'POST', '/x', { headers: { Authorization: `Bearer ${userToken()}` } });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'user_not_allowed');
});

test('dual route, user JWT → 200 (user lane)', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('proj1', ['member']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

test('dual route, no token → 200 (token-less passes; mesh allow-list gates in prod)', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets');
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx, null);
});

test('dual route, SA token (no email) → 200 (non-user passes via !email)', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${saToken()}` },
  });
  assert.equal(res.status, 200);
});

test('dual route, user JWT with insufficient scope → 403 (user lane enforced)', async () => {
  const app = guardedApp({ user: { kind: 'project', scope: 'member' } });
  const token = userToken(rptWith('proj1', ['viewer']));
  const res = await request(app, 'PUT', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'scope_insufficient');
});

// ============================================================= header parsing
test('user lane: leading whitespace before Bearer is tolerated → 200', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `   Bearer ${userToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.user_id, 'user-uuid-1');
});

test('user lane: a non-Bearer Authorization header is not decoded → passes as non-user', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x', { headers: { Authorization: userToken() } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx, null);
});

test('user lane: populates req.user for attribution (modifiedBy)', async () => {
  const app = guardedApp({ user: { kind: 'context' } }, '/x');
  const res = await request(app, 'GET', '/x', { headers: { Authorization: `Bearer ${userToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.sub, 'user-uuid-1');
  assert.equal(res.body.user.email, 'alice@example.com');
});

test('user project scope: projectId from header is trimmed before lookup → 200', async () => {
  const app = guardedApp(
    { user: { kind: 'project', scope: 'member', from: { header: 'x-project-id' } } },
    '/x',
  );
  const token = userToken(rptWith('proj1', ['member']));
  const res = await request(app, 'GET', '/x', {
    headers: { Authorization: `Bearer ${token}`, 'x-project-id': '  proj1  ' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

// ===================================================== global guard
const lane = (m: string, p: string) => {
  const pol = __testing.resolveGlobalPolicy(m, p);
  if (!pol) return 'none';
  if (pol.public) return 'public';
  return pol.user ? pol.user.kind : '-';
};

test('global policy table: every route group maps to the expected lane', () => {
  // dual (UI + callbacks) — app guard only enforces the user lane; mesh gates services
  for (const grp of ['datasets', 'knowledgebases', 'datasources', 'credentials', 'pipelines', 'models', 'agents', 'agent-teams', 'evaluation']) {
    assert.equal(lane('GET', `/api/v1/projects/p1/${grp}`), 'project', grp);
  }
  assert.equal(lane('GET', '/api/v1/projects/p1/service-account'), 'project');
  // user-only project routers
  for (const grp of ['workspace-templates', 'workspaces', 'providers']) {
    assert.equal(lane('GET', `/api/v1/projects/p1/${grp}`), 'project', grp);
  }
  // mcp-servers: GET dual (agent-service-maf reads server config east-west),
  // writes stay member (UI manages MCP servers)
  assert.equal(lane('GET', '/api/v1/projects/p1/mcp-servers/m1'), 'project');
  assert.equal(lane('POST', '/api/v1/projects/p1/mcp-servers'), 'project');
  // buckets: DUAL (workflow-engine create/get/delete + GUI health probe)
  for (const m of ['GET', 'POST', 'DELETE']) {
    assert.equal(lane(m, '/api/v1/projects/p1/buckets'), 'project', `buckets ${m}`);
  }
  assert.equal(lane('GET', '/api/v1/projects/p1/buckets/b1/health'), 'project');
  // membership read now gates on project membership (no longer plain context)
  assert.equal(lane('GET', '/api/v1/projects/p1/members'), 'project');
  // mesh-gated (intentionally unmapped — mesh DENY or allow-list is the gate)
  for (const p of ['/api/v1/internal/users', '/api/v1/internal/mcp-servers', '/api/v1/internal/reference-edges', '/api/v1/workspaces', '/api/v1/buckets/p1/b1/routing', '/api/v1/projects/p1/credentials/c1/secret-data']) {
    assert.equal(lane('GET', p), 'none', p);
  }
  // deployments: GET dual (GUI reads + storage-manager); writes mesh-gated
  assert.equal(lane('GET', '/api/v1/deployments'), 'context');
  assert.equal(lane('GET', '/api/v1/deployments/d1/buckets'), 'context');
  assert.equal(lane('POST', '/api/v1/deployments'), 'none');
  assert.equal(lane('PUT', '/api/v1/deployments/d1'), 'none');
  // project root method nuance: PUT dual (ProjectInit), GET dual (WE reads home_dir)
  assert.equal(lane('PUT', '/api/v1/projects/p1'), 'project');
  assert.equal(lane('GET', '/api/v1/projects/p1'), 'project');
  assert.equal(lane('POST', '/api/v1/projects'), 'context');
  // project root scope nuance: GET=viewer, PATCH=member, PUT=admin, DELETE=admin
  const scopeOf = (m: string, p: string) => {
    const pol = __testing.resolveGlobalPolicy(m, p);
    return pol && pol.user?.kind === 'project' ? pol.user.scope : '-';
  };
  assert.equal(scopeOf('GET', '/api/v1/projects/p1'), 'viewer');
  assert.equal(scopeOf('PATCH', '/api/v1/projects/p1'), 'member');
  assert.equal(scopeOf('PUT', '/api/v1/projects/p1'), 'admin');
  assert.equal(scopeOf('DELETE', '/api/v1/projects/p1'), 'admin');
  // platform + global admin (gateway/governance) → platform-member role
  assert.equal(lane('GET', '/api/v1/platform/mcp-servers'), 'roles');
  assert.equal(lane('GET', '/api/v1/gateway/providers'), 'roles');
  assert.equal(lane('PUT', '/api/v1/governance/virtual-keys/vk1'), 'roles');
  // no-project context surfaces
  for (const p of ['/api/v1/search', '/api/v1/mcp-server-catalog', '/api/v1/explorer', '/api/v1/guardrails', '/api/v1/evaluation/rubric-catalog']) {
    assert.equal(lane('GET', p), 'context', p);
  }
  // unmapped
  assert.equal(lane('GET', '/api/v1/totally-unknown'), 'none');
});

test('global policy table: per-endpoint scope granularity (viewer reads / member writes / admin secrets)', () => {
  const scopeOf = (m: string, p: string) => {
    const pol = __testing.resolveGlobalPolicy(m, p);
    if (!pol || pol.user?.kind !== 'project') return 'none';
    return pol.user.scope;
  };
  // content groups: GET=viewer, writes=member
  for (const grp of ['datasets', 'knowledgebases', 'agents', 'agent-teams', 'evaluation']) {
    assert.equal(scopeOf('GET', `/api/v1/projects/p1/${grp}`), 'viewer', grp);
    assert.equal(scopeOf('POST', `/api/v1/projects/p1/${grp}`), 'member', grp);
    assert.equal(scopeOf('DELETE', `/api/v1/projects/p1/${grp}/x`), 'member', grp);
  }
  // secret-adjacent groups: GET=viewer, writes=member
  for (const grp of ['datasources', 'credentials', 'pipelines', 'models']) {
    assert.equal(scopeOf('GET', `/api/v1/projects/p1/${grp}`), 'viewer', grp);
    assert.equal(scopeOf('POST', `/api/v1/projects/p1/${grp}`), 'member', grp);
  }
  assert.equal(scopeOf('GET', '/api/v1/projects/p1/mcp-servers/m1'), 'viewer');
  assert.equal(scopeOf('GET', '/api/v1/projects/p1/providers'), 'viewer');
  // credentials/:id/secret-data → mesh-gated (unmapped at app layer)
  assert.equal(lane('POST', '/api/v1/projects/p1/credentials/c1/secret-data'), 'none');
  // sibling credentials ops stay member (UI manages credentials)
  assert.equal(scopeOf('POST', '/api/v1/projects/p1/credentials/c1/rotate'), 'member');
  // service-account (returns the client secret): admin on the user lane
  assert.equal(scopeOf('GET', '/api/v1/projects/p1/service-account'), 'admin');
  assert.equal(scopeOf('POST', '/api/v1/projects/p1/service-account'), 'admin');
  // workspace-templates: viewer reads, member writes (user-only)
  assert.equal(scopeOf('GET', '/api/v1/projects/p1/workspace-templates'), 'viewer');
  assert.equal(scopeOf('POST', '/api/v1/projects/p1/workspace-templates'), 'member');
});

test('global policy table: trailing-slash variants resolve to the same rule (no bypass)', () => {
  const scopeOf = (m: string, p: string) => {
    const pol = __testing.resolveGlobalPolicy(m, p);
    return pol && pol.user?.kind === 'project' ? pol.user.scope : '-';
  };
  assert.equal(scopeOf('GET', '/api/v1/projects/p1/'), 'viewer');
  assert.equal(scopeOf('PATCH', '/api/v1/projects/p1/'), 'member');
  assert.equal(scopeOf('DELETE', '/api/v1/projects/p1/'), 'admin');
  assert.equal(lane('GET', '/api/v1/projects/p1/'), 'project');
  // mesh-gated secret-data stays unmapped with a trailing slash
  assert.equal(lane('POST', '/api/v1/projects/p1/credentials/c1/secret-data/'), 'none');
  assert.equal(lane('GET', '/api/v1/projects/p1//'), 'project');
});

test('global guard: trailing slash on destructive DELETE still requires admin scope', async () => {
  const del = await request(globalApp(), 'DELETE', '/api/v1/projects/proj1/', {
    headers: { Authorization: `Bearer ${userToken(rptWith('proj1', ['member']))}` },
  });
  assert.equal(del.status, 403);
  assert.equal(del.body.code, 'scope_insufficient');
});

function globalApp() {
  const router = Router();
  router.all('*', (req, res) =>
    res.json({ ok: true, ctx: (req as any).agentStudioContext ?? null, user: (req as any).user ?? null }),
  );
  return buildApp({ basePath: '/', router, pre: [unifiedGuardGlobal()] });
}

test('global guard: public /health needs no creds → 200', async () => {
  const res = await request(globalApp(), 'GET', '/health');
  assert.equal(res.status, 200);
});

test('global guard: /swagger and its subpaths are public → 200', async () => {
  for (const p of ['/swagger', '/swagger/', '/swagger/ui', '/swagger.json']) {
    const res = await request(globalApp(), 'GET', p);
    assert.equal(res.status, 200, p);
  }
});

test('global guard: /swagger look-alike is NOT public → token-less passes (mesh JWT gate in prod)', async () => {
  const res = await request(globalApp(), 'GET', '/swaggerify');
  assert.equal(res.status, 200);
});

test('global guard: bare root / is NOT public → token-less passes (mesh JWT gate in prod)', async () => {
  const res = await request(globalApp(), 'GET', '/');
  assert.equal(res.status, 200);
});

test('global guard: token-less caller on /internal/users → 200 (mesh-gated path)', async () => {
  const res = await request(globalApp(), 'POST', '/api/v1/internal/users/resolve');
  assert.equal(res.status, 200);
});

test('global guard: token-less caller on a user-scoped router (workspaces) → 200', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/projects/p1/workspaces');
  assert.equal(res.status, 200);
});

test('global guard: user RPT member on dual datasets → 200, projectId resolved from path', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${userToken(rptWith('proj1', ['member']))}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

test('global guard: token-less caller on dual datasets → 200', async () => {
  const res = await request(globalApp(), 'PUT', '/api/v1/projects/proj1/datasets/d1/status', {
    body: { status: 'ready' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx, null);
});

test('global guard: no creds on a project route → 200 (mesh gates token-less callers)', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/projects/proj1/datasets');
  assert.equal(res.status, 200);
});

test('global guard: wrong-project RPT on datasets → 403 (path projectId is authoritative)', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: `Bearer ${userToken(rptWith('other', ['admin']))}` },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'context_project_id_missing');
});

test('global guard: unmapped route allows token-less callers (mesh JWT gate in prod)', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/totally-unknown');
  assert.equal(res.status, 200);
});

// ===================================================== per-endpoint granularity
test('global guard: viewer RPT can GET datasets but cannot POST (write needs member)', async () => {
  const viewer = `Bearer ${userToken(rptWith('proj1', ['viewer']))}`;
  const read = await request(globalApp(), 'GET', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: viewer },
  });
  assert.equal(read.status, 200);
  const write = await request(globalApp(), 'POST', '/api/v1/projects/proj1/datasets', {
    headers: { Authorization: viewer },
  });
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'scope_insufficient');
});

test('global guard: member RPT cannot read service-account (admin), token-less still passes', async () => {
  const member = `Bearer ${userToken(rptWith('proj1', ['member']))}`;
  const denied = await request(globalApp(), 'GET', '/api/v1/projects/proj1/service-account', {
    headers: { Authorization: member },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'scope_insufficient');
  const svc = await request(globalApp(), 'GET', '/api/v1/projects/proj1/service-account');
  assert.equal(svc.status, 200);
});

test('global guard: viewer RPT can GET secret-adjacent groups (datasources, credentials, mcp-servers)', async () => {
  const viewer = `Bearer ${userToken(rptWith('proj1', ['viewer']))}`;
  for (const path of [
    '/api/v1/projects/proj1/datasources',
    '/api/v1/projects/proj1/credentials',
    '/api/v1/projects/proj1/mcp-servers',
    '/api/v1/projects/proj1/providers',
  ]) {
    const res = await request(globalApp(), 'GET', path, { headers: { Authorization: viewer } });
    assert.equal(res.status, 200, path);
  }
});

test('global guard: credentials/:id/secret-data is mesh-gated — token-less passes, user falls back to context', async () => {
  const admin = `Bearer ${userToken(rptWith('proj1', ['admin']))}`;
  const user = await request(globalApp(), 'POST', '/api/v1/projects/proj1/credentials/c1/secret-data', {
    headers: { Authorization: admin },
  });
  // Unmapped at app layer → POL.ctx fallback (mesh DENY blocks JWT in prod).
  assert.equal(user.status, 200);
  const svc = await request(globalApp(), 'POST', '/api/v1/projects/proj1/credentials/c1/secret-data');
  assert.equal(svc.status, 200);
});

test('global guard: token-less caller can GET project root and project buckets', async () => {
  const proj = await request(globalApp(), 'GET', '/api/v1/projects/proj1');
  assert.equal(proj.status, 200);
  for (const [m, p] of [['POST', '/api/v1/projects/proj1/buckets'], ['GET', '/api/v1/projects/proj1/buckets/b1'], ['DELETE', '/api/v1/projects/proj1/buckets/b1']] as const) {
    const res = await request(globalApp(), m, p);
    assert.equal(res.status, 200, `${m} ${p}`);
  }
});

test('global guard: token-less GET mcp-servers passes; viewer cannot POST mcp-servers', async () => {
  const svc = await request(globalApp(), 'GET', '/api/v1/projects/proj1/mcp-servers/m1');
  assert.equal(svc.status, 200);
  const viewer = `Bearer ${userToken(rptWith('proj1', ['viewer']))}`;
  const svcWrite = await request(globalApp(), 'POST', '/api/v1/projects/proj1/mcp-servers', {
    headers: { Authorization: viewer },
  });
  assert.equal(svcWrite.status, 403);
  assert.equal(svcWrite.body.code, 'scope_insufficient');
});

test('global guard: a viewer can still GET project root (user lane unchanged)', async () => {
  const res = await request(globalApp(), 'GET', '/api/v1/projects/proj1', {
    headers: { Authorization: `Bearer ${userToken(rptWith('proj1', ['viewer']))}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ctx.project_id, 'proj1');
});

test('global guard: gateway/governance require the platform-member role', async () => {
  const plain = `Bearer ${userToken()}`;
  const denied = await request(globalApp(), 'GET', '/api/v1/gateway/providers', {
    headers: { Authorization: plain },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'role_insufficient');
  const pm = `Bearer ${userToken({ realm_access: { roles: ['platform-member'] } })}`;
  const ok = await request(globalApp(), 'GET', '/api/v1/gateway/providers', {
    headers: { Authorization: pm },
  });
  assert.equal(ok.status, 200);
});
