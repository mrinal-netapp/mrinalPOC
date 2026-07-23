import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Layers as LayersIcon } from 'lucide-react'

const Layers: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(LayersIcon, props)

export const GroupByAggBlock: BlockConfig = {
  type: 'groupby_agg',
  name: 'GroupBy Agg',
  description: 'Group records and compute aggregate values by group',
  longDescription:
    'The GroupBy Agg block groups records of a DataFrame by a specified field and computes aggregate values for each group using aggregation functions like sum, count, min, max, etc.',
  bestPractices: `
  - Specify the field name to group by
  - Define aggregates as a map of alias names to aggregation expressions
  - Common aggregate functions: sum, count, min, max, mean, std, etc.
  - Aggregate functions can take a parameter specifying what to aggregate (e.g., sum('amount'), count('id'))
  `,
  category: 'blocks',
  bgColor: '#1E3A8A', // Blue-900 - Data Operations theme
  icon: Layers,
  subBlocks: [
    {
      id: 'group_by',
      title: 'Group By Field',
      type: 'short-input',
      placeholder: 'Enter field name to group by...',
      required: true,
    },
    {
      id: 'aggregates',
      title: 'Aggregates',
      type: 'code',
      placeholder: 'Enter aggregates as JSON (e.g., {"total": "sum(amount)", "count": "count(id)"})...',
      language: 'json',
      required: true,
    },
  ],
  tools: {
    access: ['groupby_agg'],
  },
  inputs: {
    group_by: { type: 'string', description: 'Field name to group by' },
    aggregates: { type: 'json', description: 'Map of alias name to aggregation expressions' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'Grouped and aggregated DataFrame' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame to group and aggregate',
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
        description: 'Grouped and aggregated DataFrame output',
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

