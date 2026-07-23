/**
 * Volume-backed acquired-dataset validators (create + update).
 *
 * Run: `npm run test:volume`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSetValidator,
  updateDataSetValidator,
} from '../validators/dataSetValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseAcquiredVolumeDataset } from './helpers/volumeFixtures';

test('createDataSetValidator: acquired volume dataset with filterSpec passes', async () => {
  const result = await runValidators(createDataSetValidator, { body: baseAcquiredVolumeDataset() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: allows empty description', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredVolumeDataset({ description: '' }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: acquired requires originVolume or originConnector', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredVolumeDataset({ originVolume: undefined }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('originConnector or originVolume'));
});

test('createDataSetValidator: accepts origin_volume snake_case', async () => {
  const body = baseAcquiredVolumeDataset({ originVolume: undefined, origin_volume: 'vol-snake01' });
  const result = await runValidators(createDataSetValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: rejects both originConnector and originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredVolumeDataset({ originConnector: 'cn-abc12345' }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('not both'));
});

test('createDataSetValidator: unstructured volume acquired does not require sqlQuery', async () => {
  const body = baseAcquiredVolumeDataset();
  delete (body as Record<string, unknown>).sqlQuery;
  const result = await runValidators(createDataSetValidator, { body });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: manual datasets do not require originVolume', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: {
      name: 'manual-upload',
      type: 'manual',
      kind: 'unstructured',
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: rejects metric mix in resourceSelector', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredVolumeDataset({
      resourceSelector: [
        { sourcePath: '/data' },
        { category: 'volume_metrics' },
      ],
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('cannot mix metric_category'));
});

test('updateDataSetValidator: PATCH filterSpec sourcePath passes', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      filterSpec: { sourcePath: '/archive/2026' },
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
