/** Shared request bodies for Knowledge Base validator tests (not a test file). */

export function baseKnowledgeBaseCreate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'product-docs-kb',
    description: 'KB for product documentation',
    sourceDataset: 'ds-abc12345',
    embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
    chunkSize: 512,
    vectorSize: 384,
    chunkStrategy: 'fixed',
    chunkOverlap: 50,
    chunkOptions: {},
    indexingMode: 'hybrid',
    quantizationType: 'auto',
    quantizationOptions: {},
    ...overrides,
  };
}
