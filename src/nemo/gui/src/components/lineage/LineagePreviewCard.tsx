import { useNavigate } from 'react-router-dom'
import {
  Card,
  CardHeader,
  Text,
  Badge,
  Button,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { Organization24Regular, ArrowRight16Regular } from '@fluentui/react-icons'
import { COLUMN_ORDER, KIND_MAP } from './constants'
import type { Facet } from '../../services/api'

const useStyles = makeStyles({
  card: {
    width: '100%',
    marginBottom: '16px',
  },
  body: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    flexWrap: 'wrap',
  },
  kindBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 10px',
    borderRadius: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
  },
  arrow: {
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    alignItems: 'center',
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 16px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  stats: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
})

interface LineagePreviewCardProps {
  projectId: string
  facet: Facet | null
}

export function LineagePreviewCard({ projectId, facet }: LineagePreviewCardProps) {
  const styles = useStyles()
  const navigate = useNavigate()

  if (!facet || !facet.summary) return null

  const counts = facet.summary.counts as
    | { nodeCount: number; edgeCount: number; byKind: Record<string, number> }
    | undefined

  if (!counts || counts.nodeCount === 0) return null

  const activeKinds = COLUMN_ORDER.filter((k) => (counts.byKind[k] ?? 0) > 0)

  return (
    <Card className={styles.card}>
      <CardHeader
        image={<Organization24Regular />}
        header={<Text weight="semibold">Dependency Lineage</Text>}
      />
      <div className={styles.body}>
        {activeKinds.map((kind, i) => {
          const entry = KIND_MAP[kind]
          if (!entry) return null
          const Icon = entry.icon
          const count = counts.byKind[kind]
          return (
            <span key={kind} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              {i > 0 && (
                <span className={styles.arrow}>
                  <ArrowRight16Regular />
                </span>
              )}
              <Badge
                appearance="outline"
                color="informative"
                icon={<Icon />}
              >
                {count} {count === 1 ? entry.label : entry.pluralLabel}
              </Badge>
            </span>
          )
        })}
      </div>
      <div className={styles.footer}>
        <Text className={styles.stats}>
          {counts.nodeCount} entities, {counts.edgeCount} relationships
        </Text>
        <Button
          appearance="subtle"
          size="small"
          onClick={() => navigate(`/projects/${projectId}/lineage`)}
        >
          View full lineage
        </Button>
      </div>
    </Card>
  )
}
