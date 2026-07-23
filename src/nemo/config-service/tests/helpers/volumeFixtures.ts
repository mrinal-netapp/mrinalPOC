/** Shared request bodies for volume data source / dataset tests (not a test file). */

export function baseVolumeCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'project-data-lake',
    type: 'volume',
    description: 'NFS volume for acquired datasets',
    volume_config: {
      region: 'us-west-2',
      volume_info: {
        type: 'nfs',
        endpoint: 'nfs-server.example.com:/export/data',
        mount_options: ['noac'],
        provisioning_mode: 'static',
      },
      auth_info: { type: 'none' },
      protocol: 'nfs',
    },
    metadata: { tier: 'primary' },
    ...overrides,
  };
}

export function baseDynamicVolumeCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'dynamic-nfs-vol',
    type: 'volume',
    volume_config: {
      region: 'us-east-1',
      volume_info: {
        type: 'nfs',
        provisioning_mode: 'dynamic',
        storage_class_name: 'ontap-nas',
        storage_size: '100Gi',
        access_modes: ['ReadWriteMany'],
      },
      auth_info: { type: 'none' },
      protocol: 'nfs',
    },
    ...overrides,
  };
}

export function baseAcquiredVolumeDataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'vol-acquired-ds',
    description: '',
    type: 'acquired',
    kind: 'unstructured',
    originVolume: 'vol-abc12345',
    filterSpec: { sourcePath: '/incoming/events' },
    acquisitionConfig: { writeMode: 'append', fileGlob: '*.parquet' },
    ...overrides,
  };
}
