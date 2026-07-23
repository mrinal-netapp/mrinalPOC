import { useState, useEffect, useMemo, Fragment } from 'react'
import {
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Label,
  MessageBar,
  MessageBarBody,
  Text,
  Checkbox,
} from '@fluentui/react-components'
import { datasetApi, DataSet, CreateKnowledgeBaseRequest, ChunkStrategy, ChunkOptions, IndexingMode, QuantizationType, QuantizationOptions, modelApi, Model } from '../../services/api'

// Chunking strategy configurations
export interface ChunkStrategyConfig {
  id: ChunkStrategy
  displayName: string
  description: string
  parameters: string[]
}

export const CHUNK_STRATEGIES: ChunkStrategyConfig[] = [
  {
    id: 'fixed',
    displayName: 'Fixed Size',
    description: 'Split text into fixed-size character chunks with configurable overlap. Best for general-purpose use.',
    parameters: ['chunkSize', 'chunkOverlap'],
  },
  {
    id: 'sentence',
    displayName: 'Sentence-based',
    description: 'Split on sentence boundaries to preserve semantic meaning. Avoids cutting sentences mid-thought.',
    parameters: ['maxSentences', 'overlapSentences'],
  },
  {
    id: 'recursive',
    displayName: 'Recursive',
    description: 'Try larger delimiters first (paragraphs), then fall back to smaller ones. Good for mixed content.',
    parameters: ['chunkSize'],
  },
  {
    id: 'token',
    displayName: 'Token-based',
    description: 'Split by token count for LLM-optimized retrieval. Best when targeting specific context windows.',
    parameters: ['maxTokens', 'tokenOverlap'],
  },
  {
    id: 'markdown',
    displayName: 'Markdown-aware',
    description: 'Split on markdown headers to preserve document structure. Best for technical documentation.',
    parameters: ['chunkSize', 'splitOnHeaders'],
  },
]

// Default values for each strategy
export const STRATEGY_DEFAULTS: Record<ChunkStrategy, { chunkSize?: number; chunkOverlap?: number; chunkOptions?: ChunkOptions }> = {
  fixed: { chunkSize: 512, chunkOverlap: 50, chunkOptions: {} },
  sentence: { chunkSize: 512, chunkOverlap: 0, chunkOptions: { maxSentences: 5, overlapSentences: 1 } },
  recursive: { chunkSize: 1000, chunkOverlap: 50, chunkOptions: {} },
  token: { chunkSize: 512, chunkOverlap: 0, chunkOptions: { maxTokens: 256, tokenOverlap: 20 } },
  markdown: { chunkSize: 1000, chunkOverlap: 50, chunkOptions: { splitOnHeaders: true } },
}

// Embedding model configurations with their vector sizes and recommended chunk sizes
export interface EmbeddingModelConfig {
  name: string
  displayName: string
  vectorSize: number
  recommendedChunkSize: number
  category: 'balanced' | 'quality' | 'fast' | 'multilingual'
  description: string
  /**
   * True when this row came from the live catalog (modelApi.listEmbedding)
   * but `model.model_info.dimensions` was missing AND no static-catalog
   * match resolved it. The dropdown disables the option and prompts the
   * user to re-register the model with explicit dimensions. After the
   * config-service startup backfill (BuiltinModelsService.backfillEmbedding
   * Dimensions) runs once, this state is empty for any catalog-known
   * model — only truly novel models would surface here.
   */
  unknownDimensions?: boolean
}

export const EMBEDDING_MODELS: EmbeddingModelConfig[] = [
  // Balanced (Speed/Quality)
  {
    name: 'sentence-transformers/all-MiniLM-L6-v2',
    displayName: 'all-MiniLM-L6-v2 (Default)',
    vectorSize: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Fast and good quality, ideal for most use cases',
  },
  {
    name: 'BAAI/bge-small-en-v1.5',
    displayName: 'BGE Small EN v1.5',
    vectorSize: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Better quality than MiniLM, still fast',
  },
  {
    name: 'sentence-transformers/all-MiniLM-L12-v2',
    displayName: 'all-MiniLM-L12-v2',
    vectorSize: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Slightly better than L6, still fast',
  },
  // High Quality
  {
    name: 'BAAI/bge-base-en-v1.5',
    displayName: 'BGE Base EN v1.5',
    vectorSize: 768,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'High quality, recommended for production RAG',
  },
  {
    name: 'sentence-transformers/all-mpnet-base-v2',
    displayName: 'all-mpnet-base-v2',
    vectorSize: 768,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'Best overall quality for semantic search',
  },
  {
    name: 'BAAI/bge-large-en-v1.5',
    displayName: 'BGE Large EN v1.5',
    vectorSize: 1024,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'Top benchmark performer, requires more resources',
  },
  // Fast
  {
    name: 'sentence-transformers/paraphrase-MiniLM-L3-v2',
    displayName: 'paraphrase-MiniLM-L3-v2 (Fastest)',
    vectorSize: 384,
    recommendedChunkSize: 256,
    category: 'fast',
    description: 'Fastest option, good for quick prototyping',
  },
  // Multilingual
  {
    name: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    displayName: 'Multilingual MiniLM L12',
    vectorSize: 384,
    recommendedChunkSize: 512,
    category: 'multilingual',
    description: 'Supports 50+ languages, fast',
  },
  {
    name: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
    displayName: 'Multilingual MPNet Base',
    vectorSize: 768,
    recommendedChunkSize: 512,
    category: 'multilingual',
    description: 'High quality multilingual support',
  },
  // Q&A Optimized
  {
    name: 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1',
    displayName: 'Multi-QA MiniLM L6',
    vectorSize: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Optimized for question-answering tasks',
  },
]

// Indexing mode configurations
export interface IndexingModeConfig {
  id: IndexingMode
  displayName: string
  description: string
}

export const INDEXING_MODES: IndexingModeConfig[] = [
  {
    id: 'hybrid',
    displayName: 'Hybrid Search (Recommended)',
    description: 'Combines semantic and keyword search for best results. Creates both vector and full-text indexes.',
  },
  {
    id: 'semantic',
    displayName: 'Semantic Search Only',
    description: 'Vector similarity search using embeddings. Best for finding conceptually similar content.',
  },
  {
    id: 'fts',
    displayName: 'Full Text Search (BM25)',
    description: 'Traditional keyword-based search with BM25 ranking. Best for exact term matching.',
  },
]

// Quantization type configurations
export interface QuantizationTypeConfig {
  id: QuantizationType
  displayName: string
  description: string
  showOptions: boolean
}

export const QUANTIZATION_TYPES: QuantizationTypeConfig[] = [
  {
    id: 'auto',
    displayName: 'Automatic (Recommended)',
    description: 'System selects the best index type based on KB size. Uses IVF_HNSW_SQ for large KBs, brute-force for small ones.',
    showOptions: false,
  },
  {
    id: 'none',
    displayName: 'None (Exact Search)',
    description: 'No vector index. Highest accuracy but slower for large KBs. Best for small datasets (<10k vectors).',
    showOptions: false,
  },
  {
    id: 'ivf_pq',
    displayName: 'IVF_PQ (Product Quantization)',
    description: 'Inverted File + Product Quantization. Significant compression with minimal accuracy loss. Best for >10k vectors.',
    showOptions: true,
  },
  {
    id: 'scalar',
    displayName: 'Scalar Quantization (IVF_HNSW_SQ)',
    description: 'HNSW graph + scalar quantization (float32 to int8). Best recall/latency trade-off (~1/4 compression).',
    showOptions: true,
  },
  {
    id: 'ivf_rq',
    displayName: 'IVF_RQ (RaBitQ - Maximum Compression)',
    description: 'RaBitQ binary quantization (~1/32 compression). Fastest build, best for large high-dimensional datasets.',
    showOptions: true,
  },
]

// Default quantization options for IVF_PQ
export const DEFAULT_QUANTIZATION_OPTIONS: QuantizationOptions = {
  numPartitions: 256,
  numSubVectors: 96,
}

// Default quantization options for Scalar (IVF_HNSW_SQ)
export const DEFAULT_SCALAR_OPTIONS: QuantizationOptions = {
  efConstruction: 150,
}

// Default quantization options for IVF_RQ (RaBitQ)
export const DEFAULT_IVF_RQ_OPTIONS: QuantizationOptions = {
  numBits: 1,
}

export interface KnowledgeBaseWizardProps {
  step: number
  formData: CreateKnowledgeBaseRequest
  updateFormField: (field: keyof CreateKnowledgeBaseRequest, value: any) => void
  projectId?: string
}

export function KnowledgeBaseWizard({
  step,
  formData,
  updateFormField,
  projectId,
}: KnowledgeBaseWizardProps) {
  const [availableDatasets, setAvailableDatasets] = useState<DataSet[]>([])
  // Unified embedding catalog — fetched from config-service. Falls back to
  // the hardcoded EMBEDDING_MODELS list when the fetch fails (offline dev,
  // pre-Phase-1 deployments, etc.) with a visible MessageBar warning.
  const [catalogModels, setCatalogModels] = useState<Model[] | null>(null)
  const [catalogFetchError, setCatalogFetchError] = useState<string | null>(null)

  // Load datasets for the dropdown
  useEffect(() => {
    if (projectId && step === 2) {
      datasetApi.list(projectId)
        .then((datasets) => {
          setAvailableDatasets(datasets)
        })
        .catch((err) => {
          console.error('Failed to load datasets:', err)
        })
      // Fetch embedding-model catalog. Built-ins are seeded by
      // BuiltinModelsService at project init; user-registered remote models
      // are added via the Models page.
      modelApi
        .listEmbedding(projectId)
        .then((models) => {
          setCatalogModels(models)
          setCatalogFetchError(null)
        })
        .catch((err) => {
          setCatalogFetchError(err?.message || 'Failed to fetch embedding model catalog')
          setCatalogModels(null)
        })
    }
  }, [projectId, step])

  // Project's embedding-model options. Prefer the live catalog from
  // config-service; fall back to the hardcoded list on fetch failure so the
  // wizard never blocks KB creation on an offline gateway.
  const embeddingModelOptions: EmbeddingModelConfig[] = useMemo(() => {
    if (!catalogModels || catalogModels.length === 0) return EMBEDDING_MODELS
    return catalogModels.map((m) => {
      const info = (m.model_info || {}) as Record<string, unknown>
      // No silent 384 default — wrong dimensions corrupt the LanceDB index.
      // The dropdown disables the option when dimensions is unknown so the
      // user can't proceed without first fixing the underlying Model row.
      const dimRaw = typeof info.dimensions === 'number' && info.dimensions > 0
        ? info.dimensions
        : null
      const recChunk = typeof info.recommendedChunkSize === 'number' ? info.recommendedChunkSize : 512
      const category =
        info.category === 'quality' || info.category === 'fast' || info.category === 'multilingual'
          ? (info.category as EmbeddingModelConfig['category'])
          : 'balanced'
      const description = typeof info.description === 'string' ? info.description : ''
      return {
        name: m.name,
        displayName: m.displayName || m.name,
        vectorSize: dimRaw ?? 0,
        recommendedChunkSize: recChunk,
        category,
        description,
        unknownDimensions: dimRaw === null,
      }
    })
  }, [catalogModels])

  // Map a name back to a model row so the wizard can stamp embeddingModelId
  // on the create request — config-service prefers the FK over the legacy
  // name lookup.
  const embeddingModelIdByName: Record<string, string> = useMemo(() => {
    const out: Record<string, string> = {}
    if (catalogModels) for (const m of catalogModels) out[m.name] = m.id
    return out
  }, [catalogModels])

  // Get the selected dataset to check its kind
  const selectedDataset = useMemo(() => {
    return availableDatasets.find((d) => d.id === formData.sourceDataset)
  }, [availableDatasets, formData.sourceDataset])

  // Check if selected dataset is structured
  const isStructuredDataset = selectedDataset?.kind === 'structured'

  // Step 1: Basic Information
  if (step === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Basic Information</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Provide a name and description for your knowledge base.
          </p>
        </div>

        <Field label="Knowledge Base Name" required>
          <Input
            value={formData.name}
            onChange={(e) => updateFormField('name', e.target.value)}
            placeholder="e.g., Product Documentation, Customer Support KB"
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={formData.description || ''}
            onChange={(e) => updateFormField('description', e.target.value)}
            placeholder="Describe what this knowledge base contains and how it will be used... (optional)"
            rows={4}
          />
        </Field>
      </div>
    )
  }

  // Step 2: Configuration
  if (step === 2) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Configuration</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Configure the source dataset, embedding model, and vector settings.
          </p>
        </div>

        <Field label="Source Dataset" required>
          <Dropdown
            placeholder="Select a dataset to use as the source"
            value={formData.sourceDataset || ''}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                updateFormField('sourceDataset', data.optionValue)
                // Clear textColumns when dataset changes
                updateFormField('textColumns', '')
              }
            }}
          >
            {availableDatasets.map((dataset) => (
              <Option key={dataset.id} value={dataset.id} text={`${dataset.name} (${dataset.kind})`}>
                {dataset.name} ({dataset.kind})
              </Option>
            ))}
          </Dropdown>
          {availableDatasets.length === 0 && (
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorPaletteRedForeground1)' }}>
              No datasets available. Please create a dataset first.
            </div>
          )}
        </Field>

        {/* Show info about dataset type */}
        {selectedDataset && (
          <MessageBar intent={isStructuredDataset ? 'info' : 'success'}>
            <MessageBarBody>
              {isStructuredDataset ? (
                <>
                  <strong>Structured Dataset:</strong> This dataset contains tabular data.
                  You must specify which columns to use for text extraction below.
                </>
              ) : (
                <>
                  <strong>Unstructured Dataset:</strong> This dataset contains files (documents, text files).
                  Text will be extracted automatically from the file contents.
                </>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        {/* Text Columns field - only show for structured datasets */}
        {isStructuredDataset && (
          <Field label="Text Columns" required>
            <Input
              value={formData.textColumns || ''}
              onChange={(e) => updateFormField('textColumns', e.target.value)}
              placeholder="e.g., title, content, description"
            />
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              Comma-separated list of column names that contain text to index for semantic search.
              These columns will be combined as "column_name: value" pairs for each row.
            </div>
          </Field>
        )}

        <Field label="Embedding Model" required>
          {catalogFetchError && (
            <MessageBar intent="warning" style={{ marginBottom: 8 }}>
              <MessageBarBody>
                Could not load the live embedding-model catalog ({catalogFetchError}). Falling
                back to a hardcoded list — the model dropdown may be missing user-registered
                remote models. Refresh once config-service is reachable.
              </MessageBarBody>
            </MessageBar>
          )}
          <Dropdown
            placeholder="Select an embedding model"
            value={formData.embeddingModel}
            selectedOptions={formData.embeddingModel ? [formData.embeddingModel] : []}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                updateFormField('embeddingModel', data.optionValue)
                // Stamp the FK so config-service prefers it over the
                // legacy name lookup. Empty when the fallback list (no
                // catalog fetch) was used — config-service handles that
                // via the name-based fallback path.
                const fkId = embeddingModelIdByName[data.optionValue]
                if (fkId) {
                  updateFormField('embeddingModelId', fkId)
                }
                // Auto-populate vectorSize and chunkSize based on selected model
                const selectedModel = embeddingModelOptions.find((m) => m.name === data.optionValue)
                if (selectedModel) {
                  updateFormField('vectorSize', selectedModel.vectorSize)
                  updateFormField('chunkSize', selectedModel.recommendedChunkSize)
                }
              }
            }}
          >
            {/* Group by category — same UX as the pre-port hardcoded list. */}
            {(['balanced', 'quality', 'fast', 'multilingual'] as const).map((cat) => {
              const inCat = embeddingModelOptions.filter((m) => m.category === cat)
              if (inCat.length === 0) return null
              const label =
                cat === 'balanced'
                  ? '--- Balanced (Speed/Quality) ---'
                  : cat === 'quality'
                    ? '--- High Quality ---'
                    : cat === 'fast'
                      ? '--- Fast ---'
                      : '--- Multilingual ---'
              return (
                <Fragment key={cat}>
                  <Option key={`header-${cat}`} disabled text={label}>
                    {label}
                  </Option>
                  {inCat.map((model) => (
                    <Option
                      key={model.name}
                      value={model.name}
                      text={model.displayName}
                      disabled={model.unknownDimensions}
                    >
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <Text weight="semibold">{model.displayName}</Text>
                        {model.unknownDimensions ? (
                          <Text size={200} style={{ color: 'var(--colorPaletteRedForeground1)' }}>
                            Unknown dimensions — re-register this model with model_info.dimensions set
                          </Text>
                        ) : (
                          <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                            {model.vectorSize}d • {model.description}
                          </Text>
                        )}
                      </div>
                    </Option>
                  ))}
                </Fragment>
              )
            })}
          </Dropdown>
          {formData.embeddingModel && (
            <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
              {(() => {
                const model = embeddingModelOptions.find((m) => m.name === formData.embeddingModel)
                if (model) {
                  return (
                    <Text size={200}>
                      <strong>Selected:</strong> {model.description} • Vector size: {model.vectorSize}
                    </Text>
                  )
                }
                return null
              })()}
            </div>
          )}
        </Field>

        {/* Indexing Mode Section */}
        <Field label="Indexing Mode" required>
          <Dropdown
            placeholder="Select an indexing mode"
            value={formData.indexingMode || 'hybrid'}
            selectedOptions={formData.indexingMode ? [formData.indexingMode] : ['hybrid']}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                updateFormField('indexingMode', data.optionValue as IndexingMode)
              }
            }}
          >
            {INDEXING_MODES.map((mode) => (
              <Option key={mode.id} value={mode.id} text={mode.displayName}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <Text weight="semibold">{mode.displayName}</Text>
                  <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                    {mode.description}
                  </Text>
                </div>
              </Option>
            ))}
          </Dropdown>
          {formData.indexingMode && (
            <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
              {(() => {
                const mode = INDEXING_MODES.find((m) => m.id === formData.indexingMode)
                if (mode) {
                  return (
                    <Text size={200}>
                      <strong>Selected:</strong> {mode.description}
                    </Text>
                  )
                }
                return null
              })()}
            </div>
          )}
        </Field>

        {/* Vector Index Section */}
        <Field label="Vector Index">
          <Dropdown
            placeholder="Select vector index type"
            value={formData.quantizationType || 'auto'}
            selectedOptions={formData.quantizationType ? [formData.quantizationType] : ['auto']}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                const quantType = data.optionValue as QuantizationType
                updateFormField('quantizationType', quantType)
                // Set default quantization options based on type
                if (quantType === 'ivf_pq') {
                  updateFormField('quantizationOptions', DEFAULT_QUANTIZATION_OPTIONS)
                } else if (quantType === 'scalar') {
                  updateFormField('quantizationOptions', DEFAULT_SCALAR_OPTIONS)
                } else if (quantType === 'ivf_rq') {
                  updateFormField('quantizationOptions', DEFAULT_IVF_RQ_OPTIONS)
                } else {
                  updateFormField('quantizationOptions', {})
                }
              }
            }}
          >
            {QUANTIZATION_TYPES.map((qtype) => (
              <Option key={qtype.id} value={qtype.id} text={qtype.displayName}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <Text weight="semibold">{qtype.displayName}</Text>
                  <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                    {qtype.description}
                  </Text>
                </div>
              </Option>
            ))}
          </Dropdown>
          {formData.quantizationType && (
            <div style={{ marginTop: '8px', padding: '8px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
              {(() => {
                const qtype = QUANTIZATION_TYPES.find((q) => q.id === formData.quantizationType)
                if (qtype) {
                  return (
                    <Text size={200}>
                      <strong>Selected:</strong> {qtype.description}
                    </Text>
                  )
                }
                return null
              })()}
            </div>
          )}
        </Field>

        {/* IVF_PQ Options */}
        {formData.quantizationType === 'ivf_pq' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: '1px solid var(--colorNeutralStroke1)', borderRadius: '4px' }}>
            <Field label="Num Partitions">
              <Input
                type="number"
                value={(formData.quantizationOptions?.numPartitions ?? 256).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, numPartitions: value })
                  }
                }}
                placeholder="e.g., 256"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Number of Voronoi cells (default: 256)
              </div>
            </Field>

            <Field label="Num Sub-Vectors">
              <Input
                type="number"
                value={(formData.quantizationOptions?.numSubVectors ?? 96).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, numSubVectors: value })
                  }
                }}
                placeholder="e.g., 96"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                PQ sub-vectors for compression (default: 96)
              </div>
            </Field>
          </div>
        )}

        {/* Scalar (IVF_HNSW_SQ) Options */}
        {formData.quantizationType === 'scalar' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: '1px solid var(--colorNeutralStroke1)', borderRadius: '4px' }}>
            <Field label="ef_construction">
              <Input
                type="number"
                value={(formData.quantizationOptions?.efConstruction ?? 150).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, efConstruction: value })
                  }
                }}
                placeholder="e.g., 150"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                HNSW construction parameter (default: 150)
              </div>
            </Field>

            <Field label="m (Connectivity)">
              <Input
                type="number"
                value={(formData.quantizationOptions?.m ?? '').toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, m: value })
                  } else if (e.target.value === '') {
                    const { m: _, ...rest } = formData.quantizationOptions || {}
                    updateFormField('quantizationOptions', rest)
                  }
                }}
                placeholder="Auto"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                HNSW graph connections per node (default: auto)
              </div>
            </Field>

            <Field label="Num Partitions">
              <Input
                type="number"
                value={(formData.quantizationOptions?.numPartitions ?? '').toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, numPartitions: value })
                  } else if (e.target.value === '') {
                    const { numPartitions: _, ...rest } = formData.quantizationOptions || {}
                    updateFormField('quantizationOptions', rest)
                  }
                }}
                placeholder="Auto"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                IVF partitions (default: auto)
              </div>
            </Field>
          </div>
        )}

        {/* IVF_RQ Options */}
        {formData.quantizationType === 'ivf_rq' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: '1px solid var(--colorNeutralStroke1)', borderRadius: '4px' }}>
            <Field label="Num Bits">
              <Input
                type="number"
                value={(formData.quantizationOptions?.numBits ?? 1).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value >= 1 && value <= 8) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, numBits: value })
                  }
                }}
                placeholder="e.g., 1"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Bits per dimension: 1 (standard RaBitQ), 2/4/8 for higher fidelity
              </div>
            </Field>

            <Field label="Num Partitions">
              <Input
                type="number"
                value={(formData.quantizationOptions?.numPartitions ?? '').toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('quantizationOptions', { ...formData.quantizationOptions, numPartitions: value })
                  } else if (e.target.value === '') {
                    const { numPartitions: _, ...rest } = formData.quantizationOptions || {}
                    updateFormField('quantizationOptions', rest)
                  }
                }}
                placeholder="Auto"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                IVF partitions (default: auto)
              </div>
            </Field>
          </div>
        )}

        {/* Chunking Strategy Section */}
        <Field label="Chunking Strategy" required>
          <Dropdown
            placeholder="Select a chunking strategy"
            value={formData.chunkStrategy || 'fixed'}
            selectedOptions={formData.chunkStrategy ? [formData.chunkStrategy] : ['fixed']}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                const strategy = data.optionValue as ChunkStrategy
                updateFormField('chunkStrategy', strategy)
                // Apply strategy defaults
                const defaults = STRATEGY_DEFAULTS[strategy]
                if (defaults.chunkSize) updateFormField('chunkSize', defaults.chunkSize)
                if (defaults.chunkOverlap !== undefined) updateFormField('chunkOverlap', defaults.chunkOverlap)
                if (defaults.chunkOptions) updateFormField('chunkOptions', defaults.chunkOptions)
              }
            }}
          >
            {CHUNK_STRATEGIES.map((strategy) => (
              <Option key={strategy.id} value={strategy.id} text={strategy.displayName}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <Text weight="semibold">{strategy.displayName}</Text>
                  <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                    {strategy.description}
                  </Text>
                </div>
              </Option>
            ))}
          </Dropdown>
        </Field>

        {/* Strategy-specific parameters */}
        {formData.chunkStrategy === 'fixed' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Field label="Chunk Size" required>
              <Input
                type="number"
                value={formData.chunkSize.toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('chunkSize', value)
                  }
                }}
                placeholder="e.g., 512"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Maximum characters per chunk
              </div>
            </Field>

            <Field label="Chunk Overlap">
              <Input
                type="number"
                value={(formData.chunkOverlap ?? 50).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value >= 0) {
                    updateFormField('chunkOverlap', value)
                  }
                }}
                placeholder="e.g., 50"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Characters of overlap between chunks
              </div>
            </Field>
          </div>
        )}

        {formData.chunkStrategy === 'sentence' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Field label="Max Sentences" required>
              <Input
                type="number"
                value={(formData.chunkOptions?.maxSentences ?? 5).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('chunkOptions', { ...formData.chunkOptions, maxSentences: value })
                  }
                }}
                placeholder="e.g., 5"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Maximum sentences per chunk
              </div>
            </Field>

            <Field label="Overlap Sentences">
              <Input
                type="number"
                value={(formData.chunkOptions?.overlapSentences ?? 1).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value >= 0) {
                    updateFormField('chunkOptions', { ...formData.chunkOptions, overlapSentences: value })
                  }
                }}
                placeholder="e.g., 1"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Sentences of overlap between chunks
              </div>
            </Field>
          </div>
        )}

        {formData.chunkStrategy === 'recursive' && (
          <Field label="Max Chunk Size" required>
            <Input
              type="number"
              value={formData.chunkSize.toString()}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10)
                if (!isNaN(value) && value > 0) {
                  updateFormField('chunkSize', value)
                }
              }}
              placeholder="e.g., 1000"
            />
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              Maximum characters per chunk (will try to split on natural boundaries)
            </div>
          </Field>
        )}

        {formData.chunkStrategy === 'token' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Field label="Max Tokens" required>
              <Input
                type="number"
                value={(formData.chunkOptions?.maxTokens ?? 256).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('chunkOptions', { ...formData.chunkOptions, maxTokens: value })
                  }
                }}
                placeholder="e.g., 256"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Maximum tokens per chunk (LLM-aligned)
              </div>
            </Field>

            <Field label="Token Overlap">
              <Input
                type="number"
                value={(formData.chunkOptions?.tokenOverlap ?? 20).toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value >= 0) {
                    updateFormField('chunkOptions', { ...formData.chunkOptions, tokenOverlap: value })
                  }
                }}
                placeholder="e.g., 20"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Tokens of overlap between chunks
              </div>
            </Field>
          </div>
        )}

        {formData.chunkStrategy === 'markdown' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <Field label="Max Chunk Size" required>
              <Input
                type="number"
                value={formData.chunkSize.toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('chunkSize', value)
                  }
                }}
                placeholder="e.g., 1000"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Maximum characters per chunk
              </div>
            </Field>

            <Checkbox
              checked={formData.chunkOptions?.splitOnHeaders ?? true}
              onChange={(_, data) => {
                updateFormField('chunkOptions', { ...formData.chunkOptions, splitOnHeaders: data.checked === true })
              }}
              label="Split on markdown headers (##, ###)"
            />
          </div>
        )}

        {/* Show chunk size and overlap for strategies that don't have custom UI but still use them */}
        {!formData.chunkStrategy && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <Field label="Chunk Size" required>
              <Input
                type="number"
                value={formData.chunkSize.toString()}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10)
                  if (!isNaN(value) && value > 0) {
                    updateFormField('chunkSize', value)
                  }
                }}
                placeholder="e.g., 512"
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Number of characters per chunk (auto-suggested based on model)
              </div>
            </Field>

            <Field label="Vector Size">
              <Input
                type="number"
                value={formData.vectorSize.toString()}
                disabled
                style={{ backgroundColor: 'var(--colorNeutralBackground2)' }}
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Automatically set by the embedding model
              </div>
            </Field>
          </div>
        )}

        {/* Vector Size - always show */}
        <Field label="Vector Size">
          <Input
            type="number"
            value={formData.vectorSize.toString()}
            disabled
            style={{ backgroundColor: 'var(--colorNeutralBackground2)' }}
          />
          <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
            Automatically set by the embedding model
          </div>
        </Field>
      </div>
    )
  }

  // Step 3: Review
  if (step === 3) {
    const reviewSelectedDataset = availableDatasets.find((d) => d.id === formData.sourceDataset)
    const reviewIsStructured = reviewSelectedDataset?.kind === 'structured'
    const selectedStrategy = CHUNK_STRATEGIES.find((s) => s.id === formData.chunkStrategy)

    // Helper to get chunking parameters display
    const getChunkingParamsDisplay = () => {
      const strategy = formData.chunkStrategy || 'fixed'
      switch (strategy) {
        case 'fixed':
          return `Size: ${formData.chunkSize} chars, Overlap: ${formData.chunkOverlap ?? 50} chars`
        case 'sentence':
          return `Max: ${formData.chunkOptions?.maxSentences ?? 5} sentences, Overlap: ${formData.chunkOptions?.overlapSentences ?? 1} sentences`
        case 'recursive':
          return `Max size: ${formData.chunkSize} chars`
        case 'token':
          return `Max: ${formData.chunkOptions?.maxTokens ?? 256} tokens, Overlap: ${formData.chunkOptions?.tokenOverlap ?? 20} tokens`
        case 'markdown':
          return `Max size: ${formData.chunkSize} chars, Split on headers: ${formData.chunkOptions?.splitOnHeaders !== false ? 'Yes' : 'No'}`
        default:
          return `Size: ${formData.chunkSize} chars`
      }
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Review</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Please review your knowledge base configuration before creating it.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '8px' }}>
          <div>
            <Label weight="semibold">Name</Label>
            <div style={{ marginTop: '4px' }}>{formData.name}</div>
          </div>

          {formData.description && (
            <div>
              <Label weight="semibold">Description</Label>
              <div style={{ marginTop: '4px' }}>{formData.description}</div>
            </div>
          )}

          <div>
            <Label weight="semibold">Source Dataset</Label>
            <div style={{ marginTop: '4px' }}>
              {reviewSelectedDataset ? (
                <>
                  {reviewSelectedDataset.name}{' '}
                  <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                    ({reviewSelectedDataset.kind})
                  </span>
                </>
              ) : (
                formData.sourceDataset
              )}
            </div>
          </div>

          {/* Show Text Columns for structured datasets */}
          {reviewIsStructured && formData.textColumns && (
            <div>
              <Label weight="semibold">Text Columns</Label>
              <div style={{ marginTop: '4px' }}>{formData.textColumns}</div>
            </div>
          )}

          <div>
            <Label weight="semibold">Embedding Model</Label>
            <div style={{ marginTop: '4px' }}>{formData.embeddingModel}</div>
          </div>

          <div>
            <Label weight="semibold">Indexing Mode</Label>
            <div style={{ marginTop: '4px' }}>
              {INDEXING_MODES.find((m) => m.id === formData.indexingMode)?.displayName || 'Hybrid Search'}
            </div>
          </div>

          <div>
            <Label weight="semibold">Vector Index</Label>
            <div style={{ marginTop: '4px' }}>
              {QUANTIZATION_TYPES.find((q) => q.id === formData.quantizationType)?.displayName || 'Automatic (Recommended)'}
              {formData.quantizationType === 'ivf_pq' && formData.quantizationOptions && (
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {' '}(Partitions: {formData.quantizationOptions.numPartitions ?? 256}, Sub-vectors: {formData.quantizationOptions.numSubVectors ?? 96})
                </span>
              )}
              {formData.quantizationType === 'scalar' && formData.quantizationOptions && (
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {' '}(ef_construction: {formData.quantizationOptions.efConstruction ?? 150}{formData.quantizationOptions.m ? `, m: ${formData.quantizationOptions.m}` : ''}{formData.quantizationOptions.numPartitions ? `, Partitions: ${formData.quantizationOptions.numPartitions}` : ''})
                </span>
              )}
              {formData.quantizationType === 'ivf_rq' && formData.quantizationOptions && (
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {' '}(Bits: {formData.quantizationOptions.numBits ?? 1}{formData.quantizationOptions.numPartitions ? `, Partitions: ${formData.quantizationOptions.numPartitions}` : ''})
                </span>
              )}
            </div>
          </div>

          <div>
            <Label weight="semibold">Chunking Strategy</Label>
            <div style={{ marginTop: '4px' }}>
              {selectedStrategy?.displayName || 'Fixed Size'}{' '}
              <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                ({getChunkingParamsDisplay()})
              </span>
            </div>
          </div>

          <div>
            <Label weight="semibold">Vector Size</Label>
            <div style={{ marginTop: '4px' }}>{formData.vectorSize} dimensions</div>
          </div>
        </div>
      </div>
    )
  }

  return null
}
