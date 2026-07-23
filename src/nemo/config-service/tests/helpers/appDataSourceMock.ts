/**
 * Hermetic TypeORM seam.
 *
 * `AppDataSource` is an exported singleton object, so overriding its
 * `getRepository` method at runtime redirects every route/service/middleware
 * that calls `AppDataSource.getRepository(Entity)` to an in-memory fake. No DB,
 * no network. Call `restore()` (or use `withFakeRepositories`) to undo.
 */
import { mock } from 'node:test';
import { AppDataSource } from '../../db/postgres';

export interface QueryBuilderResult {
  many?: unknown[];
  one?: unknown | null;
  count?: number;
  raw?: unknown[];
  rawOne?: unknown | null;
  execute?: unknown;
}

export type FakeQueryBuilder = Record<string, any>;

const CHAINABLE_QB_METHODS = [
  'where',
  'andWhere',
  'orWhere',
  'orderBy',
  'addOrderBy',
  'groupBy',
  'addGroupBy',
  'having',
  'andHaving',
  'skip',
  'take',
  'limit',
  'offset',
  'select',
  'addSelect',
  'from',
  'leftJoin',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndSelect',
  'leftJoinAndMapMany',
  'leftJoinAndMapOne',
  'distinct',
  'distinctOn',
  'setParameter',
  'setParameters',
  'withDeleted',
  'cache',
  'setLock',
  'returning',
  'insert',
  'into',
  'values',
  'update',
  'set',
  'delete',
  'orIgnore',
  'orUpdate',
  'onConflict',
  'output',
];

/** Build a chainable fake QueryBuilder whose terminal methods return programmed values. */
export function makeQueryBuilder(result: QueryBuilderResult = {}): FakeQueryBuilder {
  const qb: FakeQueryBuilder = {};
  for (const method of CHAINABLE_QB_METHODS) {
    qb[method] = mock.fn(() => qb);
  }
  const many = result.many ?? [];
  qb.getMany = mock.fn(async () => many);
  qb.getManyAndCount = mock.fn(async () => [many, result.count ?? many.length]);
  qb.getOne = mock.fn(async () => result.one ?? null);
  qb.getOneOrFail = mock.fn(async () => {
    if (result.one == null) throw new Error('EntityNotFound');
    return result.one;
  });
  qb.getRawMany = mock.fn(async () => result.raw ?? []);
  qb.getRawOne = mock.fn(async () => result.rawOne ?? null);
  qb.getCount = mock.fn(async () => result.count ?? many.length);
  qb.getRawAndEntities = mock.fn(async () => ({ entities: many, raw: result.raw ?? [] }));
  qb.execute = mock.fn(async () => result.execute ?? undefined);
  qb.stream = mock.fn(async () => undefined);
  return qb;
}

export type FakeRepo = Record<string, any>;

/**
 * Build an in-memory fake repository. Defaults are inert (find -> [],
 * findOne -> null, save echoes the entity). Override any method per test.
 */
export function makeFakeRepo(overrides: Record<string, any> = {}): FakeRepo {
  const repo: FakeRepo = {
    find: mock.fn(async () => []),
    findOne: mock.fn(async () => null),
    findOneBy: mock.fn(async () => null),
    findOneOrFail: mock.fn(async () => {
      throw new Error('EntityNotFound');
    }),
    findBy: mock.fn(async () => []),
    findAndCount: mock.fn(async () => [[], 0]),
    count: mock.fn(async () => 0),
    countBy: mock.fn(async () => 0),
    exists: mock.fn(async () => false),
    existsBy: mock.fn(async () => false),
    create: mock.fn((data: any) =>
      Array.isArray(data) ? data.map((d) => ({ ...d })) : { ...(data ?? {}) },
    ),
    merge: mock.fn((target: any, ...sources: any[]) => Object.assign(target, ...sources)),
    preload: mock.fn(async (data: any) => ({ ...data })),
    save: mock.fn(async (entity: any) =>
      Array.isArray(entity) ? entity.map((e) => ({ ...e })) : { ...entity },
    ),
    insert: mock.fn(async () => ({ identifiers: [], generatedMaps: [], raw: [] })),
    update: mock.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    upsert: mock.fn(async () => ({ identifiers: [], generatedMaps: [], raw: [] })),
    delete: mock.fn(async () => ({ affected: 1, raw: [] })),
    softDelete: mock.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    remove: mock.fn(async (entity: any) => entity),
    increment: mock.fn(async () => ({ affected: 1, raw: [], generatedMaps: [] })),
    clear: mock.fn(async () => undefined),
    query: mock.fn(async () => []),
    createQueryBuilder: mock.fn(() => makeQueryBuilder()),
    manager: {},
    metadata: { columns: [], relations: [], tableName: 'fake' },
    target: overrides.target,
  };
  return Object.assign(repo, overrides);
}

function entityKey(entity: any): string {
  if (typeof entity === 'function') return entity.name;
  if (entity && typeof entity === 'object' && typeof entity.name === 'string') return entity.name;
  return String(entity);
}

export interface FakeDataSourceHandle {
  /** Map of entity-name -> fake repo. */
  repos: Record<string, FakeRepo>;
  /** Get (creating on demand) the fake repo for an entity name or class. */
  repo(entity: string | Function): FakeRepo;
  /** The mocked AppDataSource.query function (returns [] by default). */
  query: ReturnType<typeof mock.fn>;
  /** Restore AppDataSource to its original state. */
  restore(): void;
}

/**
 * Override `AppDataSource.getRepository` to return fakes. Accepts an optional
 * seed map keyed by entity name (e.g. `{ Agent: makeFakeRepo({...}) }`).
 */
export function installFakeRepositories(
  seed: Record<string, FakeRepo> = {},
): FakeDataSourceHandle {
  const ds = AppDataSource as any;
  const hadOwnGetRepository = Object.prototype.hasOwnProperty.call(ds, 'getRepository');
  const originalGetRepository = ds.getRepository;
  const hadOwnQuery = Object.prototype.hasOwnProperty.call(ds, 'query');
  const originalQuery = ds.query;
  const originalIsInitialized = ds.isInitialized;

  const store: Record<string, FakeRepo> = { ...seed };
  const getRepo = (entity: any): FakeRepo => {
    const key = entityKey(entity);
    if (!store[key]) store[key] = makeFakeRepo();
    return store[key];
  };

  ds.getRepository = (entity: any) => getRepo(entity);
  ds.getTreeRepository = (entity: any) => getRepo(entity);
  const queryFn = mock.fn(async () => []);
  ds.query = queryFn;
  const originalManager = ds.manager;
  const hadOwnManager = Object.prototype.hasOwnProperty.call(ds, 'manager');
  const fakeManager: any = {
    getRepository: (entity: any) => getRepo(entity),
    query: queryFn,
    save: async (e: any) => e,
    transaction: async (cb: any) => cb(fakeManager),
    connection: ds,
  };
  ds.manager = fakeManager;
  ds.transaction = async (arg: any, maybeCb?: any) => {
    const cb = typeof arg === 'function' ? arg : maybeCb;
    return cb(fakeManager);
  };
  ds.createQueryRunner = () => ({
    connect: async () => undefined,
    startTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    release: async () => undefined,
    query: queryFn,
    manager: fakeManager,
  });
  try {
    ds.isInitialized = true;
  } catch {
    /* getter-only in some TypeORM versions; ignore */
  }

  return {
    repos: store,
    repo(entity: string | Function) {
      return getRepo(entity);
    },
    query: queryFn,
    restore() {
      if (hadOwnGetRepository) ds.getRepository = originalGetRepository;
      else delete ds.getRepository;
      delete ds.getTreeRepository;
      delete ds.transaction;
      delete ds.createQueryRunner;
      if (hadOwnManager) ds.manager = originalManager;
      else delete ds.manager;
      if (hadOwnQuery) ds.query = originalQuery;
      else delete ds.query;
      try {
        ds.isInitialized = originalIsInitialized;
      } catch {
        /* ignore */
      }
    },
  };
}

/** Convenience wrapper that installs fakes, runs `fn`, and always restores. */
export async function withFakeRepositories(
  seed: Record<string, FakeRepo>,
  fn: (handle: FakeDataSourceHandle) => Promise<void> | void,
): Promise<void> {
  const handle = installFakeRepositories(seed);
  try {
    await fn(handle);
  } finally {
    handle.restore();
  }
}
