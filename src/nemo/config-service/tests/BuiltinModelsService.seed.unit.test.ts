/**
 * Unit tests for BuiltinModelsService seeding and gateway registration seams.
 *
 * Run: node --require ts-node/register --test tests/BuiltinModelsService.seed.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { AppDataSource } from '../db/postgres';
import {
  BuiltinModelsService,
  builtinGatewayProviderName,
} from '../services/BuiltinModelsService';
import { BUILTIN_EMBEDDING_MODELS } from '../services/BuiltinModels';
import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, clearModule, restoreScope, loadFresh } from './helpers/moduleMock';

const PROJECT = 'projtest0001';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;

beforeEach(() => {
  handle = installFakeRepositories({});
  scope = restoreScope();
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({ isEnabled: () => false }),
    }),
  );
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/BuiltinModelsService');
  handle.restore();
});

test('builtinGatewayProviderName prefixes tei service name', () => {
  assert.equal(builtinGatewayProviderName('tei-minilm'), 'as-tei-minilm');
});

test('seedBuiltinsForProject: inserts one row per catalog entry', async () => {
  handle.query.mock.mockImplementation(async () =>
    Array.from({ length: BUILTIN_EMBEDDING_MODELS.length }, (_, i) => ({ id: `mdl-${i}` })),
  );
  const svc = new BuiltinModelsService(AppDataSource);
  const inserted = await svc.seedBuiltinsForProject(PROJECT);
  assert.equal(inserted, BUILTIN_EMBEDDING_MODELS.length);
  assert.ok(handle.query.mock.calls.length > 0);
  const sql = String(handle.query.mock.calls[0].arguments[0]);
  assert.match(sql, /INSERT INTO models/i);
  assert.match(sql, /ON CONFLICT/i);
});

test('seedBuiltinsForProject: returns 0 for empty catalog', async () => {
  const svc = new BuiltinModelsService(AppDataSource, []);
  assert.equal(await svc.seedBuiltinsForProject(PROJECT), 0);
});

test('registerBuiltinsWithGatewayForProject: no-op when gateway disabled', async () => {
  const svc = new BuiltinModelsService(AppDataSource, []);
  await svc.registerBuiltinsWithGatewayForProject(PROJECT);
  assert.equal(handle.query.mock.calls.length, 0);
});

test('ensureBuiltinsForAllProjects: walks projects with bounded concurrency', async () => {
  handle.repos.Project = makeFakeRepo({
    find: async () => [{ id: 'p1' }, { id: 'p2' }],
  });
  const svc = new BuiltinModelsService(AppDataSource, []);
  await svc.ensureBuiltinsForAllProjects();
  // seedBuiltinsForProject with empty catalog is a no-op per project.
  assert.equal(handle.query.mock.calls.length, 0);
});

test('ensureBuiltinsForAllProjects: no-op when there are no projects', async () => {
  handle.repos.Project = makeFakeRepo({ find: async () => [] });
  const svc = new BuiltinModelsService(AppDataSource, []);
  await svc.ensureBuiltinsForAllProjects();
  assert.equal(handle.query.mock.calls.length, 0);
});

test('backfillKnowledgeBaseEmbeddingModelId: skips when no pending rows', async () => {
  handle.query.mock.mockImplementation(async (sql: string) => {
    if (/SELECT 1 FROM knowledge_bases/.test(sql)) return [];
    return [];
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillKnowledgeBaseEmbeddingModelId();
  assert.equal(
    handle.query.mock.calls.filter((c) => /UPDATE knowledge_bases/.test(String(c.arguments[0]))).length,
    0,
  );
});

test('backfillKnowledgeBaseEmbeddingModelId: updates rows when pending exist', async () => {
  handle.query.mock.mockImplementation(async (sql: string) => {
    if (/SELECT 1 FROM knowledge_bases/.test(sql)) return [{ '?column?': 1 }];
    if (/UPDATE knowledge_bases/.test(sql)) return [{ id: 'kb-1' }, { id: 'kb-2' }];
    return [];
  });
  const svc = new BuiltinModelsService(AppDataSource);
  await svc.backfillKnowledgeBaseEmbeddingModelId();
  assert.ok(
    handle.query.mock.calls.some((c) => /UPDATE knowledge_bases/.test(String(c.arguments[0]))),
  );
});

test('registerBuiltinsWithGatewayForProject: registers models and assigns VK bindings', async () => {
  const catalog = BUILTIN_EMBEDDING_MODELS.slice(0, 1);
  let assignCalled = false;
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({
        isEnabled: () => true,
        addModel: async () => ({
          gatewayProvider: 'as-tei-minilm',
          gatewayBindingName: 'sentence-transformers__all-MiniLM-L6-v2',
          keyName: 'as-tei-minilm-key',
          keyId: 'key-1',
          bifrostTeamId: 'team-1',
          bifrostVirtualKeyId: 'vk-1',
        }),
      }),
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      assignBuiltinModelsToProjectVirtualKey: async () => {
        assignCalled = true;
      },
    }),
  );
  clearModule('services/BuiltinModelsService');
  handle.repos.Model = makeFakeRepo({
    update: async () => ({ affected: 1 }),
  });
  const { BuiltinModelsService: FreshSvc } = loadFresh<typeof import('../services/BuiltinModelsService')>(
    'services/BuiltinModelsService',
  );
  const svc = new FreshSvc(AppDataSource, catalog);
  await svc.registerBuiltinsWithGatewayForProject(PROJECT);
  assert.equal(assignCalled, true);
});

test('ensureBuiltinsForAllProjects: seeds rows and tolerates per-project failures', async () => {
  const catalog = BUILTIN_EMBEDDING_MODELS.slice(0, 1);
  handle.repos.Project = makeFakeRepo({
    find: async () => [{ id: 'p1' }, { id: 'p2' }],
  });
  let queryCount = 0;
  handle.query.mock.mockImplementation(async (sql: string) => {
    if (/INSERT INTO models/.test(sql)) {
      queryCount += 1;
      return [{ id: `mdl-${queryCount}` }];
    }
    return [];
  });
  scope.add(
    mockModule('services/gatewayClient', {
      getLLMGatewayClient: () => ({
        isEnabled: () => true,
        addModel: async () => {
          if (queryCount > 1) throw new Error('gateway down');
          return {
            gatewayProvider: 'as-tei-minilm',
            gatewayBindingName: 'sentence-transformers__all-MiniLM-L6-v2',
            keyName: 'k1',
            keyId: 'key-1',
          };
        },
      }),
    }),
  );
  scope.add(
    mockModule('services/bifrost/bifrostProjectGovernance', {
      assignBuiltinModelsToProjectVirtualKey: async () => undefined,
    }),
  );
  clearModule('services/BuiltinModelsService');
  handle.repos.Model = makeFakeRepo({ update: async () => ({ affected: 1 }) });
  const { BuiltinModelsService: FreshSvc } = loadFresh<typeof import('../services/BuiltinModelsService')>(
    'services/BuiltinModelsService',
  );
  const svc = new FreshSvc(AppDataSource, catalog);
  await svc.ensureBuiltinsForAllProjects();
  assert.ok(queryCount >= 2);
});
