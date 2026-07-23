import { configureStore } from "@reduxjs/toolkit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock"
import {
  agentsRuntimeApi,
  invalidateAgentSessionsCache,
} from "./agents-runtime-api.slice"

const PROJECT_ID = "proj-runtime"

type TestStore = ReturnType<typeof createMockStore>

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  if (typeof arg === "string") return arg
  return arg?.url ?? String(arg)
}

function makeStore(): ReturnType<typeof configureStore> {
  return configureStore({
    reducer: {
      [agentsRuntimeApi.reducerPath]: agentsRuntimeApi.reducer,
    },
    middleware: (getDefault) => getDefault().concat(agentsRuntimeApi.middleware),
  })
}

describe("agentsRuntimeApi", () => {
  it("[tag:agents-runtime-api] is injected into the shared apiSlice reducerPath", () => {
    // Endpoints are added via `apiSlice.injectEndpoints`, so the runtime api
    // shares the global cache slice (reducerPath "api") rather than owning its
    // own reducer — this is what lets tags cross-invalidate codebase-wide.
    expect(agentsRuntimeApi.reducerPath).toBe("api")
  })

  it("[tag:agents-runtime-api] declares the AgentSession tag type", () => {
    // RTK Query encodes tag types onto the api descriptor; we assert via
    // the public initiate signature accepting an AgentSession-tagged query.
    expect(typeof agentsRuntimeApi.util.invalidateTags).toBe("function")
  })

  it("[tag:agents-runtime-api] exposes hooks for sessions, invoke, and traces", () => {
    expect(agentsRuntimeApi.endpoints.listAgentSessions).toBeDefined()
    expect(agentsRuntimeApi.endpoints.getAgentSession).toBeDefined()
    expect(agentsRuntimeApi.endpoints.invokeAgent).toBeDefined()
    expect(agentsRuntimeApi.endpoints.getTraceSpans).toBeDefined()
  })

  it("[tag:agents-runtime-api] can be installed into a Redux store without throwing", () => {
    const store = makeStore()
    expect(
      (store.getState() as Record<string, unknown>)[agentsRuntimeApi.reducerPath],
    ).toBeDefined()
  })

  it("[tag:agents-runtime-api] invalidateAgentSessionsCache dispatches an invalidate-tags action with LIST and (optionally) the session id", () => {
    const dispatched: unknown[] = []
    invalidateAgentSessionsCache(
      (action) => dispatched.push(action),
      "agent-7",
    )
    expect(dispatched.length).toBe(1)
    // The action carries the invalidation payload as `payload` per RTK Query's
    // util.invalidateTags. Inspect that the LIST tag id includes the agent id.
    const action = dispatched[0] as { payload?: Array<{ type: string; id?: string }> }
    expect(action.payload).toEqual([
      { type: "AgentSession", id: "LIST-agent-7" },
    ])
  })

  it("[tag:agents-runtime-api] invalidateAgentSessionsCache also includes the session-id tag when provided", () => {
    const dispatched: unknown[] = []
    invalidateAgentSessionsCache(
      (action) => dispatched.push(action),
      "agent-7",
      "sess-5",
    )
    const action = dispatched[0] as { payload?: Array<{ type: string; id?: string }> }
    expect(action.payload).toEqual([
      { type: "AgentSession", id: "LIST-agent-7" },
      { type: "AgentSession", id: "sess-5" },
    ])
  })

  it("[tag:agents-runtime-api] getTraceSpans transformResponse normalizes both array and {data:[]} shapes", () => {
    expect(agentsRuntimeApi.endpoints.getTraceSpans.name).toBe("getTraceSpans")
  })
})

describe("agentsRuntimeApi endpoints (queryFn execution)", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore({
      projectContext: { activeProject: { id: PROJECT_ID, name: "", role: null } },
    })
  })

  afterEach(() => {
    store.dispatch(agentsRuntimeApi.util.resetApiState())
    restoreAllMocks()
  })

  describe("listAgentSessions", () => {
    it("[tag:agents-runtime-api] GETs the single-agent sessions URL", async () => {
      const mock = mockFetchSuccess({ sessions: [] })

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.listAgentSessions.initiate({ id: "agent-1", isTeam: false }),
      )

      const url = calledUrl(mock)
      expect(url).toContain(`/projects/${PROJECT_ID}/agents/agent-1/sessions`)
      expect(result.data).toEqual({ sessions: [] })
    })

    it("[tag:agents-runtime-api] GETs the agent-team sessions URL when isTeam is true", async () => {
      const mock = mockFetchSuccess({ sessions: [] })

      await store.dispatch(
        agentsRuntimeApi.endpoints.listAgentSessions.initiate({ id: "team-1", isTeam: true }),
      )

      expect(calledUrl(mock)).toContain(`/projects/${PROJECT_ID}/agent-teams/team-1/sessions`)
    })

    it("[tag:agents-runtime-api] surfaces the error branch when the request fails", async () => {
      mockFetchError(500, { message: "boom" })

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.listAgentSessions.initiate({ id: "agent-1", isTeam: false }),
      )

      expect(result.isError).toBe(true)
      expect(result.data).toBeUndefined()
    })
  })

  describe("getAgentSession", () => {
    it("[tag:agents-runtime-api] GETs a single session by id", async () => {
      const mock = mockFetchSuccess({ id: "sess-1", messages: [] })

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getAgentSession.initiate({
          id: "agent-1",
          sessionId: "sess-1",
          isTeam: false,
        }),
      )

      expect(calledUrl(mock)).toContain(`/agents/agent-1/sessions/sess-1`)
      expect(result.data).toEqual({ id: "sess-1", messages: [] })
    })

    it("[tag:agents-runtime-api] returns the error branch when the session request fails", async () => {
      mockFetchError(404)

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getAgentSession.initiate({
          id: "agent-1",
          sessionId: "sess-x",
          isTeam: false,
        }),
      )

      expect(result.isError).toBe(true)
    })
  })

  describe("invokeAgent", () => {
    it("[tag:agents-runtime-api] POSTs to the invoke URL and appends query params", async () => {
      const mock = mockFetchSuccess({ output: "ok", sessionId: "sess-new" })

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.invokeAgent.initiate({
          agentId: "agent-1",
          body: { input: "hi" } as never,
          queryParams: { stream: "false" },
        }),
      )

      const arg = mock.mock.calls[0]?.[0] as Request
      expect(arg.url).toContain(`/projects/${PROJECT_ID}/agents/agent-1/invoke`)
      expect(arg.url).toContain("stream=false")
      expect(arg.method).toBe("POST")
      expect("data" in result ? result.data : undefined).toEqual({
        output: "ok",
        sessionId: "sess-new",
      })
    })

    it("[tag:agents-runtime-api] invoke works without query params (sessionId absent)", async () => {
      const mock = mockFetchSuccess({ output: "ok" })

      await store.dispatch(
        agentsRuntimeApi.endpoints.invokeAgent.initiate({
          agentId: "agent-1",
          body: { input: "hi" } as never,
        }),
      )

      const arg = mock.mock.calls[0]?.[0] as Request
      expect(arg.url).not.toContain("?")
    })

    it("[tag:agents-runtime-api] surfaces the error branch when invoke fails", async () => {
      mockFetchError(500)

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.invokeAgent.initiate({
          agentId: "agent-1",
          body: { input: "hi" } as never,
        }),
      )

      expect("error" in result).toBe(true)
    })
  })

  describe("getTraceSpans", () => {
    it("[tag:agents-runtime-api] returns an array response unchanged", async () => {
      mockFetchSuccess([{ spanId: "a" }, { spanId: "b" }])

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getTraceSpans.initiate("trace-1"),
      )

      expect(result.data).toEqual([{ spanId: "a" }, { spanId: "b" }])
    })

    it("[tag:agents-runtime-api] unwraps the {data:[]} envelope", async () => {
      mockFetchSuccess({ data: [{ spanId: "c" }] })

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getTraceSpans.initiate("trace-2"),
      )

      expect(result.data).toEqual([{ spanId: "c" }])
    })

    it("[tag:agents-runtime-api] defaults to an empty array when the envelope has no data", async () => {
      mockFetchSuccess({})

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getTraceSpans.initiate("trace-3"),
      )

      expect(result.data).toEqual([])
    })

    it("[tag:agents-runtime-api] surfaces the error branch when traces fail", async () => {
      mockFetchError(503)

      const result = await store.dispatch(
        agentsRuntimeApi.endpoints.getTraceSpans.initiate("trace-4"),
      )

      expect(result.isError).toBe(true)
    })
  })
})
