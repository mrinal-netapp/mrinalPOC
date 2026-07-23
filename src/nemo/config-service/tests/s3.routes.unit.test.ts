/**
 * HTTP-level tests for datasource/dataset validation wiring (no Postgres).
 *
 * Mounts the same validator chains + validationResult handling as production
 * routes, but stops before repository/service calls.
 *
 * Run: `npm run test:s3`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import http from 'node:http';
import { validationResult } from 'express-validator';

import { createDataSourceValidator, updateDataSourceValidator } from '../validators/dataSourceValidator';
import { createDataSetValidator, updateDataSetValidator } from '../validators/dataSetValidator';
import { validateRequest } from '../utils/routeHandler';
import { baseS3ConnectorCreate, baseAcquiredS3Dataset } from './helpers/s3Fixtures';

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

/** Mirrors POST /datasources validation branch in dataSourceRoutes.ts */
function buildDataSourceValidationApp() {
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
    res.json({ validated: true, id: req.params.id });
  });

  app.use('/api/v1/projects/:projectId/datasources', router);
  return app;
}

/** Mirrors POST/PUT /datasets validation (validateRequest) in dataSetRoutes.ts */
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

test('POST /datasources: valid S3 connector returns 201', async () => {
  const res = await listen(buildDataSourceValidationApp(), 'POST', DS_BASE, baseS3ConnectorCreate());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasources: missing bucket returns 400 VALIDATION_ERROR', async () => {
  const { bucket: _b, ...cfg } = baseS3ConnectorCreate().connector_config as Record<string, unknown>;
  const res = await listen(buildDataSourceValidationApp(), 'POST', DS_BASE, baseS3ConnectorCreate({
    connector_config: cfg,
  }));
  assert.equal(res.status, 400);
  assert.equal(res.body?.code, 'VALIDATION_ERROR');
  assert.match(String(res.body?.error), /bucket is required/i);
});

test('POST /datasources: missing credential_id returns 400', async () => {
  const res = await listen(buildDataSourceValidationApp(), 'POST', DS_BASE, baseS3ConnectorCreate({
    credential_id: '',
  }));
  assert.equal(res.status, 400);
  assert.equal(res.body?.code, 'VALIDATION_ERROR');
});

test('PUT /datasources/:id: valid connector_config patch returns 200', async () => {
  const res = await listen(
    buildDataSourceValidationApp(),
    'PUT',
    `${DS_BASE}/cn-abc12345`,
    { connector_config: { scope: 'resource', provider: 's3', connector_type: 'objectstore', bucket: 'b2' } },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: valid acquired S3 dataset returns 201', async () => {
  const res = await listen(buildDataSetValidationApp(), 'POST', SET_BASE, baseAcquiredS3Dataset());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: acquired without origin returns 400 errors array', async () => {
  const res = await listen(buildDataSetValidationApp(), 'POST', SET_BASE, baseAcquiredS3Dataset({
    originConnector: undefined,
  }));
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});

test('PUT /datasets/:id: metric mix in resourceSelector returns 400', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-abc12345`, {
    resourceSelector: [{ bucket: 'b', prefix: 'p' }, { category: 'volume_metrics' }],
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});

test('PUT /datasets/:id: objectstore-only resourceSelector patch returns 200', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-abc12345`, {
    resourceSelector: [{ bucket: 'new-src', prefix: 'inbound/' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});
