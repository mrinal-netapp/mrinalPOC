/** Shared request bodies for GCP connector / GCNV metrics dataset tests. */

export function baseGcpConnectorCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'gcp-gcnv',
    type: 'connector',
    description: 'GCP project with GCNV volumes',
    connector_config: {
      scope: 'resource',
      provider: 'gcp',
      connector_type: 'cloud',
      project_id: 'my-gcp-project',
      default_region: 'us-central1',
    },
    credential_id: 'cred-11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

export function baseAcquiredGcpMetricsDataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'gcnv-volume-metrics',
    description: 'GCNV Cloud Monitoring volume metrics',
    type: 'acquired',
    kind: 'structured',
    originConnector: 'cn-gcp12345',
    resourceSelector: [{ category: 'volume_metrics' }],
    acquisitionConfig: { writeMode: 'append' },
    ...overrides,
  };
}
