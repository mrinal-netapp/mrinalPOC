/**
 * NFS export path (volume_info.endpoint) rules for static volumes.
 *
 * Parsing server/share → PV spec is tested in storage-manager EndpointParser.test.ts.
 * PVC endpoint drift → PVManager/PVCManager tests.
 *
 * Run: `npm run test:volume`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
} from '../validators/dataSourceValidator';
import { validateVolumeConfigUpdate } from '../utils/volumeConfigValidation';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseVolumeCreate } from './helpers/volumeFixtures';

const NFS_EXPORT_PATHS = [
  'nfs-server.example.com:/export/data',
  'nfs://nfs-server.example.com/export/data',
  '10.20.30.40:/vol_datasets_01',
  'ontap-svm.company.com:/volume_abc',
];

test('createDataSourceValidator: accepts common static NFS export path formats', async () => {
  for (const endpoint of NFS_EXPORT_PATHS) {
    const result = await runValidators(createDataSourceValidator, {
      body: baseVolumeCreate({
        volume_config: {
          ...baseVolumeCreate().volume_config,
          volume_info: {
            ...(baseVolumeCreate().volume_config as { volume_info: Record<string, unknown> })
              .volume_info,
            endpoint,
            provisioning_mode: 'static',
          },
        },
      }),
    });
    assert.equal(result.isEmpty(), true, `${endpoint}: ${validationMessages(result)}`);
  }
});

test('createDataSourceValidator: static volume without endpoint still passes express-validator', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  const vi = { ...(cfg.volume_info as Record<string, unknown>) };
  delete vi.endpoint;
  cfg.volume_info = vi;
  const result = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ volume_config: cfg }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('validateVolumeConfigUpdate: static PUT requires NFS export path when none stored', () => {
  const err = validateVolumeConfigUpdate(
    { volume_info: { provisioning_mode: 'static' } },
    { volume_info: { provisioning_mode: 'static' } },
  );
  assert.equal(err, 'volume_info.endpoint is required for static provisioning');
});

test('validateVolumeConfigUpdate: static PUT accepts nfs-server:/export patch', () => {
  const err = validateVolumeConfigUpdate(
    { volume_info: { provisioning_mode: 'static', endpoint: 'nfs-new:/export/data' } },
    { volume_info: { provisioning_mode: 'static' } },
  );
  assert.equal(err, null);
});

test('validateVolumeConfigUpdate: static PUT allows omitting endpoint when current has export path', () => {
  const err = validateVolumeConfigUpdate(
    { volume_info: { provisioning_mode: 'static' } },
    { volume_info: { provisioning_mode: 'static', endpoint: 'nfs-server:/export/data' } },
  );
  assert.equal(err, null);
});

test('validateVolumeConfigUpdate: no-op when patch omits volume_info', () => {
  assert.equal(validateVolumeConfigUpdate(undefined, { volume_info: { endpoint: 'x' } }), null);
  assert.equal(validateVolumeConfigUpdate({}, { volume_info: { endpoint: 'x' } }), null);
});

test('validateVolumeConfigUpdate: dynamic PUT requires storage_class_name', () => {
  const err = validateVolumeConfigUpdate(
    { volume_info: { provisioning_mode: 'dynamic' } },
    undefined,
  );
  assert.equal(err, 'storage_class_name is required for dynamic provisioning');
});

test('updateDataSourceValidator: express-validator accepts endpoint-only patch', async () => {
  const result = await runValidators(updateDataSourceValidator, {
    body: { volume_config: { volume_info: { endpoint: 'nfs-server:/new/export' } } },
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});
