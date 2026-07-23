/**
 * Unit tests for the volume scan additions to the DataSource surface:
 *   - createDataSourceValidator / updateDataSourceValidator
 *     gate scan_config (volume-only, scan_depth enum, custom_depth conditional)
 *   - scanCallbackValidator enforces shape of the workflow-engine callback
 *   - scanDataSourceValidator accepts/refuses scan_config overrides
 *   - listAssociatedDataSetsQueryValidator gates query params
 *
 * These are HTTP-level validator tests — no Postgres, no workflow-engine.
 *
 * Run: `npm run test:scan`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import http from 'node:http';
import { validationResult } from 'express-validator';

import {
  createDataSourceValidator,
  updateDataSourceValidator,
  scanCallbackValidator,
  scanDataSourceValidator,
  listAssociatedDataSetsQueryValidator,
} from '../validators/dataSourceValidator';

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

function genericValidatedRoute(
  validators: any[],
  method: 'post' | 'put' | 'patch' | 'get',
  path: string,
) {
  const app = express();
  app.use(express.json());
  const router = Router({ mergeParams: true });
  (router as any)[method](path, validators, (req: any, res: any) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors
        .array()
        .map((e: any) => (e.path ? `${e.path}: ${e.msg}` : e.msg))
        .join(', ');
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' });
    }
    res.status(method === 'post' ? 201 : 200).json({ validated: true });
  });
  app.use('/test', router);
  return app;
}

function baseVolumeCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'my-volume',
    type: 'volume',
    description: 'unit test volume',
    volume_config: {
      region: 'us-west-2',
      volume_info: { type: 'nfs', endpoint: 'nfs-01.example.com:/vols/v0' },
      auth_info: { type: 'none' },
      protocol: 'NFS',
    },
    ...overrides,
  };
}

function baseConnectorCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'external-s3',
    type: 'connector',
    connector_config: {
      scope: 'resource',
      provider: 's3',
      connector_type: 'objectstore',
      bucket: 'company-datalake',
    },
    credential_id: 'cred-11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

// -------- createDataSourceValidator: scan_config --------

test('POST /datasources: volume with scan_config=all_levels validates', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'all_levels' } }),
  );
  assert.equal(res.status, 201);
});

test('POST /datasources: volume with scan_config=custom + custom_depth=10 validates', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'custom', custom_depth: 10 } }),
  );
  assert.equal(res.status, 201);
});

test('POST /datasources: scan_config=custom WITHOUT custom_depth -> 400', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'custom' } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /custom_depth is required/i);
});

test('POST /datasources: scan_config=top_5_levels WITH custom_depth -> 400', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'top_5_levels', custom_depth: 3 } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /custom_depth is only allowed/i);
});

test('POST /datasources: invalid scan_depth -> 400', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'deep' } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /scan_depth must be one of/i);
});

test('POST /datasources: scan_config.custom_depth=0 -> 400 (out of range)', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'custom', custom_depth: 0 } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /between 1 and 100/i);
});

test('POST /datasources: scan_config.custom_depth=101 -> 400 (out of range)', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'custom', custom_depth: 101 } }),
  );
  assert.equal(res.status, 400);
});

test('POST /datasources: scan_config on connector -> 400', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseConnectorCreate({ scan_config: { scan_depth: 'all_levels' } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /scan_config is only allowed when type is "volume"/i);
});

test('POST /datasources: scan_config with unknown field -> 400', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: { scan_depth: 'all_levels', bogus: true } }),
  );
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /unknown field 'bogus'/);
});

test('POST /datasources: no scan_config is valid (optional)', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(app, 'POST', '/test/', baseVolumeCreate());
  assert.equal(res.status, 201);
});

test('POST /datasources: scan_config=null is accepted (optional)', async () => {
  const app = genericValidatedRoute(createDataSourceValidator, 'post', '/');
  const res = await listen(
    app,
    'POST',
    '/test/',
    baseVolumeCreate({ scan_config: null }),
  );
  assert.equal(res.status, 201);
});

// -------- updateDataSourceValidator: scan_config --------

test('PUT /datasources/:id: scan_config=none validates', async () => {
  const app = genericValidatedRoute(updateDataSourceValidator, 'put', '/:id');
  const res = await listen(app, 'PUT', '/test/vol-abc12345', {
    scan_config: { scan_depth: 'none' },
  });
  assert.equal(res.status, 200);
});

test('PUT /datasources/:id: scan_config bad shape -> 400', async () => {
  const app = genericValidatedRoute(updateDataSourceValidator, 'put', '/:id');
  const res = await listen(app, 'PUT', '/test/vol-abc12345', {
    scan_config: { scan_depth: 'sometimes' },
  });
  assert.equal(res.status, 400);
});

// -------- scanDataSourceValidator (POST /:id/scan) --------

test('POST /datasources/:id/scan: empty body is allowed', async () => {
  const app = genericValidatedRoute(scanDataSourceValidator, 'post', '/:id/scan');
  const res = await listen(app, 'POST', '/test/vol-abc12345/scan', {});
  assert.equal(res.status, 201);
});

test('POST /datasources/:id/scan: invalid scan_config -> 400', async () => {
  const app = genericValidatedRoute(scanDataSourceValidator, 'post', '/:id/scan');
  const res = await listen(app, 'POST', '/test/vol-abc12345/scan', {
    scan_config: { scan_depth: 'custom' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /custom_depth is required/i);
});

test('POST /datasources/:id/scan: valid override validates', async () => {
  const app = genericValidatedRoute(scanDataSourceValidator, 'post', '/:id/scan');
  const res = await listen(app, 'POST', '/test/vol-abc12345/scan', {
    scan_config: { scan_depth: 'top_2_levels' },
  });
  assert.equal(res.status, 201);
});

// -------- scanCallbackValidator (internal PATCH) --------

test('PATCH internal /scan-result: completed with scan_result validates', async () => {
  const app = genericValidatedRoute(scanCallbackValidator, 'patch', '/:projectId/:id/scan-result');
  const res = await listen(app, 'PATCH', '/test/proj-x/vol-abc12345/scan-result', {
    scan_status: { state: 'completed', completed_at: '2026-05-23T00:00:00Z' },
    scan_result: {
      completed_at: '2026-05-23T00:00:00Z',
      total_files: 12,
      total_folders: 3,
      total_size_bytes: 123456,
      file_type_stats: [{ file_type: '.pdf', count: 12 }],
    },
  });
  assert.equal(res.status, 200);
});

test('PATCH internal /scan-result: failed state without scan_result validates', async () => {
  const app = genericValidatedRoute(scanCallbackValidator, 'patch', '/:projectId/:id/scan-result');
  const res = await listen(app, 'PATCH', '/test/proj-x/vol-abc12345/scan-result', {
    scan_status: { state: 'failed', last_error: 'boom' },
  });
  assert.equal(res.status, 200);
});

test('PATCH internal /scan-result: bad state -> 400', async () => {
  const app = genericValidatedRoute(scanCallbackValidator, 'patch', '/:projectId/:id/scan-result');
  const res = await listen(app, 'PATCH', '/test/proj-x/vol-abc12345/scan-result', {
    scan_status: { state: 'queued' },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /scan_status.state must be one of/i);
});

test('PATCH internal /scan-result: scan_result missing required field -> 400', async () => {
  const app = genericValidatedRoute(scanCallbackValidator, 'patch', '/:projectId/:id/scan-result');
  const res = await listen(app, 'PATCH', '/test/proj-x/vol-abc12345/scan-result', {
    scan_status: { state: 'completed' },
    scan_result: {
      completed_at: '2026-05-23T00:00:00Z',
      total_files: 1,
      total_folders: 0,
      // total_size_bytes missing
      file_type_stats: [],
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /total_size_bytes is required/i);
});

test('PATCH internal /scan-result: file_type_stats must be array -> 400', async () => {
  const app = genericValidatedRoute(scanCallbackValidator, 'patch', '/:projectId/:id/scan-result');
  const res = await listen(app, 'PATCH', '/test/proj-x/vol-abc12345/scan-result', {
    scan_status: { state: 'completed' },
    scan_result: {
      completed_at: '2026-05-23T00:00:00Z',
      total_files: 1,
      total_folders: 0,
      total_size_bytes: 100,
      file_type_stats: 'nope',
    },
  });
  assert.equal(res.status, 400);
  assert.match(String(res.body?.error), /file_type_stats must be an array/i);
});

// -------- listAssociatedDataSetsQueryValidator --------

test('GET /:id/datasets: limit=10 includeManual=true validates', async () => {
  const app = genericValidatedRoute(listAssociatedDataSetsQueryValidator, 'get', '/:id/datasets');
  const res = await listen(app, 'GET', '/test/vol-abc12345/datasets?limit=10&includeManual=true');
  assert.equal(res.status, 200);
});

test('GET /:id/datasets: limit=2000 -> 400 (over max)', async () => {
  const app = genericValidatedRoute(listAssociatedDataSetsQueryValidator, 'get', '/:id/datasets');
  const res = await listen(app, 'GET', '/test/vol-abc12345/datasets?limit=2000');
  assert.equal(res.status, 400);
});

test('GET /:id/datasets: includeManual=notabool -> 400', async () => {
  const app = genericValidatedRoute(listAssociatedDataSetsQueryValidator, 'get', '/:id/datasets');
  const res = await listen(app, 'GET', '/test/vol-abc12345/datasets?includeManual=yes-please');
  assert.equal(res.status, 400);
});
