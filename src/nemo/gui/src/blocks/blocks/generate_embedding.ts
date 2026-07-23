import type { BlockConfig, BlockIcon } from '@/blocks/types'
import type { SVGProps } from 'react'
import React from 'react'
import { Sparkles as SparklesIcon } from 'lucide-react'

const Sparkles: BlockIcon = (props: SVGProps<SVGSVGElement>) => React.createElement(SparklesIcon, props)

export const GenerateEmbeddingBlock: BlockConfig = {
  type: 'generate_embedding',
  name: 'Generate Embedding',
  description: 'Generate embedding vectors from text/unstructured content using an embedding model',
  longDescription:
    'The Generate Embedding block creates embedding vectors from text or unstructured content in a DataFrame using a specified embedding model. It takes a DataFrame as input and outputs a DataFrame with the generated embeddings.',
  bestPractices: `
  - Specify the embedding model to use (e.g., text-embedding-ada-002, sentence-transformers/all-MiniLM-L6-v2)
  - Identify the column containing text/unstructured content to embed
  - Set vector dimension to match the embedding model's output dimension (e.g., 384 for all-MiniLM-L6-v2, 1536 for text-embedding-ada-002)
  - Choose precision: float32 for highest accuracy, int16/int8 for reduced storage size
  - The output DataFrame will include the original data plus the generated embedding vectors
  - Ensure your DataFrame contains text data in the specified column
  `,
  category: 'blocks',
  bgColor: '#3B82F6', // Blue-500 - Data Operations theme
  icon: Sparkles,
  subBlocks: [
    {
      id: 'embedding_model',
      title: 'Embedding Model',
      type: 'short-input',
      placeholder: 'e.g., text-embedding-ada-002, sentence-transformers/all-MiniLM-L6-v2',
      required: true,
    },
    {
      id: 'text_column',
      title: 'Text Column',
      type: 'short-input',
      placeholder: 'Column name containing text to embed',
      required: true,
    },
    {
      id: 'vector_dimension',
      title: 'Vector Dimension',
      type: 'short-input',
      placeholder: 'Enter vector dimension (e.g., 384, 768, 1536)',
      required: false,
    },
    {
      id: 'precision',
      title: 'Precision',
      type: 'dropdown',
      placeholder: 'Select precision...',
      options: [
        { label: 'int8', id: 'int8' },
        { label: 'int16', id: 'int16' },
        { label: 'float32', id: 'float32' },
      ],
      defaultValue: 'float32',
      required: false,
    },
  ],
  tools: {
    access: ['generate_embedding'],
  },
  inputs: {
    embedding_model: { type: 'string', description: 'Embedding model identifier' },
    text_column: { type: 'string', description: 'Column name containing text/unstructured content to embed' },
    vector_dimension: { type: 'number', description: 'Vector dimension (number of dimensions in the embedding vector)' },
    precision: { type: 'string', description: 'Precision type: int8, int16, or float32' },
  },
  outputs: {
    dataframe: { type: 'json', description: 'DataFrame with generated embedding vectors' },
  },
  handles: {
    inputs: [
      {
        id: 'dataframe',
        name: 'DataFrame',
        description: 'Input DataFrame containing text/unstructured content',
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
        description: 'Output DataFrame with generated embedding vectors',
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

