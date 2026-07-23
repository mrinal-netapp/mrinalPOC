import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { DataSource, QueryRunner } from 'typeorm';

/**
 * DistributedLockManager uses PostgreSQL advisory locks to ensure only one
 * instance of the config service performs bucket assignment tasks.
 * 
 * This enables horizontal scaling of the config service while preventing
 * race conditions and duplicate assignments.
 * 
 * Uses PostgreSQL pg_advisory_lock() which automatically releases locks when
 * the connection closes, making it safe for containerized environments.
 * 
 * The lock is held on a dedicated QueryRunner connection that must remain
 * alive for the duration of the lock. The lock is automatically released
 * when the connection is closed (e.g., on pod shutdown).
 */
export class DistributedLockManager {
  private dataSource: DataSource;
  private lockKey: number;
  private lockAcquired: boolean = false;
  private lockQueryRunner: QueryRunner | null = null;

  /**
   * @param dataSource TypeORM DataSource instance
   * @param lockKey Unique integer key for the lock (default: hash of 'bucket-assignment')
   */
  constructor(dataSource: DataSource, lockKey?: number) {
    this.dataSource = dataSource;
    // Use a hash of 'bucket-assignment' as default lock key
    // PostgreSQL advisory locks use bigint, so we hash the string to a number
    this.lockKey = lockKey || this.hashString('bucket-assignment');
  }

  /**
   * Try to acquire the distributed lock
   * @returns true if lock acquired, false otherwise
   */
  async tryAcquireLock(): Promise<boolean> {
    if (this.lockAcquired) {
      return true; // Already have the lock
    }

    try {
      if (!this.dataSource || !this.dataSource.isInitialized) {
        logger.warn('[DistributedLock] Database not initialized, cannot acquire lock');
        return false;
      }

      // Create a QueryRunner with a dedicated connection
      // Advisory locks are connection-scoped, so we need to keep this connection alive
      this.lockQueryRunner = this.dataSource.createQueryRunner();
      
      // Connect the QueryRunner (creates a dedicated connection)
      await this.lockQueryRunner.connect();
      
      // Try to acquire advisory lock (non-blocking)
      // pg_try_advisory_lock returns true if lock acquired, false if already held
      const result = await this.lockQueryRunner.query(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [this.lockKey]
      );

      const acquired = result[0]?.acquired === true;
      
      if (acquired) {
        this.lockAcquired = true;
        logger.info(
          `[DistributedLock] Lock acquired successfully (key: ${this.lockKey})`
        );
      } else {
        // Release the QueryRunner since we didn't get the lock
        await this.lockQueryRunner.release();
        this.lockQueryRunner = null;
        logger.info(
          `[DistributedLock] Lock already held by another instance (key: ${this.lockKey})`
        );
      }

      return acquired;
    } catch (error: any) {
      logger.error(`[DistributedLock] Error acquiring lock: ${error.message}`);
      if (this.lockQueryRunner) {
        try {
          await this.lockQueryRunner.release();
        } catch (releaseError) {
          // Ignore release errors
        }
        this.lockQueryRunner = null;
      }
      return false;
    }
  }

  /**
   * Release the distributed lock
   */
  async releaseLock(): Promise<void> {
    if (!this.lockAcquired || !this.lockQueryRunner) {
      return;
    }

    try {
      // Release the advisory lock
      await this.lockQueryRunner.query(
        'SELECT pg_advisory_unlock($1)',
        [this.lockKey]
      );
      
      // Release the QueryRunner (closes the connection)
      await this.lockQueryRunner.release();
      this.lockQueryRunner = null;
      this.lockAcquired = false;
      
      logger.info(`[DistributedLock] Lock released (key: ${this.lockKey})`);
    } catch (error: any) {
      logger.error(`[DistributedLock] Error releasing lock: ${error.message}`);
      // Try to release QueryRunner anyway
      if (this.lockQueryRunner) {
        try {
          await this.lockQueryRunner.release();
        } catch (releaseError) {
          // Ignore
        }
        this.lockQueryRunner = null;
      }
      this.lockAcquired = false;
    }
  }

  /**
   * Check if this instance currently holds the lock
   */
  isLockHeld(): boolean {
    return this.lockAcquired;
  }

  /**
   * Hash a string to a number for use as advisory lock key
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to positive number and ensure it fits in PostgreSQL bigint range
    return Math.abs(hash) % 2147483647; // Max safe integer for PostgreSQL bigint
  }
}

