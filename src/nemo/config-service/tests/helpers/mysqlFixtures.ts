/** Shared request bodies for MySQL connector / dataset tests (not a test file). */

export function baseMysqlConnectorCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'azure-mysql',
    type: 'connector',
    description: 'Bugbash MySQL',
    connector_config: {
      scope: 'resource',
      provider: 'mysql',
      connector_type: 'database',
      database_type: 'mysql',
      host: 'mysql.example.com',
      port: 3306,
      database: '',
      schema: 'public',
      ssl_mode: 'require',
    },
    credential_id: 'cred-11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

export function baseAcquiredMysqlDataset(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mysql-dt',
    description: '',
    type: 'acquired',
    kind: 'structured',
    originConnector: 'cn-5c4djvdn',
    sqlQuery: '-- Database: sakila\nSELECT * FROM sakila.actor',
    sourceDatabase: 'sakila',
    sourceSchema: 'sakila',
    resourceSelector: [{ database: 'sakila', schema: 'sakila', table: 'actor' }],
    ...overrides,
  };
}
