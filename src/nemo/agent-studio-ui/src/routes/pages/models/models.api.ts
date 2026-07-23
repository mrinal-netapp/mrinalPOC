import { apiSlice } from "@/api/api.slice";
import type { PaginatedResponse } from "@/api/api.types";
import type { DependentsPage } from "@/routes/pages/agents/api/agents-config.types";

import type {
  ModelListItem,
  ModelListParams,
  ProviderListItem,
  ProviderListParams,
} from "./models.api.types";

export type ListModelDependentsParams = {
  projectId: string;
  modelId: string;
  limit?: number;
  cursor?: string;
  kind?: string;
};

// Models-page queries. Injected into the shared `apiSlice`.
//
// Backend endpoints (config-service, routed through the apigateway `/config/*`
// mount which strips `/config` before forwarding):
//   - `GET /api/v1/projects/{projectId}/models`     — registered models
//   - `GET /api/v1/projects/{projectId}/providers`  — configured providers
//
// Both backend handlers predate the paginated table contract: `/models`
// returns a bare `Model[]` array and `/providers` returns
// `{ success, providers, total }`. `transformResponse` normalizes either
// shape (plus the already-paginated `{ data }` shape used by unit-test
// fixtures) into the `PaginatedResponse` the tables consume, so the panels
// can rely on `result.data` and `providesTags` never dereferences `undefined`.
// projectId comes from the active project context — call sites must pass it.

/** Friendly provider labels keyed by the backend `provider` / `providerId`. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  openai_compatible: "OpenAI-compatible",
  anthropic: "Anthropic",
  aws_bedrock: "AWS Bedrock",
  bedrock: "AWS Bedrock",
  azure: "Azure OpenAI",
  google: "Google Vertex AI",
  gemini: "Google Gemini",
  ollama: "Ollama",
  local: "Local",
};

function providerLabel(providerId: string | undefined | null): string {
  if (!providerId) return "—";
  return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

function makePagination(total: number) {
  return { limit: total, offset: 0, total_count: total };
}

/** Raw row from the config-service `GET /models` array response. */
type RawModel = {
  id?: string;
  model_id?: string;
  name?: string;
  displayName?: string;
  provider?: string;
  provider_id?: string;
  provider_name?: string;
  providerModelId?: string;
  modelType?: string;
  type?: string;
  modelClass?: string;
  status?: string;
  description?: string;
  // Per-model custom pricing overrides (USD per 1M tokens). Null/absent means
  // the provider list (catalog) price applies. Spread onto the list rows by
  // the config-service `GET /models` handler.
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
  // Dependents rollup the list endpoint attaches by default
  // (`?include=dependentsSummary`). `total` is the associated-resources count.
  dependentsSummary?: { total?: number; byKind?: Record<string, number> };
  // System-managed built-ins (in-cluster TEI embedding models seeded per
  // project by config-service's BuiltinModelsService, `isBuiltin: true`).
  // They are read-only (the backend blocks edit/delete) and are an
  // implementation detail of KB embedding, so the overview hides them.
  isBuiltin?: boolean;
};

function mapModelRow(raw: RawModel): ModelListItem {
  const providerId = raw.provider_id ?? raw.provider ?? "";
  const isEmbedding = (raw.modelType ?? raw.type ?? "").toLowerCase().includes("embed");
  return {
    model_id: raw.model_id ?? raw.id ?? "",
    name: raw.displayName ?? raw.name ?? "",
    type: isEmbedding ? "Embedding" : "LLM",
    provider_id: providerId,
    provider_name: raw.provider_name ?? providerLabel(providerId),
    provider_model_id: raw.providerModelId ?? undefined,
    status: (raw.status as ModelListItem["status"]) ?? "Active",
    dependentsCount: raw.dependentsSummary?.total ?? 0,
    inputCostPer1M: typeof raw.inputCostPer1M === "number" ? raw.inputCostPer1M : null,
    outputCostPer1M: typeof raw.outputCostPer1M === "number" ? raw.outputCostPer1M : null,
    context_window: 0,
    version: "",
    description: raw.description ?? "",
  };
}

/** Raw row from the config-service `GET /providers` `providers[]` response. */
type RawProvider = {
  providerId?: string;
  provider_id?: string;
  name?: string;
  connectionStatus?: string;
  status?: string;
  statusMessage?: string | null;
  status_message?: string | null;
  concurrency?: number;
  concurrent_requests?: number;
  bufferSize?: number;
  buffer_size?: number;
  capabilities?: string;
};

/**
 * Map the config-service `ProviderConnectionStatus` (connected | degraded |
 * error | disconnected) onto the four UI health states. Legacy/unknown values
 * fall back to "Disconnected" so the table never renders an undefined visual.
 */
function mapConnectionStatus(connection: string): ProviderListItem["status"] {
  switch (connection.toLowerCase()) {
    case "connected":
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

// System-managed built-in embedding providers are the in-cluster TEI ones
// config-service creates via `builtinGatewayProviderName()` as
// `as-<teiServiceName>` (always `as-tei-*`). They back only the hidden
// built-in models, so keep them out of the Providers overview as well.
const BUILTIN_PROVIDER_PREFIX = "as-tei-";

function isBuiltinProvider(raw: RawProvider): boolean {
  const id = raw.provider_id ?? raw.providerId ?? "";
  return id.startsWith(BUILTIN_PROVIDER_PREFIX);
}

function mapProviderRow(raw: RawProvider): ProviderListItem {
  const providerId = raw.provider_id ?? raw.providerId ?? "";
  const connection = raw.connectionStatus ?? raw.status ?? "";
  const message = raw.statusMessage ?? raw.status_message ?? undefined;
  return {
    provider_id: providerId,
    name: raw.name ?? providerLabel(providerId),
    status: mapConnectionStatus(connection),
    statusMessage: message ?? undefined,
    capabilities: raw.capabilities ?? "LLM, Embedding",
    concurrent_requests: raw.concurrent_requests ?? raw.concurrency ?? 0,
    buffer_size: raw.buffer_size ?? raw.bufferSize ?? 0,
  };
}

function toModelsPage(raw: unknown): PaginatedResponse<ModelListItem> {
  if (Array.isArray(raw)) {
    // Exclude system-managed built-ins (isBuiltin=true) — these are the
    // default embedding models config-service seeds onto the project VK at
    // creation time; users can't edit/delete them and only ever consume them
    // implicitly via KB creation, so they shouldn't clutter the overview.
    const data = raw
      .filter((r) => !(r as RawModel).isBuiltin)
      .map((r) => mapModelRow(r as RawModel));
    return { data, pagination: makePagination(data.length) };
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return raw as PaginatedResponse<ModelListItem>;
  }
  return { data: [], pagination: makePagination(0) };
}

function toProvidersPage(raw: unknown): PaginatedResponse<ProviderListItem> {
  if (raw && typeof raw === "object" && Array.isArray((raw as { providers?: unknown }).providers)) {
    const data = (raw as { providers: RawProvider[] }).providers
      .filter((p) => !isBuiltinProvider(p))
      .map(mapProviderRow);
    return { data, pagination: makePagination(data.length) };
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return raw as PaginatedResponse<ProviderListItem>;
  }
  if (Array.isArray(raw)) {
    const data = (raw as RawProvider[])
      .filter((r) => !isBuiltinProvider(r))
      .map((r) => mapProviderRow(r));
    return { data, pagination: makePagination(data.length) };
  }
  return { data: [], pagination: makePagination(0) };
}

/**
 * Body for `POST /models`. `modelType` is the gateway routing class; the
 * Azure `api_version` is read from the credential's metadata server-side, so
 * it is not part of this payload.
 */
export type CreateModelRequest = {
  name: string;
  provider?: string;
  credentialId?: string;
  providerModelId?: string;
  modelType?: "llm" | "embedding";
  endpoint?: string;
  // Per-model budget + rate limit. config-service persists these and syncs
  // them to Bifrost as a model-config (scope=virtual_key) on registration.
  rpm?: number;
  tpm?: number;
  spendingLimit?: number;
  spendingLimitPeriod?: "day" | "week" | "month";
  // Per-model rate-card / pricing overrides (persisted; not sent to Bifrost).
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  markupPercent?: number;
  // Optional gateway proxy controls persisted on provider config + cache.
  concurrentRequests?: number;
  bufferSize?: number;
};

export type ModelEditResponse = {
  id: string;
  name: string;
  /** config-service provider id (e.g. "openai"); used to resolve list pricing. */
  provider?: string;
  /** Provider's own model id (e.g. "gpt-4o"); used to resolve list pricing. */
  providerModelId?: string;
  rpm?: number;
  tpm?: number;
  spendingLimit?: number;
  spendingLimitPeriod?: "day" | "week" | "month";
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  markupPercent?: number;
  concurrentRequests?: number;
  bufferSize?: number;
};

export type UpdateModelRequest = {
  name: string;
  rpm?: number | null;
  tpm?: number | null;
  spendingLimit?: number | null;
  spendingLimitPeriod?: "day" | "week" | "month" | null;
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
  markupPercent?: number | null;
  concurrentRequests?: number | null;
  bufferSize?: number | null;
};

/**
 * Body for `PUT /providers/:providerId`. Edits the provider's gateway proxy
 * tuning (concurrency + buffer size) from the Providers overview. Field names
 * mirror `CreateModelRequest` so the backend parses both consistently.
 */
export type UpdateProviderRequest = {
  concurrentRequests: number;
  bufferSize: number;
};

/** Normalized model offered by a provider (from `POST /models/list-available`). */
export type AvailableModel = {
  id: string;
  name: string;
  type: "llm" | "embedding";
};

/**
 * Default (list) pricing for a provider model, per 1M tokens, sourced from the
 * Bifrost Model Catalog datasheet via `GET /models/pricing-defaults`. `null`
 * fields mean the catalog has no entry (custom/self-hosted/new models). This is
 * the provider list price — not the project's negotiated/effective rate.
 */
export type ModelPricingDefaults = {
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  source: "datasheet" | "builtin" | null;
  /** Catalog id that answered; differs from the query when matched loosely. */
  matchedModel: string | null;
  /** True when resolved via normalization/prefix match, not an exact id hit. */
  approximate: boolean;
};

function toModelPricingDefaults(raw: unknown): ModelPricingDefaults {
  const pricing =
    raw && typeof raw === "object" ? (raw as { pricing?: unknown }).pricing : null;
  if (!pricing || typeof pricing !== "object") {
    return {
      inputCostPer1M: null,
      outputCostPer1M: null,
      source: null,
      matchedModel: null,
      approximate: false,
    };
  }
  const p = pricing as Record<string, unknown>;
  return {
    inputCostPer1M: typeof p.inputCostPer1M === "number" ? p.inputCostPer1M : null,
    outputCostPer1M: typeof p.outputCostPer1M === "number" ? p.outputCostPer1M : null,
    source: p.source === "datasheet" || p.source === "builtin" ? p.source : null,
    matchedModel: typeof p.matchedModel === "string" ? p.matchedModel : null,
    approximate: p.approximate === true,
  };
}

type RawAvailableModel = { id?: string; name?: string; type?: string };

function toAvailableModels(raw: unknown): AvailableModel[] {
  const models =
    raw && typeof raw === "object" && Array.isArray((raw as { models?: unknown }).models)
      ? (raw as { models: RawAvailableModel[] }).models
      : Array.isArray(raw)
        ? (raw as RawAvailableModel[])
        : [];
  return models.map((m) => ({
    id: m.id ?? "",
    name: m.name ?? m.id ?? "",
    type: m.type === "embedding" ? "embedding" : "llm",
  }));
}

const modelsApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    listModels: builder.query<
      PaginatedResponse<ModelListItem>,
      { projectId: string } & Partial<ModelListParams>
    >({
      query: ({ projectId, ...params }) => ({
        url: `/projects/${projectId}/models`,
        params: Object.keys(params).length ? params : undefined,
      }),
      transformResponse: toModelsPage,
      providesTags: (result) =>
        result
          ? [
              { type: "Model", id: "LIST" },
              ...(result.data ?? []).map(({ model_id }) => ({
                type: "Model" as const,
                id: model_id,
              })),
            ]
          : [{ type: "Model", id: "LIST" }],
    }),

    listProviders: builder.query<
      PaginatedResponse<ProviderListItem>,
      { projectId: string } & Partial<ProviderListParams>
    >({
      query: ({ projectId, ...params }) => ({
        url: `/projects/${projectId}/providers`,
        params: Object.keys(params).length ? params : undefined,
      }),
      transformResponse: toProvidersPage,
      providesTags: (result) =>
        result
          ? [
              { type: "ModelProvider", id: "LIST" },
              ...(result.data ?? []).map(({ provider_id }) => ({
                type: "ModelProvider" as const,
                id: provider_id,
              })),
            ]
          : [{ type: "ModelProvider", id: "LIST" }],
    }),

    // `POST /providers/refresh` pulls live state from Bifrost and rewrites
    // connectionStatus + statusMessage. It returns the refreshed list in the
    // same `{ providers }` shape as the GET, so we reuse `toProvidersPage` and
    // invalidate the LIST tag to keep the table cache in sync.
    refreshProviders: builder.mutation<
      PaginatedResponse<ProviderListItem>,
      { projectId: string }
    >({
      query: ({ projectId }) => ({
        url: `/projects/${projectId}/providers/refresh`,
        method: "POST",
      }),
      transformResponse: toProvidersPage,
      invalidatesTags: [{ type: "ModelProvider", id: "LIST" }],
    }),

    // `PUT /providers/:providerId` edits the provider's gateway proxy tuning
    // (concurrency + buffer size). Persists to the config-service cache and
    // best-effort syncs Bifrost; invalidating the LIST + provider tags refetches
    // the table so the new values show on the row.
    updateProvider: builder.mutation<
      unknown,
      { projectId: string; providerId: string; body: UpdateProviderRequest }
    >({
      query: ({ projectId, providerId, body }) => ({
        url: `/projects/${projectId}/providers/${providerId}`,
        method: "PUT",
        body,
      }),
      invalidatesTags: (_result, _error, { providerId }) => [
        { type: "ModelProvider", id: "LIST" },
        { type: "ModelProvider", id: providerId },
      ],
    }),

    // `POST /models/list-available` returns the upstream catalog for a
    // provider, resolving the credential server-side. Modeled as a query (it
    // populates the model picker) keyed on provider + credentialId, so picking
    // a different credential refetches. `local`/ollama have no credential.
    listAvailableModels: builder.query<
      AvailableModel[],
      { projectId: string; provider: string; credentialId?: string; type?: "llm" | "embedding" }
    >({
      query: ({ projectId, provider, credentialId, type }) => ({
        url: `/projects/${projectId}/models/list-available`,
        method: "POST",
        body: {
          provider,
          ...(credentialId ? { credentialId } : {}),
          ...(type ? { type } : {}),
        },
      }),
      transformResponse: toAvailableModels,
    }),

    // `GET /models/pricing-defaults` returns the Bifrost catalog list price for
    // a (provider, model) so the Add-model / Modify flow can show a default
    // price per 1M tokens. Keyed on provider + model; static enough to skip tags.
    getModelPricingDefaults: builder.query<
      ModelPricingDefaults,
      { projectId: string; provider: string; model: string }
    >({
      query: ({ projectId, provider, model }) => ({
        url: `/projects/${projectId}/models/pricing-defaults`,
        params: { provider, model },
      }),
      transformResponse: toModelPricingDefaults,
    }),
    getModelForEdit: builder.query<ModelEditResponse, { projectId: string; modelId: string }>({
      query: ({ projectId, modelId }) => `/projects/${projectId}/models/${modelId}`,
      transformResponse: (raw: unknown): ModelEditResponse => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          id: String(r.id ?? ""),
          name: String(r.name ?? ""),
          provider: typeof r.provider === "string" ? r.provider : undefined,
          providerModelId: typeof r.providerModelId === "string" ? r.providerModelId : undefined,
          rpm: typeof r.rpm === "number" ? r.rpm : undefined,
          tpm: typeof r.tpm === "number" ? r.tpm : undefined,
          spendingLimit: typeof r.spendingLimit === "number" ? r.spendingLimit : undefined,
          spendingLimitPeriod:
            r.spendingLimitPeriod === "day" || r.spendingLimitPeriod === "week" || r.spendingLimitPeriod === "month"
              ? r.spendingLimitPeriod
              : undefined,
          inputCostPer1M: typeof r.inputCostPer1M === "number" ? r.inputCostPer1M : undefined,
          outputCostPer1M: typeof r.outputCostPer1M === "number" ? r.outputCostPer1M : undefined,
          markupPercent: typeof r.markupPercent === "number" ? r.markupPercent : undefined,
          concurrentRequests: typeof r.concurrentRequests === "number" ? r.concurrentRequests : undefined,
          bufferSize: typeof r.bufferSize === "number" ? r.bufferSize : undefined,
        };
      },
      providesTags: (_result, _error, { modelId }) => [
        { type: "Model", id: modelId },
        { type: "ModelDetail", id: modelId },
      ],
    }),
    updateModel: builder.mutation<
      unknown,
      { projectId: string; modelId: string; body: UpdateModelRequest }
    >({
      query: ({ projectId, modelId, body }) => ({
        url: `/projects/${projectId}/models/${modelId}`,
        method: "PUT",
        body,
      }),
      invalidatesTags: (_result, _error, { modelId }) => [
        { type: "Model", id: "LIST" },
        { type: "Model", id: modelId },
        { type: "ModelDetail", id: modelId },
      ],
    }),

    // `POST /models` registers a model against a configured provider. The
    // Azure `api_version` rides on the credential metadata, so the body only
    // needs the routing fields + credentialId. Invalidates both the model and
    // provider lists (registration upserts a provider row).
    createModel: builder.mutation<unknown, { projectId: string; body: CreateModelRequest }>({
      query: ({ projectId, body }) => ({
        url: `/projects/${projectId}/models`,
        method: "POST",
        body,
      }),
      invalidatesTags: [
        { type: "Model", id: "LIST" },
        { type: "ModelProvider", id: "LIST" },
      ],
    }),
    deleteModel: builder.mutation<unknown, { projectId: string; modelId: string }>({
      query: ({ projectId, modelId }) => ({
        url: `/projects/${projectId}/models/${modelId}`,
        method: "DELETE",
      }),
      invalidatesTags: (_result, _error, { modelId }) => [
        { type: "Model", id: "LIST" },
        { type: "Model", id: modelId },
      ],
    }),

    listModelDependents: builder.query<DependentsPage, ListModelDependentsParams>({
      query: ({ projectId, modelId, limit, cursor, kind }) => ({
        url: `/projects/${projectId}/models/${modelId}/dependents`,
        params: {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(kind ? { kind } : {}),
        },
      }),
    }),
  }),
});

export { modelsApi };
export const {
  useListModelsQuery,
  useListProvidersQuery,
  useRefreshProvidersMutation,
  useUpdateProviderMutation,
  useCreateModelMutation,
  useListAvailableModelsQuery,
  useGetModelPricingDefaultsQuery,
  useGetModelForEditQuery,
  useUpdateModelMutation,
  useDeleteModelMutation,
  useListModelDependentsQuery,
} = modelsApi;
