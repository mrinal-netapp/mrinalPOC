/**
 * S3 object-store data source validators (create + update).
 *
 * Run: `npm run test:s3`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
} from '../validators/dataSourceValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseS3ConnectorCreate } from './helpers/s3Fixtures';

test('createDataSourceValidator: full S3 connector payload passes', async () => {
  const result = await runValidators(createDataSourceValidator, { body: baseS3ConnectorCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: requires name', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({ name: '' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('Name is required'));
});

test('createDataSourceValidator: type must be volume or connector', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({ type: 'bucket' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume or connector'));
});

test('createDataSourceValidator: connector requires connector_config object', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: { name: 'x', type: 'connector', credential_id: 'cred-1' },
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('connector_config is required'));
});

test('createDataSourceValidator: connector requires credential_id', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({ credential_id: '' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('credential_id'));
});

test('createDataSourceValidator: rejects unsupported connector_type', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({
      connector_config: {
        ...baseS3ConnectorCreate().connector_config,
        connector_type: 'metrics',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('connector_type must be'));
});

test('createDataSourceValidator: rejects unknown provider', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({
      connector_config: {
        ...baseS3ConnectorCreate().connector_config,
        provider: 'not-a-provider',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('Unknown provider'));
});

test('createDataSourceValidator: rejects invalid scope', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({
      connector_config: {
        ...baseS3ConnectorCreate().connector_config,
        scope: 'global',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('scope must be'));
});

test('createDataSourceValidator: rejects S3 config without bucket', async () => {
  const { bucket: _b, ...cfg } = baseS3ConnectorCreate().connector_config as Record<string, unknown>;
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({ connector_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('bucket is required'));
});

test('createDataSourceValidator: rejects connector_config unknown field for s3', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseS3ConnectorCreate({
      connector_config: {
        ...baseS3ConnectorCreate().connector_config,
        host: 'db.example.com',
      },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes("Unknown field 'host'"));
});

test('updateDataSourceValidator: partial S3 connector_config update passes', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: {
      connector_config: {
        scope: 'resource',
        provider: 's3',
        connector_type: 'objectstore',
        bucket: 'new-bucket',
        prefix: 'v2/',
      },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateDataSourceValidator: optional description and credential_id', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: {
      description: 'updated label',
      credential_id: 'cred-22222222-2222-2222-2222-222222222222',
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateDataSourceValidator: rejects non-string credential_id when provided', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: { credential_id: 12345 },
  });
  assert.equal(result.isEmpty(), false);
});
