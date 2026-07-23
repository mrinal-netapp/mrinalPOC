/**
 * Volume data source validators (create + update + list query).
 *
 * Run: `npm run test:volume`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
  listDataSourceQueryValidator,
} from '../validators/dataSourceValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseVolumeCreate, baseDynamicVolumeCreate } from './helpers/volumeFixtures';

test('createDataSourceValidator: full static NFS volume payload passes', async () => {
  const result = await runValidators(createDataSourceValidator, { body: baseVolumeCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: dynamic volume with storage class passes', async () => {
  const result = await runValidators(createDataSourceValidator, { body: baseDynamicVolumeCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: volume does not require credential_id', async () => {
  const result = await runValidators(createDataSourceValidator, { body: baseVolumeCreate() });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createDataSourceValidator: rejects missing volume_config', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: { name: 'v', type: 'volume' },
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume_config is required'));
});

test('createDataSourceValidator: rejects missing region', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  delete cfg.region;
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ volume_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume_config.region'));
});

test('createDataSourceValidator: rejects missing volume_info.type', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  const vi = { ...(cfg.volume_info as Record<string, unknown>) };
  delete vi.type;
  cfg.volume_info = vi;
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ volume_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume_config.volume_info.type'));
});

test('createDataSourceValidator: rejects missing protocol', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  delete cfg.protocol;
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ volume_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume_config.protocol'));
});

test('createDataSourceValidator: rejects missing auth_info', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  delete cfg.auth_info;
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ volume_config: cfg }),
  });
  assert.equal(result.isEmpty(), false);
  assert.ok(validationMessages(result).includes('volume_config.auth_info'));
});

test('createDataSourceValidator: connector_config not required for volume type', async () => {
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ connector_config: undefined }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('updateDataSourceValidator: partial volume_config patch passes', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: {
      volume_config: {
        region: 'eu-central-1',
        volume_info: { endpoint: 'nfs-new:/export' },
      },
    },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('listDataSourceQueryValidator: accepts type=volume', async () => {
  const result = await runValidators(listDataSourceQueryValidator, { query: { type: 'volume' } });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('listDataSourceQueryValidator: rejects invalid type filter', async () => {
  const result = await runValidators(listDataSourceQueryValidator, { query: { type: 'bucket' } });
  assert.equal(result.isEmpty(), false);
});
