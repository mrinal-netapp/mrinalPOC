/**
 * MySQL acquired-dataset validators (create + update / PATCH body).
 *
 * Run: `npm run test:mysql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSetValidator,
  updateDataSetValidator,
} from '../validators/dataSetValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseAcquiredMysqlDataset } from './helpers/mysqlFixtures';

test('createDataSetValidator: acquired MySQL structured dataset passes', async () => {
  const result = await runValidators(createDataSetValidator, { body: baseAcquiredMysqlDataset() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: allows empty description', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredMysqlDataset({ description: '' }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: allows omitted description', async () => {
  const body = baseAcquiredMysqlDataset();
  delete (body as Record<string, unknown>).description;
  const result = await runValidators(createDataSetValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: structured acquired requires sqlQuery', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredMysqlDataset({ sqlQuery: undefined }),
  });
  assert.equal(result.isEmpty(), false);
});

test('createDataSetValidator: acquired dataset requires originConnector or originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredMysqlDataset({ originConnector: undefined }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('originConnector or originVolume'));
});

test('updateDataSetValidator: PATCH sqlQuery and sourceDatabase passes', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      sqlQuery: 'SELECT * FROM sakila.actor',
      sourceDatabase: 'sakila',
      sourceSchema: 'sakila',
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
