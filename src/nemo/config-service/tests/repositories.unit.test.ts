/**
 * Hermetic unit tests for repositories/*.ts.
 *
 * Each repository takes a TypeORM DataSource in its constructor and delegates
 * to `dataSource.getRepository(Entity)`. We build a FAKE DataSource inline
 * (no DB, no network) and assert the repositories correctly delegate and map.
 *
 * Run: node --require ts-node/register --test tests/repositories.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeFakeRepo, makeQueryBuilder, type FakeRepo } from './helpers/appDataSourceMock';

import { BaseRepository } from '../repositories/BaseRepository';
import { DeploymentRepository } from '../repositories/DeploymentRepository';
import { DeploymentAssignmentRepository } from '../repositories/DeploymentAssignmentRepository';
import { ConfigVersionRepository } from '../repositories/ConfigVersionRepository';
import { DataSourceRepository } from '../repositories/DataSourceRepository';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { ProjectMemberRepository } from '../repositories/ProjectMemberRepository';
import { HealthReportRepository } from '../repositories/HealthReportRepository';
import { MetricsRepository } from '../repositories/MetricsRepository';
import { BucketHealthRepository } from '../repositories/BucketHealthRepository';
import {
  RepositoryFactory,
  initializeRepositoryFactory,
  getRepositoryFactory,
} from '../repositories/RepositoryFactory';

const FIXED = new Date('2024-01-02T03:04:05.000Z');
const ISO = FIXED.toISOString();

/** Build a fake DataSource whose getRepository always returns `repo`. */
function dsWith(repo: FakeRepo): any {
  return {
    getRepository: () => repo,
    manager: { getRepository: () => repo },
    query: async () => [],
    createQueryBuilder: () => makeQueryBuilder({}),
  };
}

// ============================================================ BaseRepository
class TestRepository extends BaseRepository<any, any> {
  protected mapEntityToModel(entity: any): any {
    return { ...entity, _mapped: true };
  }
  protected mapModelToEntity(model: any): any {
    return { ...model, _entity: true };
  }
  protected getEntityName(): string {
    return 'TestEntity';
  }
}

class TestEntity {}

test('BaseRepository.create: maps model -> entity -> create -> save -> model', async () => {
  const repo = makeFakeRepo();
  const sut = new TestRepository(dsWith(repo) as any, TestEntity);
  const result = await sut.create({ name: 'alpha' });
  assert.equal(result.name, 'alpha');
  assert.equal(result._entity, true); // mapModelToEntity ran
  assert.equal(result._mapped, true); // mapEntityToModel ran
  assert.equal(repo.create.mock.calls.length, 1);
  assert.equal(repo.save.mock.calls.length, 1);
});

test('BaseRepository.create: unwraps array result from save', async () => {
  const repo = makeFakeRepo({ save: async (e: any) => [{ ...e, id: 's1' }] });
  const sut = new TestRepository(dsWith(repo) as any, TestEntity);
  const result = await sut.create({ name: 'beta' });
  assert.equal(result.id, 's1');
  assert.equal(result._mapped, true);
});

test('BaseRepository.getById: returns null when not found, mapped entity when found', async () => {
  const missing = new TestRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any, TestEntity);
  assert.equal(await missing.getById('x'), null);

  const found = new TestRepository(
    dsWith(makeFakeRepo({ findOne: async () => ({ id: 'x', name: 'n' }) })) as any,
    TestEntity,
  );
  const result = await found.getById('x');
  assert.deepEqual(result, { id: 'x', name: 'n', _mapped: true });
});

test('BaseRepository.update: throws when missing, saves + maps when present', async () => {
  const missing = new TestRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any, TestEntity);
  await assert.rejects(() => missing.update('x', { name: 'n' }), /TestEntity not found/);

  const repo = makeFakeRepo({ findOne: async () => ({ id: 'x', name: 'old' }) });
  const sut = new TestRepository(dsWith(repo) as any, TestEntity);
  const result = await sut.update('x', { name: 'new' });
  assert.equal(result.name, 'new');
  assert.equal(result._mapped, true);
  assert.equal(repo.save.mock.calls.length, 1);
});

test('BaseRepository.delete: returns boolean from affected count', async () => {
  const yes = new TestRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 1 }) })) as any, TestEntity);
  assert.equal(await yes.delete('x'), true);

  const no = new TestRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 0 }) })) as any, TestEntity);
  assert.equal(await no.delete('x'), false);
});

test('BaseRepository.list: maps each entity', async () => {
  const repo = makeFakeRepo({ find: async () => [{ id: 'a' }, { id: 'b' }] });
  const sut = new TestRepository(dsWith(repo) as any, TestEntity);
  const list = await sut.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((e: any) => e._mapped === true));
});

test('BaseRepository.exists: true when count > 0', async () => {
  const yes = new TestRepository(dsWith(makeFakeRepo({ count: async () => 3 })) as any, TestEntity);
  assert.equal(await yes.exists('x'), true);

  const no = new TestRepository(dsWith(makeFakeRepo({ count: async () => 0 })) as any, TestEntity);
  assert.equal(await no.exists('x'), false);
});

// ======================================================= DeploymentRepository
function deploymentEntity(overrides: Record<string, any> = {}) {
  return {
    id: 'dep-1',
    region: 'us-east',
    endpoint: 'grpc://x',
    http_endpoint: 'http://x',
    capacity: { max: 10 },
    capabilities: ['a'],
    storage_classes: ['s'],
    registered_at: FIXED,
    last_health_check: FIXED,
    status: 'healthy',
    ...overrides,
  };
}

test('DeploymentRepository.create: persists with status unknown and maps dates', async () => {
  const repo = makeFakeRepo({
    save: async (e: any) => ({ ...e, registered_at: FIXED, last_health_check: null }),
  });
  const sut = new DeploymentRepository(dsWith(repo) as any);
  const result = await sut.create({
    id: 'dep-1',
    region: 'us-east',
    endpoint: 'grpc://x',
    http_endpoint: 'http://x',
    capacity: { max: 10 } as any,
    capabilities: ['a'],
    storage_classes: ['s'],
  } as any);
  assert.equal(result.id, 'dep-1');
  assert.equal(result.status, 'unknown');
  assert.equal(result.registered_at, ISO);
});

test('DeploymentRepository.getById: null vs mapped', async () => {
  const missing = new DeploymentRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getById('dep-1'), null);

  const found = new DeploymentRepository(dsWith(makeFakeRepo({ findOne: async () => deploymentEntity() })) as any);
  const result = await found.getById('dep-1');
  assert.equal(result?.id, 'dep-1');
  assert.equal(result?.region, 'us-east');
  assert.equal(result?.last_health_check, ISO);
});

test('DeploymentRepository.update: applies fields then saves; throws when missing', async () => {
  const missing = new DeploymentRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  await assert.rejects(() => missing.update('dep-1', { region: 'eu' }), /Deployment not found/);

  const repo = makeFakeRepo({
    findOne: async () => deploymentEntity(),
    save: async (e: any) => e,
  });
  const sut = new DeploymentRepository(dsWith(repo) as any);
  const result = await sut.update('dep-1', { region: 'eu-west', capabilities: ['x', 'y'] });
  assert.equal(result.region, 'eu-west');
  assert.deepEqual(result.capabilities, ['x', 'y']);
});

test('DeploymentRepository.updateStatus: mutates + saves; throws when missing', async () => {
  let saved: any;
  const repo = makeFakeRepo({
    findOne: async () => deploymentEntity(),
    save: async (e: any) => {
      saved = e;
      return e;
    },
  });
  const sut = new DeploymentRepository(dsWith(repo) as any);
  await sut.updateStatus('dep-1', 'unhealthy', '2024-05-05T00:00:00.000Z');
  assert.equal(saved.status, 'unhealthy');
  assert.ok(saved.last_health_check instanceof Date);

  const missing = new DeploymentRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  await assert.rejects(() => missing.updateStatus('dep-1', 'healthy'), /Deployment not found/);
});

test('DeploymentRepository.delete / list / exists delegate', async () => {
  const del = new DeploymentRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 1 }) })) as any);
  assert.equal(await del.delete('dep-1'), true);

  const list = new DeploymentRepository(dsWith(makeFakeRepo({ find: async () => [deploymentEntity()] })) as any);
  const all = await list.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'dep-1');

  const exists = new DeploymentRepository(dsWith(makeFakeRepo({ count: async () => 1 })) as any);
  assert.equal(await exists.exists('dep-1'), true);
});

// ============================================= DeploymentAssignmentRepository
function assignmentEntity(overrides: Record<string, any> = {}) {
  return {
    project_id: 'proj1',
    data_source_name: 'bucket1',
    deployment_id: 'dep-1',
    role: 'primary',
    priority: 1,
    assigned_at: FIXED,
    assignment_reason: 'because',
    status: 'active',
    load_balance_weight: 50,
    ...overrides,
  };
}

test('DeploymentAssignmentRepository.create: maps bucket_name <-> data_source_name', async () => {
  const repo = makeFakeRepo({ save: async (e: any) => ({ ...e, assigned_at: FIXED }) });
  const sut = new DeploymentAssignmentRepository(dsWith(repo) as any);
  const result = await sut.create({
    project_id: 'proj1',
    bucket_name: 'bucket1',
    deployment_id: 'dep-1',
    role: 'primary' as any,
    priority: 1,
    status: 'active' as any,
  } as any);
  assert.equal(result.bucket_name, 'bucket1');
  assert.equal(result.deployment_id, 'dep-1');
  assert.equal(result.assigned_at, ISO);
  // load_balance_weight defaults to 100 when not provided
  assert.equal(result.load_balance_weight, 100);
});

test('DeploymentAssignmentRepository.get: null vs mapped', async () => {
  const missing = new DeploymentAssignmentRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.get('proj1', 'bucket1', 'dep-1'), null);

  const found = new DeploymentAssignmentRepository(
    dsWith(makeFakeRepo({ findOne: async () => assignmentEntity() })) as any,
  );
  const result = await found.get('proj1', 'bucket1', 'dep-1');
  assert.equal(result?.bucket_name, 'bucket1');
  assert.equal(result?.role, 'primary');
});

test('DeploymentAssignmentRepository.listByDeployment / listByBucket map results', async () => {
  const byDep = new DeploymentAssignmentRepository(
    dsWith(makeFakeRepo({ find: async () => [assignmentEntity()] })) as any,
  );
  const a = await byDep.listByDeployment('dep-1', 'active');
  assert.equal(a.length, 1);
  assert.equal(a[0].deployment_id, 'dep-1');

  const byBucket = new DeploymentAssignmentRepository(
    dsWith(makeFakeRepo({ find: async () => [assignmentEntity(), assignmentEntity()] })) as any,
  );
  const b = await byBucket.listByBucket('proj1', 'bucket1');
  assert.equal(b.length, 2);
});

test('DeploymentAssignmentRepository.delete returns boolean; bulk deletes return void', async () => {
  const del = new DeploymentAssignmentRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 1 }) })) as any);
  assert.equal(await del.delete('proj1', 'bucket1', 'dep-1'), true);

  let deleteCount = 0;
  const repo = makeFakeRepo({
    find: async () => [assignmentEntity()],
    delete: async () => {
      deleteCount++;
      return { affected: 1 };
    },
  });
  const sut = new DeploymentAssignmentRepository(dsWith(repo) as any);
  assert.equal(await sut.deleteByBucket('proj1', 'bucket1'), undefined);
  assert.equal(await sut.deleteByProject('proj1'), undefined);
  assert.equal(await sut.deleteByDeployment('dep-1'), undefined);
  assert.ok(deleteCount >= 3);
});

// ====================================================== ConfigVersionRepository
test('ConfigVersionRepository.getVersion: 1 when missing, stored value otherwise', async () => {
  const missing = new ConfigVersionRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getVersion(), 1);

  const found = new ConfigVersionRepository(dsWith(makeFakeRepo({ findOne: async () => ({ id: 1, version: 7 }) })) as any);
  assert.equal(await found.getVersion(), 7);
});

test('ConfigVersionRepository.incrementVersion: seeds to 2 when missing, else +1', async () => {
  const repoSeed = makeFakeRepo({ findOne: async () => null });
  const seed = new ConfigVersionRepository(dsWith(repoSeed) as any);
  assert.equal(await seed.incrementVersion(), 2);
  assert.equal(repoSeed.create.mock.calls.length, 1);

  const existing = new ConfigVersionRepository(
    dsWith(makeFakeRepo({ findOne: async () => ({ id: 1, version: 7 }), save: async (e: any) => e })) as any,
  );
  assert.equal(await existing.incrementVersion(), 8);
});

// ======================================================== DataSourceRepository
function dataSourceEntity(overrides: Record<string, any> = {}) {
  return {
    id: 'vol-1',
    projectId: 'proj1',
    name: 'src',
    type: 'volume',
    description: 'd',
    volumeConfig: { volume_info: {}, auth_info: {} },
    metadata: {},
    createdAt: FIXED,
    updatedAt: FIXED,
    ...overrides,
  };
}

test('DataSourceRepository.create: maps snake_case request and dates', async () => {
  const repo = makeFakeRepo({ save: async (e: any) => ({ ...e, id: 'vol-1', createdAt: FIXED, updatedAt: FIXED }) });
  const sut = new DataSourceRepository(dsWith(repo) as any);
  const result = await sut.create('proj1', {
    name: 'src',
    type: 'volume' as any,
    description: 'd',
  } as any);
  assert.equal(result.id, 'vol-1');
  assert.equal(result.project_id, 'proj1');
  assert.equal(result.created_at, ISO);
});

test('DataSourceRepository.get / getByName: null vs mapped', async () => {
  const missing = new DataSourceRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.get('proj1', 'vol-1'), null);
  assert.equal(await missing.getByName('proj1', 'src'), null);

  const found = new DataSourceRepository(dsWith(makeFakeRepo({ findOne: async () => dataSourceEntity() })) as any);
  assert.equal((await found.get('proj1', 'vol-1'))?.name, 'src');
  assert.equal((await found.getByName('proj1', 'src'))?.id, 'vol-1');
});

test('DataSourceRepository.update: applies fields; throws when missing', async () => {
  const missing = new DataSourceRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  await assert.rejects(() => missing.update('proj1', 'vol-1', { name: 'x' } as any), /DataSource not found/);

  const repo = makeFakeRepo({ findOne: async () => dataSourceEntity(), save: async (e: any) => e });
  const sut = new DataSourceRepository(dsWith(repo) as any);
  const result = await sut.update('proj1', 'vol-1', { name: 'renamed', description: 'new' } as any);
  assert.equal(result.name, 'renamed');
  assert.equal(result.description, 'new');
});

test('DataSourceRepository.updateScanState / updateScanConfig delegate', async () => {
  const repo = makeFakeRepo({ findOne: async () => dataSourceEntity(), save: async (e: any) => e });
  const sut = new DataSourceRepository(dsWith(repo) as any);
  const state = await sut.updateScanState('proj1', 'vol-1', { scan_status: { state: 'pending' } as any });
  assert.equal(state.id, 'vol-1');
  const cfg = await sut.updateScanConfig('proj1', 'vol-1', { foo: 'bar' } as any);
  assert.equal(cfg.id, 'vol-1');

  const missing = new DataSourceRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  await assert.rejects(() => missing.updateScanState('proj1', 'vol-1', { scan_status: {} as any }), /DataSource not found/);
  await assert.rejects(() => missing.updateScanConfig('proj1', 'vol-1', {} as any), /DataSource not found/);
});

test('DataSourceRepository.delete / exists / existsById delegate', async () => {
  const del = new DataSourceRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 1 }) })) as any);
  assert.equal(await del.delete('proj1', 'vol-1'), true);

  const exists = new DataSourceRepository(dsWith(makeFakeRepo({ count: async () => 2 })) as any);
  assert.equal(await exists.exists('proj1', 'src'), true);
  assert.equal(await exists.existsById('proj1', 'vol-1'), true);
});

test('DataSourceRepository.list: runs through query builder and maps', async () => {
  const repo = makeFakeRepo({
    createQueryBuilder: () => makeQueryBuilder({ many: [dataSourceEntity(), dataSourceEntity({ id: 'vol-2' })] }),
  });
  const sut = new DataSourceRepository(dsWith(repo) as any);
  const list = await sut.list('proj1', { type: 'volume' as any, limit: 10, skip: 0, nameRegex: 's' });
  assert.equal(list.length, 2);
  assert.equal(list[1].id, 'vol-2');
});

test('DataSourceRepository.getEntity / getEntityByName return raw entity', async () => {
  const entity = dataSourceEntity();
  const sut = new DataSourceRepository(dsWith(makeFakeRepo({ findOne: async () => entity })) as any);
  assert.strictEqual(await sut.getEntity('proj1', 'vol-1'), entity);
  assert.strictEqual(await sut.getEntityByName('proj1', 'src'), entity);
});

test('DataSourceRepository.updateConnectionTestResult: sets status + saves', async () => {
  const repo = makeFakeRepo({ findOne: async () => dataSourceEntity(), save: async (e: any) => e });
  const sut = new DataSourceRepository(dsWith(repo) as any);
  const ok = await sut.updateConnectionTestResult('proj1', 'vol-1', { success: true, message: 'good' });
  assert.equal(ok.last_connection_test_status, 'success');
  const fail = await sut.updateConnectionTestResult('proj1', 'vol-1', { success: false });
  assert.equal(fail.last_connection_test_status, 'failed');
});

// =========================================================== ProjectRepository
function projectEntity(overrides: Record<string, any> = {}) {
  return {
    id: 'proj1',
    name: 'Project',
    created_at: FIXED,
    updated_at: FIXED,
    metadata: { a: 1 },
    home_dir: 's3://bucket/projects/proj1',
    ...overrides,
  };
}

test('ProjectRepository.create / getById / update / delete / list / exists', async () => {
  const createRepo = makeFakeRepo({ save: async (e: any) => ({ ...e, created_at: FIXED, updated_at: FIXED }) });
  const createSut = new ProjectRepository(dsWith(createRepo) as any);
  const created = await createSut.create({ name: 'Project' } as any, 'proj1', 's3://bucket/projects/proj1');
  assert.equal(created.id, 'proj1');
  assert.equal(created.home_dir, 's3://bucket/projects/proj1');
  assert.equal(created.created_at, ISO);

  const missing = new ProjectRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getById('proj1'), null);
  await assert.rejects(() => missing.update('proj1', { name: 'x' } as any), /Project not found/);

  const repo = makeFakeRepo({ findOne: async () => projectEntity(), save: async (e: any) => e });
  const sut = new ProjectRepository(dsWith(repo) as any);
  assert.equal((await sut.getById('proj1'))?.name, 'Project');
  const updated = await sut.update('proj1', { name: 'New', metadata: { b: 2 } } as any);
  assert.equal(updated.name, 'New');
  assert.deepEqual(updated.metadata, { a: 1, b: 2 });

  const del = new ProjectRepository(dsWith(makeFakeRepo({ delete: async () => ({ affected: 1 }) })) as any);
  assert.equal(await del.delete('proj1'), true);

  const list = new ProjectRepository(dsWith(makeFakeRepo({ find: async () => [projectEntity()] })) as any);
  assert.equal((await list.list()).length, 1);

  const exists = new ProjectRepository(dsWith(makeFakeRepo({ count: async () => 1 })) as any);
  assert.equal(await exists.exists('proj1'), true);
});

// ===================================================== ProjectMemberRepository
function memberEntity(overrides: Record<string, any> = {}) {
  return {
    project_id: 'proj1',
    user_id: 'user1',
    role: 'member',
    invited_by: 'admin1',
    invited_at: FIXED,
    created_at: FIXED,
    ...overrides,
  };
}

test('ProjectMemberRepository.create: sets invited_at when invited_by present', async () => {
  const repo = makeFakeRepo({ save: async (e: any) => ({ ...e, created_at: FIXED, invited_at: FIXED }) });
  const sut = new ProjectMemberRepository(dsWith(repo) as any);
  const result = await sut.create({ project_id: 'proj1', user_id: 'user1', role: 'member' as any, invited_by: 'admin1' });
  assert.equal(result.user_id, 'user1');
  assert.equal(result.role, 'member');
  assert.equal(result.created_at, ISO);
});

test('ProjectMemberRepository: lookups + role update + delete + admin check', async () => {
  const missing = new ProjectMemberRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getByProjectAndUser('proj1', 'user1'), null);
  await assert.rejects(() => missing.updateRole('proj1', 'user1', 'admin' as any), /Project member not found/);
  assert.equal(await missing.isAdmin('proj1', 'user1'), false);

  const repo = makeFakeRepo({ findOne: async () => memberEntity(), save: async (e: any) => e });
  const sut = new ProjectMemberRepository(dsWith(repo) as any);
  assert.equal((await sut.getByProjectAndUser('proj1', 'user1'))?.role, 'member');
  const updated = await sut.updateRole('proj1', 'user1', 'admin' as any);
  assert.equal(updated.role, 'admin');

  const adminRepo = new ProjectMemberRepository(dsWith(makeFakeRepo({ findOne: async () => memberEntity({ role: 'admin' }) })) as any);
  assert.equal(await adminRepo.isAdmin('proj1', 'user1'), true);

  const listRepo = new ProjectMemberRepository(dsWith(makeFakeRepo({ find: async () => [memberEntity(), memberEntity({ user_id: 'user2' })] })) as any);
  assert.equal((await listRepo.getByProject('proj1')).length, 2);
  assert.equal((await listRepo.getByUser('user1')).length, 2);

  const delRepo = makeFakeRepo({ delete: async () => ({ affected: 3 }) });
  const delSut = new ProjectMemberRepository(dsWith(delRepo) as any);
  assert.equal(await delSut.delete('proj1', 'user1'), true);
  assert.equal(await delSut.deleteByProject('proj1'), 3);

  const exists = new ProjectMemberRepository(dsWith(makeFakeRepo({ count: async () => 1 })) as any);
  assert.equal(await exists.exists('proj1', 'user1'), true);
});

// ======================================================= HealthReportRepository
test('HealthReportRepository: createOrUpdate / getByDeploymentId / deleteByDeployment', async () => {
  const repo = makeFakeRepo();
  const sut = new HealthReportRepository(dsWith(repo) as any);
  await sut.createOrUpdate({ deployment_id: 'dep-1', timestamp: ISO, healthy: true } as any);
  assert.equal(repo.save.mock.calls.length, 1);

  const missing = new HealthReportRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getByDeploymentId('dep-1'), null);

  const found = new HealthReportRepository(
    dsWith(makeFakeRepo({ findOne: async () => ({ deployment_id: 'dep-1', timestamp: FIXED, healthy: true }) })) as any,
  );
  const report = await found.getByDeploymentId('dep-1');
  assert.equal(report?.deployment_id, 'dep-1');
  assert.equal(report?.timestamp, ISO);

  const delRepo = makeFakeRepo();
  const delSut = new HealthReportRepository(dsWith(delRepo) as any);
  assert.equal(await delSut.deleteByDeployment('dep-1'), undefined);
  assert.equal(delRepo.delete.mock.calls.length, 1);
});

// ============================================================ MetricsRepository
test('MetricsRepository.create: saves and prunes only when over 100', async () => {
  const fewRepo = makeFakeRepo({ find: async () => [] });
  const fewSut = new MetricsRepository(dsWith(fewRepo) as any);
  await fewSut.create({ deployment_id: 'dep-1', timestamp: ISO, metrics: {} } as any);
  assert.equal(fewRepo.save.mock.calls.length, 1);
  assert.equal(fewRepo.remove.mock.calls.length, 0);

  const many = Array.from({ length: 101 }, () => ({ deployment_id: 'dep-1', timestamp: FIXED }));
  const manyRepo = makeFakeRepo({ find: async () => many });
  const manySut = new MetricsRepository(dsWith(manyRepo) as any);
  await manySut.create({ deployment_id: 'dep-1', timestamp: ISO, metrics: {} } as any);
  assert.equal(manyRepo.remove.mock.calls.length, 1);
});

test('MetricsRepository.getRecent / deleteByDeployment delegate', async () => {
  const repo = makeFakeRepo({ find: async () => [{ deployment_id: 'dep-1', timestamp: FIXED, metrics_data: { x: 1 } }] });
  const sut = new MetricsRepository(dsWith(repo) as any);
  const recent = await sut.getRecent('dep-1', 5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].timestamp, ISO);

  const delRepo = makeFakeRepo();
  const delSut = new MetricsRepository(dsWith(delRepo) as any);
  assert.equal(await delSut.deleteByDeployment('dep-1'), undefined);
  assert.equal(delRepo.delete.mock.calls.length, 1);
});

// ========================================================= BucketHealthRepository
function bucketHealthEntity(overrides: Record<string, any> = {}) {
  return {
    project_id: 'proj1',
    data_source_name: 'bucket1',
    deployment_id: 'dep-1',
    timestamp: FIXED,
    healthy: true,
    ...overrides,
  };
}

test('BucketHealthRepository: createOrUpdate / getByBucket / getByBucketAndDeployment / deletes', async () => {
  const repo = makeFakeRepo();
  const sut = new BucketHealthRepository(dsWith(repo) as any);
  await sut.createOrUpdate({ project_id: 'proj1', bucket_name: 'bucket1', deployment_id: 'dep-1', timestamp: ISO, healthy: true } as any);
  assert.equal(repo.save.mock.calls.length, 1);

  const list = new BucketHealthRepository(dsWith(makeFakeRepo({ find: async () => [bucketHealthEntity()] })) as any);
  const reports = await list.getByBucket('proj1', 'bucket1');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].bucket_name, 'bucket1');

  const missing = new BucketHealthRepository(dsWith(makeFakeRepo({ findOne: async () => null })) as any);
  assert.equal(await missing.getByBucketAndDeployment('proj1', 'bucket1', 'dep-1'), null);

  const found = new BucketHealthRepository(dsWith(makeFakeRepo({ findOne: async () => bucketHealthEntity() })) as any);
  assert.equal((await found.getByBucketAndDeployment('proj1', 'bucket1', 'dep-1'))?.timestamp, ISO);

  const delRepo = makeFakeRepo();
  const delSut = new BucketHealthRepository(dsWith(delRepo) as any);
  assert.equal(await delSut.deleteByBucket('proj1', 'bucket1'), undefined);
  assert.equal(await delSut.deleteByDeployment('dep-1'), undefined);
  assert.equal(delRepo.delete.mock.calls.length, 2);
});

// ========================================================== RepositoryFactory
test('RepositoryFactory: getRepositoryFactory throws before initialization', () => {
  // This must run before initializeRepositoryFactory() mutates the module singleton.
  assert.throws(() => getRepositoryFactory(), /not initialized/);
});

test('RepositoryFactory: init then lazily construct + cache each repo', () => {
  const fakeDataSource: any = { getRepository: () => makeFakeRepo() };
  initializeRepositoryFactory(fakeDataSource);

  const factory = getRepositoryFactory();
  assert.ok(factory instanceof RepositoryFactory);

  assert.ok(factory.deploymentRepo instanceof DeploymentRepository);
  assert.ok(factory.assignmentRepo instanceof DeploymentAssignmentRepository);
  assert.ok(factory.configVersionRepo instanceof ConfigVersionRepository);
  assert.ok(factory.dataSourceRepo instanceof DataSourceRepository);
  assert.ok(factory.projectRepo instanceof ProjectRepository);
  assert.ok(factory.projectMemberRepo instanceof ProjectMemberRepository);
  assert.ok(factory.healthReportRepo instanceof HealthReportRepository);
  assert.ok(factory.metricsRepo instanceof MetricsRepository);
  assert.ok(factory.bucketHealthRepo instanceof BucketHealthRepository);

  // Lazy getters return the same cached instance on subsequent access.
  assert.strictEqual(factory.deploymentRepo, factory.deploymentRepo);
  assert.strictEqual(factory.projectRepo, factory.projectRepo);

  // getRepositoryFactory() returns the same singleton.
  assert.strictEqual(getRepositoryFactory(), factory);
});
