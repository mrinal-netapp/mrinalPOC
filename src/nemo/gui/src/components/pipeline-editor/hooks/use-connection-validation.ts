/**
 * Hook for validating connections between nodes with handle system support
 */

import { useCallback } from 'react'
import type { Connection } from 'reactflow'
import { useWorkflowStore } from '@/stores/workflow/store'
import { getBlock } from '@/blocks'
import {
  getHandleConfig,
  validateConnection,
  isTypeCompatible,
} from '@/utils/handle-system'
import type { ConnectionAttempt, ValidationResult } from '@/types/handle-system'

/**
 * Hook that provides connection validation for ReactFlow
 */
export function useConnectionValidation() {
  const { blocks, edges } = useWorkflowStore()

  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      const sourceNode = blocks[connection.source || '']
      const targetNode = blocks[connection.target || '']

      if (!sourceNode || !targetNode) {
        return false
      }

      const sourceBlockConfig = getBlock(sourceNode.type)
      const targetBlockConfig = getBlock(targetNode.type)

      if (!sourceBlockConfig || !targetBlockConfig) {
        return false
      }

      // Get handle IDs (default to 'default' for backward compatibility)
      const sourceHandleId = connection.sourceHandle || 'default'
      const targetHandleId = connection.targetHandle || 'default'

      // Get handle configs
      const sourceHandle = getHandleConfig(sourceBlockConfig, sourceHandleId, 'source')
      const targetHandle = getHandleConfig(targetBlockConfig, targetHandleId, 'target')

      if (!sourceHandle || !targetHandle) {
        // If handles don't exist, allow connection for backward compatibility
        return true
      }

      // Validate connection
      const attempt: ConnectionAttempt = {
        sourceNodeId: connection.source || '',
        sourceHandleId: sourceHandleId,
        targetNodeId: connection.target || '',
        targetHandleId: targetHandleId,
      }

      const result = validateConnection(
        attempt,
        sourceNode,
        targetNode,
        sourceHandle,
        targetHandle,
        edges,
        (type: string) => getBlock(type) || null
      )

      if (!result.valid && result.reason) {
        // Log warning for debugging
        console.warn('Invalid connection:', result.reason)
      }

      return result.valid
    },
    [blocks, edges]
  )

  /**
   * Get detailed validation result for a connection attempt
   */
  const getValidationResult = useCallback(
    (connection: Connection): ValidationResult => {
      const sourceNode = blocks[connection.source || '']
      const targetNode = blocks[connection.target || '']

      if (!sourceNode || !targetNode) {
        return {
          valid: false,
          reason: 'Source or target node not found',
          severity: 'error',
        }
      }

      const sourceBlockConfig = getBlock(sourceNode.type)
      const targetBlockConfig = getBlock(targetNode.type)

      if (!sourceBlockConfig || !targetBlockConfig) {
        return {
          valid: false,
          reason: 'Block configuration not found',
          severity: 'error',
        }
      }

      const sourceHandleId = connection.sourceHandle || 'default'
      const targetHandleId = connection.targetHandle || 'default'

      const sourceHandle = getHandleConfig(sourceBlockConfig, sourceHandleId, 'source')
      const targetHandle = getHandleConfig(targetBlockConfig, targetHandleId, 'target')

      if (!sourceHandle || !targetHandle) {
        // Basic compatibility check for backward compatibility
        return {
          valid: true,
          severity: 'info',
        }
      }

      const attempt: ConnectionAttempt = {
        sourceNodeId: connection.source || '',
        sourceHandleId: sourceHandleId,
        targetNodeId: connection.target || '',
        targetHandleId: targetHandleId,
      }

      return validateConnection(
        attempt,
        sourceNode,
        targetNode,
        sourceHandle,
        targetHandle,
        edges,
        (type: string) => getBlock(type) || null
      )
    },
    [blocks, edges]
  )

  /**
   * Check if two handles are type-compatible
   */
  const checkTypeCompatibility = useCallback(
    (
      sourceHandleId: string,
      sourceNodeId: string,
      targetHandleId: string,
      targetNodeId: string
    ): ValidationResult => {
      const sourceNode = blocks[sourceNodeId]
      const targetNode = blocks[targetNodeId]

      if (!sourceNode || !targetNode) {
        return {
          valid: false,
          reason: 'Nodes not found',
          severity: 'error',
        }
      }

      const sourceBlockConfig = getBlock(sourceNode.type)
      const targetBlockConfig = getBlock(targetNode.type)

      if (!sourceBlockConfig || !targetBlockConfig) {
        return {
          valid: false,
          reason: 'Block configurations not found',
          severity: 'error',
        }
      }

      const sourceHandle = getHandleConfig(sourceBlockConfig, sourceHandleId, 'source')
      const targetHandle = getHandleConfig(targetBlockConfig, targetHandleId, 'target')

      if (!sourceHandle || !targetHandle) {
        return {
          valid: true, // Allow for backward compatibility
          severity: 'info',
        }
      }

      const typeCheck = isTypeCompatible(sourceHandle.dataType, targetHandle.dataType)
      return {
        valid: typeCheck.compatible,
        reason: typeCheck.reason,
        severity: typeCheck.compatible ? 'info' : 'error',
      }
    },
    [blocks]
  )

  return {
    isValidConnection,
    getValidationResult,
    checkTypeCompatibility,
  }
}

