/**
 * Example Merge Block - Demonstrates multi-handle system
 * 
 * This is an example implementation showing how to use the new handle system
 * with multiple input handles and custom connection rules.
 * 
 * To use this block, add it to the registry in blocks/registry.ts
 */

import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { FileText as FileTextIcon } from 'lucide-react'

const FileText: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(FileTextIcon, props)

export const MergeExampleBlock: BlockConfig = {
  type: 'merge-example',
  name: 'Merge Example',
  description: 'Example block demonstrating multiple input handles',
  category: 'blocks',
  bgColor: '#8b5cf6',
  icon: FileText,
  subBlocks: [
    {
      id: 'mergeStrategy',
      type: 'dropdown',
      title: 'Merge Strategy',
      options: [
        { label: 'Combine', id: 'combine' },
        { label: 'Append', id: 'append' },
        { label: 'Merge Objects', id: 'merge' },
      ],
      defaultValue: 'combine',
    },
  ],
  tools: {
    access: ['merge'],
  },
  inputs: {
    strategy: { type: 'string', description: 'Merge strategy' },
  },
  outputs: {
    merged: { type: 'json', description: 'Merged data from all inputs' },
  },
  // Multi-handle configuration
  handles: {
    // Multiple input handles
    inputs: [
      {
        id: 'input-1',
        name: 'Input 1',
        description: 'First input stream',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 0,
        required: true,
      },
      {
        id: 'input-2',
        name: 'Input 2',
        description: 'Second input stream',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 1,
        required: true,
      },
      {
        id: 'input-3',
        name: 'Input 3',
        description: 'Third input stream (optional)',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 2,
        required: false,
      },
    ],
    // Single output handle
    outputs: [
      {
        id: 'merged',
        name: 'Merged Output',
        description: 'Combined data from all inputs',
        type: 'source',
        dataType: 'json',
        position: 'bottom',
        index: 0,
      },
    ],
  },
}

