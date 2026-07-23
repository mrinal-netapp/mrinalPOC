import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Save as SaveIcon } from 'lucide-react'

const Save: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(SaveIcon, props)

export const DatasetWriterBlock: BlockConfig = {
  type: 'dataset_writer',
  name: 'Dataset Writer',
  description: 'Write DataFrame to Dataset (Iceberg table)',
  longDescription:
    'The Dataset Writer block writes a DataFrame to a Dataset (stored as an Iceberg table in the catalog). The dataset will be auto-registered as an Iceberg table when the pipeline is deployed. It supports append mode (add to existing data) or overwrite mode (replace data). Iceberg handles versioning automatically through snapshots.',
  bestPractices: `
  - Select the target bucket and provide a dataset name
  - The dataset will be automatically registered when the pipeline is deployed
  - Use 'append' mode to add data to existing dataset
  - Use 'new_version' mode to create a new version of the dataset
  - Ensure the DataFrame schema is compatible with the dataset
  `,
  category: 'blocks',
  bgColor: '#1D4ED8', // Blue-700 - Data Operations theme
  icon: Save,
  subBlocks: [
    {
      id: 'bucket',
      title: 'Bucket',
      type: 'short-input',
      placeholder: 'Enter bucket name...',
      required: true,
      connectionDroppable: false,
    },
    {
      id: 'dataset_name',
      title: 'Dataset Name',
      type: 'short-input',
      placeholder: 'Enter dataset name...',
      required: true,
      connectionDroppable: false,
    },
    {
      id: 'write_mode',
      title: 'Write Mode',
      type: 'dropdown',
      placeholder: 'Select write mode...',
      options: [
        { label: 'Append', id: 'append' },
        { label: 'Overwrite', id: 'overwrite' },
      ],
      defaultValue: 'append',
    },
  ],
  tools: {
    access: ['dataset_writer'],
  },
  inputs: {
    bucket: { type: 'string', description: 'Bucket name where dataset will be stored' },
    dataset_name: { type: 'string', description: 'Name of the dataset to create/use' },
    write_mode: { type: 'string', description: 'Write mode: append or new_version' },
  },
  outputs: {
    success: { type: 'boolean', description: 'Whether the write operation succeeded' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame to write',
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
    // No output handles - this is a terminal block
    outputs: [],
  },
}

