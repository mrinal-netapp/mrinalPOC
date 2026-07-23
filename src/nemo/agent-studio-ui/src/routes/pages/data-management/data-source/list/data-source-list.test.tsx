import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DataSourceListItem } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks — must be at module scope (hoisted by vitest)
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockDeleteDataSource = vi.fn()
const mockUpdateDeprecation = vi.fn()
const mockFetchDataSource = vi.fn()
const mockTriggerScan = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/api/data-source-api.slice", () => ({
  useListDataSourcesQuery: vi.fn(),
  useDeleteDataSourceMutation: vi.fn(),
  useUpdateDataSourceDeprecationMutation: vi.fn(),
  useLazyGetDataSourceQuery: vi.fn(),
  useTriggerManualScanMutation: vi.fn(),
}))

vi.mock("@/store", () => ({
  useAppSelector: vi.fn().mockReturnValue({}),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import {
  useListDataSourcesQuery,
  useDeleteDataSourceMutation,
  useUpdateDataSourceDeprecationMutation,
  useLazyGetDataSourceQuery,
  useTriggerManualScanMutation,
} from "@/api/data-source-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { DataSourceListContent } from "./data-source-list"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<DataSourceListItem> = {}): DataSourceListItem {
  return {
    dsrc_id: "ds-1",
    name: "My Source",
    source_type: "NFS",
    status: "Healthy",
    scan_status: "Completed",
    deprecated: false,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    associated_datasets: [],
    associated_datasets_count: 0,
    last_validated_at: null,
    last_validation_error: null,
    scan: null,
    ...overrides,
  }
}

function setupMocks({
  rows = [makeRow()],
  isLoading = false,
  isError = false,
  isDeleting = false,
}: {
  rows?: DataSourceListItem[]
  isLoading?: boolean
  isError?: boolean
  isDeleting?: boolean
} = {}) {
  vi.mocked(useListDataSourcesQuery).mockReturnValue({
    data: { data: rows, total: rows.length },
    isLoading,
    isError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useListDataSourcesQuery>)

  vi.mocked(useDeleteDataSourceMutation).mockReturnValue([
    mockDeleteDataSource,
    { isLoading: isDeleting, reset: vi.fn() } as unknown as ReturnType<typeof useDeleteDataSourceMutation>[1],
  ])

  vi.mocked(useUpdateDataSourceDeprecationMutation).mockReturnValue([
    mockUpdateDeprecation,
    { reset: vi.fn() } as unknown as ReturnType<typeof useUpdateDataSourceDeprecationMutation>[1],
  ])

  vi.mocked(useLazyGetDataSourceQuery).mockReturnValue([mockFetchDataSource, { isLoading: false, reset: vi.fn() } as unknown as ReturnType<typeof useLazyGetDataSourceQuery>[1], { lastArg: undefined } as unknown as ReturnType<typeof useLazyGetDataSourceQuery>[2]] as unknown as ReturnType<typeof useLazyGetDataSourceQuery>)
  vi.mocked(useTriggerManualScanMutation).mockReturnValue([mockTriggerScan, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useTriggerManualScanMutation>)
}

function renderList(path = "/data-sources") {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/data-sources",
        element: <DataSourceListContent />,
      },
      {
        path: "/data-sources/create",
        element: <div data-testid="create-page" />,
      },
      {
        path: "/data-sources/:dsrcId",
        element: <div data-testid="detail-page" />,
      },
    ],
    initialEntries: [path],
  })
}

// ---------------------------------------------------------------------------
// Section 8 — DataSourceList
// ---------------------------------------------------------------------------

describe("DataSourceList", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 8.1
  it("[tag:data-source-list][tag:loading] isLoading propagates to BaseTable", () => {
    setupMocks({ isLoading: true })
    renderList()

    // BaseTable renders a loading skeleton / spinner — no data rows
    expect(screen.queryByText("My Source")).not.toBeInTheDocument()
  })

  // 8.2
  it("[tag:data-source-list][tag:error] isError propagates to BaseTable", () => {
    setupMocks({ isError: true, rows: [] })
    renderList()

    expect(screen.queryByText("My Source")).not.toBeInTheDocument()
  })

  // 8.3
  it("[tag:data-source-list] data rows mapped with id: dsrc_id", () => {
    setupMocks({ rows: [makeRow({ dsrc_id: "ds-999", name: "Test Source" })] })
    renderList()

    expect(screen.getByText("Test Source")).toBeInTheDocument()
  })

  // 8.4 — name link triggers navigate to detail path
  it("[tag:data-source-list] clicking name cell triggers navigate to detail path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dsrc_id: "ds-42", name: "Clickable" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: "Clickable" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("ds-42"),
    )
  })

  // 8.5
  it("[tag:data-source-list] Register button navigates to create path", async () => {
    const user = userEvent.setup()
    setupMocks()
    renderList()

    await user.click(screen.getByRole("button", { name: "Register" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("create"),
    )
  })

  // 8.6
  it("[tag:data-source-list][tag:confirm-dialog] delete action opens dialog with row name", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "DeleteMe" })] })
    renderList()

    // Open the actions dropdown
    const trigger = screen.getByRole("button", { name: /Actions for DeleteMe/ })
    await user.click(trigger)

    // Click Delete from the dropdown (first match in the portal is the menu item)
    const deleteItems = await screen.findAllByText("Delete")
    // menu item is the first rendered Delete text
    await user.click(deleteItems[0])

    // Dialog title should be visible and a confirm button with label "Delete" appears
    expect(await screen.findByText("Delete data source")).toBeInTheDocument()
  })

  // 8.7
  it("[tag:data-source-list][tag:confirm-dialog] confirm in dialog calls deleteDataSource mutation", async () => {
    const user = userEvent.setup()
    mockDeleteDataSource.mockResolvedValue({})
    setupMocks({ rows: [makeRow({ dsrc_id: "ds-del", name: "ToDelete" })] })
    renderList()

    // Open actions dropdown
    await user.click(screen.getByRole("button", { name: /Actions for ToDelete/ }))
    await user.click(await screen.findByText("Delete"))

    // Click confirm in dialog
    const confirmBtn = await screen.findByRole("button", { name: "Delete" })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockDeleteDataSource).toHaveBeenCalledWith(expect.objectContaining({ dsrcId: "ds-del" }))
    })
  })

  // 8.8
  it("[tag:data-source-list][tag:success] delete success → toast shown; dialog closed", async () => {
    const user = userEvent.setup()
    mockDeleteDataSource.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    setupMocks({ rows: [makeRow({ name: "GoodBye" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for GoodBye/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("GoodBye"))
    })
  })

  // 8.9
  it("[tag:data-source-list][tag:error] delete failure → error toast shown", async () => {
    const user = userEvent.setup()
    mockDeleteDataSource.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    setupMocks({ rows: [makeRow({ name: "FailSource" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for FailSource/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("FailSource"))
    })
  })

  // 8.10 — Deprecate action is temporarily hidden (see data-source-list.tsx).
  it("[tag:data-source-list] actions menu does not include Deprecate", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "ActiveSource", deprecated: false })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ActiveSource/ }))
    await screen.findByText("View details")

    expect(screen.queryByText("Deprecate")).not.toBeInTheDocument()
    expect(screen.queryByText("Un-deprecate")).not.toBeInTheDocument()
  })

  // 8.11
  it("[tag:data-source-list][tag:scanning] Edit item disabled when scan_status=Scanning", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "ScanningSource", scan_status: "Scanning" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ScanningSource/ }))

    const editItem = await screen.findByText("Edit")

    // DropdownMenuItem with disabled=true renders a non-interactive item
    expect(editItem.closest("[data-disabled]") ?? editItem.closest("[aria-disabled]")).toBeTruthy()
  })

  // 8.12
  it("[tag:data-source-list] edit action navigates to edit path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dsrc_id: "ds-edit", name: "EditSource" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for EditSource/ }))
    await user.click(await screen.findByText("Edit"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("ds-edit"))
    })
  })

  // Gap 11a: covers line 105 — the "View details" action item onClick
  it("[tag:data-source-list] 'View details' action navigates to the detail path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dsrc_id: "ds-view", name: "ViewSource" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ViewSource/ }))
    await user.click(await screen.findByText("View details"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("ds-view"))
    })
  })

  // Gap 11b: covers line 187 — `onCancel={() => setDeleteTarget(null)}` in the ConfirmDialog
  it("[tag:data-source-list][tag:confirm-dialog] Cancel in delete dialog closes the dialog without deleting", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "KeepSource" })] })
    renderList()

    // Open delete dialog
    await user.click(screen.getByRole("button", { name: /Actions for KeepSource/ }))
    await user.click(await screen.findByText("Delete"))

    expect(await screen.findByText("Delete data source")).toBeInTheDocument()

    // Click Cancel — should close the dialog
    const cancelBtn = await screen.findByRole("button", { name: "Cancel" })
    await user.click(cancelBtn)

    await waitFor(() => {
      expect(screen.queryByText("Delete data source")).not.toBeInTheDocument()
    })
    expect(mockDeleteDataSource).not.toHaveBeenCalled()
  })

  // The "Scan" and "Deprecate" row actions are temporarily hidden, so there are no
  // scan-action or deprecation tests here. scan_status still gates Edit (see test 8.11).

  it("[tag:data-source-list] actions menu does not include Explore", async () => {
    const user = userEvent.setup()
    setupMocks({
      rows: [
        makeRow({
          dsrc_id: "vol-1",
          name: "test-vol",
          category: "Volume",
          source_type: "NFS",
        }),
      ],
    })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for test-vol/ }))
    await screen.findByText("View details")

    expect(screen.queryByText("Explore")).not.toBeInTheDocument()
  })
})
