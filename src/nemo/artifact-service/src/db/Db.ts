import { Pool, PoolClient } from 'pg';

/**
 * Thin wrapper around pg.Pool. The artifact-service does not own the
 * schema — config-service's TypeORM `synchronize` creates the tables —
 * so we use raw SQL with double-quoted identifiers to match the
 * camelCase column names TypeORM produces by default.
 */
export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export function dbConfigFromEnv(): DbConfig {
  return {
    host: process.env.POSTGRES_HOST || 'postgres',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgrespassword',
    database: process.env.POSTGRES_DB || 'nemo',
    poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    idleTimeoutMs: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.DB_CONNECTION_TIMEOUT || '5000', 10),
    statementTimeoutMs: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
  };
}

export class Db {
  private readonly pool: Pool;

  constructor(config: DbConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: config.poolSize,
      idleTimeoutMillis: config.idleTimeoutMs,
      connectionTimeoutMillis: config.connectionTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
    });
  }

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(text, params as unknown[]);
    return result.rows as T[];
  }

  async one<T = unknown>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
