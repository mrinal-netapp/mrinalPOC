/**
 * PostgreSQL acquired-dataset validators (create + update / PATCH body).
 *
 * Run: `npm run test:postgresql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSetValidator,
  updateDataSetValidator,
} from '../validators/dataSetValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseAcquiredPostgresqlDataset } from './helpers/postgresqlFixtures';

test('createDataSetValidator: acquired PostgreSQL structured dataset passes', async () => {
  const result = await runValidators(createDataSetValidator, { body: baseAcquiredPostgresqlDataset() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: allows empty description', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredPostgresqlDataset({ description: '' }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: allows omitted description', async () => {
  const body = baseAcquiredPostgresqlDataset();
  delete (body as Record<string, unknown>).description;
  const result = await runValidators(createDataSetValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: structured acquired requires sqlQuery', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredPostgresqlDataset({ sqlQuery: undefined }),
  });
  assert.equal(result.isEmpty(), false);
});

test('createDataSetValidator: acquired dataset requires originConnector or originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredPostgresqlDataset({ originConnector: undefined }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('originConnector or originVolume'));
});

test('updateDataSetValidator: PATCH sqlQuery and sourceDatabase passes', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      sqlQuery: 'SELECT * FROM public.users',
      sourceDatabase: 'appdb',
      sourceSchema: 'public',
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
