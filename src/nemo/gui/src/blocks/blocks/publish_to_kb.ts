import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Upload as UploadIcon } from 'lucide-react'

const Upload: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(UploadIcon, props)

export const PublishToKbBlock: BlockConfig = {
  type: 'publish_to_kb',
  name: 'Publish to KB',
  description: 'Publish vector data from DataFrame to a knowledge base (vectorDB)',
  longDescription:
    'The Publish to KB block publishes vector data from a DataFrame to a knowledge base (vector database). It takes a DataFrame containing vector embeddings and metadata, and stores them in the specified knowledge base for later retrieval and search.',
  bestPractices: `
  - Ensure the DataFrame contains vector embeddings in the expected format
  - The DataFrame should include columns for vectors and any metadata you want to store
  - Select the target knowledge base that matches your vector dimensions and precision
  - This block is typically used after Generate Embedding block to store the generated vectors
  - The knowledge base must be configured with compatible vector settings
  `,
  category: 'blocks',
  bgColor: '#C026D3', // Fuchsia-600 - AI/ML theme (same as Knowledge block)
  icon: Upload,
  subBlocks: [
    {
      id: 'knowledgeBaseId',
      title: 'Knowledge Base',
      type: 'knowledge-base-selector',
      placeholder: 'Select knowledge base',
      multiSelect: false,
      required: true,
    },
    {
      id: 'vector_column',
      title: 'Vector Column',
      type: 'short-input',
      placeholder: 'Column name containing vector embeddings',
      required: true,
    },
    {
      id: 'metadata_columns',
      title: 'Metadata Columns (Optional)',
      type: 'short-input',
      placeholder: 'Comma-separated column names for metadata (e.g., id,title,content)',
      required: false,
    },
  ],
  tools: {
    access: ['publish_to_kb'],
  },
  inputs: {
    knowledgeBaseId: { type: 'string', description: 'Knowledge base identifier' },
    vector_column: { type: 'string', description: 'Column name containing vector embeddings' },
    metadata_columns: { type: 'string', description: 'Comma-separated list of metadata column names' },
  },
  outputs: {
    success: { type: 'boolean', description: 'Whether the publish operation succeeded' },
    recordsPublished: { type: 'number', description: 'Number of records published to the knowledge base' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame containing vector embeddings and metadata',
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

