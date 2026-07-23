import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

vi.mock("@/consts/api.consts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, AGENT_BASE_URL: "http://localhost:9999/api/agent" }
})

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { agentApi } from "./agent-api.slice"

type TestStore = ReturnType<typeof createMockStore>

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  if (typeof arg === "string") return arg
  return arg?.url ?? String(arg)
}

function calledMethod(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  return arg?.method ?? "GET"
}

async function calledBodyJson(mock: Mock): Promise<unknown> {
  const arg = mock.mock.calls[0]?.[0]
  if (arg instanceof Request) return arg.json()
  return arg?.body
}

describe("agentApi", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(agentApi.util.resetApiState())
    restoreAllMocks()
  })

  describe("rfcSearchRelevanceChat", () => {
    it("[tag:agent-api] should POST /agent/rfc_search_relevance_scorer/chat with query in body", async () => {
      const mockResponse = {
        citations: {
          latency_seconds: 1.2,
          model_id: "model-1",
          temperature: 0.7,
          llm_calls_count: 1,
        },
        data: {
          answer: "Test answer",
          trace: { request_id: "req-123" },
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          error: null,
        },
        trace: { request_id: "req-123" },
      }
      const mock = mockFetchSuccess(mockResponse)

      await store.dispatch(
        agentApi.endpoints.rfcSearchRelevanceChat.initiate({ query: "test query" }),
      )

      expect(mock).toHaveBeenCalled()
      expect(calledUrl(mock)).toContain("/agent/rfc_search_relevance_scorer/chat")
      expect(calledMethod(mock)).toBe("POST")
      expect(await calledBodyJson(mock)).toMatchObject({ query: "test query" })
    })
  })
})
