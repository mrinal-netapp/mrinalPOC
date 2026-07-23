import type { ExplorerNode } from '../../services/api'
import type { ReactNode } from 'react'

export type QueueItemStatus = 'pending' | 'applying' | 'success' | 'failed'

export interface QueueItemBase {
  id: string
  nodeLabel: string
  status: QueueItemStatus
  error?: string
}

export interface StrategyContext {
  projectId: string
  connectorId: string
  [key: string]: unknown
}

export interface ExplorerActionStrategy<T extends QueueItemBase = QueueItemBase> {
  actionLabel: string
  itemNoun: string
  selectableNodeTypes: string[]

  nodeToQueueItem(node: ExplorerNode, context: StrategyContext): T

  validateItem(item: T, allItems: T[], existingNames?: Set<string>): string | null

  renderItemFields(
    item: T,
    onUpdate: (updates: Partial<T>) => void,
    validationError: string | null,
  ): ReactNode

  applyItem(item: T, context: StrategyContext): Promise<void>
}
