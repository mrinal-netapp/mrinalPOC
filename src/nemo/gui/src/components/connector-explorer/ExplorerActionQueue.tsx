import {
  makeStyles,
  tokens,
  Text,
  Button,
  Badge,
  Spinner,
  Card,
} from '@fluentui/react-components'
import {
  Dismiss16Regular,
  Checkmark16Regular,
  DismissCircle16Regular,
} from '@fluentui/react-icons'
import type { ExplorerActionStrategy, QueueItemBase } from './ExplorerActionStrategy'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  itemCard: {
    padding: '8px 10px',
  },
  itemHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '6px',
    marginBottom: '4px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '10px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    flexShrink: 0,
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: '24px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
    fontSize: tokens.fontSizeBase200,
    textAlign: 'center',
  },
})

interface ExplorerActionQueueProps<T extends QueueItemBase> {
  strategy: ExplorerActionStrategy<T>
  items: T[]
  existingNames?: Set<string>
  onUpdateItem: (id: string, updates: Partial<T>) => void
  onRemoveItem: (id: string) => void
  onClearAll: () => void
  onApplyAll: () => void
  applying: boolean
  eligibleCount: number
  totalCount: number
}

export function ExplorerActionQueue<T extends QueueItemBase>({
  strategy,
  items,
  existingNames,
  onUpdateItem,
  onRemoveItem,
  onClearAll,
  onApplyAll,
  applying,
  eligibleCount,
  totalCount,
}: ExplorerActionQueueProps<T>) {
  const styles = useStyles()

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Text size={200} weight="semibold">{strategy.actionLabel}</Text>
          {totalCount > 0 && (
            <Badge appearance="outline" size="small" color="informative">{totalCount}</Badge>
          )}
        </div>
        {totalCount > 0 && (
          <Button
            size="small"
            appearance="transparent"
            onClick={onClearAll}
            disabled={applying}
          >
            Clear all
          </Button>
        )}
      </div>

      {totalCount === 0 ? (
        <div className={styles.emptyState}>
          Check {strategy.itemNoun}s in the tree to add them to the queue
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => {
            const validationError = strategy.validateItem(item, items, existingNames)
            const isApplying = item.status === 'applying'
            const isSuccess = item.status === 'success'
            const isFailed = item.status === 'failed'
            const isDone = isSuccess || isFailed

            return (
              <Card key={item.id} className={styles.itemCard}>
                <div className={styles.itemHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                    {isApplying && <Spinner size="tiny" />}
                    {isSuccess && <Checkmark16Regular style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                    {isFailed && <DismissCircle16Regular style={{ color: tokens.colorPaletteRedForeground1 }} />}
                    <Text
                      size={100}
                      style={{
                        fontFamily: 'monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={item.nodeLabel}
                    >
                      {item.nodeLabel}
                    </Text>
                  </div>
                  {!isDone && !isApplying && (
                    <Button
                      size="small"
                      appearance="transparent"
                      icon={<Dismiss16Regular />}
                      onClick={() => onRemoveItem(item.id)}
                      aria-label={`Remove ${item.nodeLabel}`}
                    />
                  )}
                </div>

                {!isDone && !isApplying && (
                  <div style={{ marginTop: '4px' }}>
                    {strategy.renderItemFields(
                      item,
                      (updates) => onUpdateItem(item.id, updates),
                      validationError,
                    )}
                  </div>
                )}

                {isFailed && item.error && (
                  <Text size={100} style={{ color: tokens.colorPaletteRedForeground1, marginTop: '4px' }}>
                    {item.error}
                  </Text>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {totalCount > 0 && (
        <div className={styles.footer}>
          <Button
            appearance="primary"
            onClick={onApplyAll}
            disabled={eligibleCount === 0 || applying}
            style={{ width: '100%' }}
          >
            {applying
              ? `Applying…`
              : `${strategy.actionLabel} (${eligibleCount} of ${totalCount})`}
          </Button>
        </div>
      )}
    </div>
  )
}
