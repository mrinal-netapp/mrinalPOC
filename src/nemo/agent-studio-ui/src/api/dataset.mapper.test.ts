import { describe, expect, it } from 'vitest';

import {
  deriveSourcePath,
  fromBackendScheduleConfig,
  normalizeDataset,
  normalizeDatasetListItem,
  normalizeKBListItem,
  normalizeManifest,
  normalizeSnapshot,
  toBackendAcquisitionConfig,
  toBackendDatabaseSourceFields,
  toBackendFilterSpec,
  toBackendRefreshConfig,
} from './dataset.mapper';
import type { DatasetRefreshConfig, DatasetSpec } from './dataset.types';

function makeRefreshConfig(overrides: Partial<DatasetRefreshConfig> = {}): DatasetRefreshConfig {
  return {
    auto_refresh_enabled: true,
    paused: false,
    schedule_type: 'daily',
    timezone: null,
    interval_minutes: null,
    time_of_day: null,
    day_of_week: null,
    day_of_month: null,
    cron_expression: null,
    ...overrides,
  };
}

describe('toBackendRefreshConfig', () => {
  it('always emits the core flags as booleans', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'cron', cron_expression: '0 9 * * *' }),
    );
    expect(out.auto_refresh_enabled).toBe(true);
    expect(out.paused).toBe(false);
    expect(out.schedule_type).toBe('cron');
  });

  it('omits a null timezone (backend rejects timezone: null) but keeps a real one', () => {
    expect(toBackendRefreshConfig(makeRefreshConfig({ timezone: null }))).not.toHaveProperty(
      'timezone',
    );
    expect(
      toBackendRefreshConfig(makeRefreshConfig({ timezone: 'Asia/Kolkata' })).timezone,
    ).toBe('Asia/Kolkata');
  });

  it('hourly: keeps interval_minutes only', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'hourly', interval_minutes: 120 }),
    );
    expect(out).toMatchObject({ schedule_type: 'hourly', interval_minutes: 120 });
    expect(out).not.toHaveProperty('time_of_day');
    expect(out).not.toHaveProperty('day_of_week');
    expect(out).not.toHaveProperty('cron_expression');
  });

  it('daily: keeps time_of_day only', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'daily', time_of_day: '02:30' }),
    );
    expect(out).toMatchObject({ schedule_type: 'daily', time_of_day: '02:30' });
    expect(out).not.toHaveProperty('interval_minutes');
    expect(out).not.toHaveProperty('day_of_week');
  });

  it('weekly: keeps time_of_day + non-empty day_of_week', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'weekly', time_of_day: '06:00', day_of_week: [1, 3, 5] }),
    );
    expect(out).toMatchObject({
      schedule_type: 'weekly',
      time_of_day: '06:00',
      day_of_week: [1, 3, 5],
    });
  });

  it('weekly: omits an empty day_of_week array', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'weekly', time_of_day: '06:00', day_of_week: [] }),
    );
    expect(out).not.toHaveProperty('day_of_week');
  });

  it('monthly: keeps time_of_day + day_of_month', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'monthly', time_of_day: '00:00', day_of_month: 15 }),
    );
    expect(out).toMatchObject({
      schedule_type: 'monthly',
      time_of_day: '00:00',
      day_of_month: 15,
    });
    expect(out).not.toHaveProperty('day_of_week');
  });

  it('cron: keeps cron_expression only', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ schedule_type: 'cron', cron_expression: '15 4 * * *' }),
    );
    expect(out).toMatchObject({ schedule_type: 'cron', cron_expression: '15 4 * * *' });
    expect(out).not.toHaveProperty('time_of_day');
    expect(out).not.toHaveProperty('interval_minutes');
  });

  it('reflects paused/disabled flags through to the backend', () => {
    const out = toBackendRefreshConfig(
      makeRefreshConfig({ auto_refresh_enabled: false, paused: true, schedule_type: 'cron' }),
    );
    expect(out.auto_refresh_enabled).toBe(false);
    expect(out.paused).toBe(true);
  });
});

describe('toBackendAcquisitionConfig', () => {
  const NOW = new Date('2026-06-16T00:00:00.000Z');

  it('returns undefined when there are no filters', () => {
    expect(toBackendAcquisitionConfig(undefined)).toBeUndefined();
    expect(toBackendAcquisitionConfig({ folder_scope: 'all' })).toBeUndefined();
  });

  it('maps file_types → fileIncludePattern as a comma-separated glob list', () => {
    const out = toBackendAcquisitionConfig({ file_types: ['.pdf', '.docx'] });
    expect(out).toMatchObject({ fileIncludePattern: '*.pdf,*.docx' });
  });

  it('normalises file types missing a leading dot', () => {
    const out = toBackendAcquisitionConfig({ file_types: ['pdf', 'txt'] });
    expect(out?.fileIncludePattern).toBe('*.pdf,*.txt');
  });

  it('passes through glob patterns entered in the Types field (e.g. *.csv)', () => {
    const out = toBackendAcquisitionConfig({ file_types: ['*.csv'] });
    expect(out?.fileIncludePattern).toBe('*.csv');
  });

  it('normalises unicode asterisk lookalikes in glob entries', () => {
    const out = toBackendAcquisitionConfig({ file_types: ['\uFF0A.csv'] });
    expect(out?.fileIncludePattern).toBe('*.csv');
  });

  it('passes through path-style include globs unchanged', () => {
    const out = toBackendAcquisitionConfig({ file_types: ['temp/*.csv', '*.parquet'] });
    expect(out?.fileIncludePattern).toBe('temp/*.csv,*.parquet');
  });

  it('maps exclude_patterns → fileExcludePattern and max_file_size_bytes → maxFileSize', () => {
    const out = toBackendAcquisitionConfig({
      exclude_patterns: ['temp/*', '*.tmp'],
      max_file_size_bytes: 1048576,
    });
    expect(out).toMatchObject({
      fileExcludePattern: 'temp/*,*.tmp',
      maxFileSize: 1048576,
    });
  });

  it('omits a non-positive maxFileSize', () => {
    expect(toBackendAcquisitionConfig({ max_file_size_bytes: 0 })).toBeUndefined();
  });

  it('maps a relative last_modified window → an absolute ISO modifiedAfter', () => {
    const out = toBackendAcquisitionConfig({ last_modified_filter: '7d' }, { now: NOW });
    expect(out?.modifiedAfter).toBe('2026-06-09T00:00:00.000Z');
  });

  it('treats last_modified_filter "all" as no filter', () => {
    expect(toBackendAcquisitionConfig({ last_modified_filter: 'all' })).toBeUndefined();
  });

  it('explicitClears emits empty include/exclude patterns to overwrite stale values', () => {
    const out = toBackendAcquisitionConfig({}, { explicitClears: true });
    expect(out).toEqual({ fileIncludePattern: '', fileExcludePattern: '' });
  });
});

describe('deriveSourcePath / toBackendFilterSpec', () => {
  it('returns undefined for "all folders" scope', () => {
    expect(deriveSourcePath({ folder_scope: 'all', paths: ['/a'] })).toBeUndefined();
  });

  it('returns the first non-empty custom path', () => {
    expect(deriveSourcePath({ folder_scope: 'custom', paths: ['  ', '/data/docs', '/x'] })).toBe(
      '/data/docs',
    );
  });

  it('keeps the form-shaped keys and augments with sourcePath', () => {
    const spec: DatasetSpec = { folder_scope: 'custom', paths: ['/data/docs'], file_types: ['.pdf'] };
    const out = toBackendFilterSpec(spec) as Record<string, unknown>;
    expect(out).toMatchObject({
      folder_scope: 'custom',
      paths: ['/data/docs'],
      file_types: ['.pdf'],
      sourcePath: '/data/docs',
    });
  });

  it('omits sourcePath when scope is "all"', () => {
    const out = toBackendFilterSpec({ folder_scope: 'all' }) as Record<string, unknown>;
    expect(out).not.toHaveProperty('sourcePath');
  });
});

describe('normalizeDatasetListItem data_source_origin_kind', () => {
  it('prefers backend data_source_type when present', () => {
    const item = normalizeDatasetListItem({
      id: 'dset-1',
      name: 'ds',
      data_source_type: 'connector',
      originVolume: 'vol-1',
    });
    expect(item.data_source_origin_kind).toBe('connector');
  });

  it('derives volume from originVolume', () => {
    const item = normalizeDatasetListItem({
      id: 'dset-1',
      name: 'ds',
      originVolume: 'vol-1',
    });
    expect(item.data_source_origin_kind).toBe('volume');
  });

  it('derives connector from originConnector', () => {
    const item = normalizeDatasetListItem({
      id: 'dset-1',
      name: 'ds',
      originConnector: 'cn-1',
    });
    expect(item.data_source_origin_kind).toBe('connector');
  });

  it('returns null for manual datasets with no origin', () => {
    const item = normalizeDatasetListItem({
      id: 'dset-1',
      name: 'ds',
      type: 'manual',
    });
    expect(item.data_source_origin_kind).toBeNull();
  });
});

describe('normalizeDatasetListItem status + sync + fallbacks', () => {
  it('maps each backend status onto a DatasetStatus', () => {
    expect(normalizeDatasetListItem({ status: 'ready' }).status).toBe('Ready');
    expect(normalizeDatasetListItem({ status: 'errored' }).status).toBe('Failed');
    expect(normalizeDatasetListItem({ status: 'in_progress' }).status).toBe('Importing');
    expect(normalizeDatasetListItem({ status: 'in_progress' }).lifecycle_status).toBe('in_progress');
    expect(normalizeDatasetListItem({ status: 'deprecated' }).status).toBe('Unhealthy');
    expect(normalizeDatasetListItem({ status: 'whatever' }).status).toBe('Draft');
  });

  it('derives synchronization_status from the raw status when not precomputed', () => {
    expect(normalizeDatasetListItem({ status: 'in_progress' }).synchronization_status).toBe('Synchronizing');
    expect(normalizeDatasetListItem({ status: 'ready' }).synchronization_status).toBe('Completed');
    expect(normalizeDatasetListItem({ status: 'errored' }).synchronization_status).toBe('Failed');
    expect(normalizeDatasetListItem({}).synchronization_status).toBe('Never');
  });

  it('prefers a precomputed synchronization_status', () => {
    expect(
      normalizeDatasetListItem({ status: 'ready', synchronization_status: 'Paused' }).synchronization_status,
    ).toBe('Paused');
  });

  it('reports "Never" for manual (upload) datasets even when status is ready, when not precomputed', () => {
    // Manual datasets have no sync source — a completed import is not a "sync".
    expect(normalizeDatasetListItem({ status: 'ready', type: 'manual' }).synchronization_status).toBe('Never');
    expect(normalizeDatasetListItem({ status: 'errored', type: 'manual' }).synchronization_status).toBe('Failed');
    expect(normalizeDatasetListItem({ status: 'in_progress', type: 'manual' }).synchronization_status).toBe('Synchronizing');
  });

  it('ignores a precomputed Completed synchronization_status for manual datasets', () => {
    expect(
      normalizeDatasetListItem({
        status: 'ready',
        type: 'manual',
        synchronization_status: 'Completed',
      }).synchronization_status,
    ).toBe('Never');
  });

  it('maps backend errorMessage onto error_message', () => {
    const message = 'acquisition activity failed: SQL syntax error';
    expect(
      normalizeDatasetListItem({ status: 'errored', errorMessage: message }).error_message,
    ).toBe(message);
    expect(
      normalizeDatasetListItem({ status: 'errored', error_message: message }).error_message,
    ).toBe(message);
    expect(normalizeDatasetListItem({ status: 'ready' }).error_message).toBeNull();
  });

  it('reads files_count from latest_snapshot when stats are missing', () => {
    expect(
      normalizeDatasetListItem({ latest_snapshot: { total_files: 12 } }).files_count,
    ).toBe(12);
    expect(
      normalizeDatasetListItem({ latestSnapshot: { totalFiles: 7 } }).files_count,
    ).toBe(7);
    expect(normalizeDatasetListItem({ stats: { sourceFileCount: 3 } }).files_count).toBe(3);
  });

  it('handles snake_case timestamps and data source name fallbacks', () => {
    const item = normalizeDatasetListItem({
      dset_id: 'pre-mapped',
      created_at: '2024-01-01',
      updated_at: '2024-02-02',
      data_source_id: 'src-1',
      data_source_name: 'My Source',
      modified_by: 'alice',
    });
    expect(item.dset_id).toBe('pre-mapped');
    expect(item.created_at).toBe('2024-01-01');
    expect(item.data_source).toEqual({ dsrc_id: 'src-1', name: 'My Source' });
    expect(item.modified_by).toBe('alice');
  });
});

describe('fromBackendScheduleConfig', () => {
  it('returns null when there is no cron expression', () => {
    expect(fromBackendScheduleConfig({})).toBeNull();
    expect(fromBackendScheduleConfig(null)).toBeNull();
  });

  it('maps cronExpression (and snake_case fallback) into a cron refresh config', () => {
    const cfg = fromBackendScheduleConfig({ cronExpression: '0 9 * * *', timezone: 'UTC', enabled: false });
    expect(cfg).toMatchObject({
      schedule_type: 'cron',
      cron_expression: '0 9 * * *',
      timezone: 'UTC',
      auto_refresh_enabled: false,
      paused: true,
    });

    const snake = fromBackendScheduleConfig({ cron_expression: '5 * * * *' });
    expect(snake?.cron_expression).toBe('5 * * * *');
    // enabled omitted -> defaults to true / not paused.
    expect(snake?.auto_refresh_enabled).toBe(true);
    expect(snake?.paused).toBe(false);
  });
});

describe('normalizeSnapshot', () => {
  it('maps summary counts, marks the current snapshot, and derives an ISO timestamp', () => {
    const snap = normalizeSnapshot(
      {
        snapshotId: 42,
        timestampMs: 0,
        summary: { 'total-data-files': '10', 'added-data-files': 4, 'deleted-data-files': 1 },
      },
      2,
      42,
    );
    expect(snap.id).toBe('42');
    expect(snap.version).toBe(3);
    expect(snap.total_files).toBe(10);
    expect(snap.files_added).toBe(4);
    expect(snap.files_removed).toBe(1);
    expect(snap.is_current).toBe(true);
    expect(snap.created_at).toBe(new Date(0).toISOString());
  });

  it('handles a missing summary and a non-current snapshot', () => {
    const snap = normalizeSnapshot({ snapshotId: 1 }, 0, 99);
    expect(snap.total_files).toBeNull();
    expect(snap.files_added).toBeNull();
    expect(snap.files_removed).toBeNull();
    expect(snap.is_current).toBe(false);
    // No timestamp -> epoch.
    expect(snap.created_at).toBe(new Date(0).toISOString());
  });
});

describe('normalizeKBListItem', () => {
  it('maps the raw entity shape with status + schedule + stats', () => {
    const kb = normalizeKBListItem({
      id: 'kb-1',
      name: 'KB One',
      status: 'in_progress',
      stats: { fileCount: 9 },
      scheduleConfig: { cronExpression: '0 0 * * *' },
      labels: ['x'],
      createdAt: new Date('2024-03-03T00:00:00Z'),
    });
    expect(kb.kb_id).toBe('kb-1');
    expect(kb.status).toBe('Healthy');
    expect(kb.synchronization_status).toBe('Synchronizing');
    expect(kb.file_scope).toBe(9);
    expect(kb.synchronization_schedule).toBe('0 0 * * *');
    expect(kb.labels).toEqual(['x']);
    expect(kb.created_at).toBe(new Date('2024-03-03T00:00:00Z').toISOString());
  });

  it('falls back to defaults for unknown status and pre-mapped fields', () => {
    const kb = normalizeKBListItem({
      kb_id: 'kb-2',
      status: 'mystery',
      file_scope: 4,
      synchronization_schedule: '* * * * *',
      synchronization_status: 'Completed',
      created_at: '2024-04-04',
    });
    expect(kb.kb_id).toBe('kb-2');
    expect(kb.status).toBe('Draft');
    expect(kb.file_scope).toBe(4);
    expect(kb.synchronization_status).toBe('Completed');
    expect(kb.created_at).toBe('2024-04-04');
  });

  it('defaults sync status to Never when nothing maps', () => {
    expect(normalizeKBListItem({ status: 'deprecated' }).synchronization_status).toBe('Never');
  });
});

describe('normalizeDataset (detail extras)', () => {
  it('maps detail-only fields with camelCase preference', () => {
    const detail = normalizeDataset({
      id: 'dset-1',
      name: 'ds',
      description: 'desc',
      sqlQuery: 'SELECT 1',
      filterSpec: { folder_scope: 'all' },
      resourceSelector: [{ kind: 'bucket' }],
      refreshConfig: { schedule_type: 'cron', cron_expression: '0 9 * * *' },
      namespace: 'ns',
      catalogTableName: 'tbl',
    });
    expect(detail.description).toBe('desc');
    expect(detail.sql_query).toBe('SELECT 1');
    expect(detail.spec).toEqual({ folder_scope: 'all' });
    expect(detail.resource_selector).toEqual([{ kind: 'bucket' }]);
    expect(detail.refresh_config).toMatchObject({ schedule_type: 'cron' });
    expect(detail.catalog_namespace).toBe('ns');
    expect(detail.catalog_table_name).toBe('tbl');
  });

  it('falls back to snake_case fields and converts scheduleConfig', () => {
    const detail = normalizeDataset({
      id: 'dset-2',
      name: 'ds',
      sql_query: 'SELECT 2',
      resource_selector: [{ kind: 'db' }],
      scheduleConfig: { cronExpression: '5 * * * *' },
      catalog_namespace: 'ns2',
      catalogTableRef: 'ref-tbl',
    });
    expect(detail.sql_query).toBe('SELECT 2');
    expect(detail.resource_selector).toEqual([{ kind: 'db' }]);
    expect(detail.refresh_config).toMatchObject({ schedule_type: 'cron', cron_expression: '5 * * * *' });
    expect(detail.catalog_namespace).toBe('ns2');
    expect(detail.catalog_table_name).toBe('ref-tbl');
  });

  it('leaves optional fields null when absent', () => {
    const detail = normalizeDataset({ id: 'dset-3', name: 'ds' });
    expect(detail.resource_selector).toBeNull();
    expect(detail.refresh_config).toBeNull();
    expect(detail.synchronization_summary).toBeNull();
  });

  it('strips sync schedule/history fields from synchronization_summary when sync status is Never', () => {
    const detail = normalizeDataset({
      id: 'dset-manual',
      name: 'manual-ds',
      type: 'manual',
      status: 'ready',
      synchronization_summary: {
        status: 'Never',
        schedule: '0 0 * * *',
        last_completed_synchronization: '2024-06-15T10:00:00Z',
        next_scheduled_synchronization: '2024-06-16T10:00:00Z',
      },
    });
    expect(detail.synchronization_status).toBe('Never');
    expect(detail.synchronization_summary).toEqual({
      status: 'Never',
      schedule: null,
      last_completed_synchronization: null,
      next_scheduled_synchronization: null,
    });
  });
});

describe('normalizeManifest', () => {
  it('maps manifest fields and nested files with casing fallbacks', () => {
    const manifest = normalizeManifest({
      id: 'mf-1',
      manifestId: 7,
      status: 'committed',
      files: [
        { id: 'f1', fileName: 'a.txt', uri: 's3://x/a.txt' },
        { id: 'f2', file_name: 'b.txt' },
      ],
    });
    expect(manifest.id).toBe('mf-1');
    expect(manifest.manifest_id).toBe(7);
    expect(manifest.status).toBe('committed');
    expect(manifest.files).toEqual([
      { id: 'f1', file_name: 'a.txt', uri: 's3://x/a.txt' },
      { id: 'f2', file_name: 'b.txt', uri: null },
    ]);
  });

  it('defaults status to draft and tolerates a missing files relation', () => {
    const manifest = normalizeManifest({ id: 'mf-2', status: 'weird' });
    expect(manifest.status).toBe('draft');
    expect(manifest.manifest_id).toBe(0);
    expect(manifest.files).toEqual([]);
  });

  it('keeps the deprecated manifest status', () => {
    expect(normalizeManifest({ status: 'deprecated' }).status).toBe('deprecated');
  });
});

describe('toBackendDatabaseSourceFields', () => {
  it('derives sourceDatabase and sourceSchema from the first table entry', () => {
    expect(
      toBackendDatabaseSourceFields([
        { database: 'sakila', schema: 'sakila', table: 'country' },
      ]),
    ).toEqual({ sourceDatabase: 'sakila', sourceSchema: 'sakila' });
  });

  it('returns empty object when no table entries are present', () => {
    expect(toBackendDatabaseSourceFields([{ bucket: 'b1' }])).toEqual({});
    expect(toBackendDatabaseSourceFields(undefined)).toEqual({});
    expect(toBackendDatabaseSourceFields([])).toEqual({});
  });

  it('clears derived fields on update when no table entry is present', () => {
    expect(toBackendDatabaseSourceFields([], { explicitClears: true })).toEqual({
      sourceDatabase: null,
      sourceSchema: null,
    });
    expect(toBackendDatabaseSourceFields([{ bucket: 'b1' }], { explicitClears: true })).toEqual({
      sourceDatabase: null,
      sourceSchema: null,
    });
  });

  it('clears sourceDatabase on update when the table entry has no database', () => {
    expect(
      toBackendDatabaseSourceFields([{ schema: 'public', table: 'users' }], { explicitClears: true }),
    ).toEqual({
      sourceDatabase: null,
      sourceSchema: 'public',
    });
  });
});
