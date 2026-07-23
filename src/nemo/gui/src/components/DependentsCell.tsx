import { useState } from 'react'
import {
  Badge,
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { ChevronDown16Regular } from '@fluentui/react-icons'
import {
  dependentsApi,
  DependentsPage,
  DependentsSummary,
  DependentItem,
} from '../services/api'

import { KIND_MAP } from './lineage/constants'

const useStyles = makeStyles({
  cellRoot: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  },
  zero: {
    color: tokens.colorNeutralForeground3,
  },
  popoverSurface: {
    minWidth: '320px',
    maxWidth: '420px',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    paddingTop: '4px',
    paddingBottom: '4px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  itemLast: {
    borderBottom: 'none',
  },
  kindLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
  },
  itemLink: {
    color: tokens.colorBrandForegroundLink,
    textDecoration: 'none',
    fontWeight: 500,
  },
  itemMuted: {
    color: tokens.colorNeutralForeground2,
  },
  loading: {
    paddingTop: '8px',
    paddingBottom: '8px',
    display: 'flex',
    justifyContent: 'center',
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: '12px',
  },
  totalLine: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
  },
})

/**
 * Kill switch for the entire dependents UI. The `Used by` column and the
 * delete-blocker list both check this and render nothing when the flag is
 * off, so we can disable the new surface without redeploying entity pages
 * if the API turns out to be expensive in production.
 *
 * Driven by `VITE_DEPENDENTS_UI_DISABLED=true` at build time. Defaults to
 * enabled.
 */
export function dependentsUiEnabled(): boolean {
  // Vite injects env vars under `import.meta.env`; guard for environments
  // where it's undefined (jest, ssr, server-side render harnesses).
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - import.meta is a Vite-only construct
  const flag = (import.meta?.env?.VITE_DEPENDENTS_UI_DISABLED ?? '').toString().toLowerCase()
  return !(flag === 'true' || flag === '1')
}

export function describeKind(kind: string, count: number): string {
  const entry = KIND_MAP[kind]
  if (!entry) return `${count} ${kind}${count === 1 ? '' : 's'}`
  const label = count === 1 ? entry.label : entry.pluralLabel
  return `${count} ${label}`
}

/** Returns a compact "3 agents · 1 team" summary string. */
export function summarizeDependents(
  summary: DependentsSummary | undefined,
  maxKinds = 2,
): string {
  if (!summary || summary.total === 0) return '—'
  const entries = Object.entries(summary.byKind).sort((a, b) => b[1] - a[1])
  const head = entries.slice(0, maxKinds).map(([k, n]) => describeKind(k, n))
  const remaining = entries.slice(maxKinds).reduce((acc, [, n]) => acc + n, 0)
  if (remaining > 0) head.push(`+${remaining} more`)
  return head.join(' · ')
}

interface DependentsCellProps {
  projectId: string
  /** Backend entity kind of the *target* (e.g. 'model'). */
  targetKind: string
  /** Target entity id used for the dependents API call. */
  targetId: string
  summary: DependentsSummary | undefined
  /** Compact (table cell) vs full-width inside delete dialog. */
  variant?: 'cell' | 'inline'
}

/**
 * Read-only cell that renders a dependents count and on-demand details.
 *
 * - Displays a chip-style summary (`3 agents · 1 team`) sourced from the
 *   `dependentsSummary` field already on the row, so list pages cost
 *   nothing extra to render.
 * - Clicking the chip opens a popover that lazy-loads the first page of
 *   `/dependents` for the target.
 * - Reused by every entity list page and (in `inline` variant) by the
 *   delete dialog when the 409 payload includes inline dependents.
 */
export function DependentsCell({
  projectId,
  targetKind,
  targetId,
  summary,
  variant = 'cell',
}: DependentsCellProps) {
  const styles = useStyles()
  const targetEntry = KIND_MAP[targetKind]
  const routeSegment = targetEntry?.routeSegment ?? targetKind

  if (!dependentsUiEnabled()) return null

  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<DependentsPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = summary?.total ?? 0
  const display = summarizeDependents(summary)

  const handleOpenChange = async (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen && !page && total > 0) {
      try {
        setLoading(true)
        setError(null)
        const result = await dependentsApi.list(projectId, routeSegment, targetId, { limit: 10 })
        setPage(result)
      } catch (err: any) {
        setError(err?.message ?? 'Failed to load dependents')
      } finally {
        setLoading(false)
      }
    }
  }

  const trigger = total === 0 ? (
    <Tooltip content="No dependents" relationship="label">
      <Text className={styles.zero}>{display}</Text>
    </Tooltip>
  ) : (
    <Button
      appearance="subtle"
      size="small"
      iconPosition="after"
      icon={<ChevronDown16Regular />}
      style={{ padding: '0 6px' }}
    >
      <Badge appearance="filled" color="informative" size="small" style={{ marginRight: 6 }}>
        {total}
      </Badge>
      <span>{display}</span>
    </Button>
  )

  return (
    <span className={styles.cellRoot}>
      <Popover
        open={open}
        onOpenChange={(_, data) => handleOpenChange(data.open)}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          {trigger}
        </PopoverTrigger>
        <PopoverSurface className={styles.popoverSurface}>
          <Text weight="semibold">Used by {total} {total === 1 ? 'item' : 'items'}</Text>
          {summary && summary.total > 0 && (
            <Text className={styles.totalLine}>
              {summarizeDependents(summary, 99)}
            </Text>
          )}
          {loading && (
            <div className={styles.loading}><Spinner size="tiny" /></div>
          )}
          {error && (
            <Text className={styles.empty}>{error}</Text>
          )}
          {page && page.items.length === 0 && !loading && (
            <Text className={styles.empty}>Nothing references this entity.</Text>
          )}
          {page && page.items.map((item, idx) => (
            <DependentRow
              key={`${item.kind}-${item.id}`}
              projectId={projectId}
              item={item}
              isLast={idx === page.items.length - 1}
            />
          ))}
          {page && page.nextCursor && (
            <Text className={styles.empty}>
              Showing first {page.items.length} of {total}. Use the dependents API for full details.
            </Text>
          )}
        </PopoverSurface>
      </Popover>
      {variant === 'inline' && total > 0 && (
        <Text className={styles.totalLine}>
          {summarizeDependents(summary, 99)}
        </Text>
      )}
    </span>
  )
}

interface DependentRowProps {
  projectId: string
  item: DependentItem
  isLast: boolean
}

function DependentRow({ projectId, item, isLast }: DependentRowProps) {
  const styles = useStyles()
  const entry = KIND_MAP[item.kind]
  const label = item.name?.trim() || `(unnamed ${entry?.label ?? item.kind})`
  const guiRoute = entry?.guiRoute
  const href = guiRoute ? `/projects/${projectId}/${guiRoute}/${item.id}` : null

  return (
    <div className={`${styles.itemRow} ${isLast ? styles.itemLast : ''}`}>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span className={styles.kindLabel}>{entry?.label ?? item.kind}</span>
        {href ? (
          <a className={styles.itemLink} href={href}>{label}</a>
        ) : (
          <Text className={styles.itemMuted}>{label}</Text>
        )}
      </span>
      <Badge appearance="outline" color="subtle" size="small">{item.relation}</Badge>
    </div>
  )
}

/**
 * Read-only block for the delete-confirmation dialog: groups dependents
 * inline by kind. Used when the 409 payload includes a pre-paginated
 * dependents page so the user immediately sees what blocks the delete.
 */
export function DependentsBlockerList({
  projectId,
  page,
}: {
  projectId: string
  page: DependentsPage
}) {
  const styles = useStyles()
  if (!dependentsUiEnabled()) return null
  if (page.items.length === 0) {
    return <Text className={styles.empty}>No detail available.</Text>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {page.items.map((item, idx) => (
        <DependentRow
          key={`${item.kind}-${item.id}`}
          projectId={projectId}
          item={item}
          isLast={idx === page.items.length - 1}
        />
      ))}
    </div>
  )
}
