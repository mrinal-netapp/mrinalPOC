import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { type ReactElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createMockStore } from "@test/mocks"

const mockNavigate = vi.fn()
const mockRefreshTrigger = vi.fn()
const mockDeleteMcpServer = vi.fn()
const capturedActions: {
  onViewDetails?: (toolId: string) => void
  onEdit?: (toolId: string) => void
  onDeprecate?: (toolId: string, toolName: string) => void
  onDelete?: (toolId: string, toolName: string) => void
} = {}

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("./utils/toolset-list-query", () => ({
  useToolsetListQuery: vi.fn(),
}))

vi.mock("../toolset.api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../toolset.api")>()
  return {
    ...actual,
    useRefreshMcpServersMutation: () => [mockRefreshTrigger, { isLoading: false }],
    useDeleteMcpServerMutation: () => [mockDeleteMcpServer, { isLoading: false }],
  }
})

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

vi.mock("@tabler/icons-react", () => ({
  IconDotsVertical: () => <span data-testid="icon-dots" />,
  IconCircleCheck: () => <span data-testid="icon-check" />,
  IconCircleX: () => <span data-testid="icon-x" />,
  IconAlertTriangle: () => <span data-testid="icon-alert" />,
  IconLoader2: () => <span data-testid="icon-loader" />,
}))

vi.mock("@/components/data-source/utils/status-icon", () => ({
  StatusIcon: () => <span data-testid="status-icon" />,
}))

vi.mock("@/ui-lib/base-components/typography/typography", () => ({
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))

vi.mock("@/ui-lib/base-components/baseTableMcpBxp/sortIcon", () => ({
  SortIcon: () => <span data-testid="sort-icon" />,
}))

vi.mock("@/ui-lib/base-components/tooltip/tooltip", () => ({
  Tooltip: ({
    trigger,
  }: {
    trigger: ReactElement
  }) => <div data-testid="tooltip">{trigger}</div>,
}))

vi.mock("@/ui-lib/base-components/button/button", () => ({
  Button: ({
    label,
    icon,
    ...rest
  }: {
    label?: string
    icon?: ReactElement
    "aria-label"?: string
  }) => (
    <button type="button" {...rest}>
      {icon}
      {label}
    </button>
  ),
}))

vi.mock("@/ui-lib/base-components/button/button.variants", () => ({
  buttonVariants: () => "btn-variant-mock",
}))

vi.mock("@/ui-lib/base-components/dropdown-menu/dropdown-menu", async () => {
  const React = await import("react")
  const DropdownCtx = React.createContext<{
    open: boolean
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
  } | null>(null)

  function DropdownMenu({ children }: { children: React.ReactNode }): ReactElement {
    const [open, setOpen] = React.useState(false)
    return <DropdownCtx.Provider value={{ open, setOpen }}>{children}</DropdownCtx.Provider>
  }

  function DropdownMenuTrigger({
    render,
    onClick,
  }: {
    render: ReactElement<{ onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }>
    onClick?: (event: React.MouseEvent) => void
    onPointerDown?: (event: React.PointerEvent) => void
    onKeyDown?: (event: React.KeyboardEvent) => void
  }): ReactElement {
    const ctx = React.useContext(DropdownCtx)
    return React.cloneElement(render, {
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        ctx?.setOpen((current) => !current)
      },
    })
  }

  function DropdownMenuContent({ children }: { children: React.ReactNode }): ReactElement | null {
    const ctx = React.useContext(DropdownCtx)
    if (!ctx?.open) return null
    return <div data-testid="actions-menu">{children}</div>
  }

  function DropdownMenuGroup({ children }: { children: React.ReactNode }): ReactElement {
    return <div role="group">{children}</div>
  }

  function DropdownMenuItem({
    children,
    onClick,
  }: {
    children: string
    onClick?: () => void
  }): ReactElement {
    return (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    )
  }

  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
  }
})

vi.mock("./columns/toolset-list.columns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./columns/toolset-list.columns")>()
  return {
    ...actual,
    createToolsetTableColumns: (actions: typeof capturedActions) => {
      Object.assign(capturedActions, actions)
      return actual.createToolsetTableColumns({
        onViewDetails: actions.onViewDetails ?? (() => {}),
        onEdit: actions.onEdit ?? (() => {}),
        onDeprecate: actions.onDeprecate ?? (() => {}),
        onDelete: actions.onDelete ?? (() => {}),
      })
    },
  }
})

vi.mock("@/ui-lib/base-components/baseTableMcpBxp/baseTable", () => ({
  default: ({
    data,
    columns,
    options,
  }: {
    data?: Array<Record<string, unknown>>
    columns?: Array<{
      id?: string
      cell?: (ctx: {
        row: {
          original: Record<string, unknown>
          getValue: (key: string) => unknown
        }
      }) => ReactElement
    }>
    options?: {
      topBarOptions?: {
        onPrimaryAction?: () => void
        onRefresh?: () => void
        isRefreshing?: boolean
      }
    }
  }) => {
    const actionsColumn = columns?.find((column) => column.id === "actions")
    const firstRow = data?.[0]
    const rowStub = firstRow
      ? {
          original: firstRow,
          getValue: (key: string) => firstRow[key],
        }
      : null
    const actionsCell =
      actionsColumn?.cell && rowStub
        ? actionsColumn.cell({ row: rowStub })
        : null

    return (
      <>
        <button type="button" data-testid="primary-action" onClick={options?.topBarOptions?.onPrimaryAction}>
          Add tool
        </button>
        {options?.topBarOptions?.onRefresh && (
          <button
            type="button"
            aria-label="Refresh"
            disabled={!!options?.topBarOptions?.isRefreshing}
            onClick={options?.topBarOptions?.onRefresh}
          >
            Refresh
          </button>
        )}
        {actionsCell}
      </>
    )
  },
}))

vi.mock("@/components/dialog/confirm-dialog/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    title,
    onConfirm,
    onCancel,
  }: {
    open: boolean
    title: string
    onConfirm: () => void
    onCancel: () => void
  }) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button type="button" onClick={onConfirm}>Confirm</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}))

import { toast } from "@/ui-lib/base-components/toast/toast"

import type { ToolListItem } from "./toolset-list.types"
import { useToolsetListQuery } from "./utils/toolset-list-query"
import { ToolsetList } from "./toolset-list"

function renderList(activeProjectId?: string): void {
  const preloadedState = activeProjectId
    ? ({
        projectContext: {
          activeProject: { id: activeProjectId, name: "Project", role: "admin" },
        },
      } as unknown as Parameters<typeof createMockStore>[0])
    : undefined
  const store = createMockStore(preloadedState)
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <Provider store={store}>{children}</Provider>
  )
  render(<ToolsetList />, { wrapper: Wrapper })
}

const mockListItem: ToolListItem = {
  tool_id: "tool-1",
  tool_name: "Tool 1",
  description: null,
  tool_type: "custom",
  region: null,
  healthiness_status: "Healthy",
  last_validation_error: null,
  last_validated_at: null,
  pipelines_count: 0,
  agents_count: 2,
  is_deprecated: false,
  tags: ["prod"],
  updated_at: "2026-01-01T00:00:00Z",
  updated_by: "test-user",
}

describe("ToolsetList", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    mockRefreshTrigger.mockReset()
    mockDeleteMcpServer.mockReset()
    mockDeleteMcpServer.mockReturnValue({
      unwrap: () => Promise.resolve({ deleted: true }),
    })
    delete capturedActions.onViewDetails
    delete capturedActions.onEdit
    delete capturedActions.onDeprecate
    delete capturedActions.onDelete
  })

  it("[tag:toolset-list] renders title and subtitle", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })

    renderList()

    expect(screen.getByText("Toolsets")).toBeInTheDocument()
    expect(screen.getByText("Add tools for agents to perform actions during execution.")).toBeInTheDocument()
  })

  it("[tag:toolset-list] shows loading state", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })

    renderList()
    expect(screen.getByText("Loading tools...")).toBeInTheDocument()
  })

  it("[tag:toolset-list] shows error state", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })

    renderList()
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("[tag:toolset-list] actions menu omits Deprecate", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: {
        data: [mockListItem],
      },
      isLoading: false,
      isError: false,
    })

    renderList()

    expect(capturedActions.onDeprecate).toBeDefined()

    const trigger = screen.getByRole("button", { name: "Tool actions for Tool 1" })
    expect(screen.queryByTestId("actions-menu")).not.toBeInTheDocument()
    expect(screen.queryByText("Deprecate")).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(screen.getByTestId("actions-menu")).toBeInTheDocument()
    expect(screen.getByText("View details")).toBeInTheDocument()
    expect(screen.getByText("Edit")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    expect(screen.queryByText("Deprecate")).not.toBeInTheDocument()
  })

  it("[tag:toolset-list] deletes a tool via confirm dialog", async () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: {
        data: [mockListItem],
      },
      isLoading: false,
      isError: false,
    })

    renderList("proj-1")

    act(() => {
      capturedActions.onDelete?.("tool-1", "Tool 1")
    })
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => {
      expect(mockDeleteMcpServer).toHaveBeenCalledWith({ projectId: "proj-1", id: "tool-1" })
    })
    expect(toast.success).toHaveBeenCalledWith('"Tool 1" was deleted.')
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument()
  })

  it("[tag:toolset-list] navigates to add tool from primary action", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })

    renderList()
    fireEvent.click(screen.getByTestId("primary-action"))
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/add-toolset")
  })

  it("[tag:toolset-list] maps API data rows and invokes table actions", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: {
        data: [mockListItem],
      },
      isLoading: false,
      isError: false,
    })

    renderList()

    capturedActions.onViewDetails?.("tool-1")
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/tool-1")

    capturedActions.onEdit?.("tool-1")
    expect(mockNavigate).toHaveBeenCalledWith("/toolsets/tool-1/edit")
  })

  it("[tag:toolset-list] closes confirm dialog via cancel", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })

    renderList()
    act(() => {
      capturedActions.onDelete?.("tool-1", "Tool 1")
    })
    expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument()
    expect(screen.getByText("Delete")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument()
  })

  it("[tag:toolset-list] refresh is a no-op without an active project", () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })

    renderList()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    expect(mockRefreshTrigger).not.toHaveBeenCalled()
  })

  it("[tag:toolset-list] refreshes health status and reports a healthy summary", async () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })
    mockRefreshTrigger.mockReturnValue({
      unwrap: () =>
        Promise.resolve({ success: true, total: 3, refreshed: 1, failed: 1, pending: 1 }),
    })

    renderList("proj-1")
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => {
      expect(mockRefreshTrigger).toHaveBeenCalledWith({ projectId: "proj-1" })
      expect(toast.success).toHaveBeenCalledWith(
        "Health refreshed: 1 healthy, 1 unhealthy, 1 still provisioning of 3 tools.",
      )
    })
  })

  it("[tag:toolset-list] reports an info summary when nothing is healthy", async () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })
    mockRefreshTrigger.mockReturnValue({
      unwrap: () => Promise.resolve({ success: true, total: 1, refreshed: 0, failed: 1, pending: 0 }),
    })

    renderList("proj-1")
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("Health refreshed: 0 healthy, 1 unhealthy of 1 tool.")
    })
  })

  it("[tag:toolset-list] reports when there are no tools to refresh", async () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })
    mockRefreshTrigger.mockReturnValue({
      unwrap: () => Promise.resolve({ success: true, total: 0, refreshed: 0, failed: 0, pending: 0 }),
    })

    renderList("proj-1")
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("No tools to refresh yet.")
    })
  })

  it("[tag:toolset-list] reports an error when refresh fails", async () => {
    vi.mocked(useToolsetListQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })
    mockRefreshTrigger.mockReturnValue({
      unwrap: () => Promise.reject(new Error("boom")),
    })

    renderList("proj-1")
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Unable to refresh health status. Please try again.")
    })
  })
})
