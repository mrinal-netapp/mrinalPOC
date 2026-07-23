import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { FunctionSquare as FunctionSquareIcon } from 'lucide-react'

const FunctionSquare: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(FunctionSquareIcon, props)

export const ApplyFuncBlock: BlockConfig = {
  type: 'apply_func',
  name: 'Apply Func',
  description: 'Apply a function to every record in the DataFrame',
  longDescription:
    'The Apply Func block applies a Python function to every record in the DataFrame. The function should operate on DataFrame rows and return the transformed result.',
  bestPractices: `
  - Write a Python function that operates on DataFrame rows
  - The function should accept a row (or the entire DataFrame) and return the transformed result
  - Use lambda functions or full function definitions
  - Example: lambda row: row['value'] * 2
  `,
  category: 'blocks',
  bgColor: '#2563EB', // Blue-600 - Data Operations theme
  icon: FunctionSquare,
  subBlocks: [
    {
      id: 'function',
      title: 'Function',
      type: 'code',
      placeholder: 'Enter Python function (e.g., lambda row: row["value"] * 2)...',
      language: 'python',
      required: true,
    },
  ],
  tools: {
    access: ['apply_func'],
  },
  inputs: {
    function: { type: 'string', description: 'Python function operating on a DataFrame' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'Transformed DataFrame' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame to apply function to',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 0,
        required: true,
        restrictions: {
          allowedSourceTypes: ['dataframe'],
        },
      },
    ],
    outputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Transformed DataFrame output',
        type: 'source',
        dataType: 'dataframe',
        position: 'bottom',
        index: 0,
        restrictions: {
          allowedTargetTypes: ['dataframe', 'any'],
        },
      },
    ],
  },
}

