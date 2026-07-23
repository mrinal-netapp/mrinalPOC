/**
 * Example Error Handler Block - Demonstrates type restrictions and custom validation
 * 
 * This example shows how to create a block with type-specific handles
 * and connection restrictions.
 */

import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { AlertTriangle as AlertTriangleIcon } from 'lucide-react'

const AlertTriangle: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(AlertTriangleIcon, props)

export const ErrorHandlerExampleBlock: BlockConfig = {
  type: 'error-handler-example',
  name: 'Error Handler Example',
  description: 'Example block demonstrating error handling with type restrictions',
  category: 'blocks',
  bgColor: '#ef4444',
  icon: AlertTriangle,
  subBlocks: [
    {
      id: 'errorAction',
      type: 'dropdown',
      title: 'Error Action',
      options: [
        { label: 'Log', id: 'log' },
        { label: 'Notify', id: 'notify' },
        { label: 'Retry', id: 'retry' },
      ],
      defaultValue: 'log',
    },
  ],
  tools: {
    access: ['error-handler'],
  },
  inputs: {
    action: { type: 'string', description: 'Error handling action' },
  },
  outputs: {
    success: { type: 'any', description: 'Output on successful execution' },
    error: { type: 'json', description: 'Error information' },
  },
  // Multi-handle configuration with restrictions
  handles: {
    inputs: [
      {
        id: 'input',
        name: 'Input',
        description: 'Input to process',
        type: 'target',
        dataType: 'any',
        position: 'top',
        required: true,
      },
    ],
    outputs: [
      {
        id: 'success',
        name: 'Success',
        description: 'Output when execution succeeds',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
        color: '#10b981',
      },
      {
        id: 'error',
        name: 'Error',
        description: 'Output when execution fails',
        type: 'source',
        dataType: 'error',
        position: 'bottom',
        index: 1,
        style: 'error',
        color: '#ef4444',
        // Type restrictions: error output can only connect to error handlers
        restrictions: {
          allowedTargetTypes: ['error', 'any'],
          allowedNodeTypes: ['error-handler', 'logger', 'notify'],
          blockedNodeTypes: ['data-processor', 'transformer'],
          // Custom validator example
          validator: (_sourceHandle, targetHandle) => {
            // Example: Only allow connections to nodes that can handle errors
            if (targetHandle.dataType === 'error' || targetHandle.dataType === 'any') {
              return { valid: true }
            }
            return {
              valid: false,
              reason: 'Error output can only connect to error-handling nodes',
            }
          },
        },
      },
    ],
  },
}

