/**
 * PostgreSQL database data source validators (create + update).
 *
 * Run: `npm run test:postgresql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
} from '../validators/dataSourceValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { basePostgresqlConnectorCreate } from './helpers/postgresqlFixtures';

test('createDataSourceValidator: full PostgreSQL connector payload passes', async () => {
  const result = await runValidators(createDataSourceValidator, { body: basePostgresqlConnectorCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: accepts schema field on postgresql provider', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: basePostgresqlConnectorCreate({
      connector_config: {
        ...basePostgresqlConnectorCreate().connector_config,
        schema: 'app',
        ssl_mode: 'verify-ca',
      },
    }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: rejects connector_config unknown field for postgresql', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: basePostgresqlConnectorCreate({
      connector_config: {
        ...basePostgresqlConnectorCreate().connector_config,
        bucket: 'should-not-be-here',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes("Unknown field 'bucket'"));
});

test('createDataSourceValidator: rejects postgresql config without host', async () => {
  const { host: _h, ...cfg } = basePostgresqlConnectorCreate().connector_config as Record<string, unknown>;
  const result = await runValidators(createDataSourceValidator, {
    body: basePostgresqlConnectorCreate({ connector_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('host is required'));
});

test('updateDataSourceValidator: partial PostgreSQL connector_config update passes', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: {
      connector_config: {
        scope: 'resource',
        provider: 'postgresql',
        connector_type: 'database',
        host: 'postgres.example.com',
        port: 5432,
        ssl_mode: 'verify-full',
      },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
