/** Shared request bodies for PostgreSQL connector / dataset tests (not a test file). */

export function basePostgresqlConnectorCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'azure-postgres',
    type: 'connector',
    description: 'Bugbash PostgreSQL',
    connector_config: {
      scope: 'resource',
      provider: 'postgresql',
      connector_type: 'database',
      database_type: 'postgresql',
      host: 'postgres.example.com',
      port: 5432,
      database: '',
      schema: 'public',
      ssl_mode: 'require',
    },
    credential_id: 'cred-11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

export function baseAcquiredPostgresqlDataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'postgres-dt',
    description: '',
    type: 'acquired',
    kind: 'structured',
    originConnector: 'cn-5c4djvdn',
    sqlQuery: '-- Database: appdb\nSELECT * FROM public.users',
    sourceDatabase: 'appdb',
    sourceSchema: 'public',
    resourceSelector: [{ database: 'appdb', schema: 'public', table: 'users' }],
    ...overrides,
  };
}
