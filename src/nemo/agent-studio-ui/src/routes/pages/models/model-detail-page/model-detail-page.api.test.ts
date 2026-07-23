import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mock } from "vitest";

import { createMockStore } from "@test/mocks";
import { mockFetchByUrl, restoreAllMocks } from "@test/api-mock";

import { apiSlice } from "@/api/api.slice";

import { modelDetailApi, modelUsageStatsApi } from "./model-detail-page.api";

type TestStore = ReturnType<typeof createMockStore>;

function calledUrl(mock: Mock, callIndex = 0): string {
  const arg = mock.mock.calls[callIndex]?.[0];
  if (typeof arg === "string") return arg;
  return arg?.url ?? String(arg);
}

describe("modelDetailApi", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(apiSlice.util.resetApiState());
    restoreAllMocks();
  });

  it("[tag:model-detail-api] fetches the model and matching provider health", async () => {
    const mock = mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-1",
        data: {
          id: "model-1",
          name: "fallback-name",
          displayName: "Visible name",
          status: "inactive",
          modelType: "embedding",
          provider: "provider-1",
          providerModelId: "provider-model-1",
          endpoint: "https://provider.example.com",
          description: "Embedding model",
          labels: ["prod"],
          rpm: 42,
          tpm: 9001,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
          inputCostPer1M: 1.5,
          outputCostPer1M: 2.25,
          markupPercent: 15,
          spendingLimit: 250,
          spendingLimitPeriod: "week",
        },
      },
      {
        match: "/projects/proj-1/providers",
        data: {
          providers: [
            { provider_id: "provider-1", connectionStatus: "connected" },
          ],
        },
      },
    ]);

    const result = await store.dispatch(
      modelDetailApi.endpoints.getModel.initiate({ projectId: "proj-1", modelId: "model-1" }),
    );

    expect(mock).toHaveBeenCalledTimes(2);
    expect(calledUrl(mock, 0)).toContain("/projects/proj-1/models/model-1");
    expect(calledUrl(mock, 1)).toContain("/projects/proj-1/providers");
    expect(result.data).toMatchObject({
      id: "model-1",
      name: "Visible name",
      status: "healthy",
      type: "Embedding",
      provider: "provider-1",
      providerUrl: "https://provider.example.com",
      labels: ["prod"],
      model: "provider-model-1",
      maxRequestsPerMinute: 42,
      maxTokensPerMinute: 9001,
      created: "2026-01-01T00:00:00Z",
      lastTimeUpdated: "2026-01-02T00:00:00Z",
      description: "Embedding model",
      costConfig: {
        inputCostPer1MTokens: "$1.50",
        outputCostPer1MTokens: "$2.25",
        customPricing: "Enabled",
        customInputCostPer1MTokens: "$1.50",
        customOutputCostPer1MTokens: "$2.25",
        markup: "15%",
        spendingLimitUsd: "$250 per week",
      },
    });
  });

  it("[tag:model-detail-api] maps provider health variants before falling back to model status", async () => {
    const cases = [
      {
        providerStatus: "degraded",
        rawStatus: "active",
        expectedStatus: "warning",
      },
      {
        providerStatus: "disconnected",
        rawStatus: "healthy",
        expectedStatus: "error",
      },
      {
        providerStatus: undefined,
        rawStatus: "warning",
        expectedStatus: "warning",
      },
      {
        providerStatus: undefined,
        rawStatus: "degraded",
        expectedStatus: "warning",
      },
      {
        providerStatus: undefined,
        rawStatus: "connected",
        expectedStatus: "healthy",
      },
      {
        providerStatus: undefined,
        rawStatus: "mystery",
        expectedStatus: "error",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const mock = mockFetchByUrl([
        {
          match: `/projects/proj-1/models/model-${index}`,
          data: {
            id: `model-${index}`,
            provider: testCase.providerStatus ? `provider-${index}` : undefined,
            status: testCase.rawStatus,
          },
        },
        {
          match: "/projects/proj-1/providers",
          data: {
            providers: [
              { providerId: `provider-${index}`, status: testCase.providerStatus },
            ],
          },
        },
      ]);

      const result = await store.dispatch(
        modelDetailApi.endpoints.getModel.initiate({ projectId: "proj-1", modelId: `model-${index}` }),
      );

      expect(result.data?.status).toBe(testCase.expectedStatus);
      if (testCase.providerStatus) {
        expect(mock).toHaveBeenCalledTimes(2);
      } else {
        expect(mock).toHaveBeenCalledTimes(1);
      }

      store.dispatch(apiSlice.util.resetApiState());
      restoreAllMocks();
    }
  });

  it("[tag:model-detail-api] falls back to defaults when optional fields are missing", async () => {
    mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-empty",
        data: {
          id: "model-empty",
          inputCostPer1M: Number.NaN,
          outputCostPer1M: undefined,
        },
      },
    ]);

    const result = await store.dispatch(
      modelDetailApi.endpoints.getModel.initiate({ projectId: "proj-1", modelId: "model-empty" }),
    );

    expect(result.data).toMatchObject({
      id: "model-empty",
      name: "model-empty",
      status: "error",
      type: "LLM",
      provider: "Unknown",
      lastTimeUpdated: "-",
      providerUrl: "",
      description: "",
      labels: [],
      model: "model-empty",
      maxRequestsPerMinute: 0,
      maxTokensPerMinute: 0,
      created: "-",
      cost: "-",
      avgLatencyMs: 0,
      successRate: "—",
      activityEvents: [],
      costConfig: {
        inputCostPer1MTokens: "-",
        outputCostPer1MTokens: "-",
        customPricing: "Disabled",
        customInputCostPer1MTokens: "-",
        customOutputCostPer1MTokens: "-",
        markup: "-",
        spendingLimitUsd: "-",
        spendingThresholdAlert: "-",
        currentSpending: "-",
      },
    });
  });

  it("[tag:model-detail-api] uses name and id fallbacks when display name and provider model id are absent", async () => {
    mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-fallbacks",
        data: {
          id: "model-fallbacks",
          name: "fallback-name",
          status: "inactive",
          spendingLimit: 10,
        },
      },
    ]);

    const result = await store.dispatch(
      modelDetailApi.endpoints.getModel.initiate({ projectId: "proj-1", modelId: "model-fallbacks" }),
    );

    expect(result.data).toMatchObject({
      name: "fallback-name",
      model: "fallback-name",
      status: "warning",
      costConfig: {
        spendingLimitUsd: "$10",
      },
    });
  });

  it("[tag:model-detail-api] returns the base-query error when the model request fails", async () => {
    const mock = mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-error",
        status: 500,
        data: { detail: "boom" },
      },
    ]);

    const result = await store.dispatch(
      modelDetailApi.endpoints.getModel.initiate({ projectId: "proj-1", modelId: "model-error" }),
    );

    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.error).toBeDefined();
  });

  it("[tag:model-detail-api] falls back to the raw model status when the providers response has no matching entry", async () => {
    mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-unmatched-provider",
        data: {
          id: "model-unmatched-provider",
          provider: "provider-1",
          status: "active",
        },
      },
      {
        match: "/projects/proj-1/providers",
        data: {
          providers: [{ provider_id: "other-provider", connectionStatus: "error" }],
        },
      },
    ]);

    const result = await store.dispatch(
      modelDetailApi.endpoints.getModel.initiate({
        projectId: "proj-1",
        modelId: "model-unmatched-provider",
      }),
    );

    expect(result.data?.status).toBe("healthy");
  });

  it("[tag:model-detail-api] fetches and normalizes model usage stats with a window", async () => {
    const mock = mockFetchByUrl([
      {
        match: "/projects/proj-1/models/model-1/stats",
        data: {
          requests: 1200,
          totalTokens: 3400,
          totalCost: 12.5,
          averageLatencyMs: 245.6,
          successRate: 99.2,
          available: true,
        },
      },
    ]);

    const result = await store.dispatch(
      modelUsageStatsApi.endpoints.getModelUsageStats.initiate({
        projectId: "proj-1",
        modelId: "model-1",
        days: 30,
      }),
    );

    expect(calledUrl(mock)).toContain("/projects/proj-1/models/model-1/stats?days=30");
    expect(result.data).toEqual({
      requests: 1200,
      totalTokens: 3400,
      totalCost: 12.5,
      averageLatencyMs: 245.6,
      successRate: 99.2,
      available: true,
    });
  });

  it("[tag:model-detail-api] defaults usage stats when fields are missing / unavailable", async () => {
    const mock = mockFetchByUrl([
      { match: "/projects/proj-1/models/model-2/stats", data: { available: false } },
    ]);

    const result = await store.dispatch(
      modelUsageStatsApi.endpoints.getModelUsageStats.initiate({
        projectId: "proj-1",
        modelId: "model-2",
      }),
    );

    // No `days` -> no query string (all retained logs).
    expect(calledUrl(mock)).toContain("/projects/proj-1/models/model-2/stats");
    expect(calledUrl(mock)).not.toContain("days=");
    expect(result.data).toEqual({
      requests: 0,
      totalTokens: 0,
      totalCost: 0,
      averageLatencyMs: 0,
      successRate: null,
      available: false,
    });
  });
});
