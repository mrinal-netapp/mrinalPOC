import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { safeLog } from '../utils/safeStrings';
import { Credential } from '../models/Credential';
import { DataSet } from '../models/DataSet';
import { DataSetManifest } from '../models/DataSetManifest';
import { DataSetManifestFile } from '../models/DataSetManifestFile';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { MCPServer } from '../models/MCPServer';
import { Model } from '../models/Model';
import { ModelProvider } from '../models/ModelProvider';
import { Pipeline } from '../models/Pipeline';
import { PipelineExecution } from '../models/PipelineExecution';
import { Project } from '../models/Project';
import { ProjectMember } from '../models/ProjectMember';
import { ProjectServiceAccount } from '../models/ProjectServiceAccount';
import { DataSource as DataSourceEntity } from '../models/DataSource';
import { Deployment } from '../models/Deployment';
import { DeploymentAssignment } from '../models/DeploymentAssignment';
import { Metrics } from '../models/Metrics';
import { HealthReport } from '../models/HealthReport';
import { BucketHealth } from '../models/BucketHealth';
import { Facet } from '../models/Facet';
import { ConfigVersion } from '../models/ConfigVersion';
import { DataSourceHistory } from '../models/history/DataSourceHistory';
import { DataSetHistory } from '../models/history/DataSetHistory';
import { KnowledgeBaseHistory } from '../models/history/KnowledgeBaseHistory';
import { MCPServerHistory } from '../models/history/MCPServerHistory';
import { ModelHistory } from '../models/history/ModelHistory';
import { PipelineHistory } from '../models/history/PipelineHistory';
import { Agent } from '../models/Agent';
import { AgentTeam } from '../models/AgentTeam';
import { AgentHistory } from '../models/history/AgentHistory';
import { AgentTeamHistory } from '../models/history/AgentTeamHistory';
import { WorkspaceTemplate } from '../models/WorkspaceTemplate';
import { Workspace } from '../models/Workspace';
import { ReferenceEdge } from '../models/ReferenceEdge';
import { ArtifactStore } from '../models/ArtifactStore';
import { ArtifactStoreAcl } from '../models/ArtifactStoreAcl';
import { EvaluationTemplate } from '../models/EvaluationTemplate';
import { EvaluationRun } from '../models/EvaluationRun';
import { EvaluationTemplateHistory } from '../models/history/EvaluationTemplateHistory';
import { GuardrailCatalog } from '../models/GuardrailCatalog';
import {
  DataSourceHistorySubscriber,
  DataSetHistorySubscriber,
  KnowledgeBaseHistorySubscriber,
  MCPServerHistorySubscriber,
  ModelHistorySubscriber,
  PipelineHistorySubscriber,
  AgentHistorySubscriber,
  AgentTeamHistorySubscriber,
  EvaluationTemplateHistorySubscriber,
} from './historySubscriber';

const dbHost = process.env.POSTGRES_HOST || 'postgres';
const dbPort = parseInt(process.env.POSTGRES_PORT || '5432', 10);
const dbUsername = process.env.POSTGRES_USER || 'postgres';
const dbPassword = process.env.POSTGRES_PASSWORD || 'postgrespassword';
const dbName = process.env.POSTGRES_DB || 'nemo';

const dbPoolSize = parseInt(process.env.DB_POOL_SIZE || '20', 10);
const dbPoolIdleTimeout = parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10); // release idle connections after 30s
const dbConnectionTimeout = parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000', 10);
const dbStatementTimeout = parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10);

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: dbHost,
  port: dbPort,
  username: dbUsername,
  password: dbPassword,
  database: dbName,
  synchronize: process.env.NODE_ENV !== 'production', // Auto-sync schema in dev
  logging: process.env.NODE_ENV === 'development',
  poolSize: dbPoolSize,
  extra: {
    max: dbPoolSize,
    min: 0, // allow pool to release all connections when idle (idleTimeoutMillis will reap them)
    idleTimeoutMillis: dbPoolIdleTimeout,
    connectionTimeoutMillis: dbConnectionTimeout,
    statement_timeout: dbStatementTimeout,
  },
  entities: [
    Credential,
    DataSet,
    DataSetManifest,
    DataSetManifestFile,
    KnowledgeBase,
    MCPServer,
    Model,
    ModelProvider,
    Pipeline,
    PipelineExecution,
    Project,
    ProjectMember,
    ProjectServiceAccount,
    DataSourceEntity,
    Deployment,
    DeploymentAssignment,
    Metrics,
    HealthReport,
    BucketHealth,
    Facet,
    ConfigVersion,
    DataSourceHistory,
    DataSetHistory,
    KnowledgeBaseHistory,
    MCPServerHistory,
    ModelHistory,
    PipelineHistory,
    Agent,
    AgentTeam,
    AgentHistory,
    AgentTeamHistory,
    WorkspaceTemplate,
    Workspace,
    ReferenceEdge,
    ArtifactStore,
    ArtifactStoreAcl,
    EvaluationTemplate,
    EvaluationRun,
    EvaluationTemplateHistory,
    GuardrailCatalog,
  ],
  migrations: [],
  subscribers: [
    DataSourceHistorySubscriber,
    DataSetHistorySubscriber,
    KnowledgeBaseHistorySubscriber,
    MCPServerHistorySubscriber,
    ModelHistorySubscriber,
    PipelineHistorySubscriber,
    AgentHistorySubscriber,
    AgentTeamHistorySubscriber,
    EvaluationTemplateHistorySubscriber,
  ],
});

/**
 * Backfill projects.home_dir for any existing rows that have NULL home_dir.
 * Must run BEFORE TypeORM synchronize changes the column to NOT NULL.
 *
 * Sets home_dir = 's3://<DEFAULT_BUCKET>/projects/<id>' for each row.
 */
async function backfillProjectHomeDir(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    const tableExists = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects')`
    );
    if (!tableExists[0]?.exists) return;

    const defaultBucket = process.env.DEFAULT_BUCKET_NAME || 'default-nemo';
    const result = await queryRunner.query(
      `UPDATE projects SET home_dir = 's3://' || $1 || '/projects/' || id WHERE home_dir IS NULL`,
      [defaultBucket]
    );
    const affected = result?.[1] ?? 0;
    if (affected > 0) {
      logger.info(`[Migration] Backfilled home_dir for ${affected} project(s) using bucket '${defaultBucket}'`);
    }
  } catch (error: any) {
    logger.error('[Migration] Error backfilling projects.home_dir:', error.message);
  } finally {
    await queryRunner.release();
  }
}

/**
 * Migrate entity status enum values from old vocabulary to new.
 * Must run BEFORE TypeORM synchronize so existing rows are compatible
 * with the new enum definition.
 *
 * Old: 'creating' | 'created' | 'errorred'
 * New: 'in_progress' | 'ready' | 'errored' | 'deprecated'
 */
async function migrateEntityStatusEnums(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    // Migrate data_sets status enum
    const dsTableExists = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'data_sets')`
    );
    if (dsTableExists[0]?.exists) {
      // Cast to text before comparing — after a previous migration the enum
      // type no longer contains the old literals, so a direct comparison
      // would fail with "invalid input value for enum".
      const oldValueCheck = await queryRunner.query(
        `SELECT COUNT(*) as cnt FROM data_sets WHERE status::text IN ('creating', 'created', 'errorred')`
      );
      const oldCount = parseInt(oldValueCheck[0]?.cnt || '0', 10);

      if (oldCount > 0) {
        logger.info(`[Migration] Migrating ${oldCount} data_sets rows to new status vocabulary`);

        // Step 1: Change column to text temporarily to allow value rename
        await queryRunner.query(`ALTER TABLE data_sets ALTER COLUMN status TYPE text`);

        // Step 2: Update values
        await queryRunner.query(`UPDATE data_sets SET status = 'in_progress' WHERE status = 'creating'`);
        await queryRunner.query(`UPDATE data_sets SET status = 'ready' WHERE status = 'created'`);
        await queryRunner.query(`UPDATE data_sets SET status = 'errored' WHERE status = 'errorred'`);

        // Step 3: Drop old enum type and create new one
        await queryRunner.query(`DROP TYPE IF EXISTS "data_sets_status_enum" CASCADE`);
        await queryRunner.query(`CREATE TYPE "data_sets_status_enum" AS ENUM('in_progress', 'ready', 'errored', 'deprecated')`);

        // Step 4: Cast column back to the new enum
        await queryRunner.query(
          `ALTER TABLE data_sets ALTER COLUMN status TYPE "data_sets_status_enum" USING status::"data_sets_status_enum"`
        );
        await queryRunner.query(
          `ALTER TABLE data_sets ALTER COLUMN status SET DEFAULT 'in_progress'`
        );

        logger.info(`[Migration] data_sets status enum migrated successfully`);
      } else {
        // No old values, but enum type might still be old — check if new values are valid
        try {
          await queryRunner.query(`SELECT 'in_progress'::"data_sets_status_enum"`);
        } catch {
          // Enum exists but doesn't have the new values: rebuild it
          logger.info(`[Migration] Rebuilding data_sets_status_enum with new values`);
          await queryRunner.query(`ALTER TABLE data_sets ALTER COLUMN status TYPE text`);
          await queryRunner.query(`DROP TYPE IF EXISTS "data_sets_status_enum" CASCADE`);
          await queryRunner.query(`CREATE TYPE "data_sets_status_enum" AS ENUM('in_progress', 'ready', 'errored', 'deprecated')`);
          await queryRunner.query(
            `ALTER TABLE data_sets ALTER COLUMN status TYPE "data_sets_status_enum" USING status::"data_sets_status_enum"`
          );
          await queryRunner.query(
            `ALTER TABLE data_sets ALTER COLUMN status SET DEFAULT 'in_progress'`
          );
          logger.info(`[Migration] data_sets_status_enum rebuilt`);
        }
      }
    }

    // Migrate knowledge_bases status enum
    const kbTableExists = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'knowledge_bases')`
    );
    if (kbTableExists[0]?.exists) {
      const oldKbCheck = await queryRunner.query(
        `SELECT COUNT(*) as cnt FROM knowledge_bases WHERE status::text IN ('creating', 'created', 'errorred')`
      );
      const oldKbCount = parseInt(oldKbCheck[0]?.cnt || '0', 10);

      if (oldKbCount > 0) {
        logger.info(`[Migration] Migrating ${oldKbCount} knowledge_bases rows to new status vocabulary`);

        await queryRunner.query(`ALTER TABLE knowledge_bases ALTER COLUMN status TYPE text`);
        await queryRunner.query(`UPDATE knowledge_bases SET status = 'in_progress' WHERE status = 'creating'`);
        await queryRunner.query(`UPDATE knowledge_bases SET status = 'ready' WHERE status = 'created'`);
        await queryRunner.query(`UPDATE knowledge_bases SET status = 'errored' WHERE status = 'errorred'`);
        await queryRunner.query(`DROP TYPE IF EXISTS "knowledge_bases_status_enum" CASCADE`);
        await queryRunner.query(`CREATE TYPE "knowledge_bases_status_enum" AS ENUM('in_progress', 'ready', 'errored', 'deprecated')`);
        await queryRunner.query(
          `ALTER TABLE knowledge_bases ALTER COLUMN status TYPE "knowledge_bases_status_enum" USING status::"knowledge_bases_status_enum"`
        );
        await queryRunner.query(
          `ALTER TABLE knowledge_bases ALTER COLUMN status SET DEFAULT 'in_progress'`
        );

        logger.info(`[Migration] knowledge_bases status enum migrated successfully`);
      } else {
        try {
          await queryRunner.query(`SELECT 'in_progress'::"knowledge_bases_status_enum"`);
        } catch {
          logger.info(`[Migration] Rebuilding knowledge_bases_status_enum with new values`);
          await queryRunner.query(`ALTER TABLE knowledge_bases ALTER COLUMN status TYPE text`);
          await queryRunner.query(`DROP TYPE IF EXISTS "knowledge_bases_status_enum" CASCADE`);
          await queryRunner.query(`CREATE TYPE "knowledge_bases_status_enum" AS ENUM('in_progress', 'ready', 'errored', 'deprecated')`);
          await queryRunner.query(
            `ALTER TABLE knowledge_bases ALTER COLUMN status TYPE "knowledge_bases_status_enum" USING status::"knowledge_bases_status_enum"`
          );
          await queryRunner.query(
            `ALTER TABLE knowledge_bases ALTER COLUMN status SET DEFAULT 'in_progress'`
          );
          logger.info(`[Migration] knowledge_bases_status_enum rebuilt`);
        }
      }
    }
  } catch (error: any) {
    logger.error('[Migration] Error migrating entity status enums:', error.message);
  } finally {
    await queryRunner.release();
  }
}

/**
 * Migrate Tool entity to MCPServer entity.
 * Renames Agent columns, drops empty old tables, creates new tables.
 * Must run BEFORE TypeORM synchronize (especially in production where synchronize=false).
 */
async function migrateToolsToMCPServers(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    // Rename Agent columns if they still use old names (idempotent)
    const toolIdsCol = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='toolIds'`
    );
    if (toolIdsCol.length > 0) {
      await queryRunner.query(`ALTER TABLE agents RENAME COLUMN "toolIds" TO "mcpServerIds"`);
      logger.info('[Migration] Renamed agents.toolIds -> mcpServerIds');
    }

    const toolConfigCol = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='agents' AND column_name='toolConfig'`
    );
    if (toolConfigCol.length > 0) {
      await queryRunner.query(`ALTER TABLE agents RENAME COLUMN "toolConfig" TO "mcpServerConfig"`);
      logger.info('[Migration] Renamed agents.toolConfig -> mcpServerConfig');
    }

    // Drop old tables if they exist (empty, no data to preserve)
    await queryRunner.query(`DROP TABLE IF EXISTS tool_history CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS tools CASCADE`);

    // Create new tables (required for production where synchronize=false)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "projectId" VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        description TEXT,
        transport VARCHAR(20) NOT NULL DEFAULT 'http',
        url TEXT,
        command TEXT,
        args TEXT[],
        env JSONB,
        "authType" VARCHAR(30) NOT NULL DEFAULT 'none',
        "credentialId" UUID,
        "authorizationUrl" TEXT,
        "tokenUrl" TEXT,
        "staticHeaders" JSONB,
        "queryParams" JSONB,
        "headerParams" JSONB,
        "authConfig" JSONB,
        "extraHeaders" TEXT[],
        "allowedTools" TEXT[],
        "disallowedTools" TEXT[],
        "specPath" TEXT,
        "gatewayServerId" TEXT,
        "gatewayServerName" TEXT,
        "syncStatus" VARCHAR(20) NOT NULL DEFAULT 'pending',
        status VARCHAR(20) NOT NULL DEFAULT 'unknown',
        timeout INT NOT NULL DEFAULT 600000,
        trust BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE ("projectId", name)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS mcp_server_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "entityId" UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        version INT NOT NULL,
        data JSONB NOT NULL,
        "modifiedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "modifiedBy" TEXT,
        op TEXT,
        UNIQUE ("entityId", version)
      )
    `);

    logger.info('[Migration] MCPServer tables ready');
  } catch (error: any) {
    logger.error('[Migration] Error migrating tools to MCP servers:', error.message);
  } finally {
    await queryRunner.release();
  }
}

/**
 * Rename legacy MCP server columns to gateway-neutral names.
 *
 *   mcp_servers.litellmServerId   -> gatewayServerId
 *   mcp_servers.litellmServerName -> gatewayServerName
 *
 * Idempotent: safe to run on every startup. Only renames if the legacy column
 * is still present, otherwise no-op. Must run BEFORE TypeORM synchronize.
 */
async function renameLegacyMCPGatewayColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mcp_servers')`,
    );
    if (!tableExists[0]?.exists) return;

    const renames: Array<[string, string]> = [
      ['litellmServerId', 'gatewayServerId'],
      ['litellmServerName', 'gatewayServerName'],
    ];
    for (const [oldName, newName] of renames) {
      const oldCol = await qr.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mcp_servers' AND column_name=$1`,
        [oldName],
      );
      if (oldCol.length === 0) continue;
      const newCol = await qr.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mcp_servers' AND column_name=$1`,
        [newName],
      );
      if (newCol.length > 0) {
        // Both present (rare): copy non-null values from old to new, then drop old.
        await qr.query(
          `UPDATE mcp_servers SET "${newName}" = "${oldName}" WHERE "${newName}" IS NULL AND "${oldName}" IS NOT NULL`,
        );
        await qr.query(`ALTER TABLE mcp_servers DROP COLUMN "${oldName}"`);
        console.log(`[Migration] Merged mcp_servers."${oldName}" -> "${newName}" and dropped legacy column`);
      } else {
        await qr.query(`ALTER TABLE mcp_servers RENAME COLUMN "${oldName}" TO "${newName}"`);
        console.log(`[Migration] Renamed mcp_servers."${oldName}" -> "${newName}"`);
      }
    }
  } catch (e: any) {
    console.error('[Migration] Error renaming legacy MCP gateway columns:', e.message);
  } finally {
    await qr.release();
  }
}

/**
 * Scrub any Bifrost virtual-key bearer tokens that an earlier code
 * revision wrote into `projects.metadata._gateway.virtualKeyToken`.
 *
 * SECURITY: the bearer is secret-grade material and must live only in
 * (a) Bifrost's own `config_store` and (b) the K8s Secret
 * `as-proj-{projectId}-vk`. config-service Postgres does not have the
 * RBAC / audit / encryption-at-rest controls appropriate for it.
 *
 * Idempotent: a project row whose metadata does not contain
 * `_gateway.virtualKeyToken` is left untouched (the JSONB path-delete
 * operator is a no-op when the key is absent). Re-running on a
 * scrubbed cluster reports 0 updated rows.
 *
 * Safe to run on every startup; must run BEFORE TypeORM synchronize so
 * the column shape is the existing one we wrote to.
 */
async function scrubProjectMetadataVirtualKeyToken(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects')`,
    );
    if (!tableExists[0]?.exists) return;

    // jsonb #- '{...,path}' removes the key at that path; the predicate
    // (metadata->'_gateway' ? 'virtualKeyToken') restricts the UPDATE to
    // rows that actually have the leaked field so we don't churn the
    // whole table.
    const result = await qr.query(
      `UPDATE projects
         SET metadata = metadata #- '{_gateway,virtualKeyToken}'
       WHERE metadata->'_gateway' ? 'virtualKeyToken'`,
    );
    // Postgres node driver returns [rows, count] for UPDATE; count lives
    // on the second element. Fall back to result.length for tooling that
    // doesn't expose it.
    const affected =
      (Array.isArray(result) && typeof result[1] === 'number' ? result[1] : undefined) ??
      (Array.isArray(result) ? result.length : undefined);
    if (affected && affected > 0) {
      console.log(
        `[Migration] Scrubbed virtualKeyToken from ${affected} projects.metadata row(s)`,
      );
    }
  } catch (e: any) {
    console.error(
      '[Migration] Error scrubbing projects.metadata virtualKeyToken:',
      safeLog(e?.message || e),
    );
  } finally {
    await qr.release();
  }
}

/**
 * Fix data_sets.id column migration
 * Ensures all rows have IDs before TypeORM tries to make the column NOT NULL
 */
async function fixDataSetIdColumn(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  
  try {
    // Check if data_sets table exists
    const tableExists = await queryRunner.hasTable('data_sets');
    if (!tableExists) {
      return; // Table doesn't exist yet, TypeORM will create it
    }

    // Check if id column exists
    const columns = await queryRunner.getTable('data_sets');
    const idColumn = columns?.columns.find(col => col.name === 'id');
    
    if (!idColumn) {
      // Column doesn't exist, add it as nullable first
      await queryRunner.query('ALTER TABLE data_sets ADD COLUMN id VARCHAR(12)');
      logger.info('Added id column to data_sets table');
    } else {
      // Check if column needs to be resized (old format was 11 chars, new is 12)
      const columnInfo = await queryRunner.query(`
        SELECT character_maximum_length 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'data_sets' 
        AND column_name = 'id'
      `);
      
      const currentLength = columnInfo[0]?.character_maximum_length;
      if (currentLength && currentLength < 12) {
        await queryRunner.query('ALTER TABLE data_sets ALTER COLUMN id TYPE VARCHAR(12)');
        logger.info('Resized id column from VARCHAR(11) to VARCHAR(12)');
      }
    }

    // Check for NULL values
    const nullCountResult = await queryRunner.query(
      'SELECT COUNT(*) as count FROM data_sets WHERE id IS NULL'
    );
    const nullCount = parseInt(nullCountResult[0]?.count || '0', 10);

    if (nullCount > 0) {
      // For clean installs, just delete rows with NULL IDs (they're orphaned data)
      const totalCountResult = await queryRunner.query(
        'SELECT COUNT(*) as count FROM data_sets'
      );
      const totalCount = parseInt(totalCountResult[0]?.count || '0', 10);
      
      if (nullCount === totalCount) {
        // All rows have NULL IDs - this is likely stale data from a failed migration
        logger.info(`All ${nullCount} rows have NULL IDs, deleting stale data for clean install...`);
        await queryRunner.query('DELETE FROM data_sets WHERE id IS NULL');
        logger.info('Deleted stale data_sets rows with NULL IDs');
      } else {
        // Some rows have IDs, some don't - try to generate IDs for NULL rows
        logger.info(`Found ${nullCount} rows with NULL id, generating IDs...`);
        
        // Import DataSetIdGenerator dynamically to avoid circular dependencies
        const { DataSetIdGenerator } = await import('../services/DataSetIdGenerator');
        
        // Get rows with NULL IDs
        const nullRows = await queryRunner.query(
          'SELECT ctid FROM data_sets WHERE id IS NULL ORDER BY "createdAt" NULLS LAST, ctid'
        );

        // Generate and assign IDs
        for (const row of nullRows) {
          let newId: string;
          let attempts = 0;
          const maxAttempts = 10;

          // Ensure uniqueness
          do {
            newId = DataSetIdGenerator.generate();
            attempts++;

            if (attempts > maxAttempts) {
              throw new Error('Failed to generate unique ID after multiple attempts');
            }

            const checkResult = await queryRunner.query(
              'SELECT 1 FROM data_sets WHERE id = $1',
              [newId]
            );

            if (checkResult.length === 0) {
              break; // Unique ID found
            }
          } while (true);

          // Update the row
          await queryRunner.query('UPDATE data_sets SET id = $1 WHERE ctid = $2', [
            newId,
            row.ctid,
          ]);
        }

        logger.info(`Generated IDs for ${nullRows.length} rows`);
      }
    }

    // Ensure NOT NULL constraint
    const nullableCheck = await queryRunner.query(`
      SELECT is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'data_sets' 
      AND column_name = 'id'
    `);

    if (nullableCheck[0]?.is_nullable === 'YES') {
      // Verify no NULL values before making NOT NULL
      const finalNullCheck = await queryRunner.query(
        'SELECT COUNT(*) as count FROM data_sets WHERE id IS NULL'
      );
      
      if (parseInt(finalNullCheck[0]?.count || '0', 10) > 0) {
        throw new Error('Cannot make id NOT NULL: some rows still have NULL values');
      }

      await queryRunner.query('ALTER TABLE data_sets ALTER COLUMN id SET NOT NULL');
      logger.info('Set id column to NOT NULL');
    }

    // Ensure PRIMARY KEY constraint
    const pkCheck = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'data_sets_pkey' 
        OR (contype = 'p' AND conrelid = 'data_sets'::regclass)
      ) as has_pk
    `);

    if (!pkCheck[0]?.has_pk) {
      await queryRunner.query('ALTER TABLE data_sets ADD PRIMARY KEY (id)');
      logger.info('Set id as PRIMARY KEY');
    }
  } catch (error: any) {
    logger.error('Error fixing data_sets.id column:', error.message);
    // Don't throw - let TypeORM handle it, but log the error
    // The migration script can be run manually if needed
  } finally {
    await queryRunner.release();
  }
}

/**
 * Fix data_sources.id column migration
 * Ensures all rows have IDs before TypeORM tries to make the column NOT NULL.
 * This handles the transition from the old schema (auto-generated UUID/integer PK)
 * to the new schema (varchar(12) custom IDs like vol-xxxxxxxx / cn-xxxxxxxx).
 */
async function fixDataSourceIdColumn(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();

  try {
    const tableExists = await queryRunner.hasTable('data_sources');
    if (!tableExists) {
      logger.info('[fixDataSourceId] data_sources table does not exist, skipping');
      return;
    }

    // Inspect current column state
    const colInfo = await queryRunner.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'data_sources' AND column_name = 'id'
    `);
    logger.info('[fixDataSourceId] Current id column info:', JSON.stringify(colInfo));

    // Check which columns exist for safe queries
    const allCols = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'data_sources'
    `);
    const colNames = new Set(allCols.map((c: any) => c.column_name));
    logger.info('[fixDataSourceId] Available columns:', Array.from(colNames).join(', '));

    const hasTypeCol = colNames.has('type');
    const hasCreatedAt = colNames.has('created_at');
    const hasCreatedAtCamel = colNames.has('createdAt');

    if (colInfo.length === 0) {
      // id column does not exist at all — add it as nullable
      await queryRunner.query('ALTER TABLE data_sources ADD COLUMN id VARCHAR(12)');
      logger.info('[fixDataSourceId] Added id column (VARCHAR(12), nullable)');
    } else {
      const dataType = colInfo[0].data_type;
      const maxLen = colInfo[0].character_maximum_length;

      // If column type is not varchar/character varying, or is too short, fix it
      if (dataType === 'uuid' || dataType === 'integer' || dataType === 'bigint') {
        logger.info(`[fixDataSourceId] id column is ${dataType}, converting to VARCHAR(12)...`);
        // Drop PK constraint first if it references the old column
        await dropDataSourcesPrimaryKey(queryRunner);
        // Drop NOT NULL to allow the conversion
        await queryRunner.query('ALTER TABLE data_sources ALTER COLUMN id DROP NOT NULL').catch(() => {});
        // Set existing values to NULL (they won't fit varchar(12) format)
        await queryRunner.query('ALTER TABLE data_sources ALTER COLUMN id DROP DEFAULT').catch(() => {});
        await queryRunner.query('ALTER TABLE data_sources ALTER COLUMN id TYPE VARCHAR(12) USING NULL');
        logger.info('[fixDataSourceId] Converted id column to VARCHAR(12), existing values set to NULL');
      } else if (maxLen && maxLen < 12) {
        await queryRunner.query('ALTER TABLE data_sources ALTER COLUMN id TYPE VARCHAR(12)');
        logger.info(`[fixDataSourceId] Resized id from VARCHAR(${maxLen}) to VARCHAR(12)`);
      }
    }

    // Count rows and NULLs
    const totalResult = await queryRunner.query('SELECT COUNT(*) as count FROM data_sources');
    const totalCount = parseInt(totalResult[0]?.count || '0', 10);
    const nullResult = await queryRunner.query('SELECT COUNT(*) as count FROM data_sources WHERE id IS NULL');
    const nullCount = parseInt(nullResult[0]?.count || '0', 10);
    logger.info(`[fixDataSourceId] Total rows: ${totalCount}, rows with NULL id: ${nullCount}`);

    if (nullCount > 0) {
      if (nullCount === totalCount) {
        // All rows missing IDs — safe to delete (stale data from old schema)
        logger.info(`[fixDataSourceId] All ${nullCount} rows have NULL IDs, deleting for clean migration...`);
        // Delete dependent rows from child tables first (FK constraints)
        for (const childTable of ['deployment_assignments', 'bucket_healths', 'data_source_histories']) {
          try {
            const hasChild = await queryRunner.hasTable(childTable);
            if (hasChild) {
              // Find the FK column name referencing data_sources
              const fkCol = await queryRunner.query(`
                SELECT a.attname AS col_name
                FROM pg_constraint con
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
                JOIN pg_class cls ON cls.oid = con.conrelid
                WHERE con.contype = 'f' AND con.confrelid = 'data_sources'::regclass
                  AND cls.relname = $1
              `, [childTable]);
              if (fkCol.length > 0) {
                await queryRunner.query(`DELETE FROM "${childTable}"`);
                logger.info(`[fixDataSourceId] Cleared child table ${childTable}`);
              }
            }
          } catch (e: any) {
            logger.info(`[fixDataSourceId] Could not clear ${childTable}: ${e.message}`);
          }
        }
        await queryRunner.query('DELETE FROM data_sources WHERE id IS NULL');
        logger.info('[fixDataSourceId] Deleted all rows with NULL IDs');
      } else {
        // Generate IDs for rows missing them
        logger.info(`[fixDataSourceId] Generating IDs for ${nullCount} rows...`);
        const { ConnectorIdGenerator } = await import('../services/ConnectorIdGenerator');
        const { VolumeIdGenerator } = await import('../services/VolumeIdGenerator');

        // Build a safe query that doesn't rely on columns that may not exist
        let orderClause = 'ctid';
        if (hasCreatedAt) orderClause = 'created_at NULLS LAST, ctid';
        else if (hasCreatedAtCamel) orderClause = '"createdAt" NULLS LAST, ctid';

        const selectCols = hasTypeCol ? 'ctid, type' : 'ctid';
        const nullRows = await queryRunner.query(
          `SELECT ${selectCols} FROM data_sources WHERE id IS NULL ORDER BY ${orderClause}`
        );

        for (const row of nullRows) {
          const rowType = hasTypeCol ? row.type : 'volume';
          const newId = rowType === 'connector'
            ? ConnectorIdGenerator.generate()
            : VolumeIdGenerator.generate();

          await queryRunner.query('UPDATE data_sources SET id = $1 WHERE ctid = $2', [newId, row.ctid]);
        }
        logger.info(`[fixDataSourceId] Generated IDs for ${nullRows.length} rows`);
      }
    }

    // Verify no NULLs remain
    const finalNullResult = await queryRunner.query('SELECT COUNT(*) as count FROM data_sources WHERE id IS NULL');
    const finalNullCount = parseInt(finalNullResult[0]?.count || '0', 10);
    if (finalNullCount > 0) {
      throw new Error(`[fixDataSourceId] Still have ${finalNullCount} NULL id values after fix attempt`);
    }

    // Ensure NOT NULL
    const nullableCheck = await queryRunner.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'data_sources' AND column_name = 'id'
    `);
    if (nullableCheck[0]?.is_nullable === 'YES') {
      await queryRunner.query('ALTER TABLE data_sources ALTER COLUMN id SET NOT NULL');
      logger.info('[fixDataSourceId] Set id to NOT NULL');
    }

    // Ensure PK is on `id` column specifically
    const pkCols = await queryRunner.query(`
      SELECT a.attname as column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'data_sources'::regclass AND i.indisprimary
    `);

    if (pkCols.length === 0) {
      await queryRunner.query('ALTER TABLE data_sources ADD PRIMARY KEY (id)');
      logger.info('[fixDataSourceId] Added PRIMARY KEY on id');
    } else if (pkCols.length !== 1 || pkCols[0].column_name !== 'id') {
      // PK exists but on wrong column(s) — drop and recreate
      logger.info(`[fixDataSourceId] PK is on [${pkCols.map((c: any) => c.column_name).join(', ')}], need it on [id]`);
      await dropDataSourcesPrimaryKey(queryRunner);
      await queryRunner.query('ALTER TABLE data_sources ADD PRIMARY KEY (id)');
      logger.info('[fixDataSourceId] Replaced PRIMARY KEY to be on id');
    }

    logger.info('[fixDataSourceId] Migration complete');
  } finally {
    await queryRunner.release();
  }
}

async function dropDataSourcesPrimaryKey(queryRunner: any): Promise<void> {
  // Find and log all FK constraints that reference data_sources (they will be dropped by CASCADE)
  const dependentFKs = await queryRunner.query(`
    SELECT con.conname AS fk_name, cls.relname AS from_table
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE con.contype = 'f'
      AND con.confrelid = 'data_sources'::regclass
  `);
  if (dependentFKs.length > 0) {
    logger.info(`[fixDataSourceId] Dependent FK constraints that will be dropped by CASCADE:`,
      dependentFKs.map((fk: any) => `${fk.from_table}.${fk.fk_name}`).join(', '));
  }

  const pkConstraint = await queryRunner.query(`
    SELECT conname FROM pg_constraint
    WHERE contype = 'p' AND conrelid = 'data_sources'::regclass
  `);
  if (pkConstraint.length > 0) {
    const constraintName = pkConstraint[0].conname;
    await queryRunner.query(`ALTER TABLE data_sources DROP CONSTRAINT "${constraintName}" CASCADE`);
    logger.info(`[fixDataSourceId] Dropped PK constraint ${constraintName} with CASCADE`);
  }
}

async function addManagedMCPServerColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mcp_servers')`
    );
    if (!tableExists[0]?.exists) return;

    const cols = [
      { name: 'deploymentType', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "deploymentType" VARCHAR(20) NOT NULL DEFAULT 'remote'` },
      { name: 'catalogId', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "catalogId" TEXT` },
      { name: 'managedConfig', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "managedConfig" JSONB` },
      { name: 'k8sResourceName', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "k8sResourceName" TEXT` },
      { name: 'runtimeStatus', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "runtimeStatus" VARCHAR(20)` },
      { name: 'runtimeCredentialId', sql: `ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "runtimeCredentialId" UUID` },
    ];
    for (const col of cols) await qr.query(col.sql);
    logger.info('[Migration] Managed MCP server columns ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding managed MCP columns:', e.message);
  } finally {
    await qr.release();
  }
}

async function addServerInstructionsColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mcp_servers')`
    );
    if (!tableExists[0]?.exists) return;

    await qr.query(`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "serverInstructions" TEXT`);
    logger.info('[Migration] serverInstructions column ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding serverInstructions column:', e.message);
  } finally {
    await qr.release();
  }
}

async function addRemoteMCPConnectionColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mcp_servers')`
    );
    if (!tableExists[0]?.exists) return;

    await qr.query(`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "queryParams" JSONB`);
    await qr.query(`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "headerParams" JSONB`);
    await qr.query(`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "authConfig" JSONB`);
    logger.info('[Migration] Remote MCP connection columns ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding remote MCP connection columns:', e.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add projects.init_status / init_error so a failed async project init is
 * visible on the row. Existing rows predate the feature and are assumed
 * provisioned, so they are backfilled to 'ready' (the column default
 * 'provisioning' only applies to brand-new inserts).
 */
async function ensureProjectInitStatusColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'projects')`
    );
    if (!tableExists[0]?.exists) return;

    const columnExisted = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'projects' AND column_name = 'init_status')`
    );

    await qr.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS init_status VARCHAR(20) NOT NULL DEFAULT 'provisioning'`
    );
    await qr.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS init_error TEXT`);

    // Only backfill on first introduction of the column, so we don't clobber
    // genuine 'provisioning'/'failed' states written by the workflow on reruns.
    if (!columnExisted[0]?.exists) {
      const res = await qr.query(`UPDATE projects SET init_status = 'ready' WHERE init_status = 'provisioning'`);
      const affected =
        (res as { rowCount?: number })?.rowCount ??
        (Array.isArray(res) && typeof res[1] === 'number' ? res[1] : 0);
      logger.info(`[Migration] projects.init_status backfilled ${affected} existing row(s) to 'ready'`);
    }
    logger.info('[Migration] projects.init_status / init_error columns ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding projects.init_status columns:', e.message);
  } finally {
    await qr.release();
  }
}

async function addDataSourceMountHealthColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'data_sources')`
    );
    if (!tableExists[0]?.exists) return;

    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS mount_health JSONB`);
    logger.info('[Migration] data_sources.mount_health column ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding data_sources.mount_health:', e.message);
  } finally {
    await qr.release();
  }
}

async function addDataSourceScanColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'data_sources')`
    );
    if (!tableExists[0]?.exists) return;

    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS scan_config JSONB`);
    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS scan_status JSONB`);
    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS scan_result JSONB`);
    console.log('[Migration] data_sources.scan_config / scan_status / scan_result columns ready');
  } catch (e: any) {
    console.error('[Migration] Error adding data_sources scan columns:', e.message);
  } finally {
    await qr.release();
  }
}

async function addCredentialLifecycleColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credentials')`
    );
    if (!tableExists[0]?.exists) return;

    await qr.query(`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS description TEXT`);
    await qr.query(`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP`);
    await qr.query(`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS "lastRotatedAt" TIMESTAMP`);
    await qr.query(`ALTER TABLE credentials ADD COLUMN IF NOT EXISTS "rotationVersion" INTEGER NOT NULL DEFAULT 1`);
    logger.info('[Migration] Credential lifecycle columns ready');
  } catch (e: any) {
    logger.error('[Migration] Error adding credential lifecycle columns:', e.message);
  } finally {
    await qr.release();
  }
}

async function migrateLegacyTeamTables(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const teamTableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_teams')`
    );
    if (teamTableExists[0]?.exists) return;

    const oldTeamTableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_groups')`
    );
    if (oldTeamTableExists[0]?.exists) {
      await qr.query(`ALTER TABLE agent_groups RENAME TO agent_teams`);
      logger.info('[Migration] Renamed table agent_groups -> agent_teams');
    } else {
      await qr.query(`
        CREATE TABLE IF NOT EXISTS agent_teams (
          id VARCHAR(12) PRIMARY KEY,
          "projectId" VARCHAR NOT NULL,
          name VARCHAR NOT NULL,
          description TEXT,
          "orchestrationPolicy" VARCHAR(20) NOT NULL DEFAULT 'coordinate',
          manager JSONB,
          members JSONB NOT NULL DEFAULT '[]',
          "sharedKnowledgeBaseIds" JSONB NOT NULL DEFAULT '[]',
          "sharedDatasetIds" JSONB NOT NULL DEFAULT '[]',
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
          UNIQUE ("projectId", name)
        )
      `);
      logger.info('[Migration] Created table agent_teams');
    }

    const historyTableExists = await qr.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_team_history')`
    );
    if (!historyTableExists[0]?.exists) {
      const oldHistoryTableExists = await qr.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_group_history')`
      );
      if (oldHistoryTableExists[0]?.exists) {
        await qr.query(`ALTER TABLE agent_group_history RENAME TO agent_team_history`);
        logger.info('[Migration] Renamed table agent_group_history -> agent_team_history');
      } else {
        await qr.query(`
          CREATE TABLE IF NOT EXISTS agent_team_history (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            "entityId" VARCHAR(12) NOT NULL REFERENCES agent_teams(id) ON DELETE CASCADE,
            version INT NOT NULL,
            data JSONB NOT NULL,
            "modifiedAt" TIMESTAMP NOT NULL DEFAULT now(),
            "modifiedBy" TEXT,
            op TEXT,
            UNIQUE ("entityId", version)
          )
        `);
        logger.info('[Migration] Created table agent_team_history');
      }
    }
  } catch (e: any) {
    logger.error('[Migration] Error migrating agent groups to agent teams:', e.message);
  } finally {
    await qr.release();
  }
}

async function addModelClassColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const modelsTable = await qr.getTable('models');
    if (modelsTable && !modelsTable.columns.find(c => c.name === 'modelClass')) {
      await qr.query('ALTER TABLE models ADD COLUMN "modelClass" varchar');
      logger.info('[Migration] Added modelClass column to models table');
    }
    const agentsTable = await qr.getTable('agents');
    if (agentsTable) {
      if (!agentsTable.columns.find(c => c.name === 'modelClass')) {
        await qr.query('ALTER TABLE agents ADD COLUMN "modelClass" varchar');
        logger.info('[Migration] Added modelClass column to agents table');
      }
      const modelIdCol = agentsTable.columns.find(c => c.name === 'modelId');
      if (modelIdCol && !modelIdCol.isNullable) {
        await qr.query('ALTER TABLE agents ALTER COLUMN "modelId" DROP NOT NULL');
        logger.info('[Migration] Made agents.modelId nullable');
      }
    }
  } finally {
    await qr.release();
  }
}

/**
 * Add rate-limit and pricing columns to the `models` table. All columns
 * are nullable so legacy rows are unaffected. Idempotent via
 * `ADD COLUMN IF NOT EXISTS`. Required in production where TypeORM
 * synchronize is disabled.
 */
async function addModelRateLimitAndPricingColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const modelsTable = await qr.getTable('models');
    if (!modelsTable) return;

    const statements: string[] = [
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS rpm integer',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS tpm integer',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS "spendingLimit" double precision',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS "spendingLimitPeriod" varchar(8)',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS "inputCostPer1M" double precision',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS "outputCostPer1M" double precision',
      'ALTER TABLE models ADD COLUMN IF NOT EXISTS "markupPercent" double precision',
    ];
    for (const sql of statements) await qr.query(sql);
    console.log('[Migration] models rate-limit + pricing columns ready');
  } catch (e: any) {
    console.error('[Migration] addModelRateLimitAndPricingColumns:', e.message);
  } finally {
    await qr.release();
  }
}

/** Quote a verified identifier fragment for raw SQL (only alnum + underscore). */
function pgIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`[Migration] Invalid knowledge_bases column name: ${name}`);
  }
  return `"${name.replace(/"/g, '')}"`;
}

/** Raw row from information_schema.columns (driver key casing varies). */
function physicalColumnName(r: Record<string, unknown>): string | undefined {
  const v = r.column_name ?? r.COLUMN_NAME;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Match physical column names to a logical KB field (handles camelCase vs snake_case). */
function knowledgeBaseColumnsMatching(
  colRows: ReadonlyArray<Record<string, unknown>>,
  kind: 'sourceDataset' | 'embeddingModel' | 'chunkSize' | 'vectorSize',
): string[] {
  const names = colRows.map((r) => physicalColumnName(r)).filter((n): n is string => Boolean(n));
  const norm = (n: string) => n.toLowerCase().replace(/_/g, '');
  const want =
    kind === 'sourceDataset'
      ? new Set(['sourcedataset'])
      : kind === 'embeddingModel'
        ? new Set(['embeddingmodel'])
        : kind === 'chunkSize'
          ? new Set(['chunksize'])
          : new Set(['vectorsize']);
  return names.filter((n) => want.has(norm(n)));
}

/** Parse COUNT(*) first row — drivers return `n`, `count`, `COUNT`, etc. */
function parseCountRow(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const r = rows[0] as Record<string, unknown>;
  const v =
    r.n ??
    r.N ??
    r.count ??
    r.COUNT ??
    r.cnt ??
    r.CNT ??
    Object.values(r)[0];
  return parseInt(String(v ?? '0'), 10);
}

/** `SELECT EXISTS (...)` — pg may return boolean or `'t'` / `'f'`. */
function parseExistsRow(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const r = rows[0] as Record<string, unknown>;
  const v = r.exists ?? r.EXISTS;
  if (v === true || v === 't' || v === 'true' || v === 1) return true;
  if (v === false || v === 'f' || v === 'false' || v === 0) return false;
  return Boolean(v);
}

/**
 * Backfill knowledge_bases columns that must be NOT NULL for TypeORM sync
 * but may be NULL on legacy rows.
 *
 * Uses an explicit `QueryRunner.connect()` so we own the underlying pg
 * Client (avoids pg@8+ concurrent-query deprecation), and emits per-step
 * diagnostics so we can see exactly which physical columns existed and
 * how many NULLs were patched.
 */
async function backfillKnowledgeBaseRequiredFields(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  await qr.connect();
  const q = (sql: string, params?: unknown[]) => qr.query(sql, params);

  try {
    const tableExists = await q(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knowledge_bases')`,
    );
    if (!parseExistsRow(tableExists)) {
      logger.info('[Migration] knowledge_bases table not present; nothing to backfill');
      return;
    }

    const colRows: Record<string, unknown>[] = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'knowledge_bases'`,
    );
    const cols = new Set(
      colRows.map((r) => physicalColumnName(r)).filter((n): n is string => Boolean(n)),
    );
    if (cols.size > 0) {
      logger.info(`[Migration] knowledge_bases columns: ${[...cols].sort().join(', ')}`);
    }

    // Placeholder must fit legacy VARCHAR(12) columns (some DBs tightened
    // types before TEXT). 9 chars is conservative.
    const LEGACY = '__unset__';

    async function nullCount(physicalCol: string): Promise<number> {
      const id = pgIdent(physicalCol);
      const r = await q(`SELECT COUNT(*)::int AS n FROM knowledge_bases WHERE ${id} IS NULL`);
      return parseCountRow(r);
    }

    async function backfillCol(
      logical: string,
      physicalCol: string,
      placeholder: string | number,
    ): Promise<void> {
      const id = pgIdent(physicalCol);
      const before = await nullCount(physicalCol);
      if (before === 0) {
        logger.info(`[Migration] ${logical} (physical "${physicalCol}"): 0 NULLs — nothing to do`);
        return;
      }
      await q(`UPDATE knowledge_bases SET ${id} = $1 WHERE ${id} IS NULL`, [placeholder]);
      const after = await nullCount(physicalCol);
      logger.info(
        `[Migration] Backfilled ${logical} (physical "${physicalCol}"): ${before} -> ${after} NULL(s)`,
      );
      if (after > 0) {
        throw new Error(
          `[Migration] ${physicalCol} still has ${after} NULL row(s) after backfill`,
        );
      }
    }

    // ---- sourceDataset (must be NOT NULL after sync) ----
    if (!cols.has('sourceDataset')) {
      logger.info(
        '[Migration] knowledge_bases: column "sourceDataset" missing — adding it (TypeORM contract)',
      );
      await q(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS "sourceDataset" TEXT`);
      cols.add('sourceDataset');
    }
    // Backfill TypeORM's canonical column.
    await backfillCol('sourceDataset', 'sourceDataset', LEGACY);
    // Mirror to any alias variants (snake_case etc.) so ad-hoc queries stay sane.
    for (const alias of knowledgeBaseColumnsMatching(colRows, 'sourceDataset')) {
      if (alias === 'sourceDataset') continue;
      try {
        await backfillCol(`sourceDataset(alias)`, alias, LEGACY);
      } catch (e: any) {
        logger.warn(
          `[Migration] Skipping alias "${alias}" backfill: ${e.message ?? e}`,
        );
      }
    }
    // Make the column NOT NULL up-front so TypeORM's sync sees zero work.
    try {
      await q(`ALTER TABLE knowledge_bases ALTER COLUMN "sourceDataset" SET NOT NULL`);
    } catch (e: any) {
      // Already NOT NULL → fine. Anything else (e.g. ‘still contains nulls’) → re-throw.
      if (!/cannot/i.test(String(e?.message))) {
        // e.g. "column ... is already NOT NULL" — log and continue
        logger.info(
          `[Migration] knowledge_bases."sourceDataset" SET NOT NULL: ${e?.message ?? e}`,
        );
      } else {
        throw e;
      }
    }

    // ---- embeddingModel (NOT NULL contract too) ----
    if (cols.has('embeddingModel')) {
      await backfillCol('embeddingModel', 'embeddingModel', LEGACY);
    } else {
      for (const alias of knowledgeBaseColumnsMatching(colRows, 'embeddingModel')) {
        await backfillCol(`embeddingModel(alias)`, alias, LEGACY);
      }
    }

    // ---- chunkSize / vectorSize (NOT NULL ints) ----
    for (const physical of knowledgeBaseColumnsMatching(colRows, 'chunkSize')) {
      await backfillCol('chunkSize', physical, 512);
    }
    for (const physical of knowledgeBaseColumnsMatching(colRows, 'vectorSize')) {
      await backfillCol('vectorSize', physical, 1536);
    }
  } catch (error: any) {
    logger.error('[Migration] Error backfilling knowledge_bases required fields:', error.message);
    throw error;
  } finally {
    await qr.release().catch(() => {});
  }
}

/**
 * Ensure the reference_edges table exists. Used to power the "Used by"
 * column, dependents popover, and delete-blocker payload.
 *
 * Idempotent: safe to run on every startup. Required in production where
 * TypeORM synchronize is disabled.
 */
/** Add consecutiveFailures + suspended syncStatus for MCP health circuit breaker (idempotent). */
async function addMCPConsecutiveFailuresColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('mcp_servers');
    if (!tableExists) return;
    const rows = await qr.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mcp_servers' AND column_name = 'consecutiveFailures'`,
    );
    if (!rows?.length) {
      await qr.query(
        `ALTER TABLE mcp_servers ADD COLUMN "consecutiveFailures" integer NOT NULL DEFAULT 0`,
      );
      logger.info('[Migration] Added mcp_servers."consecutiveFailures"');
    }
  } catch (error: any) {
    logger.error('[Migration] addMCPConsecutiveFailuresColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add refresh_config JSONB column to data_sets (idempotent).
 *
 * `DataSet.refreshConfig` is mapped to a physical column `refresh_config`
 * via the entity decorator. In production TypeORM synchronize is disabled,
 * so create/update that touches refreshConfig fails until this column
 * exists.
 */
async function ensureDataSetRefreshConfigColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('data_sets');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS refresh_config JSONB`);
    console.log('[Migration] data_sets.refresh_config column ready');
  } catch (error: any) {
    console.error('[Migration] ensureDataSetRefreshConfigColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the `modified_by` column to data_sources (idempotent).
 *
 * Tracks the subject of the user who last created/updated the data source.
 * In production TypeORM synchronize is disabled, so the column must be added
 * here before the entity that maps `modifiedBy` is used.
 */
async function ensureDataSourceModifiedByColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('data_sources');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS modified_by VARCHAR`);
    console.log('[Migration] data_sources.modified_by column ready');
  } catch (error: any) {
    console.error('[Migration] ensureDataSourceModifiedByColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the `deprecated` boolean column to data_sources (idempotent).
 *
 * Backs the soft-retire ("Deprecate") action on the data source list/detail.
 * In production TypeORM synchronize is disabled, so the column must be added
 * here before the entity that maps `deprecated` is used; otherwise the update
 * that toggles it is silently dropped.
 */
async function ensureDataSourceDeprecatedColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('data_sources');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS deprecated BOOLEAN NOT NULL DEFAULT false`);
    console.log('[Migration] data_sources.deprecated column ready');
  } catch (error: any) {
    console.error('[Migration] ensureDataSourceDeprecatedColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add modified_by / stats / latest_snapshot columns to data_sets (idempotent).
 *
 * `modified_by` tracks the last editor; `stats` and `latest_snapshot` hold the
 * summary captured at import completion so list/detail reads avoid catalog
 * calls. Required in production where TypeORM synchronize is disabled.
 */
async function ensureDataSetSummaryColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('data_sets');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS modified_by VARCHAR`);
    await qr.query(`ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS stats JSONB`);
    await qr.query(`ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS latest_snapshot JSONB`);
    console.log('[Migration] data_sets summary columns (modified_by, stats, latest_snapshot) ready');
  } catch (error: any) {
    console.error('[Migration] ensureDataSetSummaryColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add synchronization_config / scheduleConfig / lastSyncedAt columns to
 * knowledge_bases (idempotent).
 *
 * These fields back the KB synchronization API (manual / after_dataset_updates
 * / scheduled). Without the columns, KB create/update writes fail in
 * production where TypeORM synchronize is disabled.
 */
async function ensureKnowledgeBaseSyncColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('knowledge_bases');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS synchronization_config JSONB`);
    await qr.query(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS "scheduleConfig" JSONB`);
    await qr.query(`ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS "lastSyncedAt" TEXT`);
    console.log('[Migration] knowledge_bases sync columns (synchronization_config, scheduleConfig, lastSyncedAt) ready');
  } catch (error: any) {
    console.error('[Migration] ensureKnowledgeBaseSyncColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the `labels` TEXT[] column to data_sources, data_sets, and
 * knowledge_bases (idempotent).
 *
 * Backs the new `labels` field on the create/update APIs for these entities.
 * In production TypeORM synchronize is disabled, so writes that touch
 * `labels` fail until this column exists.
 */
async function ensureEntityLabelsColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    for (const table of [
      'data_sources',
      'data_sets',
      'knowledge_bases',
      'agents',
      'agent_teams',
    ]) {
      const tableExists = await qr.hasTable(table);
      if (!tableExists) continue;
      await qr.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS labels TEXT[]`);
    }
    console.log(
      '[Migration] labels columns ready on data_sources / data_sets / knowledge_bases / agents / agent_teams',
    );
  } catch (error: any) {
    console.error('[Migration] ensureEntityLabelsColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the new agent configuration cards to the `agents` table (idempotent).
 *
 * These columns back the namespaced cards that coexist with the legacy
 * `temperature` / `maxTokens` / `outcomeSchema` / `memoryType` /
 * `memoryConfig` / `guardrails` columns. Column names are snake_case to
 * match the user-facing spec; the entity decorator maps each one to a
 * camelCase TS property.
 */
async function ensureAgentConfigCardsColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agents');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS goal TEXT`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS top_p DOUBLE PRECISION`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS top_k INTEGER`);
    await qr.query(
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS fallback_model_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS fallback_model_params JSONB`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS output_response JSONB`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS structured_output JSONB`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_context JSONB`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS retries JSONB`);
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS rate_limiting JSONB`);
    console.log(
      '[Migration] agents config-card columns (goal, top_p, top_k, fallback_model_ids, fallback_model_params, output_response, structured_output, memory_context, retries, rate_limiting) ready',
    );
  } catch (error: any) {
    console.error('[Migration] ensureAgentConfigCardsColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the `a2a_server` JSONB column to `agent_teams` (idempotent). Backs the
 * Agent-to-Agent external server endpoint card.
 */
async function ensureAgentTeamA2AServerColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agent_teams');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS a2a_server JSONB`);
    console.log('[Migration] agent_teams.a2a_server column ready');
  } catch (error: any) {
    console.error('[Migration] ensureAgentTeamA2AServerColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add lifecycle / deployment-status columns to `agents` (idempotent).
 *
 * `status` is the simple health pill (`Healthy` / `Unhealthy`); detailed
 * lifecycle lives on `deployment_status` (`draft` / `preview` /
 * `not_deployed` / `deploying` / `deployed` / `failed` / `terminating` /
 * `terminated`).
 */
async function ensureAgentLifecycleColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agents');
    if (!tableExists) {
      return;
    }
    await qr.query(
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Healthy'`,
    );
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_message TEXT`);
    await qr.query(
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(30) NOT NULL DEFAULT 'not_deployed'`,
    );
    console.log(
      '[Migration] agents lifecycle columns (status, status_message, deployment_status) ready',
    );
  } catch (error: any) {
    console.error('[Migration] ensureAgentLifecycleColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the figma-update columns to `agents` (idempotent):
 *   - function_choice_behavior (default 'auto')
 *   - termination_strategy (jsonb)
 *
 * `labels` is handled by `ensureEntityLabelsColumns` (TEXT[]) so it
 * matches the convention used by data_sources / data_sets / knowledge_bases.
 *
 * The new shapes for `memory_context` and the unified `guardrails` column are
 * JSONB-only changes (no DDL needed). Existing rows with the older shape
 * continue to round-trip through GET, but writes against the new validators
 * will reject the legacy shape until the row is overwritten.
 */
async function ensureAgentFigmaUpdateColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agents');
    if (!tableExists) {
      return;
    }
    await qr.query(
      `ALTER TABLE agents ADD COLUMN IF NOT EXISTS function_choice_behavior VARCHAR(20) NOT NULL DEFAULT 'auto'`,
    );
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS termination_strategy JSONB`);
    // `labels` is intentionally NOT created here -- it is handled by
    // `ensureEntityLabelsColumns` above so agents/agent_teams use the same
    // TEXT[] storage as data_sources / data_sets / knowledge_bases.
    console.log(
      '[Migration] agents figma-update columns (function_choice_behavior, termination_strategy) ready',
    );
  } catch (error: any) {
    console.error('[Migration] ensureAgentFigmaUpdateColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the figma-update columns to `agent_teams` (idempotent):
 *   - termination_strategy (jsonb)
 *
 * `labels` is handled by `ensureEntityLabelsColumns` (TEXT[]) so it matches
 * the convention used by the other label-bearing tables.
 */
async function ensureAgentTeamFigmaUpdateColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agent_teams');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS termination_strategy JSONB`);
    // `labels` is intentionally NOT created here -- see
    // `ensureEntityLabelsColumns`, which now also covers agent_teams.
    console.log(
      '[Migration] agent_teams figma-update columns (termination_strategy) ready',
    );
  } catch (error: any) {
    console.error('[Migration] ensureAgentTeamFigmaUpdateColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add the `requirements` JSONB column to `agents` (idempotent).
 *
 * Holds declarative KB / MCP-server placeholders (`AgentRequirements` /
 * `AgentResourceRequirement`) — agent attachments that haven't been
 * bound to concrete ids yet. Nullable, no backfill: legacy rows read
 * back as `requirements: null` and are unaffected.
 *
 * Must run BEFORE TypeORM synchronize so production (synchronize=false)
 * gets the column too.
 */
async function ensureAgentRequirementsColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agents');
    if (!tableExists) {
      return;
    }
    await qr.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS requirements JSONB`);
    console.log('[Migration] agents.requirements column ready');
  } catch (error: any) {
    console.error('[Migration] ensureAgentRequirementsColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/** Mirrors `ensureAgentLifecycleColumns` for the `agent_teams` table. */
async function ensureAgentTeamLifecycleColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agent_teams');
    if (!tableExists) {
      return;
    }
    await qr.query(
      `ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'Healthy'`,
    );
    await qr.query(`ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS status_message TEXT`);
    await qr.query(
      `ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(30) NOT NULL DEFAULT 'not_deployed'`,
    );
    console.log(
      '[Migration] agent_teams lifecycle columns (status, status_message, deployment_status) ready',
    );
  } catch (error: any) {
    console.error('[Migration] ensureAgentTeamLifecycleColumns:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Add `memory_context` jsonb column on `agent_teams` so teams can carry the
 * unified MemoryContext schema (LangChain-style `type: window | summary |
 * summary_buffer | none` + limits + budget). Mirrors the existing
 * `agents.memory_context` column.
 *
 * No data backfill — existing rows remain `NULL`. MAF's dual-read fallback
 * derives a MemoryContext from the legacy `memoryType` + `memoryConfig`
 * columns when this is empty, so behavior is preserved during the transition.
 */
async function ensureAgentTeamMemoryContextColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('agent_teams');
    if (!tableExists) {
      return;
    }
    await qr.query(
      `ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS memory_context jsonb`,
    );
    console.log('[Migration] agent_teams.memory_context column ready');
  } catch (error: any) {
    console.error('[Migration] ensureAgentTeamMemoryContextColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/** Add originVolume for ONTAP/POSIX-backed dataset acquisition (idempotent). */
async function ensureDataSetOriginVolumeColumn(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const tableExists = await qr.hasTable('data_sets');
    if (!tableExists) {
      return;
    }
    const rows = await qr.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'data_sets' AND column_name = 'originVolume'`,
    );
    if (!rows?.length) {
      await qr.query(
        `ALTER TABLE data_sets ADD COLUMN IF NOT EXISTS "originVolume" character varying(12)`,
      );
      logger.info('[Migration] Added data_sets."originVolume"');
    }
  } catch (error: any) {
    logger.error('[Migration] ensureDataSetOriginVolumeColumn:', error.message);
  } finally {
    await qr.release();
  }
}

/**
 * Ensure the model_providers table exists. One row per (projectId, providerId).
 * Idempotent: safe to run on every startup. Required in production where
 * TypeORM synchronize is disabled.
 */
async function ensureModelProvidersTable(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS model_providers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "projectId" VARCHAR NOT NULL,
        "providerId" VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        "connectionStatus" VARCHAR NOT NULL DEFAULT 'unknown',
        concurrency INTEGER NOT NULL DEFAULT 1000,
        "bufferSize" INTEGER NOT NULL DEFAULT 5000,
        "statusMessage" TEXT,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        UNIQUE ("projectId", "providerId")
      )
    `);
    await qr.query(
      `CREATE INDEX IF NOT EXISTS idx_model_providers_project ON model_providers ("projectId")`
    );
    console.log('[Migration] model_providers table ready');
  } catch (err: any) {
    console.error('[Migration] Failed to ensure model_providers table:', err.message);
    throw err;
  } finally {
    await qr.release();
  }
}

async function createReferenceEdgesTable(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS reference_edges (
        "projectId"   TEXT        NOT NULL,
        "sourceType"  TEXT        NOT NULL,
        "sourceId"    TEXT        NOT NULL,
        "targetType"  TEXT        NOT NULL,
        "targetId"    TEXT        NOT NULL,
        relation      TEXT        NOT NULL,
        "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("projectId", "sourceType", "sourceId", "targetType", "targetId", relation)
      )
    `);
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_refedges_target
        ON reference_edges ("projectId", "targetType", "targetId")
    `);
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_refedges_source
        ON reference_edges ("projectId", "sourceType", "sourceId")
    `);
  } catch (err: any) {
    logger.error('[Migration] Failed to ensure reference_edges table:', err.message);
    throw err;
  } finally {
    await qr.release();
  }
}

/**
 * Idempotently create the Evaluations tables. In dev TypeORM `synchronize`
 * handles this; in production (synchronize=false) this runs before
 * initialize() so the schema exists. Mirrors `createReferenceEdgesTable`.
 */
async function ensureEvaluationTables(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS evaluation_templates (
        "templateId"      VARCHAR(12) PRIMARY KEY,
        "projectId"       TEXT        NOT NULL,
        "evalName"        TEXT        NOT NULL,
        "description"     TEXT,
        "labels"          TEXT[],
        "owner"           TEXT        NOT NULL,
        "createdBy"       TEXT        NOT NULL,
        "lastModifiedBy"  TEXT        NOT NULL,
        "target"          VARCHAR(32) NOT NULL DEFAULT 'agent_version',
        "agent"           JSONB       NOT NULL,
        "models"          JSONB       NOT NULL DEFAULT '[]',
        "evaluationScope" VARCHAR(32) NOT NULL DEFAULT 'full_agent_execution',
        "suite"           VARCHAR(16) NOT NULL DEFAULT 'custom',
        "evaluators"      JSONB       NOT NULL,
        "thresholds"      JSONB,
        "cases"           JSONB,
        "schedule"        JSONB,
        "scheduleStatus"  JSONB,
        "runMode"         VARCHAR(16) NOT NULL DEFAULT 'single',
        "regression"      JSONB,
        "ab"              JSONB,
        "sweep"           JSONB,
        "repeats"         JSONB,
        "concurrency"     INTEGER,
        "createdAt"       TIMESTAMP   NOT NULL DEFAULT now(),
        "updatedAt"       TIMESTAMP   NOT NULL DEFAULT now(),
        "deletedAt"       TIMESTAMP
      )
    `);
    await qr.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_eval_templates_project_name"
        ON evaluation_templates ("projectId", "evalName")
    `);
    await qr.query(`
      CREATE TABLE IF NOT EXISTS evaluation_template_history (
        "id"          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "entityId"    VARCHAR(12) NOT NULL,
        "version"     INTEGER     NOT NULL,
        "data"        JSONB       NOT NULL,
        "modifiedAt"  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "modifiedBy"  TEXT,
        "op"          TEXT
      )
    `);
    await qr.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_eval_template_history_entity_version"
        ON evaluation_template_history ("entityId", "version")
    `);
    // `evaluation_runs` schema — note the deliberate absence of
    // `casesSnapshot`. Test-case rows live as a regular project Dataset
    // on the PVC after the JSONL/dataset pivot (item 4); the eval
    // worker reads + validates them via `validateGoldenDataset`.
    await qr.query(`
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        "runId"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        "templateId"       TEXT        NOT NULL,
        "projectId"        TEXT        NOT NULL,
        "name"             TEXT        NOT NULL,
        "status"           VARCHAR(16) NOT NULL DEFAULT 'queued',
        "baselineStatus"   VARCHAR(24) NOT NULL DEFAULT 'not_set',
        "workflowId"       TEXT,
        "trigger"          JSONB,
        "provenance"       JSONB,
        "templateSnapshot" JSONB,
        "results"          JSONB,
        "audit"            JSONB       NOT NULL DEFAULT '[]',
        "startTime"        TIMESTAMPTZ,
        "endTime"          TIMESTAMPTZ,
        "createdAt"        TIMESTAMP   NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP   NOT NULL DEFAULT now()
      )
    `);
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_eval_runs_template
        ON evaluation_runs ("projectId", "templateId")
    `);
    // Drop artifacts from older installs if present. Test cases live as
    // JSONL on the PVC under `evaluations/{evalId}/testcases/`, owned by
    // the eval template; the `casesSnapshot` column and the
    // `evaluation_test_cases` table are not part of the current schema.
    // `IF EXISTS` keeps fresh installs a no-op.
    await qr.query(`
      ALTER TABLE evaluation_runs DROP COLUMN IF EXISTS "casesSnapshot"
    `);
    await qr.query(`
      DROP TABLE IF EXISTS evaluation_test_cases CASCADE
    `);
  } catch (err: any) {
    console.error('[Migration] Failed to ensure evaluation tables:', err.message);
    throw err;
  } finally {
    await qr.release();
  }
}

/**
 * Ensure the guardrails_catalog table exists (idempotent). Backs the guardrails
 * CRUD APIs. Required in production where TypeORM synchronize is disabled.
 *
 * `UNIQUE (stage, key)` — the same dispatch slug may exist once per stage with
 * different defaults (the runtime keeps separate input/output namespaces).
 */
async function createGuardrailsCatalogTable(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS guardrails_catalog (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key                TEXT        NOT NULL,
        stage              TEXT        NOT NULL,
        display_name       TEXT        NOT NULL,
        description        TEXT        NOT NULL,
        type               TEXT        NOT NULL,
        supported_actions  TEXT[]      NOT NULL,
        enabled            BOOLEAN     NOT NULL DEFAULT true,
        priority           INT         NOT NULL DEFAULT 100,
        default_action     TEXT        NOT NULL,
        message            TEXT        NOT NULL,
        config             JSONB       NOT NULL DEFAULT '{}',
        config_schema      JSONB,
        version            INT         NOT NULL DEFAULT 1,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (stage, key)
      )
    `);
    console.log('[Migration] guardrails_catalog table ready');
  } catch (err: any) {
    console.error('[Migration] Failed to ensure guardrails_catalog table:', err.message);
    throw err;
  } finally {
    await qr.release();
  }
}

/**
 * Add the unified-embedding columns: `models.isBuiltin` and
 * `knowledge_bases.embeddingModelId`. Idempotent via ADD COLUMN IF NOT
 * EXISTS. Required in production where TypeORM synchronize is disabled.
 *
 * The `models.isBuiltin` column is NOT NULL with default false so existing
 * rows automatically become user-managed (non-built-in). The FK column on
 * KBs is nullable for back-compat — pre-port KBs gain the FK via the
 * BuiltinModelsService backfill on first startup after the seeded built-ins
 * exist.
 */
async function addUnifiedEmbeddingColumns(dataSource: DataSource): Promise<void> {
  const qr = dataSource.createQueryRunner();
  try {
    const modelsTable = await qr.getTable('models');
    if (modelsTable) {
      await qr.query(
        `ALTER TABLE models ADD COLUMN IF NOT EXISTS "isBuiltin" boolean NOT NULL DEFAULT false`,
      );
    }
    const kbsTable = await qr.getTable('knowledge_bases');
    if (kbsTable) {
      await qr.query(
        `ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS "embeddingModelId" uuid`,
      );
    }
    logger.info('[Migration] Unified-embedding columns ready');
  } catch (e: any) {
    // Rethrow so the outer pre-sync block (which already distinguishes
    // transient vs. permanent via `isTransientError`) can decide whether
    // to retry connectToPostgres or surface the error. Swallowing here
    // would let TypeORM synchronize run against a table missing
    // `isBuiltin`/`embeddingModelId`, producing cryptic runtime errors
    // far from the migration root cause.
    logger.error('[Migration] addUnifiedEmbeddingColumns:', e?.message || e);
    throw e;
  } finally {
    await qr.release();
  }
}

export async function connectToPostgres(): Promise<DataSource> {
  if (AppDataSource.isInitialized) {
    return AppDataSource;
  }

  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // --- Pre-sync migrations (run BEFORE TypeORM synchronize) ---
      try {
        const preSyncDs = new DataSource({
          type: 'postgres',
          host: dbHost,
          port: dbPort,
          username: dbUsername,
          password: dbPassword,
          database: dbName,
          synchronize: false,
          logging: false,
        });
        await preSyncDs.initialize();
        await backfillProjectHomeDir(preSyncDs);
        await ensureProjectInitStatusColumns(preSyncDs);
        await migrateEntityStatusEnums(preSyncDs);
        await migrateToolsToMCPServers(preSyncDs);
        await renameLegacyMCPGatewayColumns(preSyncDs);
        await scrubProjectMetadataVirtualKeyToken(preSyncDs);
        await migrateLegacyTeamTables(preSyncDs);
        await addManagedMCPServerColumns(preSyncDs);
        await addServerInstructionsColumn(preSyncDs);
        await addRemoteMCPConnectionColumns(preSyncDs);
        await addCredentialLifecycleColumns(preSyncDs);
        await addDataSourceMountHealthColumn(preSyncDs);
        await addDataSourceScanColumns(preSyncDs);
        await addModelClassColumns(preSyncDs);
        await addModelRateLimitAndPricingColumns(preSyncDs);
        await addUnifiedEmbeddingColumns(preSyncDs);
        await fixDataSourceIdColumn(preSyncDs);
        await backfillKnowledgeBaseRequiredFields(preSyncDs);
        await createReferenceEdgesTable(preSyncDs);
        await ensureModelProvidersTable(preSyncDs);
        await ensureEvaluationTables(preSyncDs);
        await ensureDataSetOriginVolumeColumn(preSyncDs);
        await ensureDataSetRefreshConfigColumn(preSyncDs);
        await ensureDataSourceModifiedByColumn(preSyncDs);
        await ensureDataSourceDeprecatedColumn(preSyncDs);
        await ensureDataSetSummaryColumns(preSyncDs);
        await ensureKnowledgeBaseSyncColumns(preSyncDs);
        await ensureEntityLabelsColumns(preSyncDs);
        await ensureAgentConfigCardsColumns(preSyncDs);
        await ensureAgentTeamA2AServerColumn(preSyncDs);
        await ensureAgentLifecycleColumns(preSyncDs);
        await ensureAgentTeamLifecycleColumns(preSyncDs);
        await ensureAgentTeamMemoryContextColumn(preSyncDs);
        await ensureAgentFigmaUpdateColumns(preSyncDs);
        await ensureAgentTeamFigmaUpdateColumns(preSyncDs);
        await ensureAgentRequirementsColumn(preSyncDs);
        await addMCPConsecutiveFailuresColumn(preSyncDs);
        await createGuardrailsCatalogTable(preSyncDs);
        await preSyncDs.destroy();
      } catch (preSyncErr: any) {
        logger.info(`[Pre-sync migration] Skipped or failed: ${preSyncErr.message}`);
        if (isTransientError(preSyncErr)) throw preSyncErr;
      }

      // Try to initialize - if it fails due to id column issues, fix and retry
      try {
        await AppDataSource.initialize();
        await fixDataSetIdColumn(AppDataSource);
      } catch (error: any) {
        if (isTransientError(error)) throw error;

        if (
          error.message?.includes('contains null values') ||
          error.message?.includes('data_sets') ||
          error.message?.includes('data_sources') ||
          error.message?.includes('knowledge_bases') ||
          error.message?.includes('sourceDataset') ||
          error.message?.includes('embeddingModel') ||
          error.message?.includes('column "id"')
        ) {
          logger.info('Detected schema migration issue (id columns or NOT NULL backfill), attempting to fix...');
          const tempDataSource = new DataSource({
            type: 'postgres',
            host: dbHost,
            port: dbPort,
            username: dbUsername,
            password: dbPassword,
            database: dbName,
            synchronize: false,
            logging: false,
          });
          try {
            await tempDataSource.initialize();
            await fixDataSetIdColumn(tempDataSource);
            await fixDataSourceIdColumn(tempDataSource);
            await backfillKnowledgeBaseRequiredFields(tempDataSource);
            await tempDataSource.destroy();
            await AppDataSource.initialize();
            logger.info('Successfully fixed id columns and reconnected');
          } catch (fixError: any) {
            await tempDataSource.destroy().catch(() => {});
            if (isTransientError(fixError)) throw fixError;
            logger.error('Failed to fix id columns:', fixError.message);
            throw new Error(
              `Failed to fix id columns. Please run the migration script manually: ${fixError.message}`
            );
          }
        } else {
          throw error;
        }
      }

      logger.info('Connected to PostgreSQL');

      const configVersionRepo = AppDataSource.getRepository(ConfigVersion);
      const existing = await configVersionRepo.findOne({ where: { id: 1 } });
      if (!existing) {
        const configVersion = configVersionRepo.create({ id: 1, version: 1 });
        await configVersionRepo.save(configVersion);
        logger.info('Initialized config_version table');
      }

      // Post-sync startup hooks: seed the built-in embedding catalog across
      // all projects and backfill KB embeddingModelId FKs. Run in the
      // background (fire-and-forget) so connectToPostgres returns promptly
      // and Express can bind / the K8s readiness probe can succeed — N
      // sequential project iterations would otherwise stall boot on large
      // tenants. Both inner calls are idempotent (ON CONFLICT DO NOTHING on
      // the seed, `IS NULL`-guarded UPDATE on the backfill).
      //
      // Dynamic import avoids a top-of-file circular dependency through
      // gatewayClient → bifrostProjectGovernance → AppDataSource.
      void (async () => {
        try {
          const { BuiltinModelsService } = await import('../services/BuiltinModelsService');
          const svc = new BuiltinModelsService(AppDataSource);
          await svc.ensureBuiltinsForAllProjects();
          await svc.backfillKnowledgeBaseEmbeddingModelId();
          // Stamp model_info.dimensions on remote embedding rows registered
          // before the embedding catalog existed. Without this, KB creation
          // against those rows fails 400 with EMBEDDING_DIMENSIONS_REQUIRED
          // (see knowledgeBaseRoutes.resolveEmbeddingFields).
          await svc.backfillEmbeddingDimensions();
        } catch (err: any) {
          logger.error(
            '[Startup] BuiltinModelsService backfill failed (will retry on next restart):',
            err?.message || err,
          );
        }
      })();

      return AppDataSource;
    } catch (err: any) {
      if (isTransientError(err) && attempt < MAX_RETRIES) {
        logger.warn(
          `[PostgreSQL] Connection attempt ${attempt}/${MAX_RETRIES} failed (${err.code || err.message}), retrying in ${RETRY_DELAY_MS / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`[PostgreSQL] Failed to connect after ${MAX_RETRIES} attempts`);
}

function isTransientError(err: any): boolean {
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toUpperCase();
  return (
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    msg.includes('eai_again') ||
    msg.includes('connection timeout') ||
    msg.includes('connection terminated') ||
    msg.includes('connection refused') ||
    msg.includes('getaddrinfo')
  );
}

const DB_DESTROY_TIMEOUT_MS = parseInt(process.env.DB_DESTROY_TIMEOUT_MS || '5000', 10);

export async function closePostgresConnection(): Promise<void> {
  if (!AppDataSource.isInitialized) return;
  try {
    await Promise.race([
      AppDataSource.destroy(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('DB destroy timeout')), DB_DESTROY_TIMEOUT_MS)
      ),
    ]);
    logger.info('PostgreSQL connection pool closed');
  } catch (err: any) {
    logger.error('Error closing PostgreSQL connection pool:', err?.message || err);
    throw err;
  }
}

