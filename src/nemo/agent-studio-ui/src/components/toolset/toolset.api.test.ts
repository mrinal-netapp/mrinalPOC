import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { Mock } from "vitest"

import { createMockStore } from "@test/mocks"
import { mockFetchSuccess, mockFetchError, restoreAllMocks } from "@test/api-mock"
import { apiSlice } from "@/api/api.slice"

import {
  formatMcpServerDeleteError,
  summarizeMcpRefresh,
  type McpServerRecord,
  type RefreshMcpServersResponse,
} from "./toolset.api"

const PROJECT_ID = "proj-tools"

// The endpoints are injected into the shared apiSlice; reach them by name.
// (Importing toolset.api above triggers the injectEndpoints side-effect.)
const tEndpoints = apiSlice.endpoints as unknown as Record<
  string,
  { initiate: (arg: unknown) => never }
>

type TestStore = ReturnType<typeof createMockStore>

type EndpointResult = { data?: unknown; error?: unknown; isError?: boolean }

// The loose `tEndpoints` cast makes dispatch results `unknown`; this wrapper
// gives the awaited thunk result a concrete shape so call sites type-check.
async function dispatchEndpoint(s: TestStore, thunk: never): Promise<EndpointResult> {
  return (await s.dispatch(thunk)) as EndpointResult
}

function calledUrl(mock: Mock): string {
  const arg = mock.mock.calls[0]?.[0]
  if (typeof arg === "string") return arg
  return arg?.url ?? String(arg)
}

describe("summarizeMcpRefresh", () => {
  it("[tag:toolset-api] reports nothing to refresh when total is zero", () => {
    const res = summarizeMcpRefresh({ success: true, refreshed: 0, failed: 0 })
    expect(res).toEqual({ message: "No tools to refresh yet.", tone: "info" })
  })

  it("[tag:toolset-api] uses the explicit total when present", () => {
    const result: RefreshMcpServersResponse = { success: true, refreshed: 2, failed: 0, total: 5 }
    const res = summarizeMcpRefresh(result)
    expect(res.message).toBe("Health refreshed: 2 healthy of 5 tools.")
    expect(res.tone).toBe("success")
  })

  it("[tag:toolset-api] lists unhealthy and provisioning counts and pluralizes", () => {
    const res = summarizeMcpRefresh({ success: true, refreshed: 1, failed: 2, pending: 3 })
    expect(res.message).toBe("Health refreshed: 1 healthy, 2 unhealthy, 3 still provisioning of 6 tools.")
    expect(res.tone).toBe("success")
  })

  it("[tag:toolset-api] uses singular 'tool' and info tone when nothing is healthy", () => {
    const res = summarizeMcpRefresh({ success: true, refreshed: 0, failed: 1 })
    expect(res.message).toBe("Health refreshed: 0 healthy, 1 unhealthy of 1 tool.")
    expect(res.tone).toBe("info")
  })

  it("[tag:toolset-api] ignores a zero pending value", () => {
    const res = summarizeMcpRefresh({ success: true, refreshed: 1, failed: 0, total: 1, pending: 0 })
    expect(res.message).toBe("Health refreshed: 1 healthy of 1 tool.")
  })
})

describe("formatMcpServerDeleteError", () => {
  it("[tag:toolset-api] explains the dependents constraint", () => {
    const msg = formatMcpServerDeleteError({ data: { code: "HAS_DEPENDENTS" } })
    expect(msg).toContain("still assigned to one or more agents")
  })

  it("[tag:toolset-api] surfaces a server-provided error message", () => {
    expect(formatMcpServerDeleteError({ data: { error: "Boom happened" } })).toBe("Boom happened")
  })

  it("[tag:toolset-api] falls back to a generic message for unknown errors", () => {
    expect(formatMcpServerDeleteError(undefined)).toBe("Couldn't delete this tool. Please try again.")
    expect(formatMcpServerDeleteError({ data: { error: "" } })).toBe(
      "Couldn't delete this tool. Please try again.",
    )
  })
})

describe("toolsetApi endpoints", () => {
  let store: TestStore

  beforeEach(() => {
    store = createMockStore()
  })

  afterEach(() => {
    store.dispatch(apiSlice.util.resetApiState())
    restoreAllMocks()
  })

  it("[tag:toolset-api] createMcpServer POSTs to the project mcp-servers URL", async () => {
    const mock = mockFetchSuccess({ id: "tool-1" })

    const result = await dispatchEndpoint(store,
      tEndpoints.createMcpServer.initiate({ projectId: PROJECT_ID, body: { name: "t" } }),
    )

    const url = calledUrl(mock)
    expect(url).toContain(`/projects/${PROJECT_ID}/mcp-servers`)
    expect("data" in result ? result.data : undefined).toEqual({ id: "tool-1" })
  })

  it("[tag:toolset-api] createMcpServer surfaces the error branch", async () => {
    mockFetchError(500)
    const result = await dispatchEndpoint(store,
      tEndpoints.createMcpServer.initiate({ projectId: PROJECT_ID, body: {} }),
    )
    expect("error" in result).toBe(true)
  })

  it("[tag:toolset-api] getMcpServer GETs a single record", async () => {
    const record: McpServerRecord = { id: "tool-1", name: "Tool" }
    const mock = mockFetchSuccess(record)

    const result = await dispatchEndpoint(store,
      tEndpoints.getMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-1" }),
    )

    expect(calledUrl(mock)).toContain(`/mcp-servers/tool-1`)
    expect("data" in result ? result.data : undefined).toEqual(record)
  })

  it("[tag:toolset-api] getMcpServer surfaces the error branch", async () => {
    mockFetchError(404)
    const result = await dispatchEndpoint(store,
      tEndpoints.getMcpServer.initiate({ projectId: PROJECT_ID, id: "missing" }),
    )
    expect(result.isError).toBe(true)
  })

  it("[tag:toolset-api] updateMcpServer PUTs and returns the record", async () => {
    const mock = mockFetchSuccess({ id: "tool-1", name: "Renamed" })
    const result = await dispatchEndpoint(store,
      tEndpoints.updateMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-1", body: { name: "Renamed" } }),
    )
    expect(calledUrl(mock)).toContain(`/mcp-servers/tool-1`)
    expect("data" in result ? result.data : undefined).toMatchObject({ name: "Renamed" })
  })

  it("[tag:toolset-api] updateMcpServer surfaces the error branch", async () => {
    mockFetchError(400)
    const result = await dispatchEndpoint(store,
      tEndpoints.updateMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-1", body: {} }),
    )
    expect("error" in result).toBe(true)
  })

  it("[tag:toolset-api] refreshMcpServers POSTs to the refresh URL", async () => {
    const mock = mockFetchSuccess({ success: true, refreshed: 1, failed: 0 })
    const result = await dispatchEndpoint(store,
      tEndpoints.refreshMcpServers.initiate({ projectId: PROJECT_ID }),
    )
    expect(calledUrl(mock)).toContain(`/mcp-servers/refresh`)
    expect("data" in result ? result.data : undefined).toMatchObject({ refreshed: 1 })
  })

  it("[tag:toolset-api] refreshMcpServers surfaces the error branch", async () => {
    mockFetchError(500)
    const result = await dispatchEndpoint(store,
      tEndpoints.refreshMcpServers.initiate({ projectId: PROJECT_ID }),
    )
    expect("error" in result).toBe(true)
  })

  it("[tag:toolset-api] validateMcpConnection POSTs the connection body", async () => {
    const mock = mockFetchSuccess({ success: true, status: "connected" })
    const result = await dispatchEndpoint(store,
      tEndpoints.validateMcpConnection.initiate({ projectId: PROJECT_ID, body: { url: "x" } }),
    )
    expect(calledUrl(mock)).toContain(`/mcp-servers/validate-connection`)
    expect("data" in result ? result.data : undefined).toMatchObject({ status: "connected" })
  })

  it("[tag:toolset-api] validateMcpConnection surfaces the error branch", async () => {
    mockFetchError(422)
    const result = await dispatchEndpoint(store,
      tEndpoints.validateMcpConnection.initiate({ projectId: PROJECT_ID, body: {} }),
    )
    expect("error" in result).toBe(true)
  })

  it("[tag:toolset-api] deleteMcpServer returns the server response when present", async () => {
    const mock = mockFetchSuccess({ deleted: true })
    const result = await dispatchEndpoint(store,
      tEndpoints.deleteMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-1" }),
    )
    expect(calledUrl(mock)).toContain(`/mcp-servers/tool-1`)
    expect("data" in result ? result.data : undefined).toEqual({ deleted: true })
  })

  it("[tag:toolset-api] deleteMcpServer defaults to {deleted:true} when the body is empty", async () => {
    mockFetchSuccess(null)
    const result = await dispatchEndpoint(store,
      tEndpoints.deleteMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-2" }),
    )
    expect("data" in result ? result.data : undefined).toEqual({ deleted: true })
  })

  it("[tag:toolset-api] deleteMcpServer surfaces the error branch", async () => {
    mockFetchError(409)
    const result = await dispatchEndpoint(store,
      tEndpoints.deleteMcpServer.initiate({ projectId: PROJECT_ID, id: "tool-3" }),
    )
    expect("error" in result).toBe(true)
  })
})
