import React from 'react'
import { useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
} from '@fluentui/react-components'
import {
  Link24Regular,
  Flow24Regular,
  Database24Regular,
  ArrowRight16Regular,
  Bot24Regular,
  Brain24Regular,
  Book24Regular,
  Code24Regular,
  Storage24Regular,
  Table24Regular,
  HardDrive24Regular,
  DocumentBulletList24Regular,
  People24Regular,
} from '@fluentui/react-icons'
import { ProjectOverview as OverviewData } from '../../hooks/useProjectOverview'
import type { Facet } from '../../services/api'
import { LineagePreviewCard } from '../lineage/LineagePreviewCard'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  groupsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: '20px',
  },
  groupCard: {
    display: 'flex',
    flexDirection: 'column',
  },
  groupContent: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  statItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  statItemLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flex: 1,
  },
  statItemIcon: {
    fontSize: '20px',
    color: tokens.colorBrandForeground1,
  },
  statItemInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  statItemLabel: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground2,
  },
  statItemValue: {
    fontSize: '18px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  statItemSubtext: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  storageInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: '8px',
  },
  storageRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  storageLabel: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  storageValue: {
    fontSize: '14px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  iconWithOverlay: {
    position: 'relative',
    display: 'inline-flex',
  },
  iconOverlay: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
  iconOverlayGreen: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
})

interface ProjectOverviewProps {
  projectId: string
  overview: OverviewData
  lineageFacet?: Facet | null
}

export function ProjectOverview({ projectId, overview, lineageFacet }: ProjectOverviewProps) {
  const styles = useStyles()
  const navigate = useNavigate()

  const formatStorage = (gb: number): string => {
    if (gb === 0) return '0 GB'
    if (gb < 1) return `${(gb * 1024).toFixed(0)} MB`
    if (gb < 1024) return `${gb.toFixed(1)} GB`
    return `${(gb / 1024).toFixed(2)} TB`
  }

  const dataSourceItems = [
    {
      label: 'Connectors',
      value: overview.connectors,
      icon: <Link24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasources/connectors`,
      subtext: 'Databases, object stores, and APIs',
    },
    {
      label: 'Volumes',
      value: overview.buckets,
      icon: <HardDrive24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasources/volumes`,
      subtext: 'Provisioned project storage',
    },
  ]

  const dataSetItems = [
    {
      label: 'Total',
      value: overview.datasets,
      icon: <Table24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasets`,
      subtext: 'Structured and unstructured datasets',
    },
    {
      label: 'Structured',
      value: overview.datasetsStructured,
      icon: <Table24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasets`,
      subtext: 'Tabular / catalog-backed data',
    },
    {
      label: 'Unstructured',
      value: overview.datasetsUnstructured,
      icon: <DocumentBulletList24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasets`,
      subtext: 'Files, documents, and blobs',
    },
    {
      label: 'Files (manifests)',
      value: overview.filesInManifests,
      icon: <DocumentBulletList24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasets`,
      subtext: 'File entries recorded under dataset manifests',
    },
    {
      label: 'Manifest versions',
      value: overview.manifestVersions,
      icon: <DocumentBulletList24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/datasets`,
      subtext: 'Manifest snapshots across datasets (draft, committed, deprecated)',
    },
  ]

  const pipelineItems = [
    {
      label: 'All pipelines',
      value: overview.pipelines.total,
      icon: <Flow24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/pipelines`,
      subtext: 'Data plus API pipelines',
    },
    {
      label: 'Data pipelines',
      value: overview.pipelines.data,
      icon: <Flow24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/pipelines`,
      subtext: 'ETL and batch data flows',
    },
    {
      label: 'API pipelines',
      value: overview.pipelines.agent,
      icon: <Flow24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/pipelines`,
      subtext: 'Agent-facing HTTP APIs',
    },
  ]

  const aiItems = [
    {
      label: 'Agents',
      value: overview.agents,
      icon: <Bot24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/agents`,
      subtext: 'Single agents and tools',
    },
    {
      label: 'Agent teams',
      value: overview.agentTeams,
      icon: <People24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/agents`,
      subtext: 'Coordinated multi-agent groups',
    },
    {
      label: 'Models',
      value: overview.models,
      icon: <Brain24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/models`,
      subtext: 'Registered models',
    },
    {
      label: 'Knowledge bases',
      value: overview.knowledgeBases,
      icon: <Book24Regular className={styles.statItemIcon} />,
      path: `/projects/${projectId}/knowledgebases`,
      subtext: 'Retrieval and context stores',
    },
  ]

  const renderGroupCard = (
    title: string,
    icon: React.ReactNode,
    items: Array<{
      label: string
      value: number
      icon: React.ReactNode
      path: string
      subtext: string
    }>,
    showStorage?: boolean
  ) => (
    <Card className={styles.groupCard}>
      <CardHeader
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {icon}
            <Text weight="semibold">{title}</Text>
          </div>
        }
      />
      <div className={styles.groupContent}>
        {items.map((item) => (
          <div
            key={item.label}
            className={styles.statItem}
            onClick={() => navigate(item.path)}
          >
            <div className={styles.statItemLeft}>
              {item.icon}
              <div className={styles.statItemInfo}>
                <Text className={styles.statItemLabel}>{item.label}</Text>
                <Text className={styles.statItemValue}>{item.value}</Text>
                {item.subtext && (
                  <Text className={styles.statItemSubtext}>{item.subtext}</Text>
                )}
              </div>
            </div>
            <ArrowRight16Regular />
          </div>
        ))}
        {showStorage && (
          <div className={styles.storageInfo}>
            <div className={styles.storageRow}>
              <Text className={styles.storageLabel}>
                <Storage24Regular style={{ fontSize: '16px', marginRight: '6px', verticalAlign: 'middle' }} />
                Total Allotted Storage
              </Text>
              <Text className={styles.storageValue}>
                {formatStorage(overview.storage.totalAllottedGB)}
              </Text>
            </div>
            {overview.storage.totalUsedGB !== undefined && (
              <div className={styles.storageRow}>
                <Text className={styles.storageLabel}>Used Storage</Text>
                <Text className={styles.storageValue}>
                  {formatStorage(overview.storage.totalUsedGB)}
                </Text>
              </div>
            )}
            {overview.storage.totalUsedGB !== undefined && overview.storage.totalAllottedGB > 0 && (
              <div className={styles.storageRow}>
                <Text className={styles.storageLabel}>Usage</Text>
                <Text className={styles.storageValue}>
                  {((overview.storage.totalUsedGB / overview.storage.totalAllottedGB) * 100).toFixed(1)}%
                </Text>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )

  return (
    <div className={styles.container}>
      <LineagePreviewCard projectId={projectId} facet={lineageFacet ?? null} />
      <div className={styles.groupsGrid}>
        {renderGroupCard(
          'Data Sources',
          <Database24Regular />,
          dataSourceItems,
          true // Storage allotment and usage for project volumes
        )}
        {renderGroupCard(
          'DataSets',
          <Table24Regular />,
          dataSetItems
        )}
        {renderGroupCard(
          'Pipelines',
          <Flow24Regular />,
          pipelineItems
        )}
        {renderGroupCard(
          'AI',
          <Code24Regular />,
          aiItems
        )}
      </div>
    </div>
  )
}




