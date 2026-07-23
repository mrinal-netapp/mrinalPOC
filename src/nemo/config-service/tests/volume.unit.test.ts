/**
 * Volume data source reference-catalog and type guard tests.
 *
 * Dataset / data-source validator tests: volume.dataSource.unit.test.ts, volume.dataSet.unit.test.ts
 *
 * Run: `npm run test:volume`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referenceCatalog } from '../services/referenceCatalog';

test('referenceCatalog: volume data_source has no credential edge', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-vol-1', {
    id: 'ds-vol-1',
    projectId: 'p1',
    type: 'volume',
    name: 'nfs-primary',
  });
  assert.deepEqual(edges, []);
});

test('referenceCatalog: volume with credentialId still surfaces uses_credential', () => {
  const edges = referenceCatalog.extractEdges('data_source', 'ds-vol-2', {
    id: 'ds-vol-2',
    projectId: 'p1',
    type: 'volume',
    credentialId: 'cred-99',
  });
  assert.deepEqual(edges, [
    { targetType: 'credential', targetId: 'cred-99', relation: 'uses_credential' },
  ]);
});
