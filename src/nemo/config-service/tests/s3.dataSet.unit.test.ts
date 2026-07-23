/**
 * S3 acquired-dataset validators (create + update / PATCH body).
 *
 * Run: `npm run test:s3`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSetValidator,
  updateDataSetValidator,
} from '../validators/dataSetValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseAcquiredS3Dataset } from './helpers/s3Fixtures';

test('createDataSetValidator: acquired S3 dataset with resourceSelector passes', async () => {
  const result = await runValidators(createDataSetValidator, { body: baseAcquiredS3Dataset() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: acquired dataset requires originConnector or originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({ originConnector: undefined }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('originConnector or originVolume'));
});

test('createDataSetValidator: rejects both originConnector and originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({ originVolume: 'vol-abc12345' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('not both'));
});

test('createDataSetValidator: objectstore resourceSelector must not mix with metric categories', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      resourceSelector: [
        { bucket: 'b', prefix: 'p/' },
        { category: 'volume_metrics' },
      ],
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('cannot mix metric_category'));
});

test('createDataSetValidator: pure objectstore selector entries are allowed', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      resourceSelector: [
        { bucket: 'b1', prefix: 'a/' },
        { bucket: 'b2', prefix: 'b/' },
      ],
    }),
  });
  assert.equal(result.isEmpty(), true);
});

test('createDataSetValidator: manual datasets do not require originConnector', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: {
      name: 'manual-upload',
      description: 'user files',
      type: 'manual',
      kind: 'unstructured',
    },
  });
  assert.equal(result.isEmpty(), true);
});

test('createDataSetValidator: structured acquired requires sqlQuery', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({ kind: 'structured', sqlQuery: undefined }),
  });
  assert.equal(result.isEmpty(), false);
});

test('updateDataSetValidator: PATCH resourceSelector prefix passes', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      resourceSelector: [{ bucket: 'src', prefix: 'nested/path/' }],
      acquisitionConfig: { writeMode: 'overwrite', fileGlob: '*.csv' },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateDataSetValidator: rejects originConnector and originVolume together', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: { originConnector: 'cn-1', originVolume: 'vol-1' },
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('not both'));
});

test('updateDataSetValidator: rejects metric mix on resourceSelector update', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      resourceSelector: [
        { bucket: 'b', prefix: 'p' },
        { category: 'aggregate_metrics' },
      ],
    },
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('cannot mix metric_category'));
});

test('updateDataSetValidator: empty patch body passes', async () => {
  const result = await runValidators(updateDataSetValidator, { body: {} });
  assert.equal(result.isEmpty(), true);
});

test('updateDataSetValidator: rejects invalid kind when provided', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: { kind: 'tabular' },
  });
  assert.equal(result.isEmpty(), false);
});
