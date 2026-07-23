import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { GitMerge as GitMergeIcon } from 'lucide-react'

const GitMerge: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(GitMergeIcon, props)

export const JoinBlock: BlockConfig = {
  type: 'join',
  name: 'Join',
  description: 'Join 2 DataFrames to output a single joined DataFrame',
  longDescription:
    'The Join block combines two DataFrames based on specified join fields and join type. It supports equal, left, and right joins.',
  bestPractices: `
  - Specify join fields from both input DataFrames (L and R)
  - Choose join type: equal (inner join), left (left outer join), or right (right outer join)
  - Ensure join fields have compatible data types
  `,
  category: 'blocks',
  bgColor: '#1E40AF', // Blue-800 - Data Operations theme
  icon: GitMerge,
  subBlocks: [
    {
      id: 'join_fields',
      title: 'Join Fields',
      type: 'long-input',
      placeholder: 'Enter join field mapping (e.g., L.field1:R.field2)...',
      required: true,
      rows: 3,
    },
    {
      id: 'join_type',
      title: 'Join Type',
      type: 'dropdown',
      placeholder: 'Select join type...',
      options: [
        { label: 'Equal (Inner Join)', id: 'equal' },
        { label: 'Left (Left Outer Join)', id: 'left' },
        { label: 'Right (Right Outer Join)', id: 'right' },
      ],
      defaultValue: 'equal',
    },
  ],
  tools: {
    access: ['join'],
  },
  inputs: {
    join_fields: { type: 'string', description: 'Join field mapping from input L and R (e.g., L.field1:R.field2)' },
    join_type: { type: 'string', description: 'Join type: equal, left, or right' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'Joined DataFrame' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe_a',
        name: 'DataFrame L',
        description: 'Left input DataFrame',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 0,
        required: true,
        restrictions: {
          allowedSourceTypes: ['dataframe'],
        },
      },
      {
        id: 'dataframe_b',
        name: 'DataFrame R',
        description: 'Right input DataFrame',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 1,
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
        description: 'Joined DataFrame output',
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

