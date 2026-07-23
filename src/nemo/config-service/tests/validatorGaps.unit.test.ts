/**
 * Branch-coverage tests for validator gaps in knowledgeBaseValidator and
 * dataSetValidator (labels, sync/refresh schedules, acquisition filters).
 *
 * Run: node --require ts-node/register --test tests/validatorGaps.unit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDataSourceValidator,
} from '../validators/dataSourceValidator';
import { runValidators, validationMessages } from './helpers/validationRunner';
import { baseKnowledgeBaseCreate } from './helpers/knowledgeBaseFixtures';
import { baseAcquiredS3Dataset } from './helpers/s3Fixtures';
import {
  createKnowledgeBaseValidator,
  updateKnowledgeBaseValidator,
} from '../validators/knowledgeBaseValidator';
import {
  createDataSetValidator,
  updateDataSetValidator,
} from '../validators/dataSetValidator';
import { baseVolumeCreate } from './helpers/volumeFixtures';
import { baseAcquiredGcpMetricsDataset } from './helpers/gcpFixtures';

const UUID = '123e4567-e89b-12d3-a456-426614174000';

// ── Knowledge Base ───────────────────────────────────────────────────────────

test('createKnowledgeBaseValidator: accepts embeddingModelId instead of name', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      embeddingModel: undefined,
      embeddingModelId: UUID,
    }),
  });
  assert.equal(result.isEmpty(), true, validationMessages(result));
});

test('createKnowledgeBaseValidator: rejects missing embedding model fields', async () => {
  const result = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ embeddingModel: undefined, embeddingModelId: undefined }),
  });
  assert.equal(result.isEmpty(), false);
});

test('createKnowledgeBaseValidator: labels shape validation', async () => {
  const ok = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ labels: ['prod', 'docs'] }),
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const notArray = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ labels: 'bad' }),
  });
  assert.equal(notArray.isEmpty(), false);

  const emptyEntry = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ labels: ['  '] }),
  });
  assert.equal(emptyEntry.isEmpty(), false);

  const tooLong = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({ labels: ['x'.repeat(65)] }),
  });
  assert.equal(tooLong.isEmpty(), false);

  const tooMany = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      labels: Array.from({ length: 33 }, (_, i) => `tag-${i}`),
    }),
  });
  assert.equal(tooMany.isEmpty(), false);
});

test('createKnowledgeBaseValidator: scheduled sync weekly/monthly/cron/hourly branches', async () => {
  const weekly = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'weekly',
        time_of_day: '09:15',
        day_of_week: [1, 3],
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(weekly.isEmpty(), true, validationMessages(weekly));

  const monthly = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'monthly',
        time_of_day: '00:00',
        day_of_month: 15,
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(monthly.isEmpty(), true, validationMessages(monthly));

  const cron = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '0 2 * * *',
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(cron.isEmpty(), true, validationMessages(cron));

  const hourly = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'hourly',
        interval_minutes: 180,
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(hourly.isEmpty(), true, validationMessages(hourly));

  const badWeeklyDow = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'weekly',
        time_of_day: '09:00',
        day_of_week: [9],
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(badWeeklyDow.isEmpty(), false);

  const badHourly = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'hourly',
        interval_minutes: 60,
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(badHourly.isEmpty(), false);
});

test('createKnowledgeBaseValidator: data_change_threshold requires positive integer', async () => {
  const ok = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'manual',
        data_change_threshold_enabled: true,
        data_change_threshold_value: 5,
      },
    }),
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badThreshold = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'manual',
        data_change_threshold_enabled: true,
        data_change_threshold_value: 0,
      },
    }),
  });
  assert.equal(badThreshold.isEmpty(), false);

  const badMonthly = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'monthly',
        time_of_day: '09:00',
        day_of_month: 32,
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(badMonthly.isEmpty(), false);

  const badCron = await runValidators(createKnowledgeBaseValidator, {
    body: baseKnowledgeBaseCreate({
      synchronizationConfig: {
        sync_mode: 'scheduled',
        schedule_type: 'cron',
        cron_expression: '   ',
        data_change_threshold_enabled: false,
      },
    }),
  });
  assert.equal(badCron.isEmpty(), false);
});

test('updateKnowledgeBaseValidator: labels and workflow stats fields', async () => {
  const ok = await runValidators(updateKnowledgeBaseValidator, {
    body: {
      labels: ['updated'],
      status: 'ready',
      stats: { documentCount: 10, chunkCount: 50, vectorCount: 50, storageBytes: 1024 },
      lastSyncedAt: '2024-06-01T00:00:00Z',
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badLabels = await runValidators(updateKnowledgeBaseValidator, {
    body: { labels: {} },
  });
  assert.equal(badLabels.isEmpty(), false);
});

// ── Data Set ─────────────────────────────────────────────────────────────────

test('createDataSetValidator: labels and refresh_config branches', async () => {
  const ok = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      labels: ['ingest'],
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'daily',
        time_of_day: '03:30',
        timezone: 'UTC',
      },
    }),
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const weekly = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      refreshConfig: {
        auto_refresh_enabled: true,
        schedule_type: 'weekly',
        time_of_day: '12:00',
        day_of_week: [0, 6],
      },
    }),
  });
  assert.equal(weekly.isEmpty(), true, validationMessages(weekly));

  const badRefresh = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'cron',
        cron_expression: '   ',
      },
    }),
  });
  assert.equal(badRefresh.isEmpty(), false);
});

test('createDataSetValidator: acquisitionConfig filter fields', async () => {
  const ok = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      acquisitionConfig: {
        writeMode: 'append',
        fileIncludePattern: '*.csv,*.parquet',
        maxFileSize: 1_048_576,
        modifiedAfter: '2024-01-15T10:00:00Z',
      },
    }),
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badSize = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      acquisitionConfig: { maxFileSize: -1 },
    }),
  });
  assert.equal(badSize.isEmpty(), false);

  const badDate = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      acquisitionConfig: { modifiedAfter: 'not-a-date' },
    }),
  });
  assert.equal(badDate.isEmpty(), false);
});

test('createDataSetValidator: metric categories require structured kind', async () => {
  const bad = await runValidators(createDataSetValidator, {
    body: baseAcquiredGcpMetricsDataset({ kind: 'unstructured' }),
  });
  assert.equal(bad.isEmpty(), false);
  assert.ok(validationMessages(bad).includes('kind="structured"'));
});

test('updateDataSetValidator: metric category kind and writeMode guards', async () => {
  const badKind = await runValidators(updateDataSetValidator, {
    body: {
      kind: 'unstructured',
      resourceSelector: [{ category: 'volume_metrics' }],
    },
  });
  assert.equal(badKind.isEmpty(), false);

  const badWriteMode = await runValidators(updateDataSetValidator, {
    body: {
      resourceSelector: [{ category: 'volume_metrics' }],
      acquisitionConfig: { writeMode: 'overwrite' },
    },
  });
  assert.equal(badWriteMode.isEmpty(), false);

  const ok = await runValidators(updateDataSetValidator, {
    body: {
      labels: null,
      originConnector: 'cn-abc',
      originVolume: undefined,
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'monthly',
        time_of_day: '01:00',
        day_of_month: 10,
      },
    },
  });
  assert.equal(ok.isEmpty(), true, validationMessages(ok));

  const badPaused = await runValidators(updateDataSetValidator, {
    body: {
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'daily',
        time_of_day: '02:00',
        paused: 'yes',
      },
    },
  });
  assert.equal(badPaused.isEmpty(), false);
});

test('createDataSetValidator: hourly/monthly refresh_config branches', async () => {
  const hourly = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'hourly',
        interval_minutes: 240,
      },
    }),
  });
  assert.equal(hourly.isEmpty(), true, validationMessages(hourly));

  const monthly = await runValidators(createDataSetValidator, {
    body: baseAcquiredS3Dataset({
      refresh_config: {
        auto_refresh_enabled: true,
        schedule_type: 'monthly',
        time_of_day: '04:00',
        day_of_month: 1,
      },
    }),
  });
  assert.equal(monthly.isEmpty(), true, validationMessages(monthly));
});

test('createDataSourceValidator: labels and scan_config branches', async () => {
  const labelsOk = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ labels: ['prod', 'datasets'] }),
  });
  assert.equal(labelsOk.isEmpty(), true, validationMessages(labelsOk));

  const labelsBad = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({ labels: ['x'.repeat(65)] }),
  });
  assert.equal(labelsBad.isEmpty(), false);

  const scanOk = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({
      scan_config: { scan_depth: 'custom', custom_depth: 3 },
    }),
  });
  assert.equal(scanOk.isEmpty(), true, validationMessages(scanOk));

  const scanBad = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({
      scan_config: { scan_depth: 'custom', custom_depth: 200 },
    }),
  });
  assert.equal(scanBad.isEmpty(), false);

  const scanExtraField = await runValidators(createDataSourceValidator, {
    body: baseVolumeCreate({
      scan_config: { scan_depth: 'none', unexpected: true },
    }),
  });
  assert.equal(scanExtraField.isEmpty(), false);
});
