/** Fields used by template picker search (no React / JSX). */

export interface ConnectorTemplateSearchable {
  name: string
  description: string
  tagline?: string
  capabilities: string[]
  setupPrerequisites: string[]
}

export function connectorTemplateMatchesSearch(tpl: ConnectorTemplateSearchable, queryLower: string): boolean {
  if (!queryLower) return true
  const hay = [
    tpl.name,
    tpl.description,
    tpl.tagline ?? '',
    ...tpl.capabilities,
    ...tpl.setupPrerequisites,
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(queryLower)
}

export function filterConnectorTemplatesBySearch<T extends ConnectorTemplateSearchable>(
  templates: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return templates
  return templates.filter((t) => connectorTemplateMatchesSearch(t, q))
}
