import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Database as DatabaseIcon } from 'lucide-react'

const Database: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(DatabaseIcon, props)

export const DatasetReaderBlock: BlockConfig = {
  type: 'dataset_reader',
  name: 'Dataset Reader',
  description: 'Read data from Dataset (Iceberg table) as DataFrames',
  longDescription:
    'The Dataset Reader block reads data from a Dataset (stored as an Iceberg table in the catalog) as DataFrames. It accepts any input type and outputs a DataFrame that can be processed by downstream data pipeline blocks. The dataset is automatically resolved to its catalog table reference.',
  bestPractices: `
  - Select a dataset that contains the data you want to process
  - The output DataFrame can be connected to Filter, Join, GroupBy, ApplyFunc, or Dataset Writer blocks
  `,
  category: 'blocks',
  bgColor: '#2563EB', // Blue-600 - Data Operations theme
  icon: Database,
  subBlocks: [
    {
      id: 'dataset_id',
      title: 'Dataset ID',
      type: 'short-input',
      placeholder: 'Select or enter dataset ID...',
      required: true,
      connectionDroppable: false,
    },
  ],
  tools: {
    access: ['dataset_reader'],
  },
  inputs: {
    dataset_id: { type: 'string', description: 'Dataset ID to read from' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'DataFrame containing the dataset data' },
  },
  handles: {
    inputs: [
      {
        id: 'input',
        name: 'Input',
        description: 'Any input type',
        type: 'target',
        dataType: 'any',
        position: 'top',
        index: 0,
        required: false,
      },
    ],
    outputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Output DataFrame',
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

