import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

import { createMockStore } from "@test/mocks";
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock";

import { modelsApi } from "./models.api";

const PROJECT_ID = "test-project";

type TestStore = ReturnType<typeof createMockStore>;

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0];
  if (typeof arg === "string") return arg;
  return arg?.url ?? String(arg);
}

const MODELS_LIST_RESPONSE = {
  data: [
    { model_id: "gpt-4o", name: "gpt-4o" },
    { model_id: "claude", name: "claude" },
  ],
  pagination: { limit: 10, offset: 0, total_count: 2 },
};

const PROVIDERS_LIST_RESPONSE = {
  data: [
    { provider_id: "openai", name: "OpenAI" },
    { provider_id: "anthropic", name: "Anthropic" },
  ],
  pagination: { limit: 10, offset: 0, total_count: 2 },
};

describe("modelsApi", () => {
  let store: TestStore;

  beforeEach(() => {
    store = createMockStore();
  });

  afterEach(() => {
    store.dispatch(modelsApi.util.resetApiState());
    restoreAllMocks();
  });

  describe("listModels", () => {
    it("[tag:models-api] should GET the models endpoint with query params", async () => {
      const mock = mockFetchSuccess(MODELS_LIST_RESPONSE);

      await store.dispatch(modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID, limit: 10, offset: 0 }));

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).toContain("/models");
      expect(url).toContain("limit=10");
      expect(url).toContain("offset=0");
    });

    it("[tag:models-api] should GET the models endpoint without params when void", async () => {
      const mock = mockFetchSuccess(MODELS_LIST_RESPONSE);

      await store.dispatch(modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID }));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).not.toContain("limit=");
    });

    it("[tag:models-api] should provide per-item Model tags when result has data", async () => {
      mockFetchSuccess(MODELS_LIST_RESPONSE);

      await store.dispatch(modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID, limit: 10 }));

      const tags = store.getState().api.provided.tags;
      expect(tags.Model?.LIST).toBeDefined();
      expect(tags.Model?.["gpt-4o"]).toBeDefined();
      expect(tags.Model?.claude).toBeDefined();
    });

    it("[tag:models-api] should provide only LIST tag when query errors", async () => {
      mockFetchError(500);

      await store.dispatch(modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID, limit: 10 }));

      const tags = store.getState().api.provided.tags;
      expect(tags.Model?.LIST).toBeDefined();
      expect(tags.Model?.["gpt-4o"]).toBeUndefined();
    });
  });

  describe("listProviders", () => {
    it("[tag:models-api] should GET the providers endpoint", async () => {
      const mock = mockFetchSuccess(PROVIDERS_LIST_RESPONSE);

      await store.dispatch(modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }));

      expect(mock).toHaveBeenCalled();
      expect(calledUrl(mock)).toContain("/providers");
    });

    it("[tag:models-api] should provide per-item ModelProvider tags when result has data", async () => {
      mockFetchSuccess(PROVIDERS_LIST_RESPONSE);

      await store.dispatch(modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID, limit: 10 }));

      const tags = store.getState().api.provided.tags;
      expect(tags.ModelProvider?.LIST).toBeDefined();
      expect(tags.ModelProvider?.openai).toBeDefined();
      expect(tags.ModelProvider?.anthropic).toBeDefined();
    });

    it("[tag:models-api] should provide only LIST tag when query errors", async () => {
      mockFetchError(500);

      await store.dispatch(modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID, limit: 10 }));

      const tags = store.getState().api.provided.tags;
      expect(tags.ModelProvider?.LIST).toBeDefined();
      expect(tags.ModelProvider?.openai).toBeUndefined();
    });

    it("[tag:models-api] should map the backend connection status onto UI health states", async () => {
      mockFetchSuccess({
        success: true,
        total: 4,
        providers: [
          { provider_id: "openai", connectionStatus: "connected" },
          { provider_id: "azure", connectionStatus: "degraded", statusMessage: "no keys" },
          { provider_id: "aws_bedrock", connectionStatus: "error", statusMessage: "401" },
          { provider_id: "google", connectionStatus: "disconnected" },
        ],
      });

      const result = await store.dispatch(
        modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows.map((r) => r.status)).toEqual([
        "Healthy",
        "Degraded",
        "Error",
        "Disconnected",
      ]);
      expect(rows[1]?.statusMessage).toBe("no keys");
    });
  });

  describe("refreshProviders", () => {
    it("[tag:models-api] should POST the providers refresh endpoint", async () => {
      const mock = mockFetchSuccess({ success: true, providers: [], total: 0 });

      await store.dispatch(modelsApi.endpoints.refreshProviders.initiate({ projectId: PROJECT_ID }));

      expect(mock).toHaveBeenCalled();
      const arg = mock.mock.calls[0]?.[0];
      expect(calledUrl(mock)).toContain("/providers/refresh");
      expect(arg?.method).toBe("POST");
    });
  });

  describe("updateProvider", () => {
    it("[tag:models-api] PUTs the provider proxy-config endpoint", async () => {
      const mock = mockFetchSuccess({ success: true, provider: { providerId: "openai" } });

      await store.dispatch(
        modelsApi.endpoints.updateProvider.initiate({
          projectId: PROJECT_ID,
          providerId: "openai",
          body: { concurrentRequests: 200, bufferSize: 800 },
        }),
      );

      expect(mock).toHaveBeenCalled();
      const arg = mock.mock.calls[0]?.[0] as Request;
      expect(arg.url).toContain("/providers/openai");
      expect(arg.method).toBe("PUT");
    });
  });

  describe("listModelDependents", () => {
    it("[tag:models-api] should GET the model dependents endpoint with paging params", async () => {
      const mock = mockFetchSuccess({
        items: [{ kind: "agent", id: "agent-1", name: "Agent One", relation: "uses_model" }],
        totalByKind: { agent: 1 },
      });

      await store.dispatch(
        modelsApi.endpoints.listModelDependents.initiate({
          projectId: PROJECT_ID,
          modelId: "gpt-4o",
          limit: 25,
          kind: "agent",
        }),
      );

      expect(mock).toHaveBeenCalled();
      const url = calledUrl(mock);
      expect(url).toContain("/models/gpt-4o/dependents");
      expect(url).toContain("limit=25");
      expect(url).toContain("kind=agent");
    });
  });

  describe("toModelsPage / mapModelRow (array response)", () => {
    it("[tag:models-api] maps a bare model array, covering field fallbacks", async () => {
      mockFetchSuccess([
        // provider_id + model_id + displayName + modelType=embedding + custom status
        {
          model_id: "m1",
          displayName: "Embed One",
          provider_id: "openai",
          provider_name: "Custom OpenAI",
          modelType: "text-embedding",
          status: "Inactive",
          description: "d1",
        },
        // fallbacks: id over model_id, name over displayName, provider over provider_id,
        // type over modelType (non-embed -> LLM), provider_name from providerLabel(known)
        { id: "m2", name: "LLM Two", provider: "gemini", type: "chat" },
        // unknown provider id -> providerLabel returns the id; default status -> Active
        { id: "m3", provider: "made-up-provider" },
      ]);

      const result = await store.dispatch(
        modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows[0]).toMatchObject({
        model_id: "m1",
        name: "Embed One",
        type: "Embedding",
        provider_id: "openai",
        provider_name: "Custom OpenAI",
        status: "Inactive",
        description: "d1",
      });
      expect(rows[1]).toMatchObject({
        model_id: "m2",
        name: "LLM Two",
        type: "LLM",
        provider_id: "gemini",
        provider_name: "Google Gemini",
      });
      expect(rows[2]).toMatchObject({
        model_id: "m3",
        name: "",
        provider_id: "made-up-provider",
        provider_name: "made-up-provider",
        status: "Active",
        description: "",
      });
      expect(result.data?.pagination.total_count).toBe(3);
    });

    it("[tag:models-api] maps dependents summary and custom pricing onto rows", async () => {
      mockFetchSuccess([
        {
          model_id: "m1",
          name: "Custom priced",
          provider_id: "openai",
          providerModelId: "gpt-4o",
          inputCostPer1M: 1.25,
          outputCostPer1M: 5,
          dependentsSummary: { total: 4, byKind: { agent: 4 } },
        },
        { model_id: "m2", name: "No overrides", provider_id: "anthropic" },
      ]);

      const result = await store.dispatch(
        modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows[0]).toMatchObject({
        model_id: "m1",
        provider_model_id: "gpt-4o",
        dependentsCount: 4,
        inputCostPer1M: 1.25,
        outputCostPer1M: 5,
      });
      expect(rows[1]).toMatchObject({
        model_id: "m2",
        dependentsCount: 0,
        inputCostPer1M: null,
        outputCostPer1M: null,
      });
      expect(rows[1]?.provider_model_id).toBeUndefined();
    });

    it("[tag:models-api] excludes system-managed built-in models from the array", async () => {
      mockFetchSuccess([
        { model_id: "m1", name: "User LLM", provider_id: "openai" },
        // Built-in embedding model seeded by config-service — must be hidden.
        {
          model_id: "b1",
          name: "all-MiniLM-L6-v2",
          provider_id: "as-tei-minilm",
          modelType: "embedding",
          isBuiltin: true,
        },
        { model_id: "m2", name: "Another LLM", provider_id: "gemini" },
      ]);

      const result = await store.dispatch(
        modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows.map((r) => r.model_id)).toEqual(["m1", "m2"]);
      expect(result.data?.pagination.total_count).toBe(2);
    });

    it("[tag:models-api] returns an empty page for an unrecognized models shape", async () => {
      mockFetchSuccess({ unexpected: true });

      const result = await store.dispatch(
        modelsApi.endpoints.listModels.initiate({ projectId: PROJECT_ID }),
      );

      expect(result.data).toEqual({ data: [], pagination: { limit: 0, offset: 0, total_count: 0 } });
    });
  });

  describe("toProvidersPage / mapProviderRow", () => {
    it("[tag:models-api] maps the {providers:[]} shape with camel/snake fallbacks", async () => {
      mockFetchSuccess({
        providers: [
          {
            providerId: "openai",
            connectionStatus: "healthy",
            status_message: "ok",
            concurrency: 5,
            bufferSize: 10,
            capabilities: "LLM",
          },
          // no name/id -> providerLabel("") -> "—"; defaults for the numeric fields
          { connectionStatus: "weird-status" },
        ],
      });

      const result = await store.dispatch(
        modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows[0]).toMatchObject({
        provider_id: "openai",
        status: "Healthy",
        statusMessage: "ok",
        concurrent_requests: 5,
        buffer_size: 10,
        capabilities: "LLM",
      });
      expect(rows[1]).toMatchObject({
        provider_id: "",
        name: "—",
        status: "Disconnected",
        capabilities: "LLM, Embedding",
        concurrent_requests: 0,
        buffer_size: 0,
      });
    });

    it("[tag:models-api] maps a bare providers array", async () => {
      mockFetchSuccess([{ provider_id: "ollama", connectionStatus: "connected" }]);

      const result = await store.dispatch(
        modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }),
      );

      expect(result.data?.data[0]).toMatchObject({ provider_id: "ollama", status: "Healthy" });
    });

    it("[tag:models-api] excludes built-in TEI providers from both shapes", async () => {
      mockFetchSuccess({
        providers: [
          { provider_id: "openai", connectionStatus: "connected" },
          // Built-in embedding provider (in-cluster TEI) — must be hidden.
          { provider_id: "as-tei-minilm", connectionStatus: "connected" },
          { providerId: "as-tei-bge-large-en-v1-5", connectionStatus: "connected" },
        ],
      });

      const result = await store.dispatch(
        modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }),
      );

      const rows = result.data?.data ?? [];
      expect(rows.map((r) => r.provider_id)).toEqual(["openai"]);
    });

    it("[tag:models-api] returns an empty page for an unrecognized providers shape", async () => {
      mockFetchSuccess({ nope: 1 });

      const result = await store.dispatch(
        modelsApi.endpoints.listProviders.initiate({ projectId: PROJECT_ID }),
      );

      expect(result.data).toEqual({ data: [], pagination: { limit: 0, offset: 0, total_count: 0 } });
    });
  });

  describe("listAvailableModels", () => {
    it("[tag:models-api] POSTs provider/credential/type and normalizes {models:[]}", async () => {
      const mock = mockFetchSuccess({
        models: [
          { id: "a", name: "A", type: "embedding" },
          { id: "b", type: "chat" },
        ],
      });

      const result = await store.dispatch(
        modelsApi.endpoints.listAvailableModels.initiate({
          projectId: PROJECT_ID,
          provider: "openai",
          credentialId: "cred-1",
          type: "llm",
        }),
      );

      const arg = mock.mock.calls[0]?.[0] as Request;
      expect(arg.url).toContain("/models/list-available");
      expect(arg.method).toBe("POST");
      expect(result.data).toEqual([
        { id: "a", name: "A", type: "embedding" },
        { id: "b", name: "b", type: "llm" },
      ]);
    });

    it("[tag:models-api] omits credential/type when not provided and accepts a bare array", async () => {
      mockFetchSuccess([{ id: "x", name: "X", type: "llm" }]);

      const result = await store.dispatch(
        modelsApi.endpoints.listAvailableModels.initiate({ projectId: PROJECT_ID, provider: "local" }),
      );

      expect(result.data).toEqual([{ id: "x", name: "X", type: "llm" }]);
    });

    it("[tag:models-api] returns an empty list for an unrecognized shape", async () => {
      mockFetchSuccess({ junk: true });

      const result = await store.dispatch(
        modelsApi.endpoints.listAvailableModels.initiate({ projectId: PROJECT_ID, provider: "local" }),
      );

      expect(result.data).toEqual([]);
    });
  });

  describe("getModelForEdit", () => {
    it("[tag:models-api] coerces numeric fields and a valid spending period", async () => {
      mockFetchSuccess({
        id: "m1",
        name: "Model One",
        rpm: 100,
        tpm: 2000,
        spendingLimit: 50,
        spendingLimitPeriod: "month",
        inputCostPer1M: 1.5,
        outputCostPer1M: 2.5,
        markupPercent: 10,
        concurrentRequests: 4,
        bufferSize: 8,
      });

      const result = await store.dispatch(
        modelsApi.endpoints.getModelForEdit.initiate({ projectId: PROJECT_ID, modelId: "m1" }),
      );

      expect(result.data).toMatchObject({
        id: "m1",
        name: "Model One",
        rpm: 100,
        spendingLimitPeriod: "month",
        bufferSize: 8,
      });
    });

    it("[tag:models-api] drops wrong-typed fields and an invalid spending period", async () => {
      mockFetchSuccess({
        id: 99,
        name: null,
        rpm: "fast",
        spendingLimitPeriod: "fortnight",
      });

      const result = await store.dispatch(
        modelsApi.endpoints.getModelForEdit.initiate({ projectId: PROJECT_ID, modelId: "m2" }),
      );

      expect(result.data).toMatchObject({ id: "99", name: "" });
      expect(result.data?.rpm).toBeUndefined();
      expect(result.data?.spendingLimitPeriod).toBeUndefined();
    });

    it("[tag:models-api] tolerates a null body", async () => {
      mockFetchSuccess(null);

      const result = await store.dispatch(
        modelsApi.endpoints.getModelForEdit.initiate({ projectId: PROJECT_ID, modelId: "m3" }),
      );

      expect(result.data).toMatchObject({ id: "", name: "" });
    });
  });

  describe("model mutations", () => {
    it("[tag:models-api] createModel POSTs the body", async () => {
      const mock = mockFetchSuccess({ id: "new" });

      await store.dispatch(
        modelsApi.endpoints.createModel.initiate({
          projectId: PROJECT_ID,
          body: { name: "New", provider: "openai", modelType: "llm" },
        }),
      );

      const arg = mock.mock.calls[0]?.[0] as Request;
      expect(arg.url).toContain("/models");
      expect(arg.method).toBe("POST");
    });

    it("[tag:models-api] updateModel PUTs the body", async () => {
      const mock = mockFetchSuccess({ id: "m1", name: "Updated" });

      await store.dispatch(
        modelsApi.endpoints.updateModel.initiate({
          projectId: PROJECT_ID,
          modelId: "m1",
          body: { name: "Updated", rpm: null },
        }),
      );

      const arg = mock.mock.calls[0]?.[0] as Request;
      expect(arg.url).toContain("/models/m1");
      expect(arg.method).toBe("PUT");
    });

    it("[tag:models-api] deleteModel DELETEs by id", async () => {
      const mock = mockFetchSuccess({ deleted: true });

      await store.dispatch(
        modelsApi.endpoints.deleteModel.initiate({ projectId: PROJECT_ID, modelId: "m1" }),
      );

      const arg = mock.mock.calls[0]?.[0] as Request;
      expect(arg.url).toContain("/models/m1");
      expect(arg.method).toBe("DELETE");
    });
  });
});
