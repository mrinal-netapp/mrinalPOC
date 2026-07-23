import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Filter as FilterIcon } from 'lucide-react'

const Filter: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(FilterIcon, props)

export const FilterBlock: BlockConfig = {
  type: 'filter',
  name: 'Filter',
  description: 'Filter records from input DataFrame',
  longDescription:
    'The Filter block filters records from an input DataFrame based on a Python expression. It outputs a filtered DataFrame containing only records that match the filter criteria.',
  bestPractices: `
  - Use Python expression syntax for the filter (e.g., "df['age'] > 18", "df['status'] == 'active'")
  - The expression should evaluate to a boolean Series
  - Use 'include' to keep records that match, 'exclude' to remove records that match
  `,
  category: 'blocks',
  bgColor: '#3B82F6', // Blue-500 - Data Operations theme
  icon: Filter,
  subBlocks: [
    {
      id: 'filter',
      title: 'Filter Expression',
      type: 'code',
      placeholder: 'Enter Python filter expression (e.g., df["age"] > 18)...',
      language: 'python',
      required: true,
    },
    {
      id: 'on_error',
      title: 'On Error',
      type: 'dropdown',
      placeholder: 'Select error handling...',
      options: [
        { label: 'Include', id: 'include' },
        { label: 'Exclude', id: 'exclude' },
      ],
      defaultValue: 'include',
    },
  ],
  tools: {
    access: ['filter'],
  },
  inputs: {
    filter: { type: 'string', description: 'Python expression to filter DataFrame' },
    on_error: { type: 'string', description: 'Error handling: include or exclude records with errors' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'Filtered DataFrame' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame to filter',
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
        description: 'Filtered DataFrame output',
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

