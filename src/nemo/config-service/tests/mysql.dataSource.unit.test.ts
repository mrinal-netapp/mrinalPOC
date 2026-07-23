/**
 * MySQL database data source validators (create + update).
 *
 * Run: `npm run test:mysql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
} from '../validators/dataSourceValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseMysqlConnectorCreate } from './helpers/mysqlFixtures';

test('createDataSourceValidator: full MySQL connector payload passes', async () => {
  const result = await runValidators(createDataSourceValidator, { body: baseMysqlConnectorCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: accepts schema field on mysql provider', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseMysqlConnectorCreate({
      connector_config: {
        ...baseMysqlConnectorCreate().connector_config,
        schema: 'sakila',
        ssl_mode: 'require',
      },
    }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: rejects connector_config unknown field for mysql', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseMysqlConnectorCreate({
      connector_config: {
        ...baseMysqlConnectorCreate().connector_config,
        bucket: 'should-not-be-here',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes("Unknown field 'bucket'"));
});

test('createDataSourceValidator: rejects mysql config without host', async () => {
  const { host: _h, ...cfg } = baseMysqlConnectorCreate().connector_config as Record<string, unknown>;
  const result = await runValidators(createDataSourceValidator, {
    body: baseMysqlConnectorCreate({ connector_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('host is required'));
});

test('updateDataSourceValidator: partial MySQL connector_config update passes', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: {
      connector_config: {
        scope: 'resource',
        provider: 'mysql',
        connector_type: 'database',
        host: 'mysql.example.com',
        port: 3306,
        ssl_mode: 'verify-full',
      },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
