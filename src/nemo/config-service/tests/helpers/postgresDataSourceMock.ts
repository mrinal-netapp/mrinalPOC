/**
 * Fake TypeORM DataSource + QueryRunner for exercising db/postgres.ts
 * connect/migration paths without a real database.
 */
import * as path from 'node:path';
import type { Restore } from './moduleMock';
import { mockModule } from './moduleMock';

const SERVICE_ROOT = path.resolve(__dirname, '..', '..');

export type PostgresMockHandle = {
  restore: Restore;
  appInitAttempts: number;
  preSyncDestroyCount: number;
  queries: string[];
  configure: (opts: {
    failAppInitOnce?: boolean;
    failAppInitMessage?: string;
    transientOnFirstAppInit?: boolean;
    transientAlways?: boolean;
    failFixMigration?: boolean;
    failOnQueryContaining?: string;
    missingOriginVolumeColumn?: boolean;
    missingTables?: string[];
    missingMcpServersTable?: boolean;
    failAlterContaining?: string;
    dataSourceIdDataType?: string;
    dataSourceIdMaxLength?: number;
    dataSetNullIdCount?: number;
    dataSetTotalCount?: number;
    dataSetIdMaxLength?: number;
    missingDataSetIdColumn?: boolean;
    dataSetIdNullable?: boolean;
  }) => void;
};

function makeQueryRunner() {
  return {
    connected: false,
    async connect() {
      this.connected = true;
    },
    async query(sql: string, params?: unknown[]) {
      const st = (makeQueryRunner as any)._state;
      st?.queries?.push(String(sql));
      if (st?.failFixMigration && st?.fixPhase) {
        throw new Error('fix migration failed');
      }
      if (st?.preSyncMigrationPhase && st?.preSyncTransientError) {
        const err: NodeJS.ErrnoException = new Error('connection terminated');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (st?.failOnQueryContaining && st?.preSyncMigrationPhase && String(sql).includes(st.failOnQueryContaining)) {
        throw new Error(`forced migration failure on ${st.failOnQueryContaining}`);
      }
      if (st?.failAlterContaining && String(sql).toUpperCase().includes('ALTER') && String(sql).includes(st.failAlterContaining)) {
        throw new Error(`forced alter failure on ${st.failAlterContaining}`);
      }
      const s = String(sql).toLowerCase();
      if (st?.failProjectsHomeDirBackfill && s.includes('set home_dir')) {
        throw new Error('home_dir backfill failed');
      }
      if (st?.failMigrateEntityStatusEnums && s.includes('alter table data_sets alter column status type text')) {
        throw new Error('enum migration failed');
      }
      if (st?.failRenameLegacyMcpGateway && s.includes('mcp_servers') && s.includes('litellmserverid')) {
        throw new Error('legacy mcp rename failed');
      }
      if (st?.failScrubVirtualKey && s.includes('virtualkeytoken')) {
        throw new Error('scrub failed');
      }
      if (st?.failDataSetsStatusEnumProbe && s.includes('::"data_sets_status_enum"')) {
        throw new Error('invalid input value for enum data_sets_status_enum');
      }
      if (st?.failKnowledgeBasesStatusEnumProbe && s.includes('::"knowledge_bases_status_enum"')) {
        throw new Error('invalid input value for enum knowledge_bases_status_enum');
      }
      if (s.includes('select exists') || s.includes('information_schema.tables')) {
        if (st?.missingProjectsTable && s.includes('projects')) {
          return [{ exists: false }];
        }
        if (st?.missingMcpServersTable && s.includes('mcp_servers')) {
          return [{ exists: false }];
        }
        if (st?.missingDataSetsTable && s.includes('data_sets')) {
          return [{ exists: false }];
        }
        if (st?.missingKnowledgeBasesTable && s.includes('knowledge_bases')) {
          return [{ exists: false }];
        }
        if (st?.missingTables?.length) {
          for (const table of st.missingTables) {
            if (s.includes(`'${table}'`) || s.includes(table)) {
              return [{ exists: false }];
            }
          }
        }
        if (s.includes("column_name = 'init_status'")) {
          return [{ exists: st?.initStatusColumnExisted ?? true }];
        }
        return [{ exists: true }];
      }
      if (s.includes('count(*)')) {
        if (s.includes('data_sets') && s.includes('creating')) {
          const n = st?.dataSetsOldStatusCount ?? 0;
          return [{ count: String(n), cnt: String(n), n }];
        }
        if (s.includes('knowledge_bases') && s.includes('creating')) {
          const n = st?.knowledgeBasesOldStatusCount ?? 0;
          return [{ count: String(n), cnt: String(n), n }];
        }
        if (s.includes('data_sets') && s.includes('id is null')) {
          const n = st?.dataSetNullIdCount ?? 0;
          return [{ count: String(n) }];
        }
        if (s.includes('from data_sets') && !s.includes('where')) {
          const n = st?.dataSetTotalCount ?? 0;
          return [{ count: String(n) }];
        }
        return [{ count: '0', cnt: '0', n: 0 }];
      }
      if (s.includes('information_schema.columns')) {
        if (s.includes('mcp_servers') && params?.length) {
          const col = String(params[0]);
          if (col === 'litellmServerId') {
            if (st?.legacyMcpGatewayMerge || st?.legacyMcpGatewayRename) {
              return [{ column_name: 'litellmServerId' }];
            }
            return [];
          }
          if (col === 'gatewayServerId') {
            return st?.legacyMcpGatewayMerge ? [{ column_name: 'gatewayServerId' }] : [];
          }
        }
        if (s.includes("table_name = 'data_sets'") && s.includes("column_name = 'originvolume'")) {
          return st?.missingOriginVolumeColumn ? [] : [{ column_name: 'originVolume' }];
        }
        if (s.includes("table_name = 'data_sets'") && s.includes("column_name = 'id'")) {
          if (s.includes('is_nullable')) {
            return [{ is_nullable: st?.dataSetIdNullable ? 'YES' : 'NO' }];
          }
          return [{ character_maximum_length: st?.dataSetIdMaxLength ?? 12 }];
        }
        if (s.includes("table_name = 'data_sources'") && s.includes("column_name = 'id'")) {
          return [
            {
              column_name: 'id',
              data_type: st?.dataSourceIdDataType ?? 'character varying',
              character_maximum_length: st?.dataSourceIdMaxLength ?? 12,
              is_nullable: 'YES',
            },
          ];
        }
        if (s.includes("table_name = 'data_sources'") && !s.includes("column_name = 'id'")) {
          return [{ column_name: 'type' }, { column_name: 'created_at' }];
        }
        if (s.includes('consecutivefailures')) {
          return st?.missingConsecutiveFailuresColumn ? [] : [{ column_name: 'consecutiveFailures' }];
        }
        return [
          { column_name: 'sourceDataset' },
          { column_name: 'embeddingModel' },
          { column_name: 'chunkSize' },
          { column_name: 'vectorSize' },
        ];
      }
      if (s.includes('::"data_sets_status_enum"') || s.includes('::"knowledge_bases_status_enum"')) {
        return [];
      }
      if (s.includes('in_progress')) {
        return [];
      }
      if (s.includes('virtualkeytoken') && s.includes('update projects')) {
        const affected = st?.scrubVirtualKeyAffected ?? 0;
        return [[], affected];
      }
      if (s.includes('set home_dir')) {
        const affected = st?.projectsHomeDirBackfillAffected ?? 0;
        return [[], affected];
      }
      if (s.includes('ctid from data_sets where id is null')) {
        const n = st?.dataSetNullIdCount ?? 0;
        return Array.from({ length: n }, (_, i) => ({ ctid: `(0,${i + 1})` }));
      }
      if (s.includes('select 1 from data_sets where id =')) {
        return [];
      }
      if (s.includes('update data_sets set id =')) {
        return [];
      }
      return [];
    },
    async hasTable(name: string) {
      const st = (makeQueryRunner as any)._state;
      if (st?.missingTables?.includes(name)) return false;
      return true;
    },
    async getTable(name: string) {
      const st = (makeQueryRunner as any)._state;
      const columns =
        name === 'data_sets' && st?.missingDataSetIdColumn
          ? [{ name: 'name', type: 'varchar', length: '255', isNullable: true }]
          : [{ name: 'id', type: 'varchar', length: '12', isNullable: true }];
      return { name, columns };
    },
    async release() {
      this.connected = false;
    },
  };
}

export function installPostgresDataSourceMock(): PostgresMockHandle {
  const state = {
    appInitAttempts: 0,
    preSyncDestroyCount: 0,
    preSyncInitCount: 0,
    failAppInitOnce: false,
    failAppInitMessage: 'contains null values',
    transientOnFirstAppInit: false,
    transientAlways: false,
    failFixMigration: false,
    fixPhase: false,
    failOnQueryContaining: '',
    preSyncMigrationPhase: false,
    missingOriginVolumeColumn: false,
    missingTables: [] as string[],
    missingMcpServersTable: false,
    failAlterContaining: '',
    configVersionExists: false,
    queries: [] as string[],
    missingProjectsTable: false,
    missingDataSetsTable: false,
    missingKnowledgeBasesTable: false,
    dataSetsOldStatusCount: 0,
    knowledgeBasesOldStatusCount: 0,
    failDataSetsStatusEnumProbe: false,
    failKnowledgeBasesStatusEnumProbe: false,
    projectsHomeDirBackfillAffected: 0,
    failProjectsHomeDirBackfill: false,
    failMigrateEntityStatusEnums: false,
    legacyMcpGatewayMerge: false,
    legacyMcpGatewayRename: false,
    failRenameLegacyMcpGateway: false,
    scrubVirtualKeyAffected: 0,
    failScrubVirtualKey: false,
    initStatusColumnExisted: true,
    missingConsecutiveFailuresColumn: false,
    preSyncTransientError: false,
    dataSourceIdDataType: 'character varying',
    dataSourceIdMaxLength: 12,
    dataSetNullIdCount: 0,
    dataSetTotalCount: 0,
    dataSetIdMaxLength: 12,
    missingDataSetIdColumn: false,
    dataSetIdNullable: false,
  };

  // Preserve real TypeORM decorators/exports; only replace DataSource.
  const realTypeormPath = require.resolve('typeorm', { paths: [SERVICE_ROOT] });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const realTypeorm = require(realTypeormPath) as Record<string, unknown>;

  class FakeDataSource extends (realTypeorm.DataSource as new (...args: any[]) => any) {
    isInitialized = false;
    private readonly isPreSync: boolean;

    constructor(options?: { synchronize?: boolean }) {
      super(options);
      this.isPreSync = options?.synchronize === false;
    }

    createQueryRunner() {
      return makeQueryRunner();
    }

    getRepository() {
      const st = (FakeDataSource as any)._state ?? state;
      return {
        findOne: async (q: any) => {
          if (q?.where?.id === 1 && st.configVersionExists) {
            return { id: 1, version: 1 };
          }
          return null;
        },
        create: (row: unknown) => row,
        save: async (row: unknown) => row,
      };
    }

    async initialize() {
      if (this.isPreSync) {
        state.preSyncInitCount += 1;
        if (state.preSyncInitCount === 1) {
          state.preSyncMigrationPhase = true;
        }
        if (state.failFixMigration && state.preSyncInitCount === 2) {
          state.fixPhase = true;
        }
      } else {
        state.appInitAttempts += 1;
        if (state.transientAlways || (state.transientOnFirstAppInit && state.appInitAttempts === 1)) {
          const err: NodeJS.ErrnoException = new Error('connection refused');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        if (state.failAppInitOnce && state.appInitAttempts === 1) {
          throw new Error(state.failAppInitMessage);
        }
      }
      this.isInitialized = true;
    }

    async destroy() {
      if (this.isPreSync) {
        state.preSyncDestroyCount += 1;
        state.preSyncMigrationPhase = false;
      }
      this.isInitialized = false;
      return new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  const restore = mockModule('typeorm', {
    ...realTypeorm,
    DataSource: FakeDataSource,
  });
  (makeQueryRunner as any)._state = state;
  (FakeDataSource as any)._state = state;

  return {
    restore,
    get appInitAttempts() {
      return state.appInitAttempts;
    },
    get preSyncDestroyCount() {
      return state.preSyncDestroyCount;
    },
    get queries() {
      return state.queries;
    },
    configure(opts: Partial<typeof state>) {
      Object.assign(state, opts);
    },
  };
}
