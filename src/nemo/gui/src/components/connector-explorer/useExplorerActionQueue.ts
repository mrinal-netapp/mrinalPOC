import { useState, useCallback, useMemo } from 'react'
import type { ExplorerNode } from '../../services/api'
import type { ExplorerActionStrategy, QueueItemBase, StrategyContext } from './ExplorerActionStrategy'

interface UseExplorerActionQueueOptions {
  existingNames?: Set<string>
}

export function useExplorerActionQueue<T extends QueueItemBase>(
  strategy: ExplorerActionStrategy<T>,
  context: StrategyContext,
  options?: UseExplorerActionQueueOptions,
) {
  const [items, setItems] = useState<T[]>([])
  const [applying, setApplying] = useState(false)

  const selectedNodeIds = useMemo(
    () => new Set(items.map((item) => item.id)),
    [items],
  )

  const toggleNode = useCallback(
    (node: ExplorerNode) => {
      setItems((prev) => {
        const existing = prev.find((i) => i.id === node.id)
        if (existing) {
          return prev.filter((i) => i.id !== node.id)
        }
        const newItem = strategy.nodeToQueueItem(node, context)
        return [...prev, newItem]
      })
    },
    [strategy, context],
  )

  const addNodes = useCallback(
    (nodes: ExplorerNode[]) => {
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id))
        const newItems = nodes
          .filter((n) => !existingIds.has(n.id))
          .map((n) => strategy.nodeToQueueItem(n, context))
        return [...prev, ...newItems]
      })
    },
    [strategy, context],
  )

  const updateItem = useCallback((id: string, updates: Partial<T>) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...updates } : item)),
    )
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setItems([])
  }, [])

  const eligibleCount = useMemo(() => {
    return items.filter(
      (item) =>
        item.status === 'pending' &&
        strategy.validateItem(item, items, options?.existingNames) === null,
    ).length
  }, [items, strategy, options?.existingNames])

  const applyAll = useCallback(async (): Promise<{ succeeded: number; failed: number }> => {
    setApplying(true)
    let succeeded = 0
    let failed = 0

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.status !== 'pending') continue
      const validationError = strategy.validateItem(item, items, options?.existingNames)
      if (validationError !== null) continue

      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'applying' as const } : it)),
      )

      try {
        await strategy.applyItem(item, context)
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, status: 'success' as const } : it)),
        )
        succeeded++
      } catch (err: any) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id
              ? { ...it, status: 'failed' as const, error: err.message || 'Failed' }
              : it,
          ),
        )
        failed++
      }
    }

    setApplying(false)
    return { succeeded, failed }
  }, [items, strategy, context, options?.existingNames])

  return {
    items,
    selectedNodeIds,
    toggleNode,
    addNodes,
    updateItem,
    removeItem,
    clearAll,
    applyAll,
    applying,
    eligibleCount,
    totalCount: items.length,
  }
}
