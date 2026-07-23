import { describe, expect, it } from 'vitest';

import { normalizeDataSource, resolveDatasetStatus } from './data-source.mapper';

describe('resolveDatasetStatus', () => {
  it('maps each known backend status to its frontend enum', () => {
    expect(resolveDatasetStatus('ready')).toBe('Ready');
    expect(resolveDatasetStatus('errored')).toBe('Failed');
    expect(resolveDatasetStatus('in_progress')).toBe('Importing');
    expect(resolveDatasetStatus('deprecated')).toBe('Unhealthy');
  });

  it('is case-insensitive', () => {
    expect(resolveDatasetStatus('READY')).toBe('Ready');
  });

  it('falls back to Draft for unknown or undefined input', () => {
    expect(resolveDatasetStatus('something-else')).toBe('Draft');
    expect(resolveDatasetStatus(undefined)).toBe('Draft');
  });
});

describe('normalizeDataSource — source_type (resolveSourceType)', () => {
  it('maps volume protocols exactly', () => {
    expect(
      normalizeDataSource({ type: 'volume', volume_config: { volume_info: { type: 'nfs' } } })
        .source_type,
    ).toBe('NFS');
    expect(
      normalizeDataSource({ type: 'volume', volume_config: { volume_info: { type: 'SMB' } } })
        .source_type,
    ).toBe('SMB');
    expect(
      normalizeDataSource({ type: 'volume', volume_config: { volume_info: { type: 's3' } } })
        .source_type,
    ).toBe('S3');
  });

  it('returns null for an unrecognised or missing volume type', () => {
    expect(
      normalizeDataSource({ type: 'volume', volume_config: { volume_info: { type: 'weird' } } })
        .source_type,
    ).toBeNull();
    expect(normalizeDataSource({ type: 'volume' }).source_type).toBeNull();
  });

  it('maps connector providers that truly speak a protocol', () => {
    expect(
      normalizeDataSource({ type: 'connector', connector_config: { provider: 's3' } }).source_type,
    ).toBe('S3');
    expect(
      normalizeDataSource({ type: 'connector', connector_config: { provider: 'smb' } }).source_type,
    ).toBe('SMB');
  });

  it('returns null for connectors without an NFS/SMB/S3 analogue', () => {
    expect(
      normalizeDataSource({ type: 'connector', connector_config: { provider: 'gcs' } }).source_type,
    ).toBeNull();
    expect(normalizeDataSource({ type: 'connector' }).source_type).toBeNull();
  });

  it('returns null when the type is neither volume nor connector', () => {
    expect(normalizeDataSource({ type: 'mystery' }).source_type).toBeNull();
    expect(normalizeDataSource({}).source_type).toBeNull();
  });
});

describe('normalizeDataSource — category (resolveDataSourceCategory)', () => {
  it('maps volume to Volume', () => {
    expect(normalizeDataSource({ type: 'volume' }).category).toBe('Volume');
  });

  it('maps each connector_type to its category', () => {
    const cat = (connector_type: string) =>
      normalizeDataSource({ type: 'connector', connector_config: { connector_type } }).category;
    expect(cat('objectstore')).toBe('Object Store');
    expect(cat('cloud')).toBe('Storage System');
    expect(cat('database')).toBe('Database');
    expect(cat('storage')).toBe('Storage System');
    expect(cat('api')).toBe('API');
  });

  it('returns null for unknown connector_type or missing taxonomy', () => {
    expect(
      normalizeDataSource({ type: 'connector', connector_config: { connector_type: 'nope' } })
        .category,
    ).toBeNull();
    expect(normalizeDataSource({ type: 'connector' }).category).toBeNull();
    expect(normalizeDataSource({ type: 'other' }).category).toBeNull();
  });
});

describe('normalizeDataSource — status (resolveStatus)', () => {
  it('maps mount_health.status to the frontend status enum', () => {
    expect(normalizeDataSource({ mount_health: { status: 'healthy' } }).status).toBe('Healthy');
    expect(normalizeDataSource({ mount_health: { status: 'unhealthy' } }).status).toBe('Unhealthy');
    expect(normalizeDataSource({ mount_health: { status: 'whatever' } }).status).toBe(
      'Initializing',
    );
    expect(normalizeDataSource({}).status).toBe('Initializing');
  });

  it('derives connector status from the last connection test result', () => {
    expect(
      normalizeDataSource({ type: 'connector', last_connection_test_status: 'success' }).status,
    ).toBe('Healthy');
    expect(
      normalizeDataSource({ type: 'connector', last_connection_test_status: 'failed' }).status,
    ).toBe('Unhealthy');
    // Untested connector → Initializing (mount_health is ignored for connectors).
    expect(normalizeDataSource({ type: 'connector' }).status).toBe('Initializing');
  });
});

describe('normalizeDataSource — scan_status (resolveScanStatus)', () => {
  const scanStatus = (state: unknown) =>
    normalizeDataSource({ scan_status: { state } }).scan_status;

  it('maps backend scan states to frontend enum', () => {
    expect(scanStatus('completed')).toBe('Completed');
    expect(scanStatus('scanning')).toBe('Scanning');
    expect(scanStatus('pending')).toBe('Scanning');
    expect(scanStatus('failed')).toBe('Failed');
  });

  it('treats skipped/unknown/missing as Unscanned', () => {
    expect(scanStatus('skipped')).toBe('Unscanned');
    expect(scanStatus(undefined)).toBe('Unscanned');
    expect(normalizeDataSource({}).scan_status).toBe('Unscanned');
  });
});

describe('normalizeDataSource — scan (resolveScanDetails)', () => {
  it('returns null for connector data sources', () => {
    expect(
      normalizeDataSource({ type: 'connector', scan_config: { scan_depth: 'full' } }).scan,
    ).toBeNull();
  });

  it('returns null for a volume that was never configured or scanned', () => {
    expect(normalizeDataSource({ type: 'volume' }).scan).toBeNull();
  });

  it('builds full scan details from config/status/result', () => {
    const scan = normalizeDataSource({
      type: 'volume',
      scan_config: { scan_depth: 'custom', custom_depth: 3 },
      scan_status: { state: 'completed', last_error: 'old error' },
      scan_result: {
        completed_at: '2024-01-01T00:00:00Z',
        error_message: 'boom',
        total_files: 10,
        total_folders: 2,
        total_size_bytes: 1024,
        file_type_stats: [{ extension: 'txt', count: 5 }],
      },
    }).scan;

    expect(scan).toEqual({
      status: 'Completed',
      scan_depth: 'custom',
      custom_depth: 3,
      last_completed_at: '2024-01-01T00:00:00Z',
      status_message: 'boom',
      total_files: 10,
      total_folders: 2,
      total_size_bytes: 1024,
      file_type_stats: [{ extension: 'txt', count: 5 }],
    });
  });

  it('falls back to scan_status.last_error and applies safe defaults for missing fields', () => {
    const scan = normalizeDataSource({
      type: 'volume',
      scan_status: { state: 'failed', last_error: 'fallback error' },
    }).scan;

    expect(scan).not.toBeNull();
    expect(scan?.status).toBe('Failed');
    expect(scan?.scan_depth).toBe('none');
    expect(scan?.custom_depth).toBeNull();
    expect(scan?.status_message).toBe('fallback error');
    expect(scan?.total_files).toBeNull();
    expect(scan?.total_folders).toBeNull();
    expect(scan?.total_size_bytes).toBeNull();
    expect(scan?.file_type_stats).toBeNull();
  });
});

describe('normalizeDataSource — connection (splitEndpoint) and fields', () => {
  it('splits an endpoint with host:/export/path', () => {
    const ds = normalizeDataSource({
      type: 'volume',
      volume_config: {
        volume_info: { endpoint: 'host01:/export/data', folder_boundary: ['/sub'] },
        auth_info: { type: 'kerberos', username: 'svc' },
        region: 'us-east-1',
      },
    });
    expect(ds.connection.server).toBe('host01');
    expect(ds.connection.export_path).toBe('/export/data');
    expect(ds.connection.folder_boundary).toBe('/sub');
    expect(ds.connection.auth_method).toBe('kerberos');
    expect(ds.connection.username).toBe('svc');
    expect(ds.connection.region).toBe('us-east-1');
  });

  it('treats an endpoint without a colon as server only', () => {
    const ds = normalizeDataSource({
      volume_config: { volume_info: { endpoint: 'plainhost' } },
    });
    expect(ds.connection.server).toBe('plainhost');
    expect(ds.connection.export_path).toBeNull();
  });

  it('returns null export_path when the path after the colon is empty', () => {
    const ds = normalizeDataSource({
      volume_config: { volume_info: { endpoint: 'host:' } },
    });
    expect(ds.connection.server).toBe('host');
    expect(ds.connection.export_path).toBeNull();
  });

  it('defaults connection fields when volume_info is absent', () => {
    const ds = normalizeDataSource({});
    expect(ds.connection.server).toBe('');
    expect(ds.connection.export_path).toBeNull();
    expect(ds.connection.folder_boundary).toBeNull();
    expect(ds.connection.region).toBeNull();
  });

  it('surfaces dynamic-volume fields (provisioning_mode, volume_type, mount_options, storage) for edit rehydration', () => {
    const ds = normalizeDataSource({
      type: 'volume',
      volume_config: {
        volume_info: {
          type: 'nfs',
          provisioning_mode: 'dynamic',
          mount_options: ['vers=4.1', 'rsize=1048576'],
          storage_class_name: 'ontap-nas',
          storage_size: '50Gi',
        },
        auth_info: { type: 'none' },
        region: 'us-west-2',
      },
    });
    expect(ds.connection.provisioning_mode).toBe('dynamic');
    expect(ds.connection.volume_type).toBe('NFS');
    expect(ds.connection.mount_options).toEqual(['vers=4.1', 'rsize=1048576']);
    expect(ds.connection.storage_class_name).toBe('ontap-nas');
    expect(ds.connection.storage_size).toBe('50Gi');
  });

  it('maps an SMB volume to SMB source_type and volume_type', () => {
    const ds = normalizeDataSource({
      type: 'volume',
      volume_config: {
        volume_info: { type: 'smb', provisioning_mode: 'static', endpoint: 'win-host:/share' },
        auth_info: { type: 'basic', username: 'svc' },
        region: 'eu-west-1',
      },
    });
    expect(ds.source_type).toBe('SMB');
    expect(ds.connection.volume_type).toBe('SMB');
    expect(ds.connection.provisioning_mode).toBe('static');
  });

  it('defaults volume edit fields to null/static for a static volume without optional info', () => {
    const ds = normalizeDataSource({
      type: 'volume',
      volume_config: { volume_info: { endpoint: 'host:/export' } },
    });
    expect(ds.connection.provisioning_mode).toBe('static');
    expect(ds.connection.volume_type).toBeNull();
    expect(ds.connection.mount_options).toBeNull();
    expect(ds.connection.storage_class_name).toBeNull();
    expect(ds.connection.storage_size).toBeNull();
  });
});

describe('normalizeDataSource — provider and connector_scope', () => {
  it('surfaces a lowercased provider and a valid scope', () => {
    const ds = normalizeDataSource({
      type: 'connector',
      connector_config: { provider: 'GCS', scope: 'Account' },
    });
    expect(ds.provider).toBe('gcs');
    expect(ds.connector_scope).toBe('account');
  });

  it('accepts resource scope', () => {
    expect(
      normalizeDataSource({ connector_config: { scope: 'resource' } }).connector_scope,
    ).toBe('resource');
  });

  it('returns null provider and null scope when absent or invalid', () => {
    const ds = normalizeDataSource({ connector_config: { scope: 'invalid' } });
    expect(ds.provider).toBeNull();
    expect(ds.connector_scope).toBeNull();
  });
});

describe('normalizeDataSource — identity, dates and misc defaults', () => {
  it('prefers raw.id but falls back to dsrc_id', () => {
    expect(normalizeDataSource({ id: 'abc' }).dsrc_id).toBe('abc');
    expect(normalizeDataSource({ dsrc_id: 'fallback' }).dsrc_id).toBe('fallback');
    expect(normalizeDataSource({}).dsrc_id).toBe('');
  });

  it('handles both camelCase and snake_case date/author fields', () => {
    expect(normalizeDataSource({ createdAt: 'C1', updatedAt: 'U1', modifiedBy: 'M1' })).toMatchObject(
      { created_at: 'C1', updated_at: 'U1', modified_by: 'M1' },
    );
    expect(
      normalizeDataSource({ created_at: 'C2', updated_at: 'U2', modified_by: 'M2' }),
    ).toMatchObject({ created_at: 'C2', updated_at: 'U2', modified_by: 'M2' });
  });

  it('normalises labels and associated datasets to arrays', () => {
    expect(normalizeDataSource({ labels: ['a'] }).labels).toEqual(['a']);
    expect(normalizeDataSource({ labels: 'not-array' }).labels).toEqual([]);
    expect(normalizeDataSource({ associated_datasets: 'x' }).associated_datasets).toEqual([]);
    expect(normalizeDataSource({ associated_datasets_count: 7 }).associated_datasets_count).toBe(7);
    expect(normalizeDataSource({}).associated_datasets_count).toBe(0);
  });

  it('derives last_validation_error from the first blocking entry', () => {
    expect(
      normalizeDataSource({ mount_health: { blocking: ['first', 'second'] } })
        .last_validation_error,
    ).toBe('first');
    expect(normalizeDataSource({}).last_validation_error).toBeNull();
  });

  it('returns safe defaults for non-object input', () => {
    const ds = normalizeDataSource(null);
    expect(ds.name).toBe('');
    expect(ds.dsrc_id).toBe('');
    expect(ds.source_type).toBeNull();
    expect(ds.deprecated).toBe(false);
    expect(ds.scanned_data_count).toBeNull();
  });
});
