/**
 * Canonical list of system-managed built-in embedding models.
 *
 * Built-ins are seeded as Model rows in every project at init time, served
 * by an in-cluster Text Embeddings Inference (TEI) Deployment, and fronted
 * by Bifrost so consumers (kb-processor, kb-retrieval-service) hit a single
 * `/litellm/v1/embeddings` endpoint regardless of whether the model is local
 * or remote.
 *
 * To add a new built-in:
 *   1. Add an entry below with the HuggingFace model id, dimensions, etc.
 *   2. Add a matching TEI Deployment in
 *      `deployments/helm/services/charts/text-embeddings-inference/values.yaml`
 *      (one Deployment per model — TEI runs one model per process).
 *   3. Restart config-service so the startup backfill seeds the new row
 *      and registers it with Bifrost across all existing projects.
 *
 * Keep in sync with `KB_EMBEDDING_MODEL_OPTIONS` in agent-studio-ui
 * (`kb-form.consts.ts`) — those dropdown entries are platform models, not
 * per-project registrations.
 *
 * The kb-retrieval-service reads the `providerModelId` from a KB's LanceDB
 * `metadata.json` at query time, so KBs created with a given model continue
 * to work after the catalog list changes.
 */

export interface BuiltinEmbeddingModel {
  /** Stable identifier — also used as the Bifrost-side `model_name`. */
  name: string;
  /** Display label for the wizard / models page. */
  displayName: string;
  /** Hugging Face model id, passed to TEI via `--model-id`. */
  providerModelId: string;
  /**
   * In-cluster TEI Service name (without the protocol/port) that serves this
   * model. Joined with TEI_BASE_URL_TEMPLATE at registration time.
   * Must match the Helm model `key` as `tei-<key>`.
   */
  teiServiceName: string;
  dimensions: number;
  recommendedChunkSize: number;
  category: 'balanced' | 'quality' | 'fast' | 'multilingual';
  description: string;
}

/** Shared TEI Helm model `key` → catalog row. Keys must match values.yaml. */
function teiService(key: string): string {
  return `tei-${key}`;
}

/**
 * Platform embedding catalog. Every entry requires a matching TEI Deployment
 * in the text-embeddings-inference chart; without it, Bifrost registration
 * succeeds but inference returns upstream errors.
 */
export const BUILTIN_EMBEDDING_MODELS: BuiltinEmbeddingModel[] = [
  {
    name: 'sentence-transformers/all-MiniLM-L6-v2',
    displayName: 'all-MiniLM-L6-v2 (Default)',
    providerModelId: 'sentence-transformers/all-MiniLM-L6-v2',
    teiServiceName: teiService('minilm'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Fast and good quality, ideal for most use cases',
  },
  {
    name: 'BAAI/bge-small-en-v1.5',
    displayName: 'BGE Small EN v1.5',
    providerModelId: 'BAAI/bge-small-en-v1.5',
    teiServiceName: teiService('bge-small-en-v1-5'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Higher retrieval quality than MiniLM at the same 384-dim vector size',
  },
  {
    name: 'sentence-transformers/all-MiniLM-L12-v2',
    displayName: 'all-MiniLM-L12-v2',
    providerModelId: 'sentence-transformers/all-MiniLM-L12-v2',
    teiServiceName: teiService('all-minilm-l12-v2'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Better quality than MiniLM L6, still fast',
  },
  {
    name: 'BAAI/bge-base-en-v1.5',
    displayName: 'BGE Base EN v1.5',
    providerModelId: 'BAAI/bge-base-en-v1.5',
    teiServiceName: teiService('bge-base-en-v1-5'),
    dimensions: 768,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'Strong English retrieval quality with 768-dim vectors',
  },
  {
    name: 'sentence-transformers/all-mpnet-base-v2',
    displayName: 'all-mpnet-base-v2',
    providerModelId: 'sentence-transformers/all-mpnet-base-v2',
    teiServiceName: teiService('all-mpnet-base-v2'),
    dimensions: 768,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'High-quality general-purpose English embeddings',
  },
  {
    name: 'BAAI/bge-large-en-v1.5',
    displayName: 'BGE Large EN v1.5',
    providerModelId: 'BAAI/bge-large-en-v1.5',
    teiServiceName: teiService('bge-large-en-v1-5'),
    dimensions: 1024,
    recommendedChunkSize: 512,
    category: 'quality',
    description: 'Best built-in English quality; 1024-dim vectors trade storage for accuracy',
  },
  {
    name: 'sentence-transformers/paraphrase-MiniLM-L3-v2',
    displayName: 'paraphrase-MiniLM-L3-v2 (Fastest)',
    providerModelId: 'sentence-transformers/paraphrase-MiniLM-L3-v2',
    teiServiceName: teiService('paraphrase-minilm-l3-v2'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'fast',
    description: 'Smallest and fastest built-in; good for low-latency workloads',
  },
  {
    name: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    displayName: 'Multilingual MiniLM L12',
    providerModelId: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    teiServiceName: teiService('paraphrase-multilingual-minilm-l12-v2'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'multilingual',
    description: 'Compact multilingual embeddings for mixed-language corpora',
  },
  {
    name: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
    displayName: 'Multilingual MPNet Base',
    providerModelId: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
    teiServiceName: teiService('paraphrase-multilingual-mpnet-base-v2'),
    dimensions: 768,
    recommendedChunkSize: 512,
    category: 'multilingual',
    description: 'Higher-quality multilingual embeddings',
  },
  {
    name: 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1',
    displayName: 'Multi-QA MiniLM L6',
    providerModelId: 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1',
    teiServiceName: teiService('multi-qa-minilm-l6-cos-v1'),
    dimensions: 384,
    recommendedChunkSize: 512,
    category: 'balanced',
    description: 'Optimized for question-answer and FAQ-style retrieval',
  },
];

/**
 * Default TEI endpoint template. The TEI chart deploys each model as
 * `tei-<key>` in the services-tier namespace; service port is 80.
 */
export const TEI_BASE_URL_TEMPLATE =
  process.env.TEI_BASE_URL_TEMPLATE || 'http://{service}.{namespace}.svc.cluster.local:80/v1';

/**
 * Resolve the namespace where TEI Deployments live. Precedence:
 *   1. Explicit arg (used by tests and overrides)
 *   2. `TEI_NAMESPACE` env (operator-set override when TEI is in a different
 *      namespace than config-service)
 *   3. `K8S_NAMESPACE` env (the config-service chart sets this — same value
 *      as `nemo.namespace` helper, which is .Release.Namespace)
 *   4. `NAMESPACE` env (legacy compat with deployments that set this)
 *   5. `agentstudio-services` (matches the TEI chart's namespace default
 *      and the services umbrella's namespace convention)
 *
 * The previous default `agentstudio` was wrong — no chart ever deployed
 * to that namespace. Built-in registration was silently computing URLs
 * to a non-existent namespace.
 */
export function buildTeiEndpoint(
  serviceName: string,
  namespace: string = process.env.TEI_NAMESPACE ||
    process.env.K8S_NAMESPACE ||
    process.env.NAMESPACE ||
    'agentstudio-services',
): string {
  return TEI_BASE_URL_TEMPLATE.replace('{service}', serviceName).replace('{namespace}', namespace);
}
