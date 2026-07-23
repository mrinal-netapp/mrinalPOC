/**
 * Unit tests for services/DataSetCatalogOrchestrator.ts.
 *
 * Module-mocked seams (loaded before the SUT):
 *   - services/LakekeeperCatalogService (warehouse/namespace/table catalog ops)
 *   - services/DeploymentEndpointService (endpoint resolution + S3 formatting)
 *   - repositories/ProjectRepository (project metadata)
 *
 * Run: node --require ts-node/register --test tests/DataSetCatalogOrchestrator.unit.test.ts
 */
import 'reflect-metadata';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { mockModule, loadFresh, clearModule, restoreScope } from './helpers/moduleMock';

let scope: ReturnType<typeof restoreScope>;
let Orchestrator: any;

// Controllable fakes (reset per test).
let lake: any;
let dep: any;
let proj: any;

beforeEach(() => {
  lake = {
    getWarehouse: async (_n: string) => ({ warehouseId: 'wh-meta' }),
    ensureNamespace: async () => undefined,
    createTable: async (req: any) => ({ name: req.name }),
  };
  dep = {
    getPrimaryDeploymentEndpoint: async () => 'http://app.example.com',
    formatS3Endpoint: (e: string) => e.replace('app.', 's3.'),
  };
  proj = {
    getById: async (_id: string) => ({ id: 'p', metadata: { warehouseId: 'wh-existing' } }),
    update: async () => undefined,
  };

  scope = restoreScope();
  scope.add(
    mockModule('services/LakekeeperCatalogService', {
      LakekeeperCatalogService: class {
        getWarehouse(n: string) {
          return lake.getWarehouse(n);
        }
        ensureNamespace(...a: any[]) {
          return lake.ensureNamespace(...a);
        }
        createTable(r: any) {
          return lake.createTable(r);
        }
      },
    }),
  );
  scope.add(
    mockModule('services/DeploymentEndpointService', {
      DeploymentEndpointService: {
        getPrimaryDeploymentEndpoint: (...a: any[]) => dep.getPrimaryDeploymentEndpoint(...a),
        formatS3Endpoint: (e: string) => dep.formatS3Endpoint(e),
      },
    }),
  );
  scope.add(
    mockModule('repositories/ProjectRepository', {
      ProjectRepository: class {
        getById(id: string) {
          return proj.getById(id);
        }
        update(...a: any[]) {
          return proj.update(...a);
        }
      },
    }),
  );

  Orchestrator = loadFresh('services/DataSetCatalogOrchestrator').DataSetCatalogOrchestrator;
  mock.method(console, 'log', () => undefined);
});

afterEach(() => {
  scope.restoreAll();
  clearModule('services/DataSetCatalogOrchestrator');
  mock.restoreAll();
});

test('ensureWarehouse throws when no deployment endpoint is available', async () => {
  dep.getPrimaryDeploymentEndpoint = async () => null;
  await assert.rejects(Orchestrator.ensureWarehouse('p', 'bucket'), /No deployment endpoint found/);
});

test('ensureWarehouse throws NotFoundError when the project is missing', async () => {
  proj.getById = async () => null;
  await assert.rejects(Orchestrator.ensureWarehouse('p', 'bucket'), /Project.*not found/);
});

test('ensureWarehouse returns warehouseId from project metadata and verifies it', async () => {
  proj.getById = async () => ({ id: 'p', metadata: { warehouseId: 'wh-existing' } });
  const res = await Orchestrator.ensureWarehouse('p', 'bucket');
  assert.equal(res.warehouseId, 'wh-existing');
  assert.equal(res.s3Endpoint, 'http://s3.example.com');
});

test('ensureWarehouse maps a "not found" verify error to a friendly ValidationError', async () => {
  proj.getById = async () => ({ id: 'p', metadata: { warehouseId: 'wh-existing' } });
  lake.getWarehouse = async () => {
    throw new Error('warehouse not found');
  };
  await assert.rejects(Orchestrator.ensureWarehouse('p', 'bucket'), /does not exist in Lakekeeper/);
});

test('ensureWarehouse rethrows non-"not found" verify errors', async () => {
  proj.getById = async () => ({ id: 'p', metadata: { warehouseId: 'wh-existing' } });
  lake.getWarehouse = async () => {
    throw new Error('connection refused');
  };
  await assert.rejects(Orchestrator.ensureWarehouse('p', 'bucket'), /connection refused/);
});

test('ensureWarehouse looks up + caches the warehouse id when metadata is empty', async () => {
  proj.getById = async () => ({ id: 'p', metadata: {} });
  lake.getWarehouse = async () => ({ warehouseId: 'wh-looked-up' });
  const update = mock.fn(async () => undefined);
  proj.update = update;
  const res = await Orchestrator.ensureWarehouse('p', 'bucket');
  assert.equal(res.warehouseId, 'wh-looked-up');
  assert.equal(update.mock.callCount(), 1);
});

test('ensureWarehouse maps a "not found" lookup error to a friendly ValidationError', async () => {
  proj.getById = async () => ({ id: 'p', metadata: {} });
  lake.getWarehouse = async () => {
    throw new Error('warehouse not found');
  };
  await assert.rejects(Orchestrator.ensureWarehouse('p', 'bucket'), /does not exist in Lakekeeper/);
});

test('ensureNamespace delegates to the catalog service', async () => {
  const ensure = mock.fn(async () => undefined);
  lake.ensureNamespace = ensure;
  await Orchestrator.ensureNamespace(['p'], 'wh-1');
  assert.equal(ensure.mock.callCount(), 1);
});

test('createTable returns the created catalog table', async () => {
  const res = await Orchestrator.createTable({ name: 'tbl', namespace: ['p'], warehouseId: 'wh-1' });
  assert.equal(res.name, 'tbl');
});
