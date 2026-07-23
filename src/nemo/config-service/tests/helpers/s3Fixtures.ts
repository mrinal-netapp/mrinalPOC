/** Shared request bodies for S3 connector / dataset tests (not a test file). */

export function baseS3ConnectorCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'external-s3',
    type: 'connector',
    description: 'Production data lake',
    connector_config: {
      scope: 'resource',
      provider: 's3',
      connector_type: 'objectstore',
      bucket: 'company-datalake',
      prefix: 'raw/events/',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-west-2',
    },
    credential_id: 'cred-11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

export function baseAcquiredS3Dataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'my-s3-dataset',
    description: 'from external bucket',
    type: 'acquired',
    kind: 'unstructured',
    originConnector: 'cn-abc12345',
    resourceSelector: [{ bucket: 'source-bucket', prefix: 'data/incoming/' }],
    acquisitionConfig: { writeMode: 'append', fileGlob: '*.parquet' },
    ...overrides,
  };
}
