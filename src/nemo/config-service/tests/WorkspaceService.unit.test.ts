/**
 * Unit tests for services/WorkspaceService.ts.
 *
 * External seams are module-mocked before the service is loaded:
 *   - utils/s3Utils (ensureBucketExists)
 *   - utils/defaultBucket (isDefaultBucket, getProjectStorageRoot)
 *   - clients/WorkspaceOrchestratorClient (k8s orchestration)
 * The real WorkspaceTemplateService runs against the fake-repo seam.
 *
 * Run: node --require ts-node/register --test tests/WorkspaceService.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  installFakeRepositories,
  makeFakeRepo,
  makeQueryBuilder,
  type FakeDataSourceHandle,
} from './helpers/appDataSourceMock';
import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

let handle: FakeDataSourceHandle;
let scope: ReturnType<typeof restoreScope>;
let WorkspaceService: any;

// Controllable external-dependency state, reset per test.
let s3: { ensureBucketExists: ReturnType<typeof mock.fn>; isDefault: boolean };
let orchestrator: {
  launch: ReturnType<typeof mock.fn>;
  stop: ReturnType<typeof mock.fn>;
  del: ReturnType<typeof mock.fn>;
};

beforeEach(() => {
  handle = installFakeRepositories({});
  s3 = {
    ensureBucketExists: mock.fn(async () => undefined),
    isDefault: false,
  };
  orchestrator = {
    launch: mock.fn(async () => undefined),
    stop: mock.fn(async () => undefined),
    del: mock.fn(async () => undefined),
  };

  scope = restoreScope();
  scope.add(mockModule('utils/s3Utils', { ensureBucketExists: (b: string) => s3.ensureBucketExists(b) }));
  scope.add(
    mockModule('utils/defaultBucket', {
      isDefaultBucket: () => s3.isDefault,
      getProjectStorageRoot: () => ({ bucketName: 'proj-bucket', pathPrefix: 'projects/x' }),
      getDefaultBucketName: () => 'default-nemo',
    }),
  );
  scope.add(
    mockModule('clients/WorkspaceOrchestratorClient', {
      WorkspaceOrchestratorClient: class {
        launchWorkspace(req: any) {
          return orchestrator.launch(req);
        }
        stopWorkspace(req: any) {
          return orchestrator.stop(req);
        }
        deleteWorkspace(req: any) {
          return orchestrator.del(req);
        }
      },
    }),
  );
  WorkspaceService = loadFresh('services/WorkspaceService', ['services/WorkspaceTemplateService']).WorkspaceService;
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/WorkspaceService', 'services/WorkspaceTemplateService');
  handle.restore();
  mock.restoreAll();
});

const PROJECT = 'projtest0001';

function seedTemplate(overrides: Record<string, any>) {
  handle.repos.WorkspaceTemplate = makeFakeRepo(overrides);
}
function seedWorkspace(overrides: Record<string, any>) {
  handle.repos.Workspace = makeFakeRepo(overrides);
}

test('createWorkspace requires a projectId', async () => {
  await assert.rejects(WorkspaceService.createWorkspace('', { templateId: 't1' }), /projectId is required/);
});

test('createWorkspace rejects a template from another project', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: 'other', isActive: true }) });
  await assert.rejects(
    WorkspaceService.createWorkspace(PROJECT, { templateId: 't1', name: 'w' }),
    /Template does not belong/,
  );
});

test('createWorkspace rejects an inactive template', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, isActive: false }) });
  await assert.rejects(
    WorkspaceService.createWorkspace(PROJECT, { templateId: 't1', name: 'w' }),
    /Template is not active/,
  );
});

test('createWorkspace rejects a duplicate workspace name', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, isActive: true }) });
  seedWorkspace({ findOne: async () => ({ id: 'w1', name: 'w' }) });
  await assert.rejects(
    WorkspaceService.createWorkspace(PROJECT, { templateId: 't1', name: 'w' }),
    /already exists/,
  );
});

test('createWorkspace ensures a non-default bucket exists', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, isActive: true }) });
  seedWorkspace({ findOne: async () => null, create: (d: any) => ({ ...d, id: 'ws-1' }), save: async (e: any) => e });
  s3.isDefault = false;
  const ws = await WorkspaceService.createWorkspace(PROJECT, {
    templateId: 't1',
    name: 'w',
    bucketName: 'my-bucket',
  });
  assert.equal(ws.id, 'ws-1');
  assert.equal(s3.ensureBucketExists.mock.callCount(), 1);
});

test('createWorkspace skips bucket creation for the default bucket', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, isActive: true }) });
  seedWorkspace({ findOne: async () => null, create: (d: any) => ({ ...d }), save: async (e: any) => e });
  s3.isDefault = true;
  await WorkspaceService.createWorkspace(PROJECT, { templateId: 't1', name: 'w', bucketName: 'default-nemo' });
  assert.equal(s3.ensureBucketExists.mock.callCount(), 0);
});

test('createWorkspace derives the bucket from the project when not provided', async () => {
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, isActive: true }) });
  seedWorkspace({ findOne: async () => null, create: (d: any) => ({ ...d }), save: async (e: any) => e });
  handle.repos.Project = makeFakeRepo({ findOne: async () => ({ id: PROJECT, home_dir: 's3://proj-bucket/projects/x' }) });
  s3.isDefault = false;
  const ws = await WorkspaceService.createWorkspace(PROJECT, { templateId: 't1', name: 'w' });
  assert.equal(ws.bucketName, 'proj-bucket');
  assert.equal(s3.ensureBucketExists.mock.callCount(), 1);
});

test('getWorkspace returns the row', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1' }) });
  assert.equal((await WorkspaceService.getWorkspace('w1'))?.id, 'w1');
});

test('getWorkspaceOrThrow throws NotFoundError when missing', async () => {
  seedWorkspace({ findOne: async () => null });
  await assert.rejects(WorkspaceService.getWorkspaceOrThrow('w1', PROJECT), /not found/);
});

test('listWorkspaces requires a projectId and supports status filter', async () => {
  await assert.rejects(WorkspaceService.listWorkspaces(''), /projectId is required/);
  const find = mock.fn(async (_opts?: any) => [{ id: 'w1' }]);
  seedWorkspace({ find });
  await WorkspaceService.listWorkspaces(PROJECT, 'running');
  assert.equal((find.mock.calls[0].arguments[0] as any).where.status, 'running');
});

test('queryWorkspacesForManagement builds a query with filters', async () => {
  seedWorkspace({ createQueryBuilder: () => makeQueryBuilder({ many: [{ id: 'w1' }] }) });
  const rows = await WorkspaceService.queryWorkspacesForManagement({
    status: ['running'],
    deploymentId: 'nemo',
  });
  assert.equal(rows[0].id, 'w1');
});

test('queryWorkspacesForManagement supports deploymentType fallback', async () => {
  seedWorkspace({ createQueryBuilder: () => makeQueryBuilder({ many: [] }) });
  const rows = await WorkspaceService.queryWorkspacesForManagement({ deploymentType: 'nemo' });
  assert.deepEqual(rows, []);
});

test('updateWorkspace throws NotFoundError when missing', async () => {
  seedWorkspace({ findOne: async () => null });
  await assert.rejects(WorkspaceService.updateWorkspace('w1', PROJECT, { name: 'x' }), /not found/);
});

test('updateWorkspace blocks a name change while running', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', name: 'old', status: 'running' }) });
  await assert.rejects(
    WorkspaceService.updateWorkspace('w1', PROJECT, { name: 'new' }),
    /Cannot change workspace name while/,
  );
});

test('updateWorkspace rejects a duplicate name', async () => {
  let call = 0;
  seedWorkspace({
    findOne: async () => {
      call += 1;
      return call === 1 ? { id: 'w1', name: 'old', status: 'stopped' } : { id: 'w2', name: 'new' };
    },
    save: async (e: any) => e,
  });
  await assert.rejects(
    WorkspaceService.updateWorkspace('w1', PROJECT, { name: 'new' }),
    /already exists/,
  );
});

test('updateWorkspace stores resources in metadata', async () => {
  seedWorkspace({
    findOne: async () => ({ id: 'w1', name: 'w', status: 'stopped', metadata: undefined }),
    save: async (e: any) => e,
  });
  const ws = await WorkspaceService.updateWorkspace('w1', PROJECT, {
    description: 'd',
    resources: { cpu: '4' },
  });
  assert.deepEqual(ws.metadata.resources, { cpu: '4' });
});

test('deleteWorkspace throws NotFoundError when missing', async () => {
  seedWorkspace({ findOne: async () => null });
  await assert.rejects(WorkspaceService.deleteWorkspace('w1', PROJECT), /not found/);
});

test('deleteWorkspace blocks deletion of a running workspace', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'running' }) });
  await assert.rejects(WorkspaceService.deleteWorkspace('w1', PROJECT), /Cannot delete workspace while it is running/);
});

test('deleteWorkspace removes the workspace and best-effort cleans up resources', async () => {
  const remove = mock.fn(async (e: any) => e);
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopped' }), remove });
  await WorkspaceService.deleteWorkspace('w1', PROJECT);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(orchestrator.del.mock.callCount(), 1);
});

test('deleteWorkspace still removes the row when orchestrator cleanup fails', async () => {
  mock.method(console, 'error', () => undefined);
  orchestrator.del = mock.fn(async () => {
    throw new Error('k8s down');
  });
  const remove = mock.fn(async (e: any) => e);
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopped' }), remove });
  await WorkspaceService.deleteWorkspace('w1', PROJECT);
  assert.equal(remove.mock.callCount(), 1);
});

test('launchWorkspace rejects when already running', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'running' }) });
  await assert.rejects(WorkspaceService.launchWorkspace('w1', PROJECT), /already running/);
});

test('launchWorkspace rejects from creating/stopping states', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'creating' }) });
  await assert.rejects(WorkspaceService.launchWorkspace('w1', PROJECT), /currently being created/);

  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopping' }) });
  await assert.rejects(WorkspaceService.launchWorkspace('w1', PROJECT), /currently stopping/);
});

test('launchWorkspace launches from a stopped workspace', async () => {
  seedWorkspace({
    findOne: async () => ({ id: 'w1', status: 'stopped', templateId: 't1', metadata: {}, bucketName: 'b' }),
    save: async (e: any) => e,
  });
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, type: 'jupyterlab', resources: {} }) });
  const ws = await WorkspaceService.launchWorkspace('w1', PROJECT);
  assert.equal(ws.status, 'creating');
  assert.equal(orchestrator.launch.mock.callCount(), 1);
});

test('launchWorkspace marks the workspace errored when the orchestrator fails', async () => {
  orchestrator.launch = mock.fn(async () => {
    throw new Error('launch failed');
  });
  let lastSaved: any = null;
  seedWorkspace({
    findOne: async () => ({ id: 'w1', status: 'new', templateId: 't1', metadata: {} }),
    save: async (e: any) => {
      lastSaved = e;
      return e;
    },
  });
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: PROJECT, type: 'jupyterlab', resources: {} }) });
  await assert.rejects(WorkspaceService.launchWorkspace('w1', PROJECT), /launch failed/);
  assert.equal(lastSaved.status, 'error');
  assert.equal(lastSaved.metadata.errorMessage, 'launch failed');
});

test('launchWorkspace rejects when the template belongs to another project', async () => {
  seedWorkspace({
    findOne: async () => ({ id: 'w1', status: 'new', templateId: 't1', metadata: {} }),
    save: async (e: any) => e,
  });
  seedTemplate({ findOne: async () => ({ id: 't1', projectId: 'other', type: 'jupyterlab', resources: {} }) });
  await assert.rejects(WorkspaceService.launchWorkspace('w1', PROJECT), /Template does not belong/);
});

test('stopWorkspace returns immediately when already stopped', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopped' }) });
  const ws = await WorkspaceService.stopWorkspace('w1', PROJECT);
  assert.equal(ws.status, 'stopped');
  assert.equal(orchestrator.stop.mock.callCount(), 0);
});

test('stopWorkspace rejects when already stopping or not running', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopping' }) });
  await assert.rejects(WorkspaceService.stopWorkspace('w1', PROJECT), /already stopping/);

  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'new' }) });
  await assert.rejects(WorkspaceService.stopWorkspace('w1', PROJECT), /Cannot stop workspace from status/);
});

test('stopWorkspace transitions a running workspace to stopping', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'running', metadata: {} }), save: async (e: any) => e });
  const ws = await WorkspaceService.stopWorkspace('w1', PROJECT);
  assert.equal(ws.status, 'stopping');
  assert.equal(orchestrator.stop.mock.callCount(), 1);
});

test('stopWorkspace marks errored when the orchestrator fails', async () => {
  orchestrator.stop = mock.fn(async () => {
    throw new Error('stop failed');
  });
  let lastSaved: any = null;
  seedWorkspace({
    findOne: async () => ({ id: 'w1', status: 'running', metadata: {} }),
    save: async (e: any) => {
      lastSaved = e;
      return e;
    },
  });
  await assert.rejects(WorkspaceService.stopWorkspace('w1', PROJECT), /stop failed/);
  assert.equal(lastSaved.status, 'error');
});

test('updateWorkspaceToken throws NotFoundError when missing', async () => {
  seedWorkspace({ findOne: async () => null });
  await assert.rejects(WorkspaceService.updateWorkspaceToken('w1', PROJECT, 'tok'), /not found/);
});

test('updateWorkspaceToken stores the token in metadata', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', metadata: { a: 1 } }), save: async (e: any) => e });
  const ws = await WorkspaceService.updateWorkspaceToken('w1', PROJECT, 'tok-123');
  assert.equal(ws.metadata.jupyterToken, 'tok-123');
});

test('updateWorkspaceStatus transitions to running and sets endpoint metadata', async () => {
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'creating', metadata: {} }), save: async (e: any) => e });
  const ws = await WorkspaceService.updateWorkspaceStatus('w1', PROJECT, 'running', {
    podName: 'pod-1',
    endpoint: 'http://x',
  });
  assert.equal(ws.status, 'running');
  assert.equal(ws.metadata.libraryInstallStatus, 'completed');
  assert.equal(ws.deploymentId, 'workspace-svc-w1');
});

test('updateWorkspaceStatus clears fields when stopped', async () => {
  seedWorkspace({
    findOne: async () => ({ id: 'w1', status: 'stopping', endpoint: 'http://x', podName: 'p', metadata: { jupyterToken: 't' } }),
    save: async (e: any) => e,
  });
  const ws = await WorkspaceService.updateWorkspaceStatus('w1', PROJECT, 'stopped');
  assert.equal(ws.endpoint, undefined);
  assert.equal(ws.metadata.jupyterToken, undefined);
});

test('updateWorkspaceStatus records error messages and logs invalid transitions', async () => {
  mock.method(console, 'warn', () => undefined);
  seedWorkspace({ findOne: async () => ({ id: 'w1', status: 'stopped', metadata: undefined }), save: async (e: any) => e });
  const ws = await WorkspaceService.updateWorkspaceStatus('w1', PROJECT, 'error', { errorMessage: 'boom' });
  assert.equal(ws.status, 'error');
  assert.equal(ws.metadata.errorMessage, 'boom');
});
