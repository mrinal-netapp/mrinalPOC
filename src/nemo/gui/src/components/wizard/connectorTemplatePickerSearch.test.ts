import {
  connectorTemplateMatchesSearch,
  filterConnectorTemplatesBySearch,
  type ConnectorTemplateSearchable,
} from './connectorTemplatePickerSearch'

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`connectorTemplatePickerSearch.test failed: ${message}`)
  }
}

const samplePg: ConnectorTemplateSearchable = {
  name: 'PostgreSQL',
  description: 'Connect to a PostgreSQL database',
  tagline: 'Relational queries',
  capabilities: ['Run SQL and browse schemas'],
  setupPrerequisites: ['Database username and password'],
}

{
  assert(connectorTemplateMatchesSearch(samplePg, ''), 'empty query matches')
  assert(connectorTemplateMatchesSearch(samplePg, 'postgres'), 'matches name substring')
  assert(connectorTemplateMatchesSearch(samplePg, 'schemas'), 'matches capability')
  assert(connectorTemplateMatchesSearch(samplePg, 'username'), 'matches prerequisite')
  assert(!connectorTemplateMatchesSearch(samplePg, 'zzzorphan'), 'no false positive')

  const list = [samplePg, { ...samplePg, name: 'MySQL', description: 'MySQL db' }]
  const f = filterConnectorTemplatesBySearch(list, 'mysql')
  assert(f.length === 1 && f[0].name === 'MySQL', 'filter returns matching templates only')
}
