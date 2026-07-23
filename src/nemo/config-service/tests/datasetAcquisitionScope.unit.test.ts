import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DataSet } from '../models/DataSet';
import {
  datasetAcquisitionScopeChanged,
  isAcquiredDataset,
} from '../utils/datasetAcquisitionScope';

test('isAcquiredDataset detects acquired type and origin selectors', () => {
  assert.equal(isAcquiredDataset({ type: 'acquired' } as DataSet), true);
  assert.equal(isAcquiredDataset({ type: 'manual', originVolume: 'vol-1' } as DataSet), true);
  assert.equal(isAcquiredDataset({ type: 'manual' } as DataSet), false);
});

test('datasetAcquisitionScopeChanged returns false when scope fields are unchanged', () => {
  const current = {
    filterSpec: { paths: ['/data'] },
    sqlQuery: 'select 1',
    resourceSelector: [{ type: 'prefix', value: 'a/' }],
  } as unknown as DataSet;

  assert.equal(
    datasetAcquisitionScopeChanged(current, {
      filterSpec: { paths: ['/data'] },
      description: 'metadata only',
    }),
    false,
  );
});

test('datasetAcquisitionScopeChanged returns true when acquisition scope changes', () => {
  const current = {
    filterSpec: { paths: ['/data'] },
    sqlQuery: 'select 1',
    resourceSelector: [{ type: 'prefix', value: 'a/' }],
  } as unknown as DataSet;

  assert.equal(
    datasetAcquisitionScopeChanged(current, { sqlQuery: 'select 2' }),
    true,
  );
});

test('datasetAcquisitionScopeChanged detects origin_volume snake_case alias', () => {
  const current = {
    originVolume: 'vol-old12345',
  } as unknown as DataSet;

  assert.equal(
    datasetAcquisitionScopeChanged(current, { origin_volume: 'vol-old12345' }),
    false,
  );
  assert.equal(
    datasetAcquisitionScopeChanged(current, { origin_volume: 'vol-new12345' }),
    true,
  );
});
