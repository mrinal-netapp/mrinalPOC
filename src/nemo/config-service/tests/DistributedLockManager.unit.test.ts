/**
 * Unit tests for db/DistributedLockManager.ts
 *
 * Run: node --require ts-node/register --test tests/DistributedLockManager.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSource, QueryRunner } from 'typeorm';

import { DistributedLockManager } from '../db/DistributedLockManager';

type MockQr = {
  connect: () => Promise<void>;
  release: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  releaseCalls: number;
};

function makeQueryRunner(options: {
  acquired?: boolean;
  queryError?: Error;
  releaseError?: Error;
}): MockQr {
  const qr: MockQr = {
    releaseCalls: 0,
    connect: async () => undefined,
    release: async () => {
      qr.releaseCalls += 1;
      if (options.releaseError) throw options.releaseError;
    },
    query: async (sql: string) => {
      if (options.queryError) throw options.queryError;
      if (sql.includes('pg_try_advisory_lock')) {
        return [{ acquired: options.acquired ?? true }];
      }
      if (sql.includes('pg_advisory_unlock')) return [];
      return [];
    },
  };
  return qr;
}

function makeDataSource(options: {
  initialized?: boolean;
  qr?: MockQr;
  createThrows?: boolean;
}): DataSource {
  const qr = options.qr ?? makeQueryRunner({});
  return {
    isInitialized: options.initialized ?? true,
    createQueryRunner: () => {
      if (options.createThrows) throw new Error('createQueryRunner failed');
      return qr as unknown as QueryRunner;
    },
  } as unknown as DataSource;
}

test('constructor: uses explicit lock key when provided', () => {
  const mgr = new DistributedLockManager(makeDataSource({}), 424242);
  assert.equal(mgr.isLockHeld(), false);
});

test('tryAcquireLock: returns true immediately when lock already held', async () => {
  const qr = makeQueryRunner({ acquired: true });
  let queryCalls = 0;
  const origQuery = qr.query;
  qr.query = async (sql: string, params?: unknown[]) => {
    queryCalls += 1;
    return origQuery(sql, params);
  };
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  assert.equal(await mgr.tryAcquireLock(), true);
  assert.equal(await mgr.tryAcquireLock(), true);
  assert.equal(queryCalls, 1, 'second acquire must not hit the database');
});

test('tryAcquireLock: returns false when database is not initialized', async () => {
  const mgr = new DistributedLockManager(makeDataSource({ initialized: false }));
  assert.equal(await mgr.tryAcquireLock(), false);
  assert.equal(mgr.isLockHeld(), false);
});

test('tryAcquireLock: acquires lock and marks instance as holding it', async () => {
  const qr = makeQueryRunner({ acquired: true });
  const mgr = new DistributedLockManager(makeDataSource({ qr }), 99);
  assert.equal(await mgr.tryAcquireLock(), true);
  assert.equal(mgr.isLockHeld(), true);
});

test('tryAcquireLock: releases query runner when lock is held by another instance', async () => {
  const qr = makeQueryRunner({ acquired: false });
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  assert.equal(await mgr.tryAcquireLock(), false);
  assert.equal(mgr.isLockHeld(), false);
  assert.equal(qr.releaseCalls, 1);
});

test('tryAcquireLock: returns false and cleans up on query error', async () => {
  const qr = makeQueryRunner({ queryError: new Error('advisory lock failed') });
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  assert.equal(await mgr.tryAcquireLock(), false);
  assert.equal(mgr.isLockHeld(), false);
  assert.equal(qr.releaseCalls, 1);
});

test('tryAcquireLock: ignores release errors during acquire cleanup', async () => {
  const qr = makeQueryRunner({
    queryError: new Error('advisory lock failed'),
    releaseError: new Error('release failed'),
  });
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  assert.equal(await mgr.tryAcquireLock(), false);
});

test('releaseLock: no-op when lock was never acquired', async () => {
  const qr = makeQueryRunner({});
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  await mgr.releaseLock();
  assert.equal(qr.releaseCalls, 0);
});

test('releaseLock: unlocks and clears held state', async () => {
  const qr = makeQueryRunner({ acquired: true });
  const mgr = new DistributedLockManager(makeDataSource({ qr }), 7);
  await mgr.tryAcquireLock();
  await mgr.releaseLock();
  assert.equal(mgr.isLockHeld(), false);
  assert.ok(qr.releaseCalls >= 1);
});

test('releaseLock: clears state even when unlock query fails', async () => {
  let call = 0;
  const qr = makeQueryRunner({ acquired: true });
  const origQuery = qr.query;
  qr.query = async (sql: string, params?: unknown[]) => {
    call += 1;
    if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
    return origQuery(sql, params);
  };
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  await mgr.tryAcquireLock();
  await mgr.releaseLock();
  assert.equal(mgr.isLockHeld(), false);
  assert.ok(qr.releaseCalls >= 1);
});

test('releaseLock: ignores release errors during error cleanup', async () => {
  const qr = makeQueryRunner({ acquired: true });
  const origQuery = qr.query;
  qr.query = async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
    return origQuery(sql, params);
  };
  qr.release = async () => {
    throw new Error('release failed in cleanup');
  };
  const mgr = new DistributedLockManager(makeDataSource({ qr }));
  await mgr.tryAcquireLock();
  await mgr.releaseLock();
  assert.equal(mgr.isLockHeld(), false);
});
