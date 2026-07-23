/**
 * HTTP-level tests for MySQL datasource/dataset validation wiring (no Postgres).
 *
 * Mirrors s3.routes.unit.test.ts: POST/PUT hit the same validator chains as production routes.
 *
 * Note: PUT /datasources does not re-run provider-catalog validation on connector_config
 * (same as S3); only shape checks from updateDataSourceValidator apply.
 * PATCH /datasets/:id is used for workflow watermark merges and has no express-validator chain.
 *
 * Run: `npm run test:mysql`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import http from 'node:http';
import { validationResult } from 'express-validator';

import { createDataSourceValidator, updateDataSourceValidator } from '../validators/dataSourceValidator';
import { createDataSetValidator, updateDataSetValidator } from '../validators/dataSetValidator';
import { validateRequest } from '../utils/routeHandler';
import { baseMysqlConnectorCreate, baseAcquiredMysqlDataset } from './helpers/mysqlFixtures';

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

test('POST /datasources: valid MySQL connector returns 201', async () => {
  const res = await listen(buildDataSourceValidationApp(), 'POST', DS_BASE, baseMysqlConnectorCreate());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasources: schema field accepted on create', async () => {
  const res = await listen(
    buildDataSourceValidationApp(),
    'POST',
    DS_BASE,
    baseMysqlConnectorCreate({
      connector_config: {
        ...baseMysqlConnectorCreate().connector_config,
        schema: 'sakila',
        ssl_mode: 'require',
      },
    }),
  );
  assert.equal(res.status, 201);
});

test('POST /datasources: unknown connector field returns 400', async () => {
  const res = await listen(
    buildDataSourceValidationApp(),
    'POST',
    DS_BASE,
    baseMysqlConnectorCreate({
      connector_config: {
        ...baseMysqlConnectorCreate().connector_config,
        bucket: 'not-for-mysql',
      },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.body?.code, 'VALIDATION_ERROR');
  assert.match(String(res.body?.error), /Unknown field 'bucket'/i);
});

test('POST /datasources: missing host returns 400', async () => {
  const { host: _h, ...cfg } = baseMysqlConnectorCreate().connector_config as Record<string, unknown>;
  const res = await listen(
    buildDataSourceValidationApp(),
    'POST',
    DS_BASE,
    baseMysqlConnectorCreate({ connector_config: cfg }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /host is required/i);
});

test('PUT /datasources/:id: valid connector_config patch returns 200', async () => {
  const res = await listen(
    buildDataSourceValidationApp(),
    'PUT',
    `${DS_BASE}/cn-mysql001`,
    {
      connector_config: {
        scope: 'resource',
        provider: 'mysql',
        connector_type: 'database',
        host: 'mysql.example.com',
        port: 3306,
        ssl_mode: 'verify-full',
        schema: 'sakila',
      },
    },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: valid acquired MySQL dataset returns 201', async () => {
  const res = await listen(buildDataSetValidationApp(), 'POST', SET_BASE, baseAcquiredMysqlDataset());
  assert.equal(res.status, 201);
  assert.equal(res.body?.validated, true);
});

test('POST /datasets: empty description returns 201', async () => {
  const res = await listen(
    buildDataSetValidationApp(),
    'POST',
    SET_BASE,
    baseAcquiredMysqlDataset({ description: '' }),
  );
  assert.equal(res.status, 201);
});

test('POST /datasets: acquired without origin returns 400 errors array', async () => {
  const res = await listen(
    buildDataSetValidationApp(),
    'POST',
    SET_BASE,
    baseAcquiredMysqlDataset({ originConnector: undefined }),
  );
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});

test('PUT /datasets/:id: sqlQuery and sourceDatabase patch returns 200', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-mysql01`, {
    sqlQuery: 'SELECT * FROM sakila.actor',
    sourceDatabase: 'sakila',
    sourceSchema: 'sakila',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.validated, true);
});

test('PUT /datasets/:id: empty description patch returns 200', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-mysql01`, {
    description: '',
  });
  assert.equal(res.status, 200);
});

test('PUT /datasets/:id: metric mix in resourceSelector returns 400', async () => {
  const res = await listen(buildDataSetValidationApp(), 'PUT', `${SET_BASE}/ds-mysql01`, {
    resourceSelector: [
      { database: 'sakila', schema: 'sakila', table: 'actor' },
      { category: 'volume_metrics' },
    ],
  });
  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body?.errors));
});
