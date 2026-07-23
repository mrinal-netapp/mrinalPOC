import type { TabItem } from "@/ui-lib/base-components/tab/tab";

import type { ModelCatalogItem, ModelProvider } from "./add-model.types";

/** Top-level tab strip on the Add Model page. */
const PROVIDER_TABS: TabItem[] = [
  { id: "providers", label: "Add from providers" },
  { id: "self-hosted", label: "Add self-hosted model" },
];

/**
 * Catalog of provider *types* a user can connect to from the Add Model
 * screen. `provider_id` matches the config-service provider keys
 * (`openai`, `azure`, `aws_bedrock`, `google`, `ollama`) so the selection
 * can be handed straight to the registration write path. TODO(backend):
 * replace with a real provider-catalog endpoint once the model service
 * exposes one (the registry has the keys but no display metadata yet).
 */
const PROVIDER_CATALOG: readonly ModelProvider[] = [
  { provider_id: "openai", name: "OpenAI", capabilities: "Chat, Embeddings", data_residency: "Global" },
  { provider_id: "anthropic", name: "Anthropic", capabilities: "Chat", data_residency: "Global" },
  { provider_id: "azure", name: "Azure OpenAI", capabilities: "Chat, Embeddings", data_residency: "Regional" },
  { provider_id: "aws_bedrock", name: "AWS Bedrock", capabilities: "Chat, Embeddings", data_residency: "Regional" },
  { provider_id: "google", name: "Google Vertex AI", capabilities: "Chat, Embeddings", data_residency: "Regional" },
  { provider_id: "gemini", name: "Google Gemini", capabilities: "Chat, Embeddings", data_residency: "Global" },
  { provider_id: "cohere", name: "Cohere", capabilities: "Chat, Embeddings", data_residency: "Global" },
  { provider_id: "perplexity", name: "Perplexity", capabilities: "Chat", data_residency: "Global" },
  { provider_id: "huggingface", name: "Hugging Face", capabilities: "Chat, Embeddings", data_residency: "Global" },
  { provider_id: "fireworks", name: "Fireworks AI", capabilities: "Chat, Embeddings", data_residency: "Global" },
  { provider_id: "ollama", name: "Ollama", capabilities: "Chat, Embeddings", data_residency: "Global" },
];

/**
 * Fallback model catalog rendered when no provider-specific entry exists
 * in `MODEL_CATALOG_BY_PROVIDER` below. Mirrors the OpenAI / Azure default
 * set from the Figma design.
 */
const DEFAULT_MODEL_CATALOG: readonly ModelCatalogItem[] = [
  { key: "gpt-4-turbo", value: "gpt-4-turbo", label: "GPT-4 Turbo", kind: "llm" },
  { key: "gpt-3.5-turbo", value: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", kind: "llm" },
  { key: "gpt-4o", value: "gpt-4o", label: "GPT-4o", kind: "llm" },
  {
    key: "text-embedding-3-large",
    value: "text-embedding-3-large",
    label: "Text Embedding 3 Large",
    kind: "embedding",
  },
  {
    key: "text-embedding-3-small",
    value: "text-embedding-3-small",
    label: "Text Embedding 3 Small",
    kind: "embedding",
  },
  { key: "gpt-4-vision", value: "gpt-4-vision", label: "GPT-4 Vision", kind: "llm" },
];

/**
 * Per-provider model catalog. Providers not listed here fall back to
 * `DEFAULT_MODEL_CATALOG`. TODO(backend): drop this map once the model
 * service exposes a real catalog endpoint.
 */
const MODEL_CATALOG_BY_PROVIDER: Readonly<Record<string, readonly ModelCatalogItem[]>> = {
  "azure-openai": DEFAULT_MODEL_CATALOG,
  openai: DEFAULT_MODEL_CATALOG,
  anthropic: [
    { key: "claude-3-5-sonnet", value: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet", kind: "llm" },
    {
      key: "embed-v4-placeholder",
      value: "embed-v4-placeholder",
      label: "Embedding model (placeholder)",
      kind: "embedding",
    },
  ],
  "aws-bedrock": [
    { key: "bedrock-claude", value: "bedrock-claude", label: "Claude (Bedrock)", kind: "llm" },
    {
      key: "bedrock-titan-embed",
      value: "bedrock-titan-embed",
      label: "Titan Embeddings (placeholder)",
      kind: "embedding",
    },
  ],
  "vertex-ai": [
    { key: "gemini-1.5-flash", value: "gemini-1.5-flash", label: "Gemini 1.5 Flash", kind: "llm" },
    {
      key: "vertex-text-embedding",
      value: "vertex-text-embedding",
      label: "Text embeddings (placeholder)",
      kind: "embedding",
    },
  ],
};

export {
  DEFAULT_MODEL_CATALOG,
  MODEL_CATALOG_BY_PROVIDER,
  PROVIDER_CATALOG,
  PROVIDER_TABS,
};
