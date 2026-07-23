/**
 * Route-handler tests for several small routers mounted in real express apps:
 *   - routes/catalogRoutes.ts          (/api/v1/mcp-server-catalog)  — real static catalog
 *   - routes/explorerRoutes.ts         (/api/v1/explorer)            — ProviderCatalogService mocked
 *   - routes/internalWorkspaceRoutes.ts(/api/v1/internal/workspaces) — WorkspaceService mocked
 *   - routes/setupRoutes.ts            (/api/v1/setup)               — KeycloakClientService mocked
 *
 * Run: node --require ts-node/register --test tests/smallRoutes.routes.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeRepositories, type FakeDataSourceHandle } from './helpers/appDataSourceMock';
import { buildApp, request } from './helpers/httpApp';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';
import { NotFoundError } from '../utils/errors';
import catalogRouter from '../routes/catalogRoutes';
import type { Express } from 'express';

// ─── Shared mutable state for the mocked services ───────────────────────────
const PROVIDERS = [
  { id: 'aws', label: 'AWS', scopes: ['account', 'resource'], supportedActions: [] },
  { id: 'gcp', label: 'GCP', scopes: ['account'], supportedActions: [] },
];

let keycloakState: { realmExists: boolean | Error; userCount: number };

class FakeKeycloakClientService {
  async realmExists(): Promise<boolean> {
    if (keycloakState.realmExists instanceof Error) throw keycloakState.realmExists;
    return keycloakState.realmExists;
  }
  async getUserCount(): Promise<number> {
    return keycloakState.userCount;
  }
  getAdminCredentials(): { username: string; password: string } {
    return { username: 'admin', password: 'secretpw' };
  }
}

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let catalogApp: Express;
let explorerApp: Express;
let internalWsApp: Express;
let setupApp: Express;

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  keycloakState = { realmExists: false, userCount: 0 };

  scope.add(
    mockModule('services/ProviderCatalogService', {
      getAllProviders: () => PROVIDERS,
      getProvider: (id: string) => PROVIDERS.find((p) => p.id === id),
    }),
  );
  scope.add(
    mockModule('services/WorkspaceService', {
      WorkspaceService: {
        updateWorkspaceStatus: async (id: string, projectId: string, status: string, resources: any) => {
          if (id === 'missing') throw new NotFoundError('Workspace', id);
          return { id, projectId, status, ...resources };
        },
      },
    }),
  );
  scope.add(
    mockModule('services/KeycloakClientService', { KeycloakClientService: FakeKeycloakClientService }),
  );

  catalogApp = buildApp({ basePath: '/api/v1/mcp-server-catalog', router: catalogRouter });
  explorerApp = buildApp({ basePath: '/api/v1/explorer', router: loadFresh('routes/explorerRoutes').default });
  internalWsApp = buildApp({
    basePath: '/api/v1/internal/workspaces',
    router: loadFresh('routes/internalWorkspaceRoutes').default,
  });
  setupApp = buildApp({ basePath: '/api/v1/setup', router: loadFresh('routes/setupRoutes').default });
});

afterEach(() => {
  scope.restoreAll();
  clearModule('routes/explorerRoutes', 'routes/internalWorkspaceRoutes', 'routes/setupRoutes');
  handle.restore();
});

// ─── catalogRoutes ──────────────────────────────────────────────────────────

test('GET /mcp-server-catalog: returns resolved catalog entries (200)', async () => {
  const res = await request(catalogApp, 'GET', '/api/v1/mcp-server-catalog');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.length > 0);
  const entry = res.body[0];
  assert.ok(typeof entry.id === 'string');
  assert.ok(typeof entry.name === 'string');
  assert.ok(Array.isArray(entry.envSchema));
  // defaultEnvFn is stripped from the response shape.
  assert.equal(entry.defaultEnvFn, undefined);
});

// ─── explorerRoutes ─────────────────────────────────────────────────────────

test('GET /explorer/providers: returns provider list (200)', async () => {
  const res = await request(explorerApp, 'GET', '/api/v1/explorer/providers');
  assert.equal(res.status, 200);
  assert.equal(res.body.providers.length, 2);
  assert.equal(res.body.providers[0].id, 'aws');
});

test('GET /explorer/providers/:id: found 200, missing 404', async () => {
  const ok = await request(explorerApp, 'GET', '/api/v1/explorer/providers/aws');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'aws');

  const missing = await request(explorerApp, 'GET', '/api/v1/explorer/providers/nope');
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /not found/i);
});

test('GET /explorer/providers: catalog failure -> 500 with fallback message', async () => {
  scope.add(
    mockModule('services/ProviderCatalogService', {
      getAllProviders: () => {
        throw new Error('catalog offline');
      },
      getProvider: () => null,
    }),
  );
  clearModule('routes/explorerRoutes');
  const app = buildApp({
    basePath: '/api/v1/explorer',
    router: loadFresh('routes/explorerRoutes').default,
  });
  const res = await request(app, 'GET', '/api/v1/explorer/providers');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'catalog offline');
});

test('GET /explorer/providers/:id: provider lookup failure -> 500 with default message', async () => {
  scope.add(
    mockModule('services/ProviderCatalogService', {
      getAllProviders: () => PROVIDERS,
      getProvider: () => {
        throw Object.assign(new Error(''), { message: '' });
      },
    }),
  );
  clearModule('routes/explorerRoutes');
  const app = buildApp({
    basePath: '/api/v1/explorer',
    router: loadFresh('routes/explorerRoutes').default,
  });
  const res = await request(app, 'GET', '/api/v1/explorer/providers/aws');
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'Failed to load provider');
});

// ─── internalWorkspaceRoutes ────────────────────────────────────────────────

test('PUT /internal/workspaces/:id/status: updates 200', async () => {
  const res = await request(internalWsApp, 'PUT', '/api/v1/internal/workspaces/ws000001/status?projectId=p1', {
    body: { status: 'running', podName: 'pod-1', endpoint: 'http://x' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'running');
  assert.equal(res.body.podName, 'pod-1');
});

test('PUT /internal/workspaces/:id/status: missing projectId -> 400', async () => {
  const res = await request(internalWsApp, 'PUT', '/api/v1/internal/workspaces/ws000001/status', {
    body: { status: 'running' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /required/i);
});

test('PUT /internal/workspaces/:id/status: invalid status -> 400', async () => {
  const res = await request(internalWsApp, 'PUT', '/api/v1/internal/workspaces/ws000001/status?projectId=p1', {
    body: { status: 'bogus' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /Invalid status/i);
});

test('PUT /internal/workspaces/:id/status: workspace not found -> 404', async () => {
  const res = await request(internalWsApp, 'PUT', '/api/v1/internal/workspaces/missing/status?projectId=p1', {
    body: { status: 'running' },
  });
  assert.equal(res.status, 404);
});

// ─── setupRoutes ────────────────────────────────────────────────────────────

test('GET /setup/status: realm missing -> isSetupComplete false (200)', async () => {
  const res = await request(setupApp, 'GET', '/api/v1/setup/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.isSetupComplete, false);
  assert.equal(res.body.realmName, 'nemo');
  assert.equal(res.body.adminCredentials.username, 'admin');
  assert.ok(typeof res.body.adminConsoleUrl === 'string');
});

test('GET /setup/status: realm exists with users -> isSetupComplete true (200)', async () => {
  keycloakState.realmExists = true;
  keycloakState.userCount = 3;
  const res = await request(setupApp, 'GET', '/api/v1/setup/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.isSetupComplete, true);
  assert.equal(res.body.userCount, 3);
});

test('GET /setup/status: keycloak unavailable -> safe 200 with error', async () => {
  keycloakState.realmExists = new Error('connection refused');
  const res = await request(setupApp, 'GET', '/api/v1/setup/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.isSetupComplete, false);
  assert.match(String(res.body.error), /Unable to check setup status/i);
});
