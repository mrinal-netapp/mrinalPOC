/**
 * Unit tests for services/LakekeeperCatalogService.ts.
 *
 * Run: node --require ts-node/register --test tests/LakekeeperCatalogService.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AxiosInstance } from 'axios';

import { LakekeeperCatalogService } from '../services/LakekeeperCatalogService';

class TestLakekeeper extends LakekeeperCatalogService {
  constructor(private readonly fake: AxiosInstance) {
    super('http://lakekeeper.test');
    (this as any).client = fake;
    (this as any).serviceAccountClient = null;
  }
}

function makeFake(handlers: Partial<Record<'get' | 'post' | 'delete', (url: string, body?: unknown, config?: any) => Promise<any>>>): AxiosInstance {
  return {
    get: async (url: string) => handlers.get?.(url) ?? { status: 200, data: {} },
    post: async (url: string, body?: unknown, config?: any) =>
      handlers.post?.(url, body, config) ?? { status: 200, data: {} },
    delete: async (url: string) => handlers.delete?.(url) ?? { status: 204, data: {} },
  } as AxiosInstance;
}

test('healthCheck: succeeds on first reachable endpoint', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        calls.push(url);
        if (url === '/health') return { status: 200, data: { ok: true } };
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
  assert.deepEqual(calls, ['/health']);
});

test('healthCheck: returns false when all endpoints fail', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('down');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    }),
  );
  assert.equal(await svc.healthCheck(), false);
});

test('listWarehouses: unwraps warehouses array', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          return { data: { warehouses: [{ name: 'nemo', 'warehouse-id': 'wh-1' }] } };
        }
        throw new Error(url);
      },
    }),
  );
  const rows = await svc.listWarehouses();
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).name, 'nemo');
});

test('getWarehouse: finds by name and caches warehouse id', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          return {
            data: {
              warehouses: [
                { name: 'nemo', 'warehouse-id': 'wh-uuid-1', 'storage-profile': { bucket: 'bucket-a' } },
              ],
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  const wh = await svc.getWarehouse('nemo');
  assert.equal(wh.name, 'nemo');
  assert.equal((wh as any).warehouseId, 'wh-uuid-1');
  assert.match(wh.uri || '', /bucket-a/);
});

test('getWarehouse: throws when name not found', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({ data: { warehouses: [] } }),
    }),
  );
  await assert.rejects(() => svc.getWarehouse('missing'), /not found/);
});

test('createWarehouse: posts s3 storage profile from s3:// uri', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url, body) => {
        posted = { url, body };
        return { status: 200, data: { 'warehouse-id': 'wh-new', name: 'my-wh' } };
      },
    }),
  );
  const result = await svc.createWarehouse({
    name: 'my-wh',
    uri: 's3://datasets-bucket/prefix',
    properties: { region: 'us-west-2', endpoint: 'https://s3.local' },
  });
  assert.equal(posted.url, '/management/v1/warehouse');
  assert.equal(posted.body['warehouse-name'], 'my-wh');
  assert.equal(posted.body['storage-profile'].bucket, 'datasets-bucket');
  assert.equal(posted.body['storage-profile'].region, 'us-west-2');
  assert.equal(posted.body['storage-profile'].endpoint, 'https://s3.local');
  assert.equal((result as any)['warehouse-id'], 'wh-new');
});

test('ensureWarehouse: returns existing warehouse without create', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: { warehouses: [{ name: 'nemo', 'warehouse-id': 'wh-1' }] },
      }),
    }),
  );
  const wh = await svc.ensureWarehouse('nemo');
  assert.equal(wh.name, 'nemo');
});

test('createNamespace: requires a valid warehouse UUID', async () => {
  const svc = new TestLakekeeper(makeFake({}));
  await assert.rejects(
    () => svc.createNamespace({ namespace: ['proj1', 'datasets'] }),
    /Warehouse ID is required/,
  );
  await assert.rejects(
    () => svc.createNamespace({ namespace: ['proj1'] }, 'not-a-uuid'),
    /UUID format/,
  );
});

test('createNamespace: posts namespace with warehouse header', async () => {
  const whId = '123e4567-e89b-12d3-a456-426614174000';
  let posted: { url?: string; headers?: Record<string, string> } = {};
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url, _body, config) => {
        posted = { url, headers: config?.headers };
        return { data: { namespace: ['proj1', 'datasets'], properties: {} } };
      },
    }),
  );
  const result = await svc.createNamespace({ namespace: ['proj1', 'datasets'] }, whId);
  assert.deepEqual(result.namespace, ['proj1', 'datasets']);
  assert.equal(posted.headers?.['x-warehouse-id'], whId);
  assert.match(posted.url ?? '', /namespaces/);
});

test('listNamespaces: returns namespace list', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: { namespaces: [{ namespace: ['proj1'] }, { namespace: ['proj2'] }] },
      }),
    }),
  );
  (svc as any).warehouseId = '123e4567-e89b-12d3-a456-426614174000';
  const namespaces = await svc.listNamespaces();
  assert.equal(namespaces.length, 2);
});

const WH_ID = '123e4567-e89b-12d3-a456-426614174000';

test('createTable: posts table payload to catalog path', async () => {
  let posted: { url?: string; body?: Record<string, unknown> } = {};
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url, body) => {
        posted = { url, body: body as Record<string, unknown> };
        return {
          data: {
            'metadata-location': 's3://bucket/table/metadata.json',
            metadata: { 'table-uuid': 'tbl-1' },
          },
        };
      },
    }),
  );
  const table = await svc.createTable({
    name: 'events',
    namespace: ['proj1', 'datasets'],
    warehouseId: WH_ID,
    schema: { type: 'struct', fields: [{ id: 1, name: 'id', type: 'long', required: true }] },
    properties: { format: 'parquet' },
  });
  assert.match(posted.url ?? '', new RegExp(`/catalog/v1/${WH_ID}/namespaces/proj1.datasets/tables`));
  assert.equal(posted.body?.name, 'events');
  assert.ok(table);
});

test('createTable: rejects invalid warehouse id', async () => {
  const svc = new TestLakekeeper(makeFake({}));
  await assert.rejects(
    () =>
      svc.createTable({
        name: 'events',
        namespace: ['default'],
        warehouseId: 'not-a-uuid',
        schema: { type: 'struct', fields: [] },
      }),
    /UUID format/,
  );
});

test('listTables: extracts table names from identifiers', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables')) {
          return {
            data: {
              identifiers: [{ name: 'events' }, { name: 'metrics', namespace: ['proj1'] }],
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const tables = await svc.listTables(['proj1', 'datasets']);
  assert.deepEqual(tables, ['events', 'metrics']);
});

test('ensureNamespace: returns existing namespace without create', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/namespaces/proj1.datasets')) {
          return { data: { namespace: ['proj1', 'datasets'], properties: {} } };
        }
        throw new Error(url);
      },
    }),
  );
  const ns = await svc.ensureNamespace(['proj1', 'datasets'], undefined, WH_ID);
  assert.deepEqual(ns.namespace, ['proj1', 'datasets']);
});

test('ensureNamespace: creates namespace when missing', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/namespaces/proj2.datasets')) {
          const err: any = new Error('not found');
          err.message = 'Namespace not found';
          throw err;
        }
        throw new Error(url);
      },
      post: async () => ({
        data: { namespace: ['proj2', 'datasets'], properties: {} },
      }),
    }),
  );
  const ns = await svc.ensureNamespace(['proj2', 'datasets'], undefined, WH_ID);
  assert.deepEqual(ns.namespace, ['proj2', 'datasets']);
});

test('ensureNamespace: resolves warehouse id from warehouseName', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          return { data: { warehouses: [{ name: 'nemo', 'warehouse-id': WH_ID }] } };
        }
        if (url.includes('/namespaces/proj3.datasets')) {
          return { data: { namespace: ['proj3', 'datasets'], properties: {} } };
        }
        throw new Error(url);
      },
    }),
  );
  const ns = await svc.ensureNamespace(['proj3', 'datasets'], 'nemo');
  assert.deepEqual(ns.namespace, ['proj3', 'datasets']);
});

test('ensureWarehouse: creates warehouse when missing and healthy', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          const err: any = new Error('not found');
          err.message = 'Warehouse not found';
          throw err;
        }
        if (url === '/health') return { status: 200, data: { ok: true } };
        throw new Error(url);
      },
      post: async (url) => {
        if (url === '/management/v1/warehouse') {
          return { data: { 'warehouse-id': 'wh-created', name: 'new-wh' } };
        }
        throw new Error(url);
      },
    }),
  );
  const wh = await svc.ensureWarehouse('new-wh', 's3://bucket/prefix');
  assert.equal(wh.name, 'new-wh');
});

test('ensureNamespace: throws when warehouse id cannot be resolved', async () => {
  const svc = new TestLakekeeper(makeFake({ get: async () => ({ data: { warehouses: [] } }) }));
  await assert.rejects(
    () => svc.ensureNamespace(['proj4', 'datasets'], 'missing-wh'),
    /Failed to get warehouse ID/,
  );
});

test('ensureNamespace: uses cached warehouse id when name lookup omits id', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          return { data: { warehouses: [{ name: 'nemo' }] } };
        }
        if (url.includes('/namespaces/proj6.datasets')) {
          return { data: { namespace: ['proj6', 'datasets'], properties: {} } };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehouseId = WH_ID;
  const ns = await svc.ensureNamespace(['proj6', 'datasets'], 'nemo');
  assert.deepEqual(ns.namespace, ['proj6', 'datasets']);
});

test('ensureNamespace: uses cached warehouse id without name or explicit id', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/namespaces/proj7.datasets')) {
          return { data: { namespace: ['proj7', 'datasets'], properties: {} } };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehouseId = WH_ID;
  const ns = await svc.ensureNamespace(['proj7', 'datasets']);
  assert.deepEqual(ns.namespace, ['proj7', 'datasets']);
});

test('ensureNamespace: throws when no warehouse id is available', async () => {
  const svc = new TestLakekeeper(makeFake({}));
  await assert.rejects(
    () => svc.ensureNamespace(['proj8', 'datasets']),
    /Warehouse ID is required to check namespace/,
  );
});

test('ensureNamespace: throws when warehouse name lookup returns no id', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          return { data: { warehouses: [{ name: 'nemo' }] } };
        }
        throw new Error(url);
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureNamespace(['proj9', 'datasets'], 'nemo'),
    /Warehouse ID not found for warehouse 'nemo'/,
  );
});

test('ensureWarehouse: rethrows non-not-found lookup errors', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('upstream timeout');
        err.message = 'upstream timeout';
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.ensureWarehouse('busy-wh'), /upstream timeout/);
});

test('ensureNamespace: rethrows non-not-found namespace errors', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/namespaces/')) {
          const err: any = new Error('upstream timeout');
          throw err;
        }
        throw new Error(url);
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureNamespace(['proj5', 'datasets'], undefined, WH_ID),
    /upstream timeout/,
  );
});

test('ensureWarehouse: fails when service is unhealthy before create', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          const err: any = new Error('not found');
          err.message = 'Warehouse not found';
          throw err;
        }
        if (url === '/health') {
          const err: any = new Error('down');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        throw new Error(url);
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureWarehouse('bad-wh', 's3://bucket/prefix'),
    /Lakekeeper service is not reachable/,
  );
});

test('getTable: fetches table metadata', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-schema-id': 1,
                schemas: [{ 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true }] }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const table = await svc.getTable(['proj1', 'datasets'], 'events');
  assert.ok(table.metadata);
});

test('getTableSchema: returns current schema fields', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-schema-id': 1,
                schemas: [{ 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true }] }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const schema = await svc.getTableSchema(['proj1', 'datasets'], 'events');
  assert.equal(schema?.type, 'struct');
  assert.equal(schema?.fields?.[0]?.name, 'id');
});

test('deleteTable: passes purgeRequested query flag', async () => {
  let deletedUrl = '';
  const svc = new TestLakekeeper(
    makeFake({
      delete: async (url) => {
        deletedUrl = url;
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await svc.deleteTable(['proj1', 'datasets'], 'events', 'nemo', { purge: true });
  assert.match(deletedUrl, /purgeRequested=true/);
  assert.match(deletedUrl, /\/tables\/events/);
});

test('ensureWarehouse: creates warehouse when missing after health check', async () => {
  let posts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/health') return { status: 200, data: { ok: true } };
        if (url === '/management/v1/warehouse') {
          const err: any = new Error('not found');
          err.message = 'Warehouse not found';
          throw err;
        }
        throw new Error(url);
      },
      post: async (url) => {
        posts += 1;
        return { data: { 'warehouse-id': 'wh-created', name: 'new-wh' } };
      },
    }),
  );
  const wh = await svc.ensureWarehouse('new-wh', 's3://bucket/prefix');
  assert.equal(wh.name, 'new-wh');
  assert.equal(posts, 1);
});

test('ensureWarehouse: throws when service is unreachable', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url === '/management/v1/warehouse') {
          const err: any = new Error('not found');
          err.message = 'Warehouse not found';
          throw err;
        }
        const err: any = new Error('down');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.ensureWarehouse('missing-wh'), /not reachable/);
});

test('ensureNamespace: rethrows non-not-found errors', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('upstream timeout');
        err.message = 'upstream timeout';
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.ensureNamespace(['proj1', 'datasets'], undefined, WH_ID),
    /upstream timeout/,
  );
});

test('getTableSnapshots: returns snapshots from table metadata', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                snapshots: [
                  { 'snapshot-id': 2, 'parent-snapshot-id': 1, 'timestamp-ms': 2000 },
                  { 'snapshot-id': 1, 'timestamp-ms': 1000 },
                ],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const snaps = await svc.getTableSnapshots(['proj1', 'datasets'], 'events');
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0]['snapshot-id'], 2);
});

test('updateTableSchema: delegates to updateTableMetadata', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-schema-id': 1,
                schemas: [{ 'schema-id': 1, fields: [{ id: 1, name: 'id', type: 'long', required: true }] }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const table = await svc.updateTableSchema(
    ['proj1', 'datasets'],
    'events',
    { type: 'struct', fields: [{ id: 2, name: 'title', type: 'string', required: false }] },
  );
  assert.ok(table.metadata);
});

test('setCurrentSnapshot: posts commit with snapshot ref update', async () => {
  let posted: { url?: string; body?: Record<string, unknown> } = {};
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url, body) => {
        posted = { url, body: body as Record<string, unknown> };
        return { data: { metadata: { 'current-snapshot-id': 1 } } };
      },
    }),
  );
  await svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 42, 99);
  const updates = posted.body?.updates as Array<Record<string, unknown>>;
  assert.equal(updates?.[0]?.action, 'set-snapshot-ref');
  assert.equal(updates?.[0]?.['snapshot-id'], 42);
});

test('deleteTable: retries with unit-separator namespace on 404', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      delete: async (url) => {
        attempts += 1;
        if (url.includes('proj1.datasets')) {
          const err: any = new Error('not found');
          err.response = { status: 404 };
          throw err;
        }
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await svc.deleteTable(['proj1', 'datasets'], 'events', 'nemo');
  assert.equal(attempts, 2);
});

test('getTableSnapshots: wraps upstream errors', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('table missing');
        err.response = { data: { message: 'table missing' } };
        throw err;
      },
    }),
  );
  await assert.rejects(
    () => svc.getTableSnapshots(['proj1', 'datasets'], 'events'),
    /Failed to get table snapshots/,
  );
});

test('getCurrentSnapshotId: returns null when metadata has no current snapshot', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return { data: { metadata: { snapshots: [] } } };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const current = await svc.getCurrentSnapshotId(['proj1', 'datasets'], 'events');
  assert.equal(current, null);
});

test('setCurrentSnapshot: retries commit with unit-separator namespace on 404', async () => {
  let attempts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url) => {
        attempts += 1;
        if (url.includes('proj1.datasets')) {
          const err: any = new Error('not found');
          err.response = { status: 404 };
          throw err;
        }
        return { data: { metadata: { 'current-snapshot-id': 2 } } };
      },
    }),
  );
  await svc.setCurrentSnapshot(['proj1', 'datasets'], 'events', 2);
  assert.equal(attempts, 2);
});

test('expireSnapshot: rejects unknown snapshot id', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 1,
                snapshots: [{ 'snapshot-id': 1, 'timestamp-ms': 1000 }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.expireSnapshot(['proj1', 'datasets'], 'events', 99),
    /Snapshot 99 not found/,
  );
});

test('expireSnapshot: rejects expiring the only snapshot', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 1,
                snapshots: [{ 'snapshot-id': 1, 'timestamp-ms': 1000 }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.expireSnapshot(['proj1', 'datasets'], 'events', 1),
    /only snapshot/,
  );
});

test('expireSnapshot: rolls back current snapshot before remove', async () => {
  let posts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 2,
                snapshots: [
                  { 'snapshot-id': 2, 'parent-snapshot-id': 1, 'timestamp-ms': 2000 },
                  { 'snapshot-id': 1, 'timestamp-ms': 1000 },
                ],
              },
            },
          };
        }
        throw new Error(url);
      },
      post: async () => {
        posts += 1;
        return { data: { metadata: { 'current-snapshot-id': 1 } } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const result = await svc.expireSnapshot(['proj1', 'datasets'], 'events', 2);
  assert.equal(result.newCurrentSnapshotId, 1);
  assert.ok(posts >= 2);
});

test('expireSnapshot: throws when no rollback target exists for current snapshot', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 9,
                snapshots: [{ 'snapshot-id': 9, 'timestamp-ms': 9000 }],
              },
            },
          };
        }
        throw new Error(url);
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  await assert.rejects(
    () => svc.expireSnapshot(['proj1', 'datasets'], 'events', 9),
    /only snapshot/,
  );
});

test('createWarehouse: defaults region when uri is s3', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    makeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { 'warehouse-id': 'wh-s3', name: 's3-wh' } };
      },
    }),
  );
  await svc.createWarehouse({ name: 's3-wh', uri: 's3://bucket/prefix' });
  assert.equal(posted['storage-profile'].bucket, 'bucket');
  assert.equal(posted['storage-profile'].region, 'us-east-1');
});

test('listWarehouses: wraps list failures', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('network');
        err.response = { data: { message: 'catalog down' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.listWarehouses(), /Failed to list warehouses/);
});

test('getWarehouse: throws when warehouse name is missing', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({ data: { warehouses: [{ name: 'other' }] } }),
    }),
  );
  await assert.rejects(() => svc.getWarehouse('nemo'), /not found/);
});

test('getWarehouse: maps upstream errors from listWarehouses', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('boom');
        err.response = { status: 503, data: { message: 'unavailable' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.getWarehouse('nemo'), /Failed to get warehouse/);
});

test('getWarehouse: returns row when warehouse id is absent', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: {
          warehouses: [{
            name: 'nemo',
            uri: 's3://bucket/prefix',
            'storage-profile': { bucket: 'bucket' },
          }],
        },
      }),
    }),
  );
  const wh = await svc.getWarehouse('nemo');
  assert.equal(wh.name, 'nemo');
});

test('healthCheck: succeeds on fallback endpoint after 404', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        calls.push(url);
        if (url === '/health') {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        return { status: 200, data: { ok: true } };
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
  assert.deepEqual(calls, ['/health', '/api/health']);
});

test('healthCheck: skips failing endpoints until one succeeds', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        calls.push(url);
        if (url === '/health') {
          const err: any = new Error('service error');
          err.response = { status: 503 };
          throw err;
        }
        if (url === '/api/health') {
          return { status: 200, data: { ok: true } };
        }
        throw new Error('unexpected');
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
  assert.deepEqual(calls, ['/health', '/api/health']);
});

test('createWarehouse: uses warehouse name when uri is not s3', async () => {
  let posted: any = null;
  const svc = new TestLakekeeper(
    makeFake({
      post: async (_url, body) => {
        posted = body;
        return { data: { 'warehouse-id': 'wh-local', name: 'local-wh' } };
      },
    }),
  );
  await svc.createWarehouse({ name: 'local-wh', uri: 'file:///data/warehouse' });
  assert.equal(posted['storage-profile'].bucket, 'local-wh');
  assert.equal(posted['storage-profile'].region, 'us-east-1');
});

test('listNamespaces: returns namespaces for cached warehouse', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: { namespaces: [{ namespace: ['proj1', 'datasets'] }] },
      }),
    }),
  );
  (svc as any).warehouseId = WH_ID;
  const rows = await svc.listNamespaces(['proj1']);
  assert.equal(rows.length, 1);
});

test('expireSnapshot: rolls back to sibling when parent snapshot missing', async () => {
  let posts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 3,
                snapshots: [
                  { 'snapshot-id': 3, 'timestamp-ms': 3000 },
                  { 'snapshot-id': 2, 'timestamp-ms': 2000 },
                  { 'snapshot-id': 1, 'timestamp-ms': 1000 },
                ],
              },
            },
          };
        }
        throw new Error(url);
      },
      post: async () => {
        posts += 1;
        return { data: { metadata: { 'current-snapshot-id': 2 } } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const result = await svc.expireSnapshot(['proj1', 'datasets'], 'events', 3);
  assert.equal(result.newCurrentSnapshotId, 2);
  assert.ok(posts >= 2);
});

test('expireSnapshot: uses parent snapshot when expiring current', async () => {
  let posts = 0;
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        if (url.includes('/tables/events')) {
          return {
            data: {
              metadata: {
                'current-snapshot-id': 2,
                snapshots: [
                  { 'snapshot-id': 2, 'parent-snapshot-id': 1, 'timestamp-ms': 2000 },
                  { 'snapshot-id': 1, 'timestamp-ms': 1000 },
                ],
              },
            },
          };
        }
        throw new Error(url);
      },
      post: async () => {
        posts += 1;
        return { data: { metadata: { 'current-snapshot-id': 1 } } };
      },
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const result = await svc.expireSnapshot(['proj1', 'datasets'], 'events', 2);
  assert.equal(result.newCurrentSnapshotId, 1);
  assert.ok(posts >= 2);
});

test('listNamespaces: throws when 404 retry also fails', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.listNamespaces(['proj1']), /Failed to list namespaces/);
});

test('listNamespaces: wraps non-404 list failures', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('upstream');
        err.response = { status: 503, data: { message: 'catalog busy' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.listNamespaces(['proj1']), /catalog busy/);
});

test('resolveWarehousePrefix: uses LAKEKEEPER_WAREHOUSE env override', async (t) => {
  const prev = process.env.LAKEKEEPER_WAREHOUSE;
  process.env.LAKEKEEPER_WAREHOUSE = 'custom-wh';
  t.after(() => {
    if (prev === undefined) delete process.env.LAKEKEEPER_WAREHOUSE;
    else process.env.LAKEKEEPER_WAREHOUSE = prev;
  });
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: {
          warehouses: [{ name: 'custom-wh', 'warehouse-id': WH_ID, 'storage-profile': { bucket: 'b' } }],
        },
      }),
    }),
  );
  const prefix = await (svc as any).resolveWarehousePrefix();
  assert.equal(prefix, WH_ID);
});

test('healthCheck: succeeds on root path fallback', async () => {
  const calls: string[] = [];
  const svc = new TestLakekeeper(
    makeFake({
      get: async (url) => {
        calls.push(url);
        if (url === '/') return { status: 200, data: { ok: true } };
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  assert.equal(await svc.healthCheck(), true);
  assert.ok(calls.includes('/'));
});

test('getNamespace: wraps upstream errors', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => {
        const err: any = new Error('missing');
        err.response = { status: 404, data: { message: 'namespace gone' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.getNamespace('wh-1', ['proj', 'datasets']), /namespace gone/);
});

test('updateNamespace: retries with unit separator on 404', async () => {
  let calls = 0;
  const svc = new TestLakekeeper(
    makeFake({
      post: async (url: string) => {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        assert.match(url, /\x1F/);
        return { data: { namespace: ['proj', 'datasets'], properties: { owner: 'team-a' } } };
      },
    }),
  );
  const ns = await svc.updateNamespace(['proj', 'datasets'], { owner: 'team-a' });
  assert.equal(ns.properties?.owner, 'team-a');
  assert.equal(calls, 2);
});

test('updateNamespace: wraps non-404 failures', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      post: async () => {
        const err: any = new Error('forbidden');
        err.response = { status: 403, data: { message: 'denied' } };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.updateNamespace(['proj'], { k: 'v' }), /denied/);
});

test('deleteNamespace: retries with unit separator on 404', async () => {
  let calls = 0;
  const svc = new TestLakekeeper(
    makeFake({
      delete: async (url: string) => {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error('missing');
          err.response = { status: 404 };
          throw err;
        }
        assert.match(url, /\x1F/);
      },
    }),
  );
  await svc.deleteNamespace(['proj', 'datasets']);
  assert.equal(calls, 2);
});

test('deleteNamespace: wraps retry failures', async () => {
  let calls = 0;
  const svc = new TestLakekeeper(
    makeFake({
      delete: async () => {
        calls += 1;
        const err: any = new Error('missing');
        err.response = { status: 404 };
        throw err;
      },
    }),
  );
  await assert.rejects(() => svc.deleteNamespace(['proj']), /Failed to delete namespace/);
  assert.equal(calls, 2);
});

test('updateTableMetadata: delegates to getTable', async () => {
  const svc = new TestLakekeeper(
    makeFake({
      get: async () => ({
        data: { name: 'events', namespace: ['ns'], metadata: { properties: { format: 'parquet' } } },
      }),
    }),
  );
  (svc as any).warehousePrefixCache.set('nemo', WH_ID);
  const result = await svc.updateTableMetadata(['ns'], 'events', { properties: { format: 'parquet' } });
  assert.equal(result.name, 'events');
});
