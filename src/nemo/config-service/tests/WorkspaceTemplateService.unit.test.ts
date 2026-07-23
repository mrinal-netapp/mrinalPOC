/**
 * Unit tests for services/WorkspaceTemplateService.ts. Pure AppDataSource
 * access via the fake-repo seam (no DB/network).
 *
 * Run: node --require ts-node/register --test tests/WorkspaceTemplateService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { WorkspaceTemplateService } from '../services/WorkspaceTemplateService';
import {
  installFakeRepositories,
  makeFakeRepo,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';

const PROJECT = 'projtest0001';
let handle: FakeDataSourceHandle;

beforeEach(() => {
  handle = installFakeRepositories({});
});
afterEach(() => {
  handle.restore();
  mock.restoreAll();
});

function seedTemplate(overrides: Record<string, any>) {
  handle.repos.WorkspaceTemplate = makeFakeRepo(overrides);
}

test('seedDefaultTemplates creates the default when none exists', async () => {
  mock.method(console, 'log', () => undefined);
  let saved: any = null;
  seedTemplate({
    findOne: async () => null,
    create: (d: any) => ({ ...d }),
    save: async (e: any) => {
      saved = e;
      return e;
    },
  });
  await WorkspaceTemplateService.seedDefaultTemplates(PROJECT);
  assert.equal(saved.name, 'JupyterLab');
  assert.equal(saved.isActive, true);
});

test('seedDefaultTemplates is idempotent when the template already exists', async () => {
  const save = mock.fn(async (e: any) => e);
  seedTemplate({ findOne: async () => ({ id: 't1', name: 'JupyterLab' }), save });
  await WorkspaceTemplateService.seedDefaultTemplates(PROJECT);
  assert.equal(save.mock.callCount(), 0);
});

test('createTemplate rejects a missing projectId', async () => {
  await assert.rejects(
    WorkspaceTemplateService.createTemplate('', { name: 'x' } as any),
    /projectId is required/,
  );
});

test('createTemplate rejects a duplicate name with ConflictError', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', name: 'dup' }) });
  await assert.rejects(
    WorkspaceTemplateService.createTemplate(PROJECT, { name: 'dup', environment: {} } as any),
    /already exists/,
  );
});

test('createTemplate requires an environment', async () => {
  seedTemplate({ findOne: async () => null });
  await assert.rejects(
    WorkspaceTemplateService.createTemplate(PROJECT, { name: 'x' } as any),
    /environment is required/,
  );
});

test('createTemplate persists a valid template', async () => {
  seedTemplate({
    findOne: async () => null,
    create: (d: any) => ({ ...d, id: 'tmpl-1' }),
    save: async (e: any) => e,
  });
  const t = await WorkspaceTemplateService.createTemplate(PROJECT, {
    name: 'New',
    description: 'd',
    type: 'jupyterlab',
    environment: { baseImage: 'img' },
  } as any);
  assert.equal(t.id, 'tmpl-1');
  assert.equal(t.isActive, true);
});

test('getTemplate returns the row from findOne', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1' }) });
  assert.equal((await WorkspaceTemplateService.getTemplate('t1'))?.id, 't1');
});

test('getTemplateOrThrow throws NotFoundError when missing', async () => {
  seedTemplate({ findOne: async () => null });
  await assert.rejects(WorkspaceTemplateService.getTemplateOrThrow('missing'), /not found/);
});

test('getTemplateOrThrow returns the template when present', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1' }) });
  assert.equal((await WorkspaceTemplateService.getTemplateOrThrow('t1')).id, 't1');
});

test('listTemplates requires a projectId', async () => {
  await assert.rejects(WorkspaceTemplateService.listTemplates(''), /projectId is required/);
});

test('listTemplates returns active templates', async () => {
  const rows = [{ id: 't1' }, { id: 't2' }];
  seedTemplate({ find: async () => rows });
  assert.deepEqual(await WorkspaceTemplateService.listTemplates(PROJECT), rows);
});

test('listTemplates can include inactive templates', async () => {
  const find = mock.fn(async (_opts?: any) => [{ id: 't1' }]);
  seedTemplate({ find });
  await WorkspaceTemplateService.listTemplates(PROJECT, false);
  const arg = find.mock.calls[0].arguments[0] as any;
  assert.equal(arg.where.isActive, undefined);
});

test('updateTemplate throws NotFoundError for a missing template', async () => {
  seedTemplate({ findOne: async () => null });
  await assert.rejects(
    WorkspaceTemplateService.updateTemplate('missing', PROJECT, { name: 'x' }),
    /not found/,
  );
});

test('updateTemplate rejects a duplicate name', async () => {
  let call = 0;
  seedTemplate({
    findOne: async () => {
      call += 1;
      // First lookup returns the template, second (dup check) returns a clash.
      return call === 1 ? { id: 't1', name: 'old' } : { id: 't2', name: 'new' };
    },
    save: async (e: any) => e,
  });
  await assert.rejects(
    WorkspaceTemplateService.updateTemplate('t1', PROJECT, { name: 'new' }),
    /already exists/,
  );
});

test('updateTemplate applies updates and saves', async () => {
  seedTemplate({
    findOne: async () => ({ id: 't1', name: 'old', description: 'd' }),
    save: async (e: any) => e,
  });
  const t = await WorkspaceTemplateService.updateTemplate('t1', PROJECT, { description: 'new' });
  assert.equal(t.description, 'new');
});

test('deleteTemplate throws NotFoundError for a missing template', async () => {
  seedTemplate({ findOne: async () => null });
  await assert.rejects(WorkspaceTemplateService.deleteTemplate('missing', PROJECT), /not found/);
});

test('deleteTemplate refuses when workspaces still use the template', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1' }), save: async (e: any) => e });
  handle.repos.Workspace = makeFakeRepo({ count: async () => 2 });
  await assert.rejects(
    WorkspaceTemplateService.deleteTemplate('t1', PROJECT),
    /Cannot delete template: 2 workspace/,
  );
});

test('deleteTemplate soft-deletes when unused', async () => {
  let saved: any = null;
  seedTemplate({
    findOne: async () => ({ id: 't1', isActive: true }),
    save: async (e: any) => {
      saved = e;
      return e;
    },
  });
  handle.repos.Workspace = makeFakeRepo({ count: async () => 0 });
  await WorkspaceTemplateService.deleteTemplate('t1', PROJECT);
  assert.equal(saved.isActive, false);
});
