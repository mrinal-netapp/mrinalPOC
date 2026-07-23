import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDataSetValidator, updateDataSetValidator } from '../validators/dataSetValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseAcquiredGcpMetricsDataset } from './helpers/gcpFixtures';

test('createDataSetValidator: acquired GCP metrics dataset passes', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredGcpMetricsDataset(),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSetValidator: metrics resourceSelector must not mix with objectstore', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredGcpMetricsDataset({
      resourceSelector: [
        { bucket: 'b', prefix: 'p/' },
        { category: 'volume_metrics' },
      ],
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('cannot mix metric_category'));
});

test('createDataSetValidator: pure volume_metrics selector is allowed', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredGcpMetricsDataset({
      resourceSelector: [{ category: 'volume_metrics' }],
    }),
  });
  assert.equal(result.isEmpty(), true);
});

test('createDataSetValidator: rejects overwrite writeMode for metrics datasets', async () => {
  const result = await runValidators(createDataSetValidator, {
    body: baseAcquiredGcpMetricsDataset({
      acquisitionConfig: { writeMode: 'overwrite' },
    }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('metric_category'));
});

test('updateDataSetValidator: PATCH volume_metrics selector passes', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      resourceSelector: [{ category: 'volume_metrics' }],
      acquisitionConfig: { writeMode: 'append' },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateDataSetValidator: rejects metric mix on resourceSelector update', async () => {
  const result = await runValidators(updateDataSetValidator, {
    body: {
      resourceSelector: [
        { bucket: 'b', prefix: 'p' },
        { category: 'volume_metrics' },
      ],
    },
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('cannot mix metric_category'));
});
