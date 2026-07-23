import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  makeStyles,
  tokens,
  Text,
  Button,
  Input,
  Checkbox,
  Spinner,
  Popover,
  PopoverTrigger,
  PopoverSurface,
} from '@fluentui/react-components'
import { Filter16Regular, Dismiss16Regular } from '@fluentui/react-icons'
import { datasetApi, type FilterCriteria, type HistogramBucket } from '../../services/api'

const useStyles = makeStyles({
  trigger: {
    minWidth: 'auto',
    padding: '2px',
  },
  surface: {
    width: '280px',
    maxHeight: '400px',
    display: 'flex',
    flexDirection: 'column',
    padding: '12px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  searchInput: {
    marginBottom: '8px',
  },
  list: {
    flex: '1 1 0',
    overflowY: 'auto',
    maxHeight: '240px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    marginBottom: '8px',
  },
  itemRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '2px 0',
    fontSize: '13px',
  },
  countLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
    marginLeft: '4px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '8px',
  },
  bulkActions: {
    display: 'flex',
    gap: '8px',
    marginBottom: '4px',
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  error: {
    fontSize: '12px',
    color: tokens.colorPaletteRedForeground1,
    padding: '8px 0',
  },
})

interface ColumnFilterPopoverProps {
  namespace: string
  tableName: string
  column: string
  columnType: string
  activeFilter?: FilterCriteria
  onApply: (filter: FilterCriteria) => void
  onClear: () => void
}

export function ColumnFilterPopover({
  namespace,
  tableName,
  column,
  columnType: _columnType,
  activeFilter,
  onApply,
  onClear,
}: ColumnFilterPopoverProps) {
  const styles = useStyles()
  const [open, setOpen] = useState(false)
  const [buckets, setBuckets] = useState<HistogramBucket[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const fetchValues = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await datasetApi.columnHistogram(namespace, tableName, column)
      setBuckets(resp.buckets ?? [])
      if (activeFilter?.op === 'IN' && activeFilter.value) {
        setSelected(new Set(activeFilter.value.split(',').map((v) => v.trim())))
      } else {
        setSelected(new Set())
      }
    } catch (err: any) {
      setError(err?.response?.data?.detail || err.message || 'Failed to load values')
    } finally {
      setLoading(false)
    }
  }, [namespace, tableName, column, activeFilter])

  useEffect(() => {
    if (open) {
      fetchValues()
      setSearch('')
    }
  }, [open, fetchValues])

  const filteredBuckets = useMemo(() => {
    if (!search) return buckets
    const q = search.toLowerCase()
    return buckets.filter((b) => b.label.toLowerCase().includes(q))
  }, [buckets, search])

  const handleToggle = (label: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setSelected(new Set(filteredBuckets.map((b) => b.label)))
  }

  const handleClearSelection = () => {
    setSelected(new Set())
  }

  const handleApply = () => {
    if (selected.size === 0) {
      onClear()
    } else {
      onApply({
        column,
        op: 'IN',
        value: Array.from(selected).join(','),
      })
    }
    setOpen(false)
  }

  const handleClearFilter = () => {
    onClear()
    setSelected(new Set())
    setOpen(false)
  }

  const hasActive = !!activeFilter

  return (
    <Popover
      open={open}
      onOpenChange={(_e, data) => setOpen(data.open)}
      positioning="below-end"
      trapFocus
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          className={styles.trigger}
          icon={<Filter16Regular />}
          appearance="subtle"
          size="small"
          onClick={(e) => e.stopPropagation()}
          style={hasActive ? { color: tokens.colorBrandForeground1 } : undefined}
        />
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        <div className={styles.header}>
          <Text weight="semibold" style={{ fontSize: '13px' }}>Filter: {column}</Text>
          <Button
            icon={<Dismiss16Regular />}
            appearance="subtle"
            size="small"
            onClick={() => setOpen(false)}
          />
        </div>

        {loading ? (
          <div className={styles.loading}>
            <Spinner size="small" label="Loading values..." />
          </div>
        ) : error ? (
          <Text className={styles.error}>{error}</Text>
        ) : (
          <>
            <Input
              className={styles.searchInput}
              placeholder="Search values..."
              value={search}
              onChange={(_e, data) => setSearch(data.value)}
              size="small"
            />
            <div className={styles.bulkActions}>
              <Button size="small" appearance="subtle" onClick={handleSelectAll}>
                Select all
              </Button>
              <Button size="small" appearance="subtle" onClick={handleClearSelection}>
                Clear
              </Button>
            </div>
            <div className={styles.list}>
              {filteredBuckets.length === 0 ? (
                <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, padding: '8px 0' }}>
                  No values found
                </Text>
              ) : (
                filteredBuckets.map((bucket) => (
                  <div key={bucket.label} className={styles.itemRow}>
                    <Checkbox
                      label={bucket.label || '(empty)'}
                      checked={selected.has(bucket.label)}
                      onChange={() => handleToggle(bucket.label)}
                      size="medium"
                    />
                    <Text className={styles.countLabel}>{bucket.count.toLocaleString()}</Text>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        <div className={styles.actions}>
          {hasActive && (
            <Button size="small" appearance="subtle" onClick={handleClearFilter}>
              Remove filter
            </Button>
          )}
          <Button size="small" appearance="primary" onClick={handleApply} disabled={loading}>
            Apply
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  )
}
