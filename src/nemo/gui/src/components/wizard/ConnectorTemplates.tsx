import { useMemo, useState } from 'react'
import {
  Text,
  Badge,
  makeStyles,
  tokens,
  Input,
} from '@fluentui/react-components'
import {
  Database24Regular,
  CloudArrowUp24Regular,
  Cloud24Regular,
  Storage24Regular,
  ShieldLock24Regular,
  Table24Regular,
  Archive24Regular,
  Server24Regular,
  DatabaseSearch24Regular,
  Options24Regular,
  Board24Regular,
  CheckmarkCircle16Regular,
} from '@fluentui/react-icons'
import type { ConnectorFormData } from './ConnectorWizard'
import type { ConnectorType, DataSourceItem } from '../../services/api'
import type { ConnectorTemplateSearchable } from './connectorTemplatePickerSearch'
import {
  connectorTemplateMatchesSearch as matchesConnectorTemplateSearch,
  filterConnectorTemplatesBySearch as filterTemplatesBySearchQuery,
} from './connectorTemplatePickerSearch'

export interface ConnectorTemplate extends ConnectorTemplateSearchable {
  id: string
  category: ConnectorType
  defaults: Partial<ConnectorFormData>
}

export type { ConnectorTemplateSearchable } from './connectorTemplatePickerSearch'

export function connectorTemplateMatchesSearch(tpl: ConnectorTemplate, queryLower: string): boolean {
  return matchesConnectorTemplateSearch(tpl, queryLower)
}

export function filterConnectorTemplatesBySearch(
  templates: ConnectorTemplate[],
  query: string,
): ConnectorTemplate[] {
  return filterTemplatesBySearchQuery(templates, query)
}

/** Display order for grouped picker (matches connectors page categories). */
export const CONNECTOR_CATEGORY_ORDER: ConnectorType[] = [
  'database',
  'objectstore',
  'cloud',
  'storage',
  'api',
]

export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    description: 'Connect to a PostgreSQL database',
    tagline: 'Relational queries over schemas and tables',
    category: 'database',
    capabilities: [
      'Run SQL and browse schemas from the explorer',
      'Use as a pipeline or dataset source',
    ],
    setupPrerequisites: [
      'Database host and port reachable from the cluster',
      'Database username and password (credential)',
      'Default database and schema names',
    ],
    defaults: {
      connectorType: 'database',
      databaseType: 'postgresql',
      port: 5432,
      schema: 'public',
      sslMode: 'prefer',
    },
  },
  {
    id: 'postgresql-ssl',
    name: 'PostgreSQL (SSL Required)',
    description: 'PostgreSQL with mandatory SSL — RDS, Aurora, Cloud SQL',
    tagline: 'Hosted PostgreSQL requiring TLS',
    category: 'database',
    capabilities: [
      'Same as PostgreSQL with enforced SSL',
      'Suited for managed cloud databases',
    ],
    setupPrerequisites: [
      'Database endpoint hostname and port',
      'Username and password (credential)',
      'CA trust if your cluster validates server certs strictly',
    ],
    defaults: {
      connectorType: 'database',
      databaseType: 'postgresql',
      port: 5432,
      schema: 'public',
      sslMode: 'require',
    },
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'Connect to a MySQL database',
    tagline: 'MySQL-compatible relational access',
    category: 'database',
    capabilities: ['Browse databases and tables', 'Use in pipelines and explorers'],
    setupPrerequisites: [
      'MySQL host, port (often 3306), database name',
      'Username and password (credential)',
    ],
    defaults: {
      connectorType: 'database',
      databaseType: 'mysql',
      port: 3306,
      sslMode: 'prefer',
    },
  },
  {
    id: 'amazon-s3',
    name: 'Amazon S3',
    description: 'Connect to an Amazon S3 bucket',
    tagline: 'AWS S3 object storage',
    category: 'objectstore',
    capabilities: ['List buckets and objects', 'Read objects for datasets and workflows'],
    setupPrerequisites: [
      'AWS access key ID and secret access key (credential)',
      'Bucket name and optional prefix',
      'Region for the bucket',
    ],
    defaults: {
      connectorType: 'objectstore',
      provider: 's3',
      region: 'us-east-1',
    },
  },
  {
    id: 's3-compatible',
    name: 'S3-Compatible (MinIO)',
    description: 'S3-compatible object store with custom endpoint',
    tagline: 'Private or on-prem S3 API',
    category: 'objectstore',
    capabilities: ['Same S3-style browsing against a custom endpoint', 'Works with MinIO and similar gateways'],
    setupPrerequisites: [
      'Base endpoint URL (HTTPS recommended)',
      'Access key and secret (credential)',
      'Bucket name once connectivity is confirmed',
    ],
    defaults: {
      connectorType: 'objectstore',
      provider: 's3',
      endpoint: 'http://minio:9000',
    },
  },
  {
    id: 'gcs',
    name: 'Google Cloud Storage',
    description: 'Connect to a Google Cloud Storage bucket',
    tagline: 'GCS buckets via service account',
    category: 'objectstore',
    capabilities: ['Browse buckets and objects', 'Integrate with GCP-backed workloads'],
    setupPrerequisites: [
      'Service account JSON with Storage access (credential)',
      'Bucket name',
    ],
    defaults: {
      connectorType: 'objectstore',
      provider: 'gcs',
    },
  },
  {
    id: 'custom-database',
    name: 'Custom Database',
    description: 'Configure a database connection from scratch',
    tagline: 'Pick engine and parameters yourself',
    category: 'database',
    capabilities: [
      'Flexible database connector — capabilities depend on settings you choose',
    ],
    setupPrerequisites: [
      'Know which database engine (PostgreSQL or MySQL) and connection parameters',
      'Matching credential secret fields for that engine',
    ],
    defaults: {
      connectorType: 'database',
    },
  },
  {
    id: 'custom-objectstore',
    name: 'Custom Object Store',
    description: 'Configure an object store connection from scratch',
    tagline: 'Choose provider, region, and endpoints manually',
    category: 'objectstore',
    capabilities: [
      'Flexible object storage — behavior follows the provider and options you set',
    ],
    setupPrerequisites: [
      'Provider choice (S3-compatible vs GCS)',
      'Appropriate cloud keys or service account JSON',
      'Bucket and optional prefix',
    ],
    defaults: {
      connectorType: 'objectstore',
    },
  },
  {
    id: 'gcp',
    name: 'Google Cloud',
    description: 'Browse Cloud SQL, NetApp Volumes, and Cloud Storage in your GCP project, plus collect GCNV performance metrics',
    tagline: 'Account-scoped discovery across GCP data services + metrics',
    category: 'cloud',
    capabilities: [
      'Explore supported GCP resources from one account connector',
      'Acquire GCNV performance metrics from Cloud Monitoring as a metric_category dataset',
      'Drive guided flows that depend on project context',
    ],
    setupPrerequisites: [
      'GCP project ID',
      'Service account JSON with the data-API roles you need plus monitoring.viewer for metrics (credential)',
      'Optional default region',
    ],
    defaults: {
      connectorType: 'cloud',
      provider: 'gcp',
    },
  },
  {
    id: 'ontap',
    name: 'NetApp ONTAP',
    description: 'Browse SVMs, volumes, LUNs, snapshots, and Counter Manager performance metrics on an ONTAP cluster',
    tagline: 'Cluster management + Counter Manager exploration',
    category: 'storage',
    capabilities: [
      'Navigate SVMs, volumes, snapshots, and related storage objects',
      'Validate NFS readiness before registering volumes',
      'Acquire volume / aggregate / quota performance metrics as a metric_category dataset',
    ],
    setupPrerequisites: [
      'Cluster management URL (HTTPS)',
      'ONTAP REST credentials or mTLS client materials (credential)',
      'TLS verification preference for self-signed clusters',
    ],
    defaults: {
      connectorType: 'storage',
      provider: 'ontap',
      verifyTls: true,
    },
  },
  {
    id: 'redash',
    name: 'Redash',
    description: 'Pull queries, dashboards, and data sources from a Redash instance',
    tagline: 'BI metadata from Redash',
    category: 'api',
    capabilities: [
      'Harvest saved queries, dashboards, and data source definitions',
      'Optional inclusion of heavy query result payloads (configured in wizard)',
    ],
    setupPrerequisites: [
      'Redash base URL (HTTPS)',
      'Redash API key (credential)',
    ],
    defaults: {
      connectorType: 'api',
      provider: 'redash',
      verifyTls: true,
    },
  },
]

export const CONNECTOR_TEMPLATE_BY_ID: Record<string, ConnectorTemplate> = Object.fromEntries(
  CONNECTOR_TEMPLATES.map((t) => [t.id, t]),
)

/** Infer template id from persisted connector_config (matches tree leaf labeling). */
export function getInstanceTypeKey(ds: DataSourceItem): string {
  const cfg = ds.connector_config
  if (!cfg) return 'unknown'
  if (cfg.connector_type === 'database') {
    if (cfg.database_type === 'mysql') return 'mysql'
    if (cfg.ssl_mode === 'require') return 'postgresql-ssl'
    return 'postgresql'
  }
  if (cfg.connector_type === 'objectstore') {
    if (cfg.provider === 'gcs') return 'gcs'
    if (cfg.endpoint) return 's3-compatible'
    return 'amazon-s3'
  }
  if (cfg.connector_type === 'cloud') return 'gcp'
  if (cfg.connector_type === 'storage') return 'ontap'
  if (cfg.connector_type === 'api') {
    return 'redash'
  }
  return 'unknown'
}

export function getConnectorClassLabel(ds: DataSourceItem): string {
  const key = getInstanceTypeKey(ds)
  const tpl = CONNECTOR_TEMPLATE_BY_ID[key]
  if (tpl) return tpl.name
  if (key === 'unknown') return 'Unknown type'
  return key
}

type FluentIcon = typeof Database24Regular

export const CONNECTOR_PICKER_ICONS: Record<string, FluentIcon> = {
  postgresql: Database24Regular,
  'postgresql-ssl': ShieldLock24Regular,
  mysql: Table24Regular,
  'amazon-s3': Archive24Regular,
  's3-compatible': Server24Regular,
  gcs: CloudArrowUp24Regular,
  'custom-database': DatabaseSearch24Regular,
  'custom-objectstore': Options24Regular,
  gcp: Cloud24Regular,
  ontap: Storage24Regular,
  redash: Board24Regular,
}

const useStyles = makeStyles({
  pickerRoot: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
  },
  searchRow: {
    flexShrink: 0,
  },
  scrollBody: {
    maxHeight: 'min(60vh, 520px)',
    overflowY: 'auto',
    paddingRight: '4px',
  },
  section: {
    marginBottom: '16px',
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: '10px',
    color: tokens.colorNeutralForeground1,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '12px',
  },
  card: {
    cursor: 'pointer',
    padding: '14px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'border-color, box-shadow, background-color',
    transitionDuration: '0.15s',
    ':hover': {
      boxShadow: tokens.shadow4,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
    ':focus-visible': {
      outlineWidth: '2px',
      outlineStyle: 'solid',
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: '2px',
    },
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    marginBottom: '8px',
  },
  iconWrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: tokens.borderRadiusMedium,
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  bulletList: {
    margin: '4px 0 0 0',
    paddingLeft: '0',
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  bulletRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
  },
  sectionLabel: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightSemibold,
    marginTop: '8px',
    marginBottom: '2px',
    color: tokens.colorNeutralForeground1,
  },
  iconDb: { color: tokens.colorPaletteBlueForeground2 },
  iconStore: { color: tokens.colorPaletteGreenForeground2 },
  iconCloud: { color: tokens.colorPaletteDarkOrangeForeground2 },
  iconStorage: { color: tokens.colorPalettePurpleForeground2 },
  iconApi: { color: tokens.colorPaletteMarigoldForeground2 },
  emptySearch: {
    padding: '24px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase300,
  },
})

function categoryIconClass(
  category: ConnectorType,
  styles: ReturnType<typeof useStyles>,
): string {
  switch (category) {
    case 'database':
      return styles.iconDb
    case 'cloud':
      return styles.iconCloud
    case 'storage':
      return styles.iconStorage
    case 'api':
      return styles.iconApi
    default:
      return styles.iconStore
  }
}

function categoryBadge(category: ConnectorType): {
  label: string
  color: 'informative' | 'success' | 'warning' | 'important'
} {
  switch (category) {
    case 'database':
      return { label: 'Database', color: 'informative' }
    case 'cloud':
      return { label: 'Cloud Account', color: 'warning' }
    case 'storage':
      return { label: 'Storage System', color: 'important' }
    case 'api':
      return { label: 'API', color: 'important' }
    default:
      return { label: 'Object Store', color: 'success' }
  }
}

function PickerCard({
  tpl,
  styles,
  onSelect,
}: {
  tpl: ConnectorTemplate
  styles: ReturnType<typeof useStyles>
  onSelect: (t: ConnectorTemplate) => void
}) {
  const IconComponent = CONNECTOR_PICKER_ICONS[tpl.id] ?? Database24Regular
  const iconCls = categoryIconClass(tpl.category, styles)
  const badge = categoryBadge(tpl.category)
  const tagline = tpl.tagline ?? tpl.description
  const ariaLabel = `Add ${tpl.name} connector, ${badge.label}`

  const activate = () => onSelect(tpl)

  return (
    <div
      className={styles.card}
      tabIndex={0}
      role="button"
      aria-label={ariaLabel}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
    >
      <div className={styles.cardHeader}>
        <div className={styles.iconWrap}>
          <IconComponent className={iconCls} aria-hidden />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text weight="semibold" size={300} block>
            {tpl.name}
          </Text>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '2px' }} block>
            {tagline}
          </Text>
        </div>
      </div>

      <Text className={styles.sectionLabel}>Capabilities</Text>
      <ul className={styles.bulletList}>
        {tpl.capabilities.map((line, i) => (
          <li key={`c-${i}`} className={styles.bulletRow}>
            <CheckmarkCircle16Regular
              style={{ flexShrink: 0, marginTop: '2px', color: tokens.colorPaletteGreenForeground1 }}
              aria-hidden
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <Text className={styles.sectionLabel}>You&apos;ll need</Text>
      <ul className={styles.bulletList}>
        {tpl.setupPrerequisites.map((line, i) => (
          <li key={`s-${i}`} className={styles.bulletRow}>
            <span style={{ marginLeft: '2px' }}>•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: '10px' }}>
        <Badge appearance="outline" color={badge.color} size="small">
          {badge.label}
        </Badge>
      </div>
    </div>
  )
}

export interface ConnectorTemplatePickerProps {
  categoryFilter?: ConnectorType | null
  onSelect: (template: ConnectorTemplate) => void
}

export function ConnectorTemplatePicker({ categoryFilter, onSelect }: ConnectorTemplatePickerProps) {
  const styles = useStyles()
  const [search, setSearch] = useState('')

  const filtered = useMemo(
    () => filterConnectorTemplatesBySearch(CONNECTOR_TEMPLATES, search),
    [search],
  )

  const templatesForLayout = useMemo(() => {
    if (categoryFilter == null) return filtered
    return filtered.filter((t) => t.category === categoryFilter)
  }, [filtered, categoryFilter])

  const grouped = useMemo(() => {
    const map = new Map<ConnectorType, ConnectorTemplate[]>()
    for (const cat of CONNECTOR_CATEGORY_ORDER) {
      map.set(cat, [])
    }
    for (const t of templatesForLayout) {
      const list = map.get(t.category) || []
      list.push(t)
      map.set(t.category, list)
    }
    return map
  }, [templatesForLayout])

  const categoryLabels: Record<ConnectorType, string> = {
    database: 'Databases',
    objectstore: 'Object Stores',
    cloud: 'Cloud Accounts',
    storage: 'Storage Systems',
    api: 'APIs',
  }

  return (
    <div className={styles.pickerRoot}>
      <div className={styles.searchRow}>
        <Input
          placeholder="Search connector types..."
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          aria-label="Search connector types"
        />
      </div>
      <div className={styles.scrollBody}>
        {templatesForLayout.length === 0 ? (
          <div className={styles.emptySearch}>No connectors match your search.</div>
        ) : categoryFilter != null ? (
          <div className={styles.grid}>
            {templatesForLayout.map((tpl) => (
              <PickerCard key={tpl.id} tpl={tpl} styles={styles} onSelect={onSelect} />
            ))}
          </div>
        ) : (
          CONNECTOR_CATEGORY_ORDER.map((cat) => {
            const list = grouped.get(cat) || []
            if (list.length === 0) return null
            return (
              <div key={cat} className={styles.section}>
                <div className={styles.sectionTitle}>{categoryLabels[cat]}</div>
                <div className={styles.grid}>
                  {list.map((tpl) => (
                    <PickerCard key={tpl.id} tpl={tpl} styles={styles} onSelect={onSelect} />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** @deprecated Prefer ConnectorTemplatePicker — kept for any legacy imports */
export function ConnectorTemplates({ onSelect }: { onSelect: (template: ConnectorTemplate) => void }) {
  return <ConnectorTemplatePicker categoryFilter={null} onSelect={onSelect} />
}
