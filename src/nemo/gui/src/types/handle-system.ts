/**
 * Handle System Type Definitions
 * 
 * This module defines types for the multi-handle pipeline editor system,
 * supporting multiple handles per node with type restrictions and named handles.
 */

import type { PrimitiveValueType } from '@/blocks/types'

/**
 * Data types that handles can carry
 */
export type HandleDataType = 
  | PrimitiveValueType
  | 'void'          // No data (for control flow)
  | 'error'         // Error output type
  | 'trigger'       // Trigger/event type
  | 'dataframe'     // DataFrame type for data pipeline processing

/**
 * Handle direction (source = output, target = input)
 */
export type HandleDirection = 'source' | 'target'

/**
 * Handle position on the node
 */
export type HandlePosition = 'top' | 'bottom' | 'left' | 'right'

/**
 * Visual style for handles
 */
export type HandleStyle = 'default' | 'primary' | 'error' | 'warning' | 'success'

/**
 * Connection restrictions for a handle
 */
export interface HandleRestrictions {
  /**
   * For target handles: what source data types are allowed
   */
  allowedSourceTypes?: HandleDataType[]
  
  /**
   * For source handles: what target data types are allowed
   */
  allowedTargetTypes?: HandleDataType[]
  
  /**
   * Explicitly blocked source data types
   */
  blockedSourceTypes?: HandleDataType[]
  
  /**
   * Explicitly blocked target data types
   */
  blockedTargetTypes?: HandleDataType[]
  
  /**
   * Only connect to specific node types
   */
  allowedNodeTypes?: string[]
  
  /**
   * Never connect to these node types
   */
  blockedNodeTypes?: string[]
  
  /**
   * Only connect to specific handle IDs
   */
  allowedHandleIds?: string[]
  
  /**
   * Never connect to these handle IDs
   */
  blockedHandleIds?: string[]
  
  /**
   * Custom validation function
   * @param sourceHandle The source handle configuration
   * @param targetHandle The target handle configuration
   * @returns Validation result
   */
  validator?: (
    sourceHandle: HandleConfig,
    targetHandle: HandleConfig
  ) => {
    valid: boolean
    reason?: string
  }
}

/**
 * Configuration for a single handle
 */
export interface HandleConfig {
  /**
   * Unique identifier within the node (e.g., "main", "error", "output-1")
   */
  id: string
  
  /**
   * Human-readable display name (e.g., "Main Output", "Error Handler")
   */
  name: string
  
  /**
   * Optional description/tooltip text
   */
  description?: string
  
  /**
   * Handle direction: 'source' (output) or 'target' (input)
   */
  type: HandleDirection
  
  /**
   * Data type this handle carries
   */
  dataType: HandleDataType
  
  /**
   * Whether this handle must be connected (for target handles)
   */
  required?: boolean
  
  /**
   * Physical position on the node
   */
  position: HandlePosition
  
  /**
   * Order index when multiple handles on same side
   */
  index?: number
  
  /**
   * Connection restrictions
   */
  restrictions?: HandleRestrictions
  
  /**
   * Custom color (defaults based on dataType)
   */
  color?: string
  
  /**
   * Optional icon identifier
   */
  icon?: string
  
  /**
   * Visual style variant
   */
  style?: HandleStyle
  
  /**
   * Maximum connections allowed (default: unlimited)
   */
  maxConnections?: number
  
  /**
   * Can connect to same node (default: false)
   */
  allowSelfConnection?: boolean
}

/**
 * Handle configuration at block level
 */
export interface BlockHandlesConfig {
  /**
   * Input handles (receives data)
   */
  inputs?: HandleConfig[]
  
  /**
   * Output handles (sends data)
   */
  outputs?: HandleConfig[]
}

/**
 * Runtime state for a handle
 */
export interface HandleState {
  /**
   * Handle ID
   */
  id: string
  
  /**
   * Handle configuration
   */
  config: HandleConfig
  
  /**
   * Edge IDs connected to this handle
   */
  connections: string[]
  
  /**
   * Whether this handle is required
   */
  isRequired: boolean
  
  /**
   * Whether this handle is currently connected
   */
  isConnected: boolean
}

/**
 * Connection attempt information
 */
export interface ConnectionAttempt {
  sourceNodeId: string
  sourceHandleId: string
  targetNodeId: string
  targetHandleId: string
}

/**
 * Validation result for a connection attempt
 */
export interface ValidationResult {
  /**
   * Whether the connection is valid
   */
  valid: boolean
  
  /**
   * Reason for validation failure (if not valid)
   */
  reason?: string
  
  /**
   * Severity level
   */
  severity?: 'error' | 'warning' | 'info'
}

/**
 * Type compatibility check result
 */
export interface TypeCompatibility {
  compatible: boolean
  reason?: string
}

/**
 * Handle style configuration
 */
export interface HandleStyleConfig {
  /**
   * Base CSS classes
   */
  base: string
  
  /**
   * Color based on dataType
   */
  color: string
  
  /**
   * Size variant
   */
  size: 'small' | 'medium' | 'large'
  
  /**
   * Shape variant
   */
  shape: 'circle' | 'square' | 'diamond'
  
  /**
   * Optional icon
   */
  icon?: string
}

/**
 * Handle position calculation result
 */
export interface HandlePositionStyle {
  left?: string
  top?: string
  right?: string
  bottom?: string
  transform?: string
}

/**
 * Default handle configuration for legacy blocks
 */
export interface DefaultHandlesConfig {
  /**
   * Include default source handle (default: true)
   */
  source?: boolean
  
  /**
   * Include default target handle (default: true)
   */
  target?: boolean
}

/**
 * Extended edge data with handle information
 */
export interface HandleEdgeData {
  /**
   * Source handle display name
   */
  sourceHandleName?: string
  
  /**
   * Target handle display name
   */
  targetHandleName?: string
  
  /**
   * Source handle data type
   */
  sourceDataType?: HandleDataType
  
  /**
   * Target handle data type
   */
  targetDataType?: HandleDataType
}

