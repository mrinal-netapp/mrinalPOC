import { apiSlice } from "@/api/api.slice";
import type { FetchBaseQueryError } from "@reduxjs/toolkit/query";

import type { ModelDetail } from "./model-detail-page.types";

type RawModelDetailResponse = {
  id?: string;
  name?: string;
  displayName?: string;
  status?: string;
  modelType?: string;
  provider?: string;
  providerModelId?: string;
  endpoint?: string;
  description?: string;
  labels?: string[];
  rpm?: number;
  tpm?: number;
  createdAt?: string;
  updatedAt?: string;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  markupPercent?: number;
  spendingLimit?: number;
  spendingLimitPeriod?: "day" | "week" | "month";
};

type RawProvidersResponse = {
  providers?: Array<{
    providerId?: string;
    provider_id?: string;
    connectionStatus?: string;
    status?: string;
  }>;
};

function mapStatus(status: string | undefined): ModelDetail["status"] {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "healthy" || normalized === "connected" || normalized === "active") return "healthy";
  if (normalized === "warning" || normalized === "degraded" || normalized === "inactive") return "warning";
  return "error";
}

function mapConnectionStatus(status: string | undefined): ModelDetail["status"] | undefined {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "connected" || normalized === "healthy") return "healthy";
  if (normalized === "degraded") return "warning";
  if (normalized === "error" || normalized === "disconnected") return "error";
  return undefined;
}

function mapType(modelType: string | undefined): ModelDetail["type"] {
  return modelType?.toLowerCase() === "embedding" ? "Embedding" : "LLM";
}

function formatMoney(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return "-";
  return `$${value.toFixed(2)}`;
}

function mapModelDetail(raw: RawModelDetailResponse, providerConnection?: string): ModelDetail {
  const providerModel = raw.providerModelId ?? raw.name ?? raw.id ?? "-";
  const inputCost = formatMoney(raw.inputCostPer1M);
  const outputCost = formatMoney(raw.outputCostPer1M);
  const markup = raw.markupPercent != null ? `${raw.markupPercent}%` : "-";
  const spendingLimit =
    raw.spendingLimit != null
      ? `$${raw.spendingLimit}${raw.spendingLimitPeriod ? ` per ${raw.spendingLimitPeriod}` : ""}`
      : "-";

  return {
    id: raw.id ?? "",
    name: raw.displayName ?? raw.name ?? raw.id ?? "Unnamed model",
    // Keep status source consistent with Models overview:
    // prefer provider connection health when available.
    status: mapConnectionStatus(providerConnection) ?? mapStatus(raw.status),
    type: mapType(raw.modelType),
    provider: raw.provider ?? "Unknown",
    lastTimeUpdated: raw.updatedAt ?? "-",
    providerUrl: raw.endpoint ?? "",
    description: raw.description ?? "",
    labels: raw.labels ?? [],
    model: providerModel,
    maxRequestsPerMinute: raw.rpm ?? 0,
    maxTokensPerMinute: raw.tpm ?? 0,
    created: raw.createdAt ?? "-",
    requests: 0,
    cost: "-",
    avgLatencyMs: 0,
    successRate: "—",
    activityEvents: [],
    costConfig: {
      inputCostPer1MTokens: inputCost,
      outputCostPer1MTokens: outputCost,
      customPricing: raw.inputCostPer1M != null || raw.outputCostPer1M != null ? "Enabled" : "Disabled",
      customInputCostPer1MTokens: inputCost,
      customOutputCostPer1MTokens: outputCost,
      markup,
      spendingLimitUsd: spendingLimit,
      spendingThresholdAlert: "-",
      currentSpending: "-",
    },
  };
}

// Model detail query. Backend endpoint:
//   GET /api/v1/projects/{projectId}/models/{id}
// Routed through apigateway `/config/*` to config-service. projectId comes
// from the active project context — call sites must pass it.
const modelDetailApi = apiSlice.injectEndpoints({
  endpoints: (builder) => ({
    getModel: builder.query<ModelDetail, { projectId: string; modelId: string }>({
      async queryFn({ projectId, modelId }, _api, _extraOptions, baseQuery) {
        const modelResult = await baseQuery(`/projects/${projectId}/models/${modelId}`);
        if ("error" in modelResult) {
          return { error: modelResult.error as FetchBaseQueryError };
        }

        const rawModel = modelResult.data as RawModelDetailResponse;
        const providerId = rawModel.provider;
        let providerConnectionStatus: string | undefined;

        if (providerId) {
          const providersResult = await baseQuery(`/projects/${projectId}/providers`);
          if ("data" in providersResult) {
            const providers = (providersResult.data as RawProvidersResponse).providers ?? [];
            const provider = providers.find(
              (p) => (p.provider_id ?? p.providerId ?? "") === providerId,
            );
            providerConnectionStatus = provider?.connectionStatus ?? provider?.status;
          }
        }

        return { data: mapModelDetail(rawModel, providerConnectionStatus) };
      },
      providesTags: (_result, _error, { modelId }) => [
        { type: "ModelDetail", id: modelId },
      ],
    }),
  }),
});

// Per-model usage statistics, aggregated by config-service from Bifrost's logs
// store. `successRate` is a percentage (0-100) or null when there is no traffic
// to base it on; `available` is false when the gateway logs store is disabled
// or unreachable (metrics are zeroed in that case).
export type ModelUsageStats = {
  requests: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number;
  successRate: number | null;
  available: boolean;
};

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Usage-stats query. Backend endpoint:
//   GET /api/v1/projects/{projectId}/models/{id}/stats?days={days}
// `days` is an optional rolling window; omit for all retained logs (<=90d).
const modelUsageStatsApi = modelDetailApi.injectEndpoints({
  endpoints: (builder) => ({
    getModelUsageStats: builder.query<
      ModelUsageStats,
      { projectId: string; modelId: string; days?: number }
    >({
      query: ({ projectId, modelId, days }) => {
        const suffix = days ? `?days=${days}` : "";
        return `/projects/${projectId}/models/${modelId}/stats${suffix}`;
      },
      transformResponse: (raw: Partial<ModelUsageStats>): ModelUsageStats => ({
        requests: toNumber(raw.requests),
        totalTokens: toNumber(raw.totalTokens),
        totalCost: toNumber(raw.totalCost),
        averageLatencyMs: toNumber(raw.averageLatencyMs),
        successRate: raw.successRate == null ? null : toNumber(raw.successRate),
        available: !!raw.available,
      }),
      providesTags: (_result, _error, { modelId }) => [
        { type: "ModelDetail", id: `${modelId}-stats` },
      ],
    }),
  }),
});

const { useGetModelQuery } = modelDetailApi;
const { useGetModelUsageStatsQuery } = modelUsageStatsApi;

export {
  modelDetailApi,
  modelUsageStatsApi,
  useGetModelQuery,
  useGetModelUsageStatsQuery,
};
