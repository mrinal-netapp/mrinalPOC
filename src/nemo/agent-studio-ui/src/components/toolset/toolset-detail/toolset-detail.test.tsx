import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { type ReactElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createMockStore, mockResizeObserver, type ResizeObserverHandle } from "@test/mocks"

import { toast } from "@/ui-lib/base-components/toast/toast"

import { setDetailData, setDetailMcpExpanded } from "../reducer"
import { setDetailError, setDetailLoading } from "../reducer"
import { ToolsetDetail } from "./toolset-detail"
import { TOOLSET_AGENTS_FIXTURE, TOOLSET_DETAIL_FIXTURE } from "./toolset-detail.fixtures"
import { TOOLSET_DETAIL_STRINGS } from "./toolset-detail.consts"

const mockNavigate = vi.fn()
const mockUseParams = vi.fn((): { toolId?: string } => ({ toolId: "tool-mcp-01" }))
const mockDeleteMcpServer = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => mockUseParams(),
  }
})

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

vi.mock("../toolset.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../toolset.api")>()
  return {
    ...actual,
    useDeleteMcpServerMutation: () => [mockDeleteMcpServer, { isLoading: false }],
    useRefreshMcpServersMutation: () => [vi.fn(), { isLoading: false }],
  }
})

vi.mock("@/routes/pages/agents/api/agents-config-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/routes/pages/agents/api/agents-config-api.slice")>()
  return {
    ...actual,
    useListMcpServersQuery: vi.fn(() => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
    })),
    useListMcpServerDependentsQuery: vi.fn(() => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
      isError: false,
    })),
    useListMcpServerToolsQuery: vi.fn(() => ({
      data: undefined,
      isLoading: false,
      isFetching: false,
    })),
  }
})

function createDetailStore(): ReturnType<typeof createMockStore> {
  return createMockStore({
    projectContext: {
      activeProject: { id: "proj-1", name: "Project", role: "admin" },
    },
  } as unknown as Parameters<typeof createMockStore>[0])
}

function TestProviders({ children, store }: { children: ReactNode; store: ReturnType<typeof createMockStore> }): ReactElement {
  return (
    <Provider store={store}>
      <MemoryRouter>{children}</MemoryRouter>
    </Provider>
  )
}

describe("ToolsetDetail", () => {
  let roHandle: ResizeObserverHandle

  beforeEach(() => {
    mockNavigate.mockReset()
    mockUseParams.mockReturnValue({ toolId: "tool-mcp-01" })
    mockDeleteMcpServer.mockReset()
    mockDeleteMcpServer.mockReturnValue({
      unwrap: () => Promise.resolve({ deleted: true }),
    })
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:toolset-detail] shows empty state when route has toolId but detail is not hydrated", async () => {
    const store = createMockStore()

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(TOOLSET_DETAIL_STRINGS.EMPTY_MESSAGE)).toBeInTheDocument()
    })
  })

  it("[tag:toolset-detail] shows empty state when no tool id and no detail data", () => {
    mockUseParams.mockReturnValue({})
    const store = createMockStore()

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    expect(screen.getByText(TOOLSET_DETAIL_STRINGS.EMPTY_MESSAGE)).toBeInTheDocument()
  })

  it("[tag:toolset-detail] shows loading state", () => {
    mockUseParams.mockReturnValue({})
    const store = createMockStore()
    store.dispatch(setDetailLoading(true))

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i)
  })

  it("[tag:toolset-detail] shows error state", () => {
    mockUseParams.mockReturnValue({})
    const store = createMockStore()
    store.dispatch(setDetailError(true))

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:toolset-detail] renders summary and tabs when detail is hydrated in redux", async () => {
    const store = createMockStore()

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: TOOLSET_DETAIL_FIXTURE,
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Toolset details" })).toBeInTheDocument()
      expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument()
      expect(screen.getByRole("tab", { name: "Testing" })).toBeInTheDocument()
      expect(screen.getAllByText("tool-mcp-01").length).toBeGreaterThanOrEqual(1)
    })
  })

  it("[tag:toolset-detail] exercises testing tab actions and dialogs", async () => {
    const store = createDetailStore()
    const user = userEvent.setup({ delay: null })

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: { ...TOOLSET_DETAIL_FIXTURE, connectionStatus: "error" },
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Toolset details" })).toBeInTheDocument()
    })

    await user.click(screen.getByRole("button", { name: "Edit" }))
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/tool-mcp-01/edit")

    await user.click(screen.getByRole("tab", { name: "Testing" }))
    await user.click(screen.getByRole("button", { name: "Test connection" }))
    await user.click(screen.getByRole("button", { name: "Toggle MCP details" }))

    await user.click(screen.getByRole("button", { name: "MCP actions" }))
    const configureItems = await screen.findAllByText("Configure")
    await user.click(configureItems[0]!)
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/tool-mcp-01/edit")

    const actionsButton = screen.getAllByRole("button", { name: "Actions" })[0]!
    await user.click(actionsButton)
    expect(screen.queryByText("Deprecate")).not.toBeInTheDocument()

    await user.click(actionsButton)
    const deleteItems = await screen.findAllByText("Delete")
    await user.click(deleteItems[0]!)
    await user.click(screen.getByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(mockDeleteMcpServer).toHaveBeenCalledWith({
        projectId: "proj-1",
        id: "tool-mcp-01",
      })
      expect(mockNavigate).toHaveBeenCalledWith("/toolsets")
    })

    await user.click(screen.getByRole("tab", { name: "Associated agents (1)" }))
    expect(screen.getByText("agent-01")).toBeInTheDocument()
  }, 15_000)

  it("[tag:toolset-detail] navigates to the agent detail page from the associated agents table", async () => {
    const store = createDetailStore()
    const user = userEvent.setup({ delay: null })

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: TOOLSET_DETAIL_FIXTURE,
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await user.click(screen.getByRole("tab", { name: "Associated agents (1)" }))
    await user.click(screen.getByRole("button", { name: "agent-01" }))

    expect(mockNavigate).toHaveBeenCalledWith("/agents/a1")
  })

  it("[tag:toolset-detail] surfaces a toast when refresh has no active project", async () => {
    const store = createMockStore()
    const user = userEvent.setup({ delay: null })

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: TOOLSET_DETAIL_FIXTURE,
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await user.click(screen.getByRole("button", { name: "Refresh health status" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Unable to refresh health status. Please try again.")
    })
  })

  it("[tag:toolset-detail] renders unhealthy summary status", async () => {
    const store = createMockStore()

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: { ...TOOLSET_DETAIL_FIXTURE, status: "Unhealthy" },
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByText("Unhealthy")).toBeInTheDocument()
    })
  })

  it("[tag:toolset-detail] renders unknown summary status", async () => {
    const store = createMockStore()

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: { ...TOOLSET_DETAIL_FIXTURE, status: "Unknown" },
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByText("Unknown")).toBeInTheDocument()
    })
  })

  it("[tag:toolset-detail] renders collapsed MCP toggle when panel is closed", async () => {
    const store = createMockStore()
    const user = userEvent.setup({ delay: null })

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: TOOLSET_DETAIL_FIXTURE,
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
      store.dispatch(setDetailMcpExpanded(false))
    })

    await user.click(screen.getByRole("tab", { name: "Testing" }))
    expect(screen.getByRole("button", { name: "Toggle MCP details" })).toHaveAttribute("aria-expanded", "false")
  })

  it("[tag:toolset-detail] renders not-configured connection status", async () => {
    const store = createMockStore()
    const user = userEvent.setup({ delay: null })

    render(
      <TestProviders store={store}>
        <ToolsetDetail />
      </TestProviders>,
    )

    await act(async () => {
      store.dispatch(
        setDetailData({
          toolId: TOOLSET_DETAIL_FIXTURE.id,
          tool: { ...TOOLSET_DETAIL_FIXTURE, connectionStatus: "not-configured" },
          agents: TOOLSET_AGENTS_FIXTURE,
        }),
      )
      store.dispatch(setDetailMcpExpanded(true))
    })

    await user.click(screen.getByRole("tab", { name: "Testing" }))
    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })
})
