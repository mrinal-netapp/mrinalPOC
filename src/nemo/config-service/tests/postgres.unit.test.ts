/**
 * Unit tests for db/postgres.ts public connection lifecycle API.
 *
 * Internal migration helpers are not exported; they are exercised indirectly
 * via integration/startup paths rather than direct unit tests, so this file
 * stays limited to the exported surface.
 *
 * Run: node --require ts-node/register --test tests/postgres.unit.test.ts
 */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppDataSource, connectToPostgres, closePostgresConnection } from '../db/postgres';

test('connectToPostgres: returns AppDataSource when already initialized', async () => {
  const ds = AppDataSource as { isInitialized: boolean };
  const prev = ds.isInitialized;
  ds.isInitialized = true;
  try {
    const out = await connectToPostgres();
    assert.equal(out, AppDataSource);
  } finally {
    ds.isInitialized = prev;
  }
});

test('closePostgresConnection: no-op when not initialized', async () => {
  const ds = AppDataSource as { isInitialized: boolean };
  const prev = ds.isInitialized;
  ds.isInitialized = false;
  try {
    await closePostgresConnection();
    assert.ok(true);
  } finally {
    ds.isInitialized = prev;
  }
});

test('closePostgresConnection: destroys pool when initialized', async () => {
  const ds = AppDataSource as {
    isInitialized: boolean;
    destroy: () => Promise<void>;
  };
  const prevInit = ds.isInitialized;
  let destroyed = false;
  const prevDestroy = ds.destroy;
  ds.isInitialized = true;
  ds.destroy = async () => {
    destroyed = true;
    ds.isInitialized = false;
  };
  try {
    await closePostgresConnection();
    assert.equal(destroyed, true);
  } finally {
    ds.isInitialized = prevInit;
    ds.destroy = prevDestroy;
  }
});

test('closePostgresConnection: propagates destroy errors', async () => {
  const ds = AppDataSource as {
    isInitialized: boolean;
    destroy: () => Promise<void>;
  };
  const prevInit = ds.isInitialized;
  const prevDestroy = ds.destroy;
  ds.isInitialized = true;
  ds.destroy = async () => {
    throw new Error('destroy failed');
  };
  try {
    await assert.rejects(() => closePostgresConnection(), /destroy failed/);
  } finally {
    ds.isInitialized = prevInit;
    ds.destroy = prevDestroy;
  }
});
