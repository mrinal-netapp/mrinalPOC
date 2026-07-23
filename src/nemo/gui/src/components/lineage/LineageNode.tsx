import { memo } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { Text, Tooltip, makeStyles, tokens } from '@fluentui/react-components'
import { CircleOffRegular, Key16Regular } from '@fluentui/react-icons'
import { KIND_MAP } from './constants'
import type { CredentialRef } from './layoutGraph'

const useStyles = makeStyles({
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1.5px solid ${tokens.colorNeutralStroke1}`,
    minWidth: '160px',
    maxWidth: '240px',
    height: '40px',
    cursor: 'pointer',
    transition: 'opacity 0.15s ease, box-shadow 0.15s ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      boxShadow: tokens.shadow4,
    },
  },
  icon: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  label: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
  },
  credentialBadge: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: tokens.colorPaletteMarigoldForeground1,
    cursor: 'help',
    opacity: 0.85,
    ':hover': {
      opacity: 1,
    },
  },
  tooltipBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  tooltipHeading: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  tooltipItem: {
    fontSize: tokens.fontSizeBase200,
  },
  headerCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 12px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    userSelect: 'none',
    cursor: 'default',
  },
  overflowCard: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    minWidth: '160px',
    height: '40px',
    cursor: 'default',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  orphanCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    minWidth: '160px',
    maxWidth: '240px',
    height: '40px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    cursor: 'default',
  },
})

interface LineageNodeData {
  label: string
  kind: string
  entityId: string
  credentials?: CredentialRef[]
}

export const LineageNodeComponent = memo(({ data }: NodeProps<LineageNodeData>) => {
  const styles = useStyles()
  const entry = KIND_MAP[data.kind]
  const Icon = entry?.icon
  const credentials = data.credentials ?? []

  return (
    <div
      className={styles.card}
      style={entry ? { borderLeftColor: entry.color, borderLeftWidth: 3 } : undefined}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
      {Icon && (
        <span className={styles.icon} style={{ color: entry?.color }}>
          <Icon />
        </span>
      )}
      <Text className={styles.label} title={data.label}>
        {data.label}
      </Text>
      {credentials.length > 0 && (
        <Tooltip
          relationship="description"
          withArrow
          content={
            <div className={styles.tooltipBody}>
              <span className={styles.tooltipHeading}>
                {credentials.length === 1 ? 'Credential' : `Credentials (${credentials.length})`}
              </span>
              {credentials.map((c) => (
                <span key={c.id} className={styles.tooltipItem}>
                  {c.name}
                </span>
              ))}
            </div>
          }
        >
          <span
            className={styles.credentialBadge}
            aria-label={`Uses ${credentials.length} credential${credentials.length === 1 ? '' : 's'}`}
          >
            <Key16Regular />
          </span>
        </Tooltip>
      )}
      <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
    </div>
  )
})
LineageNodeComponent.displayName = 'LineageNode'

export const ColumnHeaderNode = memo(({ data }: NodeProps<{ label: string; count: number }>) => {
  const styles = useStyles()
  return (
    <div className={styles.headerCard}>
      <span>{data.label}</span>
      <span>({data.count})</span>
    </div>
  )
})
ColumnHeaderNode.displayName = 'ColumnHeaderNode'

export const OverflowNode = memo(({ data }: NodeProps<{ label: string; kind: string }>) => {
  const styles = useStyles()
  return (
    <div className={styles.overflowCard}>
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
      <Text>{data.label}</Text>
      <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
    </div>
  )
})
OverflowNode.displayName = 'OverflowNode'

export const OrphanPlaceholderNode = memo(({ data }: NodeProps<{ kind: string; count: number }>) => {
  const styles = useStyles()
  const entry = KIND_MAP[data.kind]
  const label = entry?.pluralLabel ?? data.kind
  const tooltip = `${data.count} ${label} in this project have no incoming or outgoing references.`
  return (
    <div className={styles.orphanCard} title={tooltip}>
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
      <span className={styles.icon} style={{ color: tokens.colorNeutralForeground3 }}>
        <CircleOffRegular />
      </span>
      <Text>{data.count} unconnected</Text>
      <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
    </div>
  )
})
OrphanPlaceholderNode.displayName = 'OrphanPlaceholderNode'
