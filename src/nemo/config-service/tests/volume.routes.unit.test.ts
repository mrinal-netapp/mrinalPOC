/**
 * HTTP-level tests for volume datasource/dataset validation wiring.
 *
 * Run: `npm run test:volume`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import http from 'node:http';
import { validationResult } from 'express-validator';

import { createDataSourceValidator, updateDataSourceValidator } from '../validators/dataSourceValidator';
import { createDataSetValidator, updateDataSetValidator } from '../validators/dataSetValidator';
import { validateRequest } from '../utils/routeHandler';
import { validateVolumeConfigUpdate } from '../utils/volumeConfigValidation';
import { baseVolumeCreate, baseAcquiredVolumeDataset } from './helpers/volumeFixtures';

type HttpJson = { status: number; body: Record<string, unknown> | null };

function listen(
  app: express.Express,
  method: string,
  urlPath: string,
  jsonBody?: Record<string, unknown>,
): Promise<HttpJson> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('failed to bind test server'));
      }
      const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: addr.port,
          path: urlPath,
          method,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const raw = Buffer.concat(chunks).toString('utf8');
            let body: Record<string, unknown> | null = null;
            if (raw) {
              try {
                body = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                body = { _raw: raw };
              }
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const CURRENT_STATIC_NO_ENDPOINT = {
  type: 'volume',
  volume_config: { volume_info: { provisioning_mode: 'static', type: 'nfs' } },
};

const CURRENT_STATIC_WITH_ENDPOINT = {
  type: 'volume',
  volume_config: {
    volume_info: {
      provisioning_mode: 'static',
      type: 'nfs',
      endpoint: 'nfs-server.example.com:/export/data',
    },
  },
};

function buildDataSourceValidationApp(includeVolumeUpdateRules = false) {
  const app = express();
  app.use(express.json());
  const router = Router({ mergeParams: true });

  router.post('/', createDataSourceValidator, (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors
        .array()
        .map((e: { path?: string; msg: string }) => (e.path ? `${e.path}: ${e.msg}` : e.msg))
        .join(', ');
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' });
    }
    res.status(201).json({ validated: true, name: req.body.name });
  });

  router.put('/:id', updateDataSourceValidator, (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors
        .array()
        .map((e: { path?: string; msg: string }) => (e.path ? `${e.path}: ${e.msg}` : e.msg))
        .join(', ');
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' });
    }
    if (includeVolumeUpdateRules) {
      const current =
        req.params.id === 'vol-has-endpoint'
          ? CURRENT_STATIC_WITH_ENDPOINT
          : CURRENT_STATIC_NO_ENDPOINT;
      if (current.type === 'volume' && req.body.volume_config) {
        const volumeErr = validateVolumeConfigUpdate(
          req.body.volume_config,
          current.volume_config,
        );
        if (volumeErr) {
          return res.status(400).json({ error: volumeErr, code: 'INVALID_REQUEST' });
        }
      }
    }
    res.json({ validated: true, id: req.params.id });
  });

  app.use('/api/v1/projects/:projectId/datasources', router);
  return app;
}

function buildDataSetValidationApp() {
  const app = express();
  app.use(express.json());
  const router = Router({ mergeParams: true });

  router.post('/', createDataSetValidator, (req, res) => {
    if (!validateRequest(req, res)) return;
    res.status(201).json({ validated: true, name: req.body.name });
  });

  router.put('/:id', updateDataSetValidator, (req, res) => {
    if (!validateRequest(req, res)) return;
    res.json({ validated: true, id: req.params.id });
  });

  app.use('/api/v1/projects/:projectId/datasets', router);
  return app;
}

const PROJECT = 'proj-test01';
const DS_BASE = `/api/v1/projects/${PROJECT}/datasources`;
const SET_BASE = `/api/v1/projects/${PROJECT}/datasets`;

test('POST /datasources: valid volume returns 201', async () => {
  const res = await listen(buildDataSourceValidationApp(), 'POST', DS_BASE, baseVolumeCreate());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasources: missing region returns 400', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  delete cfg.region;
  const res = await listen(
    buildDataSourceValidationApp(),
    'POST',
    DS_BASE,
    baseVolumeCreate({ volume_config: cfg }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.code, 'VALIDATION_ERROR');
  assert.match(String(res.body?.error), /volume_config\.region/i);
});

test('PUT /datasources/:id: partial volume_config patch returns 200', async () => {
  const res = await listen(buildDataSourceValidationApp(), 'PUT', `${DS_BASE}/vol-00001`, {
    volume_config: {
      region: 'eu-west-1',
      volume_info: { endpoint: 'nfs-new:/data' },
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});

test('POST /datasources: static volume without NFS export path passes express-validator only', async () => {
  const body = baseVolumeCreate();
  const cfg = { ...(body.volume_config as Record<string, unknown>) };
  const vi = { ...(cfg.volume_info as Record<string, unknown>) };
  delete vi.endpoint;
  cfg.volume_info = vi;
  const res = await listen(
    buildDataSourceValidationApp(),
    'POST',
    DS_BASE,
    baseVolumeCreate({ volume_config: cfg }),
  );
  assert.equal(res.status, 201);
});

test('PUT /datasources/:id: static update without export path returns 400 when route rules applied', async () => {
  const res = await listen(
    buildDataSourceValidationApp(true),
    'PUT',
    `${DS_BASE}/vol-no-endpoint`,
    { volume_config: { volume_info: { provisioning_mode: 'static' } } },
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.code, 'INVALID_REQUEST');
  assert.match(String(res.body?.error), /volume_info\.endpoint is required/i);
});

test('PUT /datasources/:id: static NFS export path patch returns 200 when route rules applied', async () => {
  const res = await listen(
    buildDataSourceValidationApp(true),
    'PUT',
    `${DS_BASE}/vol-no-endpoint`,
    {
      volume_config: {
        volume_info: {
          provisioning_mode: 'static',
          endpoint: 'nfs-server.example.com:/export/data',
        },
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: valid acquired volume dataset returns 201', async () => {
  const res = await listen(buildDataSetValidationApp(), 'POST', SET_BASE, baseAcquiredVolumeDataset());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: acquired without origin returns 400 errors array', async () => {
  const res = await listen(
    buildDataSetValidationApp(),
    'POST',
    SET_BASE,
    baseAcquiredVolumeDataset({ originVolume: undefined }),
  );
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});

test('POST /datasets: both origins returns 400', async () => {
  const res = await listen(
    buildDataSetValidationApp(),
    'POST',
    SET_BASE,
    baseAcquiredVolumeDataset({ originConnector: 'cn-abc12345' }),
  );
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});

test('PUT /datasets/:id: filterSpec patch returns 200', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-vol001`, {
    filterSpec: { sourcePath: '/exports/incoming' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});
