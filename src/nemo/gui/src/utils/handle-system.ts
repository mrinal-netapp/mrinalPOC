/**
 * Handle System Utility Functions
 * 
 * Provides validation, type checking, and helper functions for the handle system.
 */

import type { Edge } from 'reactflow'
import type { BlockConfig } from '@/blocks/types'
import type { BlockState } from '@/stores/workflow/types'
import type {
  HandleConfig,
  HandleDataType,
  ConnectionAttempt,
  ValidationResult,
  TypeCompatibility,
  HandleStyleConfig,
  HandlePositionStyle,
} from '@/types/handle-system'

/**
 * Type compatibility matrix
 * Maps source types to compatible target types
 */
const TYPE_COMPATIBILITY: Record<HandleDataType, HandleDataType[]> = {
  string: ['string', 'any'],
  number: ['number', 'any'],
  boolean: ['boolean', 'any'],
  json: ['json', 'any'],
  array: ['array', 'any'],
  files: ['files', 'any'],
  any: ['string', 'number', 'boolean', 'json', 'array', 'files', 'any', 'error', 'trigger', 'dataframe'],
  void: ['void'],
  error: ['error', 'any'],
  trigger: ['trigger', 'any'],
  dataframe: ['dataframe', 'any'],
}

/**
 * Default color mapping for handle data types
 */
const HANDLE_COLORS: Record<HandleDataType, string> = {
  string: '#3b82f6',      // Blue
  number: '#10b981',      // Green
  boolean: '#f59e0b',     // Amber
  json: '#8b5cf6',        // Purple
  array: '#ec4899',       // Pink
  files: '#06b6d4',       // Cyan
  any: '#6b7280',         // Gray
  void: '#374151',        // Dark gray
  error: '#ef4444',       // Red
  trigger: '#f97316',     // Orange
  dataframe: '#6366f1',   // Indigo
}

/**
 * Check if two data types are compatible for connection
 */
export function isTypeCompatible(
  sourceType: HandleDataType,
  targetType: HandleDataType
): TypeCompatibility {
  // Exact match
  if (sourceType === targetType) {
    return { compatible: true }
  }
  
  // Any accepts everything
  if (targetType === 'any') {
    return { compatible: true }
  }
  
  // Void only connects to void
  if (sourceType === 'void' || targetType === 'void') {
    if (sourceType === 'void' && targetType === 'void') {
      return { compatible: true }
    }
    return {
      compatible: false,
      reason: 'Void type can only connect to void type',
    }
  }
  
  // Check compatibility matrix
  const compatibleTypes = TYPE_COMPATIBILITY[sourceType] || []
  if (compatibleTypes.includes(targetType)) {
    return { compatible: true }
  }
  
  // Get human-readable type names
  const getTypeDisplayName = (type: HandleDataType): string => {
    const typeNames: Record<HandleDataType, string> = {
      string: 'text/string',
      number: 'number',
      boolean: 'boolean',
      json: 'JSON object',
      array: 'array',
      files: 'files',
      any: 'any type',
      void: 'void (no data)',
      error: 'error',
      trigger: 'trigger',
      dataframe: 'dataframe/table',
    }
    return typeNames[type] || type
  }
  
  return {
    compatible: false,
    reason: `Cannot connect ${getTypeDisplayName(sourceType)} to ${getTypeDisplayName(targetType)}. These data types are not compatible.`,
  }
}

/**
 * Get handle configuration from block config
 */
export function getHandleConfig(
  blockConfig: BlockConfig,
  handleId: string,
  direction: 'source' | 'target'
): HandleConfig | null {
  const handles = blockConfig.handles
  
  if (!handles) {
    // Return default handle if no handles defined
    return getDefaultHandle(handleId, direction)
  }
  
  const handleList = direction === 'source' ? handles.outputs : handles.inputs
  if (!handleList || handleList.length === 0) {
    return getDefaultHandle(handleId, direction)
  }
  
  return handleList.find(h => h.id === handleId) || null
}

/**
 * Get all handles for a block
 */
export function getAllHandles(blockConfig: BlockConfig): {
  inputs: HandleConfig[]
  outputs: HandleConfig[]
} {
  const handles = blockConfig.handles
  
  if (!handles) {
    // Return default handles
    const defaultSource = getDefaultHandle('default', 'source')
    const defaultTarget = getDefaultHandle('default', 'target')
    return {
      inputs: defaultTarget ? [{ ...defaultTarget }] : [],
      outputs: defaultSource ? [{ ...defaultSource }] : [],
    }
  }
  
  return {
    inputs: handles.inputs || [],
    outputs: handles.outputs || [],
  }
}

/**
 * Get default handle configuration
 */
function getDefaultHandle(
  handleId: string,
  direction: 'source' | 'target'
): HandleConfig | null {
  return {
    id: handleId,
    name: direction === 'source' ? 'Output' : 'Input',
    type: direction,
    dataType: 'any',
    position: direction === 'source' ? 'bottom' : 'top',
    index: 0,
  }
}

/**
 * Validate a connection attempt
 */
export function validateConnection(
  attempt: ConnectionAttempt,
  sourceNode: BlockState,
  targetNode: BlockState,
  sourceHandle: HandleConfig,
  targetHandle: HandleConfig,
  existingEdges: Edge[],
  getBlockConfig: (type: string) => BlockConfig | null
): ValidationResult {
  // 1. Check self-connection
  if (attempt.sourceNodeId === attempt.targetNodeId) {
    if (!sourceHandle.allowSelfConnection && !targetHandle.allowSelfConnection) {
      const blockConfig = getBlockConfig(sourceNode.type)
      const blockName = blockConfig?.name || sourceNode.type
      return {
        valid: false,
        reason: `Cannot connect "${blockName}" to itself. Self-connections are not allowed for these handles.`,
        severity: 'error',
      }
    }
  }
  
  // 2. Check type compatibility
  const typeCheck = isTypeCompatible(sourceHandle.dataType, targetHandle.dataType)
  if (!typeCheck.compatible) {
    const sourceBlockConfig = getBlockConfig(sourceNode.type)
    const targetBlockConfig = getBlockConfig(targetNode.type)
    const sourceBlockName = sourceBlockConfig?.name || sourceNode.type
    const targetBlockName = targetBlockConfig?.name || targetNode.type
    
    return {
      valid: false,
      reason: `Cannot connect ${sourceHandle.dataType} output from "${sourceBlockName}" (${sourceHandle.name || sourceHandle.id}) to ${targetHandle.dataType} input on "${targetBlockName}" (${targetHandle.name || targetHandle.id}). ${typeCheck.reason || 'Type mismatch'}`,
      severity: 'error',
    }
  }
  
  // 3. Check handle restrictions
  if (targetHandle.restrictions) {
    const restrictionResult = validateHandleRestrictions(
      attempt,
      sourceNode,
      targetNode,
      sourceHandle,
      targetHandle,
      getBlockConfig
    )
    if (!restrictionResult.valid) {
      return restrictionResult
    }
  }
  
  // 4. Check connection limits
  const sourceConnections = existingEdges.filter(
    e => e.source === attempt.sourceNodeId && e.sourceHandle === attempt.sourceHandleId
  )
  if (sourceHandle.maxConnections && 
      sourceConnections.length >= sourceHandle.maxConnections) {
    const sourceBlockConfig = getBlockConfig(sourceNode.type)
    const sourceBlockName = sourceBlockConfig?.name || sourceNode.type
    return {
      valid: false,
      reason: `"${sourceBlockName}" (${sourceHandle.name || sourceHandle.id}) already has the maximum number of connections (${sourceHandle.maxConnections}). Remove an existing connection first.`,
      severity: 'error',
    }
  }
  
  const targetConnections = existingEdges.filter(
    e => e.target === attempt.targetNodeId && e.targetHandle === attempt.targetHandleId
  )
  if (targetHandle.maxConnections && 
      targetConnections.length >= targetHandle.maxConnections) {
    const targetBlockConfig = getBlockConfig(targetNode.type)
    const targetBlockName = targetBlockConfig?.name || targetNode.type
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) already has the maximum number of connections (${targetHandle.maxConnections}). Remove an existing connection first.`,
      severity: 'error',
    }
  }
  
  return { valid: true }
}

/**
 * Validate handle restrictions
 */
function validateHandleRestrictions(
  attempt: ConnectionAttempt,
  sourceNode: BlockState,
  targetNode: BlockState,
  sourceHandle: HandleConfig,
  targetHandle: HandleConfig,
  getBlockConfig: (type: string) => BlockConfig | null
): ValidationResult {
  const restrictions = targetHandle.restrictions!
  const sourceBlockConfig = getBlockConfig(sourceNode.type)
  const targetBlockConfig = getBlockConfig(targetNode.type)
  const sourceBlockName = sourceBlockConfig?.name || sourceNode.type
  const targetBlockName = targetBlockConfig?.name || targetNode.type
  
  // Check allowed source types
  if (restrictions.allowedSourceTypes && 
      !restrictions.allowedSourceTypes.includes(sourceHandle.dataType)) {
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) only accepts ${restrictions.allowedSourceTypes.join(', ')} data types, but "${sourceBlockName}" outputs ${sourceHandle.dataType}. Try connecting to a different input handle or use a compatible block.`,
      severity: 'error',
    }
  }
  
  // Check blocked source types
  if (restrictions.blockedSourceTypes?.includes(sourceHandle.dataType)) {
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) cannot accept ${sourceHandle.dataType} data. The source block "${sourceBlockName}" outputs ${sourceHandle.dataType}, which is not compatible with this input.`,
      severity: 'error',
    }
  }
  
  // Check allowed node types
  if (restrictions.allowedNodeTypes && 
      !restrictions.allowedNodeTypes.includes(sourceNode.type)) {
    const allowedBlockNames = restrictions.allowedNodeTypes
      .map(type => {
        const config = getBlockConfig(type)
        return config?.name || type
      })
      .join(', ')
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) only accepts connections from: ${allowedBlockNames}. The source block "${sourceBlockName}" is not compatible.`,
      severity: 'error',
    }
  }
  
  // Check blocked node types
  if (restrictions.blockedNodeTypes?.includes(sourceNode.type)) {
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) cannot accept connections from "${sourceBlockName}" blocks. Please use a different block type.`,
      severity: 'error',
    }
  }
  
  // Check allowed handle IDs
  if (restrictions.allowedHandleIds && 
      !restrictions.allowedHandleIds.includes(attempt.sourceHandleId)) {
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) only accepts connections from specific handles. The source handle "${sourceHandle.name || sourceHandle.id}" is not compatible.`,
      severity: 'error',
    }
  }
  
  // Check blocked handle IDs
  if (restrictions.blockedHandleIds?.includes(attempt.sourceHandleId)) {
    return {
      valid: false,
      reason: `"${targetBlockName}" (${targetHandle.name || targetHandle.id}) cannot accept connections from "${sourceHandle.name || sourceHandle.id}". Please use a different output handle.`,
      severity: 'error',
    }
  }
  
  // Custom validator
  if (restrictions.validator) {
    const customResult = restrictions.validator(sourceHandle, targetHandle)
    if (!customResult.valid) {
      return {
        valid: false,
        reason: customResult.reason || `Cannot connect "${sourceBlockName}" to "${targetBlockName}": Custom validation failed`,
        severity: 'error',
      }
    }
  }
  
  return { valid: true }
}

/**
 * Get handle style configuration
 */
export function getHandleStyle(handle: HandleConfig): HandleStyleConfig {
  const styleMap: Record<string, string> = {
    default: '',
    primary: 'ring-2 ring-blue-500',
    error: 'ring-2 ring-red-500',
    warning: 'ring-2 ring-yellow-500',
    success: 'ring-2 ring-green-500',
  }
  
  return {
    base: `handle ${styleMap[handle.style || 'default']}`,
    color: handle.color || HANDLE_COLORS[handle.dataType] || HANDLE_COLORS.any,
    size: 'medium',
    shape: 'circle',
    icon: handle.icon,
  }
}

/**
 * Calculate handle position style
 */
export function calculateHandlePosition(
  handle: HandleConfig,
  totalHandles: number,
  side: 'top' | 'bottom' | 'left' | 'right'
): HandlePositionStyle {
  const index = handle.index || 0
  const spacing = 100 / (totalHandles + 1)  // Percentage spacing
  
  if (side === 'top' || side === 'bottom') {
    return {
      left: `${spacing * (index + 1)}%`,
      [side === 'top' ? 'top' : 'bottom']: '-7px',
      transform: 'translateX(-50%)',
    }
  } else {
    return {
      top: `${spacing * (index + 1)}%`,
      [side === 'left' ? 'left' : 'right']: '-7px',
      transform: 'translateY(-50%)',
    }
  }
}

/**
 * Get handle color by data type
 */
export function getHandleColor(dataType: HandleDataType): string {
  return HANDLE_COLORS[dataType] || HANDLE_COLORS.any
}

/**
 * Check if a handle is required and not connected
 */
export function isRequiredHandleUnconnected(
  handle: HandleConfig,
  connections: Edge[]
): boolean {
  if (!handle.required || handle.type !== 'target') {
    return false
  }
  
  return connections.length === 0
}

/**
 * Get all unconnected required handles for a node
 */
export function getUnconnectedRequiredHandles(
  handles: HandleConfig[],
  nodeId: string,
  edges: Edge[]
): HandleConfig[] {
  return handles.filter(handle => {
    if (!handle.required || handle.type !== 'target') {
      return false
    }
    
    const isConnected = edges.some(
      edge => edge.target === nodeId && edge.targetHandle === handle.id
    )
    
    return !isConnected
  })
}

