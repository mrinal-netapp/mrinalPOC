/**
 * Example Router Block - Demonstrates multiple output handles with type restrictions
 * 
 * This example shows how to create a conditional router with multiple outputs
 * and custom styling for different handle types.
 */

import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { GitBranch as GitBranchIcon } from 'lucide-react'

const GitBranch: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(GitBranchIcon, props)

export const RouterExampleBlock: BlockConfig = {
  type: 'router-example',
  name: 'Router Example',
  description: 'Example block demonstrating multiple output handles',
  category: 'blocks',
  bgColor: '#10b981',
  icon: GitBranch,
  subBlocks: [
    {
      id: 'condition',
      type: 'condition-input',
      title: 'Condition',
    },
  ],
  tools: {
    access: ['router'],
  },
  inputs: {
    condition: { type: 'boolean', description: 'Routing condition' },
  },
  outputs: {
    true: { type: 'any', description: 'Output when condition is true' },
    false: { type: 'any', description: 'Output when condition is false' },
  },
  // Multi-handle configuration with styling
  handles: {
    inputs: [
      {
        id: 'input',
        name: 'Input',
        description: 'Input data to route',
        type: 'target',
        dataType: 'any',
        position: 'top',
        required: true,
      },
    ],
    outputs: [
      {
        id: 'true',
        name: 'True',
        description: 'Output when condition evaluates to true',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 0,
        style: 'success',
        color: '#10b981',
      },
      {
        id: 'false',
        name: 'False',
        description: 'Output when condition evaluates to false',
        type: 'source',
        dataType: 'any',
        position: 'bottom',
        index: 1,
        style: 'warning',
        color: '#f59e0b',
      },
    ],
  },
}

