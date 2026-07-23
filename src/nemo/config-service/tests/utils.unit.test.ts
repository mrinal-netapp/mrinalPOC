/**
 * Unit tests for the pure utility helpers in utils/.
 *
 * Run: node --require ts-node/register --test tests/utils.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Router } from 'express';
import { body } from 'express-validator';
import { QueryFailedError } from 'typeorm';

import { safeSegment, safeLog } from '../utils/safeStrings';
import { jsonFieldEqual } from '../utils/jsonFieldEquals';
import { isPostgresUniqueViolation } from '../utils/pgErrors';
import { getStatusCodeFromError, sendErrorResponse } from '../utils/errorHandler';
import { validateDatasetName, sanitizeDatasetName } from '../utils/datasetNameValidation';
import { validateBucketName } from '../utils/bucketNameValidation';
import { cronFromKBSync } from '../utils/cronFromKBSync';
import { cronFromRefreshConfig } from '../utils/cronFromRefreshConfig';
import { nextRunFromRefreshConfig } from '../utils/nextRunFromRefreshConfig';
import {
  DEFAULT_WAREHOUSE_NAME,
  getDefaultBucketName,
  getDefaultBucketDeploymentId,
  getProjectStorageRoot,
  isDefaultBucket,
} from '../utils/defaultBucket';
import {
  asyncHandler,
  validateRequest,
  sendSuccess,
  sendError,
  createCrudHandlers,
} from '../utils/routeHandler';
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors';
import { request, buildApp } from './helpers/httpApp';

// ---------------------------------------------------------------- safeStrings
test('safeSegment: url-encodes path segments and handles nullish', () => {
  assert.equal(safeSegment('a/b c'), 'a%2Fb%20c');
  assert.equal(safeSegment(''), '');
  assert.equal(safeSegment(undefined), '');
  assert.equal(safeSegment(null), '');
});

test('safeLog: strips control chars, coerces, and caps length', () => {
  assert.equal(safeLog('line1\nline2\ttab'), 'line1 line2 tab');
  assert.equal(safeLog(null), 'null');
  assert.equal(safeLog(undefined), 'undefined');
  assert.equal(safeLog(42), '42');
  const long = 'x'.repeat(600);
  const out = safeLog(long);
  assert.equal(out.length, 501); // 500 chars + ellipsis
  assert.ok(out.endsWith('…'));
});

// ------------------------------------------------------------- jsonFieldEquals
test('jsonFieldEqual: treats reordered object keys as equal', () => {
  assert.equal(
    jsonFieldEqual(
      { maxSentences: 5, overlapSentences: 2 },
      { overlapSentences: 2, maxSentences: 5 },
    ),
    true,
  );
});

test('jsonFieldEqual: detects nested value changes', () => {
  assert.equal(
    jsonFieldEqual(
      { chunkOptions: { maxSentences: 5, overlapSentences: 2 } },
      { chunkOptions: { overlapSentences: 2, maxSentences: 6 } },
    ),
    false,
  );
});

test('jsonFieldEqual: coerces undefined to null at the top level', () => {
  assert.equal(jsonFieldEqual(undefined, null), true);
  assert.equal(jsonFieldEqual(undefined, undefined), true);
});

test('jsonFieldEqual: compares arrays with order sensitivity', () => {
  assert.equal(jsonFieldEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(jsonFieldEqual(['a', 'b'], ['b', 'a']), false);
});

// ----------------------------------------------------------------- pgErrors
test('isPostgresUniqueViolation: detects 23505 and rejects others', () => {
  const unique = new QueryFailedError('INSERT', [], { code: '23505' } as any);
  assert.equal(isPostgresUniqueViolation(unique), true);

  const other = new QueryFailedError('INSERT', [], { code: '23503' } as any);
  assert.equal(isPostgresUniqueViolation(other), false);

  assert.equal(isPostgresUniqueViolation(new Error('boom')), false);
  assert.equal(isPostgresUniqueViolation(null), false);
  assert.equal(isPostgresUniqueViolation('23505'), false);
});

// --------------------------------------------------------------- errorHandler
test('getStatusCodeFromError: maps domain errors', () => {
  assert.equal(getStatusCodeFromError(new NotFoundError('Agent', 'a1')), 404);
  assert.equal(getStatusCodeFromError(new ConflictError('dupe')), 409);
  assert.equal(getStatusCodeFromError(new ValidationError('bad')), 400);
  assert.equal(getStatusCodeFromError(new Error('unmapped')), 500);
});

test('sendErrorResponse: writes status + error message', () => {
  let statusCode = 0;
  let payload: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(obj: any) {
      payload = obj;
      return this;
    },
  } as unknown as express.Response;

  sendErrorResponse(res, new ConflictError('already exists'));
  assert.equal(statusCode, 409);
  assert.deepEqual(payload, { error: 'already exists' });
});

// -------------------------------------------------------- datasetNameValidation
test('validateDatasetName: accepts valid names', () => {
  assert.equal(validateDatasetName('my_dataset-1').valid, true);
  assert.equal(validateDatasetName('_underscore').valid, true);
});

test('validateDatasetName: rejects empty/long/bad-start/reserved and sanitizes', () => {
  assert.equal(validateDatasetName('').valid, false);
  assert.equal(validateDatasetName(undefined as unknown as string).valid, false);
  assert.equal(validateDatasetName('x'.repeat(256)).valid, false);
  assert.equal(validateDatasetName('1abc').valid, false); // bad start
  assert.equal(validateDatasetName('table').valid, false); // reserved
  const withSpace = validateDatasetName('my data!');
  assert.equal(withSpace.valid, false);
  assert.ok(withSpace.sanitized && /^[a-z_][a-z0-9_-]*$/.test(withSpace.sanitized));
  assert.equal(validateDatasetName('My Data').valid, false); // uppercase start
});

test('sanitizeDatasetName: always yields a valid identifier', () => {
  assert.equal(sanitizeDatasetName('My Data!'), 'my_data');
  assert.equal(sanitizeDatasetName(''), 'dataset');
  assert.equal(sanitizeDatasetName(undefined as unknown as string), 'dataset');
  assert.equal(sanitizeDatasetName('123start'), 'dataset_123start');
  assert.ok(sanitizeDatasetName('-'.repeat(10)).length >= 1);
  assert.ok(sanitizeDatasetName('a'.repeat(300)).length <= 255);
});

// --------------------------------------------------------- bucketNameValidation
test('validateBucketName: accepts a valid bucket', () => {
  assert.equal(validateBucketName('my-bucket.name1').valid, true);
});

test('validateBucketName: rejects each rule violation', () => {
  assert.equal(validateBucketName('').valid, false);
  assert.equal(validateBucketName('ab').valid, false); // too short
  assert.equal(validateBucketName('a'.repeat(64)).valid, false); // too long
  assert.equal(validateBucketName('Has-Upper').valid, false);
  assert.equal(validateBucketName('bad_underscore').valid, false);
  assert.equal(validateBucketName('-startsdash').valid, false);
  assert.equal(validateBucketName('endsdash-').valid, false);
  assert.equal(validateBucketName('dots..bad').valid, false);
  assert.equal(validateBucketName('192.168.1.1').valid, false);
  assert.equal(validateBucketName('xn--bucket').valid, false);
  assert.equal(validateBucketName('sthree-bucket').valid, false);
  assert.equal(validateBucketName('mybucket-s3alias').valid, false);
  assert.equal(validateBucketName('mybucket--ol-s3').valid, false);
});

// ------------------------------------------------------------------- cron
test('cronFromKBSync: derives expressions per schedule_type', () => {
  assert.equal(cronFromKBSync(null), null);
  assert.equal(cronFromKBSync({ sync_mode: 'manual' } as any), null);
  assert.deepEqual(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'cron', cron_expression: '5 4 * * *' } as any), {
    cronExpression: '5 4 * * *',
    timezone: 'UTC',
  });
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'cron', cron_expression: '  ' } as any), null);
  assert.deepEqual(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'hourly', interval_minutes: 180, timezone: 'Asia/Kolkata' } as any), {
    cronExpression: '0 */3 * * *',
    timezone: 'Asia/Kolkata',
  });
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'hourly', interval_minutes: 30 } as any), null);
  assert.deepEqual(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'daily', time_of_day: '09:30' } as any), {
    cronExpression: '30 9 * * *',
    timezone: 'UTC',
  });
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'daily', time_of_day: '99:99' } as any), null);
  assert.deepEqual(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'weekly', time_of_day: '06:00', day_of_week: [1, 3, 5] } as any), {
    cronExpression: '0 6 * * 1,3,5',
    timezone: 'UTC',
  });
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'weekly', time_of_day: '06:00', day_of_week: [] } as any), null);
  assert.deepEqual(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'monthly', time_of_day: '00:00', day_of_month: 15 } as any), {
    cronExpression: '0 0 15 * *',
    timezone: 'UTC',
  });
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'monthly', time_of_day: '00:00', day_of_month: 40 } as any), null);
  assert.equal(cronFromKBSync({ sync_mode: 'scheduled', schedule_type: 'bogus' } as any), null);
});

test('cronFromRefreshConfig: gates on enabled/paused and derives per type', () => {
  assert.equal(cronFromRefreshConfig(null), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: false } as any), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, paused: true } as any), null);
  assert.deepEqual(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 120 } as any), {
    cronExpression: '0 */2 * * *',
    timezone: 'UTC',
  });
  // Below the 120-minute (2h) minimum is rejected (mirrors the validator).
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 90 } as any), null);
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'hourly', interval_minutes: 60 } as any), null);
  assert.deepEqual(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'weekly', time_of_day: '12:15', day_of_week: [0, 6] } as any), {
    cronExpression: '15 12 * * 0,6',
    timezone: 'UTC',
  });
  assert.equal(cronFromRefreshConfig({ auto_refresh_enabled: true, schedule_type: 'cron', cron_expression: '' } as any), null);
});

test('nextRunFromRefreshConfig: gates on enabled/paused/timezone and computes per type', () => {
  // No config / disabled / paused → null.
  assert.equal(nextRunFromRefreshConfig(null), null);
  assert.equal(nextRunFromRefreshConfig(undefined), null);
  assert.equal(nextRunFromRefreshConfig({ auto_refresh_enabled: false, paused: false, schedule_type: 'daily', time_of_day: '03:00' } as any), null);
  assert.equal(nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: true, schedule_type: 'daily', time_of_day: '03:00' } as any), null);

  // Non-UTC and raw cron are not computable without a tz-aware cron parser.
  assert.equal(nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'daily', time_of_day: '03:00', timezone: 'America/New_York' } as any), null);
  assert.equal(nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'cron', cron_expression: '0 3 * * *', timezone: 'UTC' } as any), null);

  // Daily 03:00 UTC → future ISO string, top of the hour, strictly ahead of now.
  const daily = nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'daily', time_of_day: '03:00', timezone: 'UTC' } as any);
  assert.ok(daily && daily.endsWith('T03:00:00.000Z'));
  assert.ok(new Date(daily as string).getTime() > Date.now());

  // Hourly interval → future ISO string aligned to the interval boundary.
  const hourly = nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'hourly', interval_minutes: 120, timezone: 'UTC' } as any);
  assert.ok(hourly && new Date(hourly as string).getTime() > Date.now());

  // Weekly → picks the soonest upcoming matching weekday.
  const weekly = nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'weekly', time_of_day: '09:30', day_of_week: [0, 6], timezone: 'UTC' } as any);
  assert.ok(weekly && weekly.endsWith('T09:30:00.000Z'));
  assert.ok(new Date(weekly as string).getTime() > Date.now());

  // Monthly (string day_of_week coercion) → valid future day-of-month.
  const monthly = nextRunFromRefreshConfig({ auto_refresh_enabled: true, paused: false, schedule_type: 'monthly', time_of_day: '00:00', day_of_month: '15', timezone: 'UTC' } as any);
  assert.ok(monthly && new Date(monthly as string).getUTCDate() === 15);
  assert.ok(new Date(monthly as string).getTime() > Date.now());
});

test('nextRunFromRefreshConfig: monthly skips invalid months and invalid day_of_month', () => {
  const invalidDom = nextRunFromRefreshConfig({
    auto_refresh_enabled: true,
    paused: false,
    schedule_type: 'monthly',
    time_of_day: '12:00',
    day_of_month: 99,
    timezone: 'UTC',
  } as any);
  assert.equal(invalidDom, null);

  const badTime = nextRunFromRefreshConfig({
    auto_refresh_enabled: true,
    paused: false,
    schedule_type: 'daily',
    time_of_day: 'bad',
    timezone: 'UTC',
  } as any);
  assert.equal(badTime, null);

  // Day 31 in months with fewer days should advance rather than overflow.
  const day31 = nextRunFromRefreshConfig({
    auto_refresh_enabled: true,
    paused: false,
    schedule_type: 'monthly',
    time_of_day: '23:59',
    day_of_month: 31,
    timezone: 'UTC',
  } as any);
  assert.ok(day31);
  // day_of_month=31 must resolve to a month that actually has a 31st (the
  // helper advances past shorter months rather than overflowing into the
  // next month), so the returned date's UTC day is exactly 31.
  assert.equal(new Date(day31 as string).getUTCDate(), 31);
});

test('nextRunFromRefreshConfig: weekly without days and unknown schedule type return null', () => {
  assert.equal(
    nextRunFromRefreshConfig({
      auto_refresh_enabled: true,
      paused: false,
      schedule_type: 'weekly',
      time_of_day: '09:00',
      day_of_week: [],
      timezone: 'UTC',
    } as any),
    null,
  );
  assert.equal(
    nextRunFromRefreshConfig({
      auto_refresh_enabled: true,
      paused: false,
      schedule_type: 'bogus',
      timezone: 'UTC',
    } as any),
    null,
  );
});

// ---------------------------------------------------------------- defaultBucket
test('defaultBucket: env-driven names and home_dir parsing', () => {
  assert.equal(DEFAULT_WAREHOUSE_NAME, 'nemo');
  const prevName = process.env.DEFAULT_BUCKET_NAME;
  const prevDep = process.env.DEFAULT_BUCKET_DEPLOYMENT_ID;
  delete process.env.DEFAULT_BUCKET_NAME;
  delete process.env.DEFAULT_BUCKET_DEPLOYMENT_ID;
  try {
    assert.equal(getDefaultBucketName(), 'default-nemo');
    assert.equal(getDefaultBucketDeploymentId(), undefined);
    assert.equal(isDefaultBucket('default-nemo'), true);
    assert.equal(isDefaultBucket('other'), false);

    process.env.DEFAULT_BUCKET_NAME = 'custom-bucket';
    process.env.DEFAULT_BUCKET_DEPLOYMENT_ID = 'dep-1';
    assert.equal(getDefaultBucketName(), 'custom-bucket');
    assert.equal(getDefaultBucketDeploymentId(), 'dep-1');

    assert.deepEqual(getProjectStorageRoot({ home_dir: 's3://default-nemo/projects/abc123/' }), {
      bucketName: 'default-nemo',
      pathPrefix: 'projects/abc123',
    });
    assert.throws(() => getProjectStorageRoot({ home_dir: 'not-an-s3-uri' }), /Invalid home_dir/);
  } finally {
    if (prevName === undefined) delete process.env.DEFAULT_BUCKET_NAME;
    else process.env.DEFAULT_BUCKET_NAME = prevName;
    if (prevDep === undefined) delete process.env.DEFAULT_BUCKET_DEPLOYMENT_ID;
    else process.env.DEFAULT_BUCKET_DEPLOYMENT_ID = prevDep;
  }
});

// ----------------------------------------------------------------- routeHandler
function buildCrudApp() {
  const store = new Map<string, any>([['x1', { id: 'x1', name: 'one' }]]);
  const handlers = createCrudHandlers<any, any>({
    create: async (data) => {
      const id = `x${store.size + 1}`;
      const entity = { id, ...data };
      store.set(id, entity);
      return entity;
    },
    getById: async (id) => store.get(id) ?? null,
    update: async (id, data) => {
      const cur = store.get(id) ?? { id };
      const next = { ...cur, ...data };
      store.set(id, next);
      return next;
    },
    delete: async (id) => store.delete(id),
    list: async () => Array.from(store.values()),
    entityName: 'Widget',
  });

  const router = Router();
  router.post(
    '/',
    body('name').isString().notEmpty(),
    (req, res, next) => {
      if (!validateRequest(req, res)) return;
      next();
    },
    handlers.create,
  );
  router.post('/raw', body('name').isString().notEmpty(), handlers.create);
  router.get('/', handlers.list);
  router.get('/:id', handlers.getById);
  router.put('/:id', handlers.update);
  router.put(
    '/raw/:id',
    body('name').isString().notEmpty(),
    handlers.update,
  );
  router.delete('/:id', handlers.delete);
  router.get('/boom/throw', asyncHandler(async () => {
    throw new NotFoundError('Widget', 'boom');
  }));
  router.get('/util/success', (_req, res) => sendSuccess(res, { ok: true }, 202));
  router.get('/util/error', (_req, res) => sendError(res, new ConflictError('conflict!')));

  return buildApp({ basePath: '/widgets', router });
}

test('routeHandler: createCrudHandlers create/list/getById flows', async () => {
  const app = buildCrudApp();
  const created = await request(app, 'POST', '/widgets', { body: { name: 'two' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'two');

  const list = await request(app, 'GET', '/widgets');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));

  const found = await request(app, 'GET', '/widgets/x1');
  assert.equal(found.status, 200);
  assert.equal(found.body.id, 'x1');

  const missing = await request(app, 'GET', '/widgets/nope');
  assert.equal(missing.status, 404);
});

test('routeHandler: update + delete + validation + async error', async () => {
  const app = buildCrudApp();
  const updated = await request(app, 'PUT', '/widgets/x1', { body: { name: 'renamed' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'renamed');

  const del = await request(app, 'DELETE', '/widgets/x1');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, { deleted: true });

  const delMissing = await request(app, 'DELETE', '/widgets/ghost');
  assert.equal(delMissing.status, 404);

  const invalid = await request(app, 'POST', '/widgets', { body: {} });
  assert.equal(invalid.status, 400);
  assert.ok(Array.isArray(invalid.body.errors));

  const thrown = await request(app, 'GET', '/widgets/boom/throw');
  assert.equal(thrown.status, 404);

  const ok = await request(app, 'GET', '/widgets/util/success');
  assert.equal(ok.status, 202);

  const errored = await request(app, 'GET', '/widgets/util/error');
  assert.equal(errored.status, 409);
  assert.equal(errored.body.name, 'ConflictError');
});

test('routeHandler: createCrudHandlers raw create/update validateRequest branches', async () => {
  const app = buildCrudApp();
  const rawInvalid = await request(app, 'POST', '/widgets/raw', { body: {} });
  assert.equal(rawInvalid.status, 400);
  assert.ok(Array.isArray(rawInvalid.body.errors));

  const rawUpdateInvalid = await request(app, 'PUT', '/widgets/raw/x1', { body: { name: '' } });
  assert.equal(rawUpdateInvalid.status, 400);
  assert.ok(Array.isArray(rawUpdateInvalid.body.errors));
});
