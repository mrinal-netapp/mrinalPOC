import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMockStore } from "@test/mocks"
import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"

// Control the RTK Query hook so we can exercise the server->ToolListItem mapping
// branches without standing up a real fetch round-trip.
const useListMcpServersQuery = vi.fn()
vi.mock("@/routes/pages/agents/api/agents-config-api.slice", () => ({
  useListMcpServersQuery: (...args: unknown[]) => useListMcpServersQuery(...args),
}))

import { useToolsetListQuery } from "./toolset-list-query"

const PROJECT_ID = "proj-toolsets"

function wrapperWith(projectId?: string) {
  const store = createMockStore(
    projectId ? { projectContext: { activeProject: { id: projectId, name: "", role: null } } } : undefined,
  )
  return function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

function renderQuery(projectId?: string) {
  return renderHook(() => useToolsetListQuery(), { wrapper: wrapperWith(projectId) })
}

describe("useToolsetListQuery", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:toolset-list-query] returns the Redux fallback when no project is active", () => {
    useListMcpServersQuery.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    const { result } = renderQuery(undefined)

    expect(result.current.data).toEqual({ data: [] })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it("[tag:toolset-list-query] maps a user-onboarded remote server to a healthy custom tool", () => {
    const servers: McpServerSummary[] = [
      {
        id: "s1",
        name: "Remote Tool",
        description: "desc",
        status: "connected",
        transport: "stdio",
        deploymentType: "remote",
        labels: ["a", "b"],
        dependentsSummary: { byKind: { agent: 3 } },
      },
    ]
    useListMcpServersQuery.mockReturnValue({ data: servers, isLoading: false, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.data?.data[0]).toMatchObject({
      tool_id: "s1",
      tool_name: "Remote Tool",
      description: "desc",
      tool_type: "custom",
      healthiness_status: "Healthy",
      agents_count: 3,
      tags: ["a", "b"],
    })
  })

  it("[tag:toolset-list-query] maps error/disconnected servers to Unhealthy and catalog deployments to catalogue", () => {
    const servers: McpServerSummary[] = [
      {
        id: "s2",
        name: "Errored",
        status: "error",
        transport: "http",
        deploymentType: "managed",
        description: null,
      },
      { id: "s3", name: "Down", status: "disconnected", transport: "sse", deploymentType: "platform" },
    ]
    useListMcpServersQuery.mockReturnValue({ data: servers, isLoading: false, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    const items = result.current.data?.data ?? []
    expect(items[0]).toMatchObject({
      healthiness_status: "Unhealthy",
      tool_type: "catalogue",
      description: null,
      agents_count: 0,
      tags: [],
    })
    expect(items[1].healthiness_status).toBe("Unhealthy")
    expect(items[1].tool_type).toBe("catalogue")
  })

  it("[tag:toolset-list-query] maps a provisioning managed server to Deploying (not Unknown)", () => {
    const servers: McpServerSummary[] = [
      {
        id: "s5",
        name: "Catalog Tool",
        status: "unknown",
        transport: "streamable-http",
        deploymentType: "managed",
        runtimeStatus: "provisioning",
      },
    ]
    useListMcpServersQuery.mockReturnValue({ data: servers, isLoading: false, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.data?.data[0].healthiness_status).toBe("Deploying")
  })

  it("[tag:toolset-list-query] maps a failed managed provision to Unhealthy", () => {
    const servers: McpServerSummary[] = [
      {
        id: "s6",
        name: "Broken Catalog Tool",
        status: "unknown",
        transport: "streamable-http",
        deploymentType: "managed",
        runtimeStatus: "failed",
      },
    ]
    useListMcpServersQuery.mockReturnValue({ data: servers, isLoading: false, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.data?.data[0].healthiness_status).toBe("Unhealthy")
  })

  it("[tag:toolset-list-query] maps an unrecognized status to Unknown", () => {
    const servers = [
      { id: "s4", name: "Mystery", status: "pending" as unknown as McpServerSummary["status"] },
    ] as McpServerSummary[]
    useListMcpServersQuery.mockReturnValue({ data: servers, isLoading: false, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.data?.data[0].healthiness_status).toBe("Unknown")
  })

  it("[tag:toolset-list-query] returns an empty list when the query has no data yet", () => {
    useListMcpServersQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.data).toEqual({ data: [] })
    expect(result.current.isLoading).toBe(true)
  })

  it("[tag:toolset-list-query] propagates the error flag from the query", () => {
    useListMcpServersQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    const { result } = renderQuery(PROJECT_ID)

    expect(result.current.isError).toBe(true)
  })
})
