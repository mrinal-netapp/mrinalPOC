/*
 * Local row shapes for the Providers + Models tables on the Models
 * overview screen. The real shapes will come from the generated types
 * once `/providers` and `/models` land — see the matching TODO(backend)
 * markers in the panel files.
 */

/**
 * Connection health of a model provider. Mirrors the config-service
 * `ProviderConnectionStatus` enum (connected | disconnected | degraded |
 * error) surfaced by `POST /providers/refresh`.
 */
type ProviderHealth = "Healthy" | "Degraded" | "Error" | "Disconnected";

/** One row in the Providers tab. */
type ProviderRow = {
  provider_id: string;
  name: string;
  status: ProviderHealth;
  /** Optional human-readable detail behind a non-healthy status. */
  statusMessage?: string;
  capabilities: string;
  concurrent_requests: number;
  buffer_size: number;
};

/** Lifecycle status of a registered model. */
type ModelStatus = "Active" | "Inactive" | "Failed";

/** High-level categorization of a model. */
type ModelKind = "LLM" | "Embedding" | "Vision" | "Reranker";

/** One row in the Models tab. */
type ModelRow = {
  model_id: string;
  name: string;
  type: ModelKind;
  provider_id: string;
  provider_name: string;
  /** Provider's own model id (e.g. "gpt-4o"); used to resolve list pricing. */
  provider_model_id?: string;
  status: ModelStatus;
  /**
   * Live connection health, derived from the model's provider Bifrost status
   * (the same source the Providers tab uses). Defaults to "Disconnected" until
   * the providers list / Refresh resolves the provider. The Models tab renders
   * this in its Status column.
   */
  connectionStatus?: ProviderHealth;
  /** Optional human-readable detail behind a non-healthy connection status. */
  connectionMessage?: string;
  /**
   * Count of resources (agents, KBs, …) that reference this model, from the
   * list endpoint's `dependentsSummary`. Rendered in the Associated resources
   * column.
   */
  dependentsCount?: number;
  /**
   * Custom input price override, USD per 1M input tokens. Null/undefined means
   * no override — the provider list (catalog) price applies instead.
   */
  inputCostPer1M?: number | null;
  /** Custom output price override, USD per 1M output tokens. Null = use default. */
  outputCostPer1M?: number | null;
  context_window: number;
  version: string;
  description: string;
};

export type { ModelKind, ModelRow, ModelStatus, ProviderHealth, ProviderRow };
