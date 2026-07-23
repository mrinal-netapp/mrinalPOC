import {
  Key24Regular,
  Database24Regular,
  BrainCircuit24Regular,
  Server24Regular,
  Table24Regular,
  BookOpen24Regular,
  Bot24Regular,
  PeopleTeam24Regular,
  Flow24Regular,
} from '@fluentui/react-icons'

/**
 * Map a backend entity `kind` to human labels, route segments, and icons.
 * Shared by DependentsCell, the lineage page, and the lineage preview card.
 */
export type KindEntry = {
  label: string
  pluralLabel: string
  routeSegment: string
  guiRoute: string
  icon: typeof Key24Regular
  color: string
}

export const KIND_MAP: Record<string, KindEntry> = {
  pipeline:        { label: 'pipeline',        pluralLabel: 'pipelines',        routeSegment: 'pipelines',       guiRoute: 'pipelines',       icon: Flow24Regular,         color: '#8764B8' },
  agent:           { label: 'agent',           pluralLabel: 'agents',           routeSegment: 'agents',          guiRoute: 'agents',          icon: Bot24Regular,          color: '#0078D4' },
  agent_team:      { label: 'team',            pluralLabel: 'teams',            routeSegment: 'agent-teams',     guiRoute: 'agent-teams',     icon: PeopleTeam24Regular,   color: '#005A9E' },
  knowledge_base:  { label: 'knowledge base',  pluralLabel: 'knowledge bases',  routeSegment: 'knowledgebases',  guiRoute: 'knowledge-bases', icon: BookOpen24Regular,     color: '#107C10' },
  dataset:         { label: 'dataset',         pluralLabel: 'datasets',         routeSegment: 'datasets',        guiRoute: 'datasets',        icon: Table24Regular,        color: '#038387' },
  mcp_server:      { label: 'MCP server',      pluralLabel: 'MCP servers',      routeSegment: 'mcp-servers',     guiRoute: 'mcp-servers',     icon: Server24Regular,       color: '#CA5010' },
  model:           { label: 'model',           pluralLabel: 'models',           routeSegment: 'models',          guiRoute: 'models',          icon: BrainCircuit24Regular, color: '#E3008C' },
  data_source:     { label: 'data source',     pluralLabel: 'data sources',     routeSegment: 'datasources',     guiRoute: 'datasources',     icon: Database24Regular,     color: '#4F6BED' },
  credential:      { label: 'credential',      pluralLabel: 'credentials',      routeSegment: 'credentials',     guiRoute: 'credentials',     icon: Key24Regular,          color: '#7A7574' },
}

/**
 * Left-to-right column order: consumers on left, dependencies on right.
 * Arrows flow left-to-right following "X depends on Y" direction.
 */
export const COLUMN_ORDER = [
  'pipeline',
  'agent',
  'agent_team',
  'knowledge_base',
  'dataset',
  'mcp_server',
  'model',
  'data_source',
  'credential',
] as const

export const COLUMN_WIDTH = 280
export const ROW_HEIGHT = 80
export const HEADER_HEIGHT = 40
export const MAX_NODES_PER_COLUMN = 20
