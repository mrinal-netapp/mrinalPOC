/**
 * Unit tests for db/postgres.ts connectToPostgres migration + retry paths.
 *
 * Run: node --require ts-node/register --test tests/postgres.connect.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearModule, loadFresh, mockModule, restoreScope } from './helpers/moduleMock';
import { installPostgresDataSourceMock } from './helpers/postgresDataSourceMock';

let scope: ReturnType<typeof restoreScope>;
let pgMock: ReturnType<typeof installPostgresDataSourceMock> & {
  configure: (opts: Record<string, unknown>) => void;
};

beforeEach(() => {
  scope = restoreScope();
  scope.add(
    mockModule('@agentstudio/observability-client-runtime', {
      get_logger: () => ({
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    }),
  );
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async ensureBuiltinsForAllProjects() {
          return undefined;
        }
        async backfillKnowledgeBaseEmbeddingModelId() {
          return undefined;
        }
        async backfillEmbeddingDimensions() {
          return undefined;
        }
      },
    }),
  );
  scope.add(
    mockModule('services/DataSetIdGenerator', {
      DataSetIdGenerator: { generate: () => 'ds1234567890' },
    }),
  );

  pgMock = installPostgresDataSourceMock() as typeof pgMock;
  clearModule('db/postgres');
});

afterEach(() => {
  scope.restoreAll();
  pgMock.restore();
  clearModule('db/postgres', 'typeorm');
});

test('connectToPostgres: runs pre-sync migrations and initializes AppDataSource', async () => {
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  const ds = AppDataSource as { isInitialized: boolean };
  ds.isInitialized = false;

  const out = await connectToPostgres();
  assert.equal(out, AppDataSource);
  assert.equal(ds.isInitialized, true);
  assert.equal(pgMock.appInitAttempts, 1);
  assert.ok(pgMock.preSyncDestroyCount >= 1);
});

test('connectToPostgres: repairs schema when synchronize hits null-value errors', async () => {
  pgMock.configure({ failAppInitOnce: true, failAppInitMessage: 'contains null values' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  const ds = AppDataSource as { isInitialized: boolean };
  ds.isInitialized = false;

  await connectToPostgres();
  assert.equal(ds.isInitialized, true);
  assert.equal(pgMock.appInitAttempts, 2);
});

test('connectToPostgres: retries transient connection failures', async () => {
  pgMock.configure({ transientOnFirstAppInit: true });
  const prevSetTimeout = global.setTimeout;
  global.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  const ds = AppDataSource as { isInitialized: boolean };
  ds.isInitialized = false;

  try {
    await connectToPostgres();
    assert.equal(ds.isInitialized, true);
    assert.equal(pgMock.appInitAttempts, 2);
  } finally {
    global.setTimeout = prevSetTimeout;
  }
});

test('closePostgresConnection: surfaces destroy timeout', async () => {
  const prev = process.env.DB_DESTROY_TIMEOUT_MS;
  process.env.DB_DESTROY_TIMEOUT_MS = '1';

  try {
    const realTypeormPath = require.resolve('typeorm', {
      paths: [require('path').resolve(__dirname, '..')],
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const realTypeorm = require(realTypeormPath) as Record<string, unknown>;

    class SlowDestroyDataSource extends (realTypeorm.DataSource as new (...args: any[]) => any) {
      isInitialized = true;
      createQueryRunner() {
        return {
          connect: async () => undefined,
          query: async () => [],
          hasTable: async () => false,
          getTable: async () => null,
          release: async () => undefined,
        };
      }
      getRepository() {
        return {
          findOne: async () => null,
          create: (row: unknown) => row,
          save: async (row: unknown) => row,
        };
      }
      async initialize() {
        this.isInitialized = true;
      }
      async destroy() {
        return new Promise<void>(() => undefined);
      }
    }

    scope.add(
      mockModule('typeorm', {
        ...realTypeorm,
        DataSource: SlowDestroyDataSource,
      }),
    );
    clearModule('db/postgres');

    const { closePostgresConnection, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
      'db/postgres',
    );
    (AppDataSource as { isInitialized: boolean }).isInitialized = true;

    await assert.rejects(() => closePostgresConnection(), /DB destroy timeout/);
  } finally {
    if (prev === undefined) {
      delete process.env.DB_DESTROY_TIMEOUT_MS;
    } else {
      process.env.DB_DESTROY_TIMEOUT_MS = prev;
    }
  }
});

test('connectToPostgres: rethrows non-schema initialization errors', async () => {
  pgMock.configure({ failAppInitOnce: true, failAppInitMessage: 'permission denied for database' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;

  await assert.rejects(() => connectToPostgres(), /permission denied for database/);
});

test('connectToPostgres: surfaces fix-migration failures after schema error', async () => {
  pgMock.configure({ failAppInitOnce: true, failAppInitMessage: 'contains null values', failFixMigration: true });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;

  await assert.rejects(() => connectToPostgres(), /Failed to fix id columns/);
});

test('connectToPostgres: logs BuiltinModelsService backfill failures in background', async () => {
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async ensureBuiltinsForAllProjects() {
          throw new Error('seed failed');
        }
        async backfillKnowledgeBaseEmbeddingModelId() {
          return undefined;
        }
        async backfillEmbeddingDimensions() {
          return undefined;
        }
      },
    }),
  );
  clearModule('db/postgres');

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;

  await connectToPostgres();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: throws after max retry attempts', async () => {
  pgMock.configure({ transientAlways: true });
  const prevSetTimeout = global.setTimeout;
  global.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;

  try {
    await assert.rejects(() => connectToPostgres(), /connection refused/);
  } finally {
    global.setTimeout = prevSetTimeout;
  }
});

test('connectToPostgres: tolerates pre-sync migration failures for guardrails and embedding columns', async () => {
  pgMock.configure({ failOnQueryContaining: 'guardrails_catalog' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates evaluation table migration failures', async () => {
  pgMock.configure({ failOnQueryContaining: 'evaluation_runs' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates unified embedding column migration failures', async () => {
  pgMock.configure({ failOnQueryContaining: '"isBuiltin"' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: adds data_sets originVolume column when missing', async () => {
  pgMock.configure({ missingOriginVolumeColumn: true });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((sql) => String(sql).includes('"originVolume"')));
});

test('connectToPostgres: returns immediately when already initialized', async () => {
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = true;
  const out = await connectToPostgres();
  assert.equal(out, AppDataSource);
  assert.equal(pgMock.appInitAttempts, 0);
});

test('connectToPostgres: skips config_version seed when row already exists', async () => {
  pgMock.configure({ configVersionExists: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: repairs schema when knowledge_bases error is detected', async () => {
  pgMock.configure({ failAppInitOnce: true, failAppInitMessage: 'knowledge_bases sourceDataset' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.equal(pgMock.appInitAttempts, 2);
});

test('connectToPostgres: repairs schema when data_sources id column error is detected', async () => {
  pgMock.configure({ failAppInitOnce: true, failAppInitMessage: 'column "id" of relation data_sources' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: logs backfillKnowledgeBaseEmbeddingModelId failures in background', async () => {
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async ensureBuiltinsForAllProjects() {
          return undefined;
        }
        async backfillKnowledgeBaseEmbeddingModelId() {
          throw new Error('kb backfill failed');
        }
        async backfillEmbeddingDimensions() {
          return undefined;
        }
      },
    }),
  );
  clearModule('db/postgres');

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: logs backfillEmbeddingDimensions failures in background', async () => {
  scope.add(
    mockModule('services/BuiltinModelsService', {
      BuiltinModelsService: class {
        async ensureBuiltinsForAllProjects() {
          return undefined;
        }
        async backfillKnowledgeBaseEmbeddingModelId() {
          return undefined;
        }
        async backfillEmbeddingDimensions() {
          throw new Error('dims backfill failed');
        }
      },
    }),
  );
  clearModule('db/postgres');

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

const ALTER_TOLERANCE_CASES = [
  { label: 'agent lifecycle columns', failAlterContaining: 'agents ADD COLUMN IF NOT EXISTS status' },
  { label: 'agent team lifecycle columns', failAlterContaining: 'agent_teams ADD COLUMN IF NOT EXISTS status' },
  { label: 'agent team memory_context', failAlterContaining: 'memory_context jsonb' },
  { label: 'data_sets refresh_config', failAlterContaining: 'refresh_config JSONB' },
  { label: 'data_sources modified_by', failAlterContaining: 'modified_by VARCHAR' },
  { label: 'data_sources deprecated', failAlterContaining: 'deprecated BOOLEAN' },
  { label: 'data_sets summary columns', failAlterContaining: 'latest_snapshot JSONB' },
  { label: 'agent config cards', failAlterContaining: 'fallback_model_ids JSONB' },
  { label: 'agent team a2a server', failAlterContaining: 'a2a_server JSONB' },
  { label: 'agent figma columns', failAlterContaining: 'function_choice_behavior' },
  { label: 'agent requirements', failAlterContaining: 'requirements JSONB' },
];

for (const { label, failAlterContaining } of ALTER_TOLERANCE_CASES) {
  test(`connectToPostgres: tolerates ${label} migration failures`, async () => {
    pgMock.configure({ failAlterContaining });

    const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
      'db/postgres',
    );
    (AppDataSource as { isInitialized: boolean }).isInitialized = false;
    await connectToPostgres();
    assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  });
}

const MISSING_TABLE_CASES = ['agent_teams', 'agents', 'data_sets'];

for (const table of MISSING_TABLE_CASES) {
  test(`connectToPostgres: skips column migrations when ${table} table is missing`, async () => {
    pgMock.configure({ missingTables: [table] });

    const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
      'db/postgres',
    );
    (AppDataSource as { isInitialized: boolean }).isInitialized = false;
    await connectToPostgres();
    assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  });
}

test('connectToPostgres: tolerates model_providers table migration failure in pre-sync', async () => {
  pgMock.configure({ failOnQueryContaining: 'model_providers' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates reference_edges table migration failure in pre-sync', async () => {
  pgMock.configure({ failOnQueryContaining: 'reference_edges' });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

const PRE_SYNC_QUERY_FAILURES = [
  { label: 'managed MCP columns', failOnQueryContaining: 'deploymentType' },
  { label: 'serverInstructions column', failOnQueryContaining: 'serverInstructions' },
  { label: 'remote MCP connection columns', failOnQueryContaining: 'queryParams' },
  { label: 'project init status columns', failOnQueryContaining: 'init_status' },
  { label: 'data source mount health', failOnQueryContaining: 'mount_health' },
  { label: 'data source scan columns', failOnQueryContaining: 'scan_config' },
  { label: 'credential lifecycle columns', failOnQueryContaining: 'rotationVersion' },
  { label: 'model class columns', failOnQueryContaining: 'modelClass' },
  { label: 'model rate limit columns', failOnQueryContaining: 'spendingLimit' },
  { label: 'KB sync columns', failAlterContaining: 'synchronization_config' },
  { label: 'entity labels columns', failAlterContaining: 'labels TEXT[]' },
  { label: 'MCP consecutiveFailures column', failAlterContaining: 'consecutiveFailures' },
  { label: 'tools to MCP rename', failOnQueryContaining: 'toolIds' },
  { label: 'legacy team table rename', failOnQueryContaining: 'agent_groups' },
  { label: 'KB required fields backfill', failOnQueryContaining: 'sourceDataset' },
];

for (const { label, failOnQueryContaining, failAlterContaining: alter } of PRE_SYNC_QUERY_FAILURES) {
  test(`connectToPostgres: tolerates ${label} migration failures`, async () => {
    if (failOnQueryContaining) pgMock.configure({ failOnQueryContaining });
    if (alter) pgMock.configure({ failAlterContaining: alter });

    const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
      'db/postgres',
    );
    (AppDataSource as { isInitialized: boolean }).isInitialized = false;
    await connectToPostgres();
    assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  });
}

test('connectToPostgres: skips managed MCP migrations when mcp_servers table missing', async () => {
  pgMock.configure({ missingMcpServersTable: true });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: skips MCP consecutiveFailures when mcp_servers table missing via hasTable', async () => {
  pgMock.configure({ missingTables: ['mcp_servers'] });

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>(
    'db/postgres',
  );
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: skips projects.home_dir backfill when projects table missing', async () => {
  pgMock.configure({ missingProjectsTable: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates projects.home_dir backfill failures', async () => {
  pgMock.configure({ failProjectsHomeDirBackfill: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: backfills projects.home_dir when rows are updated', async () => {
  pgMock.configure({ projectsHomeDirBackfillAffected: 2 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: migrates data_sets rows with legacy status values', async () => {
  pgMock.configure({ dataSetsOldStatusCount: 3 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('data_sets_status_enum')));
});

test('connectToPostgres: rebuilds data_sets status enum when probe fails', async () => {
  pgMock.configure({ failDataSetsStatusEnumProbe: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: migrates knowledge_bases rows with legacy status values', async () => {
  pgMock.configure({ knowledgeBasesOldStatusCount: 2 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: rebuilds knowledge_bases status enum when probe fails', async () => {
  pgMock.configure({ failKnowledgeBasesStatusEnumProbe: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates entity status enum migration failures', async () => {
  pgMock.configure({ failMigrateEntityStatusEnums: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: renames legacy MCP gateway columns when only legacy column exists', async () => {
  pgMock.configure({ legacyMcpGatewayRename: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('RENAME COLUMN')));
});

test('connectToPostgres: merges legacy MCP gateway columns when both names exist', async () => {
  pgMock.configure({ legacyMcpGatewayMerge: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('DROP COLUMN')));
});

test('connectToPostgres: tolerates legacy MCP gateway rename failures', async () => {
  pgMock.configure({ failRenameLegacyMcpGateway: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: scrubs leaked virtualKeyToken from project metadata', async () => {
  pgMock.configure({ scrubVirtualKeyAffected: 1 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: tolerates virtualKeyToken scrub failures', async () => {
  pgMock.configure({ failScrubVirtualKey: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: backfills init_status on first column introduction', async () => {
  pgMock.configure({ initStatusColumnExisted: false });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: adds consecutiveFailures column when missing', async () => {
  pgMock.configure({ missingConsecutiveFailuresColumn: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('consecutiveFailures')));
});

test('connectToPostgres: rethrows transient pre-sync migration errors', async () => {
  pgMock.configure({ preSyncTransientError: true });
  const prevSetTimeout = global.setTimeout;
  global.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;

  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  try {
    await assert.rejects(() => connectToPostgres(), /connection terminated/);
  } finally {
    global.setTimeout = prevSetTimeout;
  }
});

test('closePostgresConnection: no-op when pool is not initialized', async () => {
  const { closePostgresConnection, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await assert.doesNotReject(() => closePostgresConnection());
});

test('connectToPostgres: skips knowledge_bases sync columns when table is missing', async () => {
  pgMock.configure({ missingTables: ['knowledge_bases'] });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(!pgMock.queries.some((q) => String(q).includes('synchronization_config')));
});

test('connectToPostgres: skips data_sets originVolume when table is missing', async () => {
  pgMock.configure({ missingTables: ['data_sets'] });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(!pgMock.queries.some((q) => String(q).includes('"originVolume"')));
});

test('connectToPostgres: converts legacy uuid data_sources.id column during pre-sync', async () => {
  pgMock.configure({ dataSourceIdDataType: 'uuid' });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('ALTER TABLE data_sources ALTER COLUMN id TYPE VARCHAR(12)')));
});

test('connectToPostgres: deletes stale data_sets rows when all ids are null', async () => {
  pgMock.configure({ dataSetNullIdCount: 3, dataSetTotalCount: 3 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('DELETE FROM data_sets WHERE id IS NULL')));
});

test('connectToPostgres: adds data_sets id column when missing after init', async () => {
  pgMock.configure({ missingDataSetIdColumn: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('ALTER TABLE data_sets ADD COLUMN id VARCHAR(12)')));
});

test('connectToPostgres: resizes data_sets id column when too short', async () => {
  pgMock.configure({ dataSetIdMaxLength: 11 });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('ALTER COLUMN id TYPE VARCHAR(12)')));
});

test('closePostgresConnection: surfaces destroy errors', async () => {
  scope.add(
    mockModule('typeorm', {
      ...(require(require.resolve('typeorm', { paths: [require('path').resolve(__dirname, '..')] })) as Record<string, unknown>),
      DataSource: class {
        isInitialized = true;
        async destroy() {
          throw new Error('destroy failed');
        }
      },
    }),
  );
  clearModule('db/postgres');
  const { closePostgresConnection, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = true;
  await assert.rejects(() => closePostgresConnection(), /destroy failed/);
});

test('closePostgresConnection: closes initialized pool successfully', async () => {
  const { closePostgresConnection, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = true;
  await assert.doesNotReject(() => closePostgresConnection());
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, false);
});

test('connectToPostgres: tolerates originVolume migration failures', async () => {
  pgMock.configure({ failAlterContaining: '"originVolume"' });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
});

test('connectToPostgres: generates ids for partial null data_sets rows', async () => {
  pgMock.configure({ dataSetNullIdCount: 2, dataSetTotalCount: 5, dataSetIdNullable: true });
  const { connectToPostgres, AppDataSource } = loadFresh<typeof import('../db/postgres')>('db/postgres');
  (AppDataSource as { isInitialized: boolean }).isInitialized = false;
  await connectToPostgres();
  assert.equal((AppDataSource as { isInitialized: boolean }).isInitialized, true);
  assert.ok(pgMock.queries.some((q) => String(q).includes('UPDATE data_sets SET id')));
});
