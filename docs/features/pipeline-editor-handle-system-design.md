# Pipeline Editor Handle System Design

## Overview

This document outlines a comprehensive design for a multi-handle pipeline editor system inspired by n8n, supporting:
1. Multiple handles/attach points per node
2. Type system and connection restrictions
3. Individual named handles

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Type System](#type-system)
3. [Handle Definition](#handle-definition)
4. [Connection Validation](#connection-validation)
5. [Data Structures](#data-structures)
6. [UI/UX Design](#uiux-design)
7. [Implementation Plan](#implementation-plan)
8. [Migration Strategy](#migration-strategy)

---

## Core Concepts

### Handle Types

A **handle** is a connection point on a node that can either:
- **Receive data** (input/target handle) - positioned on the top/left
- **Send data** (output/source handle) - positioned on the bottom/right

### Handle Characteristics

Each handle has:
- **Unique ID**: Identifier within the node (e.g., "main", "error", "metadata")
- **Name**: Human-readable label (e.g., "Main Output", "Error Handler")
- **Type**: Data type it carries (e.g., "string", "json", "any")
- **Position**: Physical location on the node (top, bottom, left, right)
- **Connection Rules**: What it can/cannot connect to
- **Visual Style**: Color, icon, or styling to indicate type/purpose

---

## Type System

### Data Types

Extend the existing `PrimitiveValueType` to support handle typing:

```typescript
type HandleDataType = 
  | 'string'
  | 'number'
  | 'boolean'
  | 'json'
  | 'array'
  | 'files'
  | 'any'           // Accepts any type (default)
  | 'void'          // No data (for control flow)
  | 'error'         // Error output type
  | 'trigger'       // Trigger/event type
```

### Type Compatibility Matrix

| Source Type | Compatible Target Types |
|------------|------------------------|
| `string` | `string`, `any` |
| `number` | `number`, `any` |
| `boolean` | `boolean`, `any` |
| `json` | `json`, `any` |
| `array` | `array`, `any` |
| `files` | `files`, `any` |
| `any` | All types |
| `void` | `void` only (control flow) |
| `error` | `error`, `any` |
| `trigger` | `trigger`, `any` |

### Type Hierarchy

- **Strict matching**: Exact type match required
- **Polymorphic**: `any` accepts all types
- **Specialized**: `error` and `trigger` have specific semantics

---

## Handle Definition

### Handle Configuration Schema

```typescript
interface HandleConfig {
  // Identity
  id: string                    // Unique within node (e.g., "main", "error", "output-1")
  name: string                  // Display name (e.g., "Main Output", "Error Handler")
  description?: string           // Tooltip/help text
  
  // Type and Data
  type: 'source' | 'target'     // Direction
  dataType: HandleDataType      // What data this handle carries
  required?: boolean            // Must be connected (for target handles)
  
  // Position and Layout
  position: 'top' | 'bottom' | 'left' | 'right'
  index?: number                // Order when multiple handles on same side
  
  // Connection Restrictions
  restrictions?: HandleRestrictions
  
  // Visual
  color?: string                // Handle color (defaults based on dataType)
  icon?: string                 // Optional icon identifier
  style?: 'default' | 'primary' | 'error' | 'warning' | 'success'
  
  // Behavior
  maxConnections?: number       // Max connections allowed (default: unlimited)
  allowSelfConnection?: boolean // Can connect to same node (default: false)
}

interface HandleRestrictions {
  // Type-based restrictions
  allowedSourceTypes?: HandleDataType[]    // For target handles: what source types allowed
  allowedTargetTypes?: HandleDataType[]    // For source handles: what target types allowed
  blockedSourceTypes?: HandleDataType[]    // Explicitly blocked source types
  blockedTargetTypes?: HandleDataType[]    // Explicitly blocked target types
  
  // Node-based restrictions
  allowedNodeTypes?: string[]              // Only connect to specific node types
  blockedNodeTypes?: string[]              // Never connect to these node types
  
  // Handle-based restrictions
  allowedHandleIds?: string[]               // Only connect to specific handle IDs
  blockedHandleIds?: string[]               // Never connect to these handle IDs
  
  // Custom validation
  validator?: (sourceHandle: HandleConfig, targetHandle: HandleConfig) => {
    valid: boolean
    reason?: string
  }
}
```

### Block-Level Handle Configuration

Extend `BlockConfig` to include handle definitions:

```typescript
interface BlockConfig {
  // ... existing fields ...
  
  // Handle definitions
  handles?: {
    sources?: HandleConfig[]    // Output handles
    targets?: HandleConfig[]    // Input handles
  }
  
  // Legacy support: if handles not defined, use defaults
  defaultHandles?: {
    source?: boolean            // Default: true
    target?: boolean             // Default: true
  }
}
```

### Example: Multi-Handle Block Definition

```typescript
export const MergeBlock: BlockConfig = {
  type: 'merge',
  name: 'Merge',
  // ... other config ...
  
  handles: {
    // Multiple input handles
    targets: [
      {
        id: 'input-1',
        name: 'Input 1',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 0,
        required: true,
      },
      {
        id: 'input-2',
        name: 'Input 2',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 1,
        required: true,
      },
      {
        id: 'input-3',
        name: 'Input 3',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 2,
        required: false,
      },
    ],
    // Single output handle
    sources: [
      {
        id: 'merged',
        name: 'Merged Output',
        type: 'source',
        dataType: 'json',
        position: 'bottom',
        index: 0,
      },
    ],
  },
}
```

### Example: Error Handling Block

```typescript
export const TryCatchBlock: BlockConfig = {
  type: 'try-catch',
  name: 'Try/Catch',
  // ... other config ...
  
  handles: {
    targets: [
      {
        id: 'input',
        name: 'Input',
        type: 'target',
        dataType: 'any',
        position: 'top',
      },
    ],
    sources: [
      {
        id: 'success',
        name: 'Success',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
      },
      {
        id: 'error',
        name: 'Error',
        type: 'source',
        dataType: 'error',
        position: 'bottom',
        index: 1,
        style: 'error',
        restrictions: {
          allowedTargetTypes: ['error', 'any'],
        },
      },
    ],
  },
}
```

### Example: Conditional Router

```typescript
export const RouterBlock: BlockConfig = {
  type: 'router',
  name: 'Router',
  // ... other config ...
  
  handles: {
    targets: [
      {
        id: 'input',
        name: 'Input',
        type: 'target',
        dataType: 'any',
        position: 'top',
      },
    ],
    sources: [
      {
        id: 'true',
        name: 'True',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
      },
      {
        id: 'false',
        name: 'False',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 1,
        style: 'warning',
      },
    ],
  },
}
```

---

## Connection Validation

### Validation Rules

1. **Type Compatibility**: Source and target data types must be compatible
2. **Handle Restrictions**: Must satisfy handle-level restrictions
3. **Node Restrictions**: Must satisfy node-level restrictions
4. **Connection Limits**: Must not exceed `maxConnections`
5. **Self-Connection**: Only if `allowSelfConnection` is true
6. **Required Handles**: Target handles marked `required` must have at least one connection

### Validation Function

```typescript
interface ConnectionAttempt {
  sourceNodeId: string
  sourceHandleId: string
  targetNodeId: string
  targetHandleId: string
}

interface ValidationResult {
  valid: boolean
  reason?: string
  severity?: 'error' | 'warning' | 'info'
}

function validateConnection(
  attempt: ConnectionAttempt,
  sourceNode: BlockState,
  targetNode: BlockState,
  sourceHandle: HandleConfig,
  targetHandle: HandleConfig,
  existingEdges: Edge[]
): ValidationResult {
  // 1. Check self-connection
  if (attempt.sourceNodeId === attempt.targetNodeId) {
    if (!sourceHandle.allowSelfConnection && !targetHandle.allowSelfConnection) {
      return {
        valid: false,
        reason: 'Self-connections are not allowed for these handles',
        severity: 'error',
      }
    }
  }
  
  // 2. Check type compatibility
  if (!isTypeCompatible(sourceHandle.dataType, targetHandle.dataType)) {
    return {
      valid: false,
      reason: `Cannot connect ${sourceHandle.dataType} to ${targetHandle.dataType}`,
      severity: 'error',
    }
  }
  
  // 3. Check handle restrictions
  if (targetHandle.restrictions) {
    const restrictions = targetHandle.restrictions
    
    // Check allowed source types
    if (restrictions.allowedSourceTypes && 
        !restrictions.allowedSourceTypes.includes(sourceHandle.dataType)) {
      return {
        valid: false,
        reason: `Target handle only accepts: ${restrictions.allowedSourceTypes.join(', ')}`,
        severity: 'error',
      }
    }
    
    // Check blocked source types
    if (restrictions.blockedSourceTypes?.includes(sourceHandle.dataType)) {
      return {
        valid: false,
        reason: `Target handle does not accept: ${sourceHandle.dataType}`,
        severity: 'error',
      }
    }
    
    // Check allowed node types
    if (restrictions.allowedNodeTypes && 
        !restrictions.allowedNodeTypes.includes(sourceNode.type)) {
      return {
        valid: false,
        reason: `Target handle only accepts connections from: ${restrictions.allowedNodeTypes.join(', ')}`,
        severity: 'error',
      }
    }
    
    // Check blocked node types
    if (restrictions.blockedNodeTypes?.includes(sourceNode.type)) {
      return {
        valid: false,
        reason: `Target handle cannot accept connections from: ${sourceNode.type}`,
        severity: 'error',
      }
    }
    
    // Check allowed handle IDs
    if (restrictions.allowedHandleIds && 
        !restrictions.allowedHandleIds.includes(attempt.sourceHandleId)) {
      return {
        valid: false,
        reason: `Target handle only accepts connections from specific handles`,
        severity: 'error',
      }
    }
    
    // Check blocked handle IDs
    if (restrictions.blockedHandleIds?.includes(attempt.sourceHandleId)) {
      return {
        valid: false,
        reason: `Target handle cannot accept connections from this source handle`,
        severity: 'error',
      }
    }
    
    // Custom validator
    if (restrictions.validator) {
      const customResult = restrictions.validator(sourceHandle, targetHandle)
      if (!customResult.valid) {
        return {
          valid: false,
          reason: customResult.reason || 'Custom validation failed',
          severity: 'error',
        }
      }
    }
  }
  
  // 4. Check connection limits
  const existingConnections = existingEdges.filter(
    e => e.source === attempt.sourceNodeId && e.sourceHandle === attempt.sourceHandleId
  )
  if (sourceHandle.maxConnections && 
      existingConnections.length >= sourceHandle.maxConnections) {
    return {
      valid: false,
      reason: `Source handle already has maximum connections (${sourceHandle.maxConnections})`,
      severity: 'error',
    }
  }
  
  const existingTargetConnections = existingEdges.filter(
    e => e.target === attempt.targetNodeId && e.targetHandle === attempt.targetHandleId
  )
  if (targetHandle.maxConnections && 
      existingTargetConnections.length >= targetHandle.maxConnections) {
    return {
      valid: false,
      reason: `Target handle already has maximum connections (${targetHandle.maxConnections})`,
      severity: 'error',
    }
  }
  
  return { valid: true }
}

function isTypeCompatible(sourceType: HandleDataType, targetType: HandleDataType): boolean {
  // Exact match
  if (sourceType === targetType) return true
  
  // Any accepts everything
  if (targetType === 'any') return true
  
  // Void only connects to void
  if (sourceType === 'void' || targetType === 'void') {
    return sourceType === targetType
  }
  
  // Error can connect to error or any
  if (sourceType === 'error') {
    return targetType === 'error' || targetType === 'any'
  }
  
  // Trigger can connect to trigger or any
  if (sourceType === 'trigger') {
    return targetType === 'trigger' || targetType === 'any'
  }
  
  // Default: incompatible
  return false
}
```

### Real-time Validation in ReactFlow

```typescript
// In use-workflow-handlers.ts
const isValidConnection = useCallback(
  (connection: Connection): boolean => {
    const sourceNode = blocks[connection.source]
    const targetNode = blocks[connection.target]
    
    if (!sourceNode || !targetNode) return false
    
    const sourceBlockConfig = getBlock(sourceNode.type)
    const targetBlockConfig = getBlock(targetNode.type)
    
    if (!sourceBlockConfig || !targetBlockConfig) return false
    
    // Get handle configs
    const sourceHandle = getHandleConfig(
      sourceBlockConfig,
      connection.sourceHandle || 'default',
      'source'
    )
    const targetHandle = getHandleConfig(
      targetBlockConfig,
      connection.targetHandle || 'default',
      'target'
    )
    
    if (!sourceHandle || !targetHandle) return false
    
    // Validate
    const result = validateConnection(
      {
        sourceNodeId: connection.source,
        sourceHandleId: connection.sourceHandle || 'default',
        targetNodeId: connection.target,
        targetHandleId: connection.targetHandle || 'default',
      },
      sourceNode,
      targetNode,
      sourceHandle,
      targetHandle,
      edges
    )
    
    if (!result.valid) {
      // Show error message to user
      console.warn('Invalid connection:', result.reason)
      // Could show toast notification here
    }
    
    return result.valid
  },
  [blocks, edges]
)

// Use in ReactFlow
<ReactFlow
  // ... other props ...
  onConnectStart={(event, { nodeId, handleId, handleType }) => {
    // Visual feedback when starting connection
  }}
  onConnectEnd={(event) => {
    // Cleanup
  }}
  isValidConnection={isValidConnection}
  connectionMode={ConnectionMode.Loose} // Allow connections to any handle
/>
```

---

## Data Structures

### Extended Block State

```typescript
interface BlockState {
  // ... existing fields ...
  
  // Handle state (runtime)
  handles?: {
    sources?: Record<string, HandleState>
    targets?: Record<string, HandleState>
  }
}

interface HandleState {
  id: string
  config: HandleConfig
  connections: string[]  // Edge IDs connected to this handle
  isRequired: boolean
  isConnected: boolean
}
```

### Extended Edge Structure

```typescript
interface Edge {
  id: string
  source: string
  target: string
  sourceHandle: string    // Now required and specific
  targetHandle: string    // Now required and specific
  type: string
  data?: {
    sourceHandleName?: string
    targetHandleName?: string
    sourceDataType?: HandleDataType
    targetDataType?: HandleDataType
  }
}
```

### Serialization Updates

```typescript
interface SerializedConnection {
  source: string
  target: string
  sourceHandle: string    // Required
  targetHandle: string    // Required
  metadata?: {
    sourceHandleName?: string
    targetHandleName?: string
  }
}

interface SerializedBlock {
  // ... existing fields ...
  handles?: {
    sources?: Array<{
      id: string
      name: string
      dataType: HandleDataType
    }>
    targets?: Array<{
      id: string
      name: string
      dataType: HandleDataType
      required?: boolean
    }>
  }
}
```

---

## UI/UX Design

### Visual Handle Representation

#### Handle Styling

```typescript
interface HandleStyle {
  base: string           // Base CSS classes
  color: string          // Color based on dataType
  size: 'small' | 'medium' | 'large'
  shape: 'circle' | 'square' | 'diamond'
  icon?: string          // Optional icon
}

const getHandleStyle = (handle: HandleConfig): HandleStyle => {
  const colorMap: Record<HandleDataType, string> = {
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
  }
  
  const styleMap: Record<string, string> = {
    default: '',
    primary: 'ring-2 ring-blue-500',
    error: 'ring-2 ring-red-500',
    warning: 'ring-2 ring-yellow-500',
    success: 'ring-2 ring-green-500',
  }
  
  return {
    base: `handle ${styleMap[handle.style || 'default']}`,
    color: handle.color || colorMap[handle.dataType] || colorMap.any,
    size: 'medium',
    shape: 'circle',
    icon: handle.icon,
  }
}
```

#### Handle Layout

For multiple handles on the same side, distribute evenly:

```typescript
function calculateHandlePosition(
  handle: HandleConfig,
  totalHandles: number,
  side: 'top' | 'bottom' | 'left' | 'right'
): { left?: string; top?: string; right?: string; bottom?: string } {
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
```

### Handle Labels

Show handle names on hover or always visible for important handles:

```tsx
<Handle
  type={handle.type}
  position={Position[handle.position.toUpperCase()]}
  id={handle.id}
  style={calculateHandlePosition(handle, handles.length, handle.position)}
  className={getHandleStyle(handle).base}
>
  {/* Optional: Always-visible label for important handles */}
  {handle.required && (
    <span className="handle-label">{handle.name}</span>
  )}
</Handle>

{/* Tooltip on hover */}
<Tooltip content={handle.description || handle.name}>
  {/* Handle element */}
</Tooltip>
```

### Connection Visual Feedback

1. **Valid Connection**: Green highlight
2. **Invalid Connection**: Red highlight with error message
3. **Type Mismatch Warning**: Yellow highlight with warning
4. **Hover Preview**: Show handle names and types

### Handle Icons

Use icons to indicate handle purpose:
- ✅ Success/True: Checkmark
- ❌ Error/False: X
- ⚠️ Warning: Warning triangle
- 🔄 Loop/Iteration: Circular arrow
- 📊 Data: Chart icon
- 🎯 Main: Dot/Circle

---

## Implementation Plan

### Phase 1: Core Type System

1. **Extend Type Definitions**
   - Add `HandleDataType` type
   - Create `HandleConfig` interface
   - Extend `BlockConfig` with handles

2. **Type Compatibility Logic**
   - Implement `isTypeCompatible()` function
   - Create type compatibility matrix

3. **Handle Configuration Helpers**
   - `getHandleConfig()` - Get handle config from block
   - `getDefaultHandles()` - Generate default handles for legacy blocks

### Phase 2: Validation System

1. **Validation Engine**
   - Implement `validateConnection()` function
   - Add validation hooks to ReactFlow

2. **Real-time Feedback**
   - Visual indicators for valid/invalid connections
   - Error messages and tooltips

### Phase 3: UI Components

1. **Handle Rendering**
   - Update `WorkflowBlock` to render multiple handles
   - Implement handle positioning logic
   - Add handle labels and tooltips

2. **Visual Styling**
   - Color coding by data type
   - Handle icons and styles
   - Connection line styling

### Phase 4: Data Persistence

1. **Serializer Updates**
   - Update `SerializedConnection` to require handle IDs
   - Add handle metadata to serialization

2. **Migration**
   - Migrate existing workflows to new format
   - Default handle IDs for legacy connections

### Phase 5: Advanced Features

1. **Dynamic Handles**
   - Allow runtime handle addition/removal
   - Handle state management

2. **Handle Customization**
   - User-editable handle names (optional)
   - Custom handle colors

---

## Migration Strategy

### Backward Compatibility

1. **Legacy Blocks**
   - Blocks without `handles` config get default handles:
     - One target handle: `id: 'default'`, `name: 'Input'`
     - One source handle: `id: 'default'`, `name: 'Output'`

2. **Legacy Connections**
   - Existing edges without `sourceHandle`/`targetHandle` default to `'default'`
   - Migration script adds default handles to existing workflows

### Migration Script

```typescript
function migrateWorkflow(workflow: SerializedWorkflow): SerializedWorkflow {
  return {
    ...workflow,
    connections: workflow.connections.map(conn => ({
      ...conn,
      sourceHandle: conn.sourceHandle || 'default',
      targetHandle: conn.targetHandle || 'default',
    })),
    blocks: workflow.blocks.map(block => {
      // Add default handles if not present
      if (!block.handles) {
        return {
          ...block,
          handles: {
            sources: block.outputs ? [{
              id: 'default',
              name: 'Output',
              dataType: inferDataType(block.outputs),
            }] : [],
            targets: block.inputs ? [{
              id: 'default',
              name: 'Input',
              dataType: 'any',
            }] : [],
          },
        }
      }
      return block
    }),
  }
}
```

---

## Example Implementations

### Example 1: Simple Block with Default Handles

```typescript
export const SimpleBlock: BlockConfig = {
  type: 'simple',
  name: 'Simple Block',
  // ... other config ...
  // No handles defined - uses defaults:
  // - One target handle (top)
  // - One source handle (bottom)
}
```

### Example 2: Multi-Input Merge Block

```typescript
export const MergeBlock: BlockConfig = {
  type: 'merge',
  name: 'Merge',
  handles: {
    targets: [
      { id: 'input-1', name: 'Input 1', type: 'target', dataType: 'any', position: 'top', index: 0 },
      { id: 'input-2', name: 'Input 2', type: 'target', dataType: 'any', position: 'top', index: 1 },
      { id: 'input-3', name: 'Input 3', type: 'target', dataType: 'any', position: 'top', index: 2 },
    ],
    sources: [
      { id: 'merged', name: 'Merged', type: 'source', dataType: 'json', position: 'bottom' },
    ],
  },
}
```

### Example 3: Conditional Router with Type Restrictions

```typescript
export const RouterBlock: BlockConfig = {
  type: 'router',
  name: 'Router',
  handles: {
    targets: [
      { id: 'input', name: 'Input', type: 'target', dataType: 'any', position: 'top' },
    ],
    sources: [
      {
        id: 'true',
        name: 'True',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
      },
      {
        id: 'false',
        name: 'False',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 1,
        style: 'warning',
      },
    ],
  },
}
```

### Example 4: Error Handler with Strict Types

```typescript
export const ErrorHandlerBlock: BlockConfig = {
  type: 'error-handler',
  name: 'Error Handler',
  handles: {
    targets: [
      {
        id: 'input',
        name: 'Input',
        type: 'target',
        dataType: 'any',
        position: 'top',
      },
    ],
    sources: [
      {
        id: 'success',
        name: 'Success',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
      },
      {
        id: 'error',
        name: 'Error',
        type: 'source',
        dataType: 'error',
        position: 'bottom',
        index: 1,
        style: 'error',
        restrictions: {
          allowedTargetTypes: ['error', 'any'],
          allowedNodeTypes: ['error-handler', 'logger'],
        },
      },
    ],
  },
}
```

---

## Benefits

1. **Flexibility**: Support complex workflows with multiple data paths
2. **Type Safety**: Prevent invalid connections at design time
3. **Clarity**: Named handles make workflows self-documenting
4. **Extensibility**: Easy to add new handle types and restrictions
5. **User Experience**: Visual feedback guides users to create valid workflows
6. **Maintainability**: Clear separation of concerns and well-defined interfaces

---

## Future Enhancements

1. **Dynamic Handles**: Allow blocks to add/remove handles at runtime
2. **Handle Groups**: Group related handles visually
3. **Handle Templates**: Reusable handle configurations
4. **Connection Suggestions**: AI-powered connection recommendations
5. **Handle Validation Rules**: User-defined validation rules
6. **Handle Analytics**: Track connection patterns and usage

---

## Conclusion

This design provides a comprehensive foundation for a multi-handle pipeline editor that:
- Supports complex workflow patterns
- Enforces type safety and connection rules
- Provides clear visual feedback
- Maintains backward compatibility
- Scales to future requirements

The implementation can be done incrementally, starting with core type system and validation, then adding UI enhancements and advanced features.

---

## Appendix: Implementation File Map

### Files Modified

| File | Change |
|------|--------|
| `src/nemo/gui/src/blocks/types.ts` | Extended `BlockConfig` with optional `handles` property |
| `src/nemo/gui/src/components/workflow-block/workflow-block.tsx` | Multi-handle rendering, dynamic positioning, styling, labels |
| `src/nemo/gui/src/components/workflow-editor/hooks/use-workflow-handlers.ts` | Connection validation before adding edges, handle ID usage |
| `src/nemo/gui/src/components/workflow-editor/workflow-content.tsx` | Added `isValidConnection` prop to ReactFlow |
| `src/nemo/gui/src/serializer/index.ts` | Handle ID persistence, backward-compatible defaults |

### Files Created

| File | Purpose |
|------|---------|
| `src/nemo/gui/src/types/handle-system.ts` | `HandleConfig`, `HandleRestrictions`, `ValidationResult` and related type definitions |
| `src/nemo/gui/src/utils/handle-system.ts` | `isTypeCompatible()`, `validateConnection()`, `getHandleConfig()`, `getAllHandles()`, `getHandleStyle()`, `calculateHandlePosition()` |
| `src/nemo/gui/src/components/workflow-editor/hooks/use-connection-validation.ts` | React hook: `isValidConnection()`, `getValidationResult()`, `checkTypeCompatibility()` |
| `src/nemo/gui/src/blocks/blocks/merge-example.ts` | Example block with multiple input handles |
| `src/nemo/gui/src/blocks/blocks/router-example.ts` | Example block with multiple styled output handles |
| `src/nemo/gui/src/blocks/blocks/error-handler-example.ts` | Example block with type restrictions and custom validation |

