import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Database as DatabaseIcon } from 'lucide-react'

const Database: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(DatabaseIcon, props)

export const SqlBlock: BlockConfig = {
  type: 'sql',
  name: 'SQL Query',
  description: 'Execute SQL queries with dynamic inputs',
  longDescription:
    'Execute SQL queries with syntax highlighting. Connect multiple data sources as inputs and combine them in your SQL query.',
  bestPractices: `
  - Use input handles to connect data sources (tables, datasets, etc.)
  - Reference inputs in your SQL query using the input handle names
  - The query result will be available as the output
  `,
  category: 'blocks',
  bgColor: '#3b82f6', // Blue-500
  icon: Database,
  subBlocks: [
    {
      id: 'query',
      title: 'SQL Query',
      type: 'sql',
      placeholder: 'SELECT * FROM input1\nWHERE column = value',
      description: 'Enter your SQL query. Reference inputs using input handle names (e.g., input1, input2)',
      required: true,
    },
    {
      id: 'inputCount',
      title: 'Number of Inputs',
      type: 'slider',
      min: 1,
      max: 10,
      step: 1,
      value: () => '1',
      description: 'Number of input handles to use (click + button in the block to add more)',
    },
  ],
  tools: {
    access: [],
  },
  inputs: {
    query: { type: 'string', description: 'SQL query to execute' },
    inputCount: { type: 'number', description: 'Number of input handles' },
  },
  outputs: {
    result: {
      type: 'json',
      description: 'Query result as JSON array of rows',
    },
  },
  handles: {
    // Dynamic input handles - will be generated based on inputCount
    // We define up to 10 handles, but only show the ones needed
    inputs: [
      {
        id: 'input-1',
        name: 'Input 1',
        description: 'First data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 0,
        required: true,
      },
      {
        id: 'input-2',
        name: 'Input 2',
        description: 'Second data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 1,
        required: false,
      },
      {
        id: 'input-3',
        name: 'Input 3',
        description: 'Third data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 2,
        required: false,
      },
      {
        id: 'input-4',
        name: 'Input 4',
        description: 'Fourth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 3,
        required: false,
      },
      {
        id: 'input-5',
        name: 'Input 5',
        description: 'Fifth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 4,
        required: false,
      },
      {
        id: 'input-6',
        name: 'Input 6',
        description: 'Sixth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 5,
        required: false,
      },
      {
        id: 'input-7',
        name: 'Input 7',
        description: 'Seventh data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 6,
        required: false,
      },
      {
        id: 'input-8',
        name: 'Input 8',
        description: 'Eighth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 7,
        required: false,
      },
      {
        id: 'input-9',
        name: 'Input 9',
        description: 'Ninth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 8,
        required: false,
      },
      {
        id: 'input-10',
        name: 'Input 10',
        description: 'Tenth data source input',
        type: 'target',
        dataType: 'dataframe',
        position: 'top',
        index: 9,
        required: false,
      },
    ],
    // Single output handle
    outputs: [
      {
        id: 'result',
        name: 'Result',
        description: 'SQL query result as DataFrame',
        type: 'source',
        dataType: 'dataframe',
        position: 'bottom',
        index: 0,
      },
    ],
  },
}

