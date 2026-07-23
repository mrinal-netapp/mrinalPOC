import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DatasetListItem } from "@/api/dataset.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockDeleteDataset = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/api/dataset-api.slice", () => ({
  useListDatasetsQuery: vi.fn(),
  useDeleteDatasetMutation: vi.fn(),
}))

vi.mock("@/store", () => ({
  useAppSelector: vi.fn().mockReturnValue({}),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

import {
  useListDatasetsQuery,
  useDeleteDatasetMutation,
} from "@/api/dataset-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { DatasetListContent } from "./dataset-list-content"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<DatasetListItem> = {}): DatasetListItem {
  return {
    dset_id: "d-1",
    name: "My Dataset",
    kind: "unstructured",
    status: "Healthy",
    lifecycle_status: "ready",
    synchronization_status: "Completed",
    input_type: "data-source",
    data_source: { dsrc_id: "ds-1", name: "My Source" },
    deprecated: false,
    files_count: 10,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    modified_by: "user@example.com",
    latest_snapshot: { id: "snap-1", version: 5, date: "2026-02-10T07:15:06Z", total_files: 10, files_added: 1, files_removed: 0 },
    ...overrides,
  }
}

function setupMocks({
  rows = [makeRow()],
  isLoading = false,
  isError = false,
  isDeleting = false,
}: {
  rows?: DatasetListItem[]
  isLoading?: boolean
  isError?: boolean
  isDeleting?: boolean
} = {}) {
  vi.mocked(useListDatasetsQuery).mockReturnValue({
    data: { data: rows, total: rows.length },
    isLoading,
    isError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useListDatasetsQuery>)

  vi.mocked(useDeleteDatasetMutation).mockReturnValue([
    mockDeleteDataset,
    { isLoading: isDeleting, reset: vi.fn() } as unknown as ReturnType<typeof useDeleteDatasetMutation>[1],
  ])
}

function renderList() {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/datasets",
        element: <DatasetListContent />,
      },
      {
        path: "/datasets/create",
        element: <div data-testid="create-page" />,
      },
      {
        path: "/datasets/:dsetId",
        element: <div data-testid="detail-page" />,
      },
    ],
    initialEntries: ["/datasets"],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetListContent", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 1
  it("[tag:dataset-list] isLoading propagates to BaseTable", () => {
    setupMocks({ isLoading: true })
    renderList()

    expect(screen.queryByText("My Dataset")).not.toBeInTheDocument()
  })

  // 2
  it("[tag:dataset-list] isError propagates to BaseTable", () => {
    setupMocks({ isError: true, rows: [] })
    renderList()

    expect(screen.queryByText("My Dataset")).not.toBeInTheDocument()
  })

  // 3
  it("[tag:dataset-list] data rows are rendered", () => {
    setupMocks({ rows: [makeRow({ dset_id: "d-999", name: "Test Dataset" })] })
    renderList()

    expect(screen.getByText("Test Dataset")).toBeInTheDocument()
  })

  // 4
  it("[tag:dataset-list] clicking name cell navigates to detail path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dset_id: "d-42", name: "Clickable" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: "Clickable" }))

    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("d-42"))
  })

  // 5
  it("[tag:dataset-list] Add button navigates to create path", async () => {
    const user = userEvent.setup()
    setupMocks()
    renderList()

    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("create"))
  })

  // 6
  it("[tag:dataset-list][tag:confirm-dialog] delete action opens dialog with row name", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "DeleteMe" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for DeleteMe/ }))
    const deleteItems = await screen.findAllByText("Delete")
    await user.click(deleteItems[0])

    expect(await screen.findByText("Delete dataset")).toBeInTheDocument()
  })

  // 7
  it("[tag:dataset-list][tag:confirm-dialog] confirm delete calls deleteDataset mutation", async () => {
    const user = userEvent.setup()
    mockDeleteDataset.mockResolvedValue({})
    setupMocks({ rows: [makeRow({ dset_id: "d-del", name: "ToDelete" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ToDelete/ }))
    await user.click(await screen.findByText("Delete"))

    const confirmBtn = await screen.findByRole("button", { name: "Delete" })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockDeleteDataset).toHaveBeenCalledWith(expect.objectContaining({ dsetId: "d-del", dsrcId: "ds-1" }))
    })
  })

  // 8
  it("[tag:dataset-list][tag:success] delete success shows toast and closes dialog", async () => {
    const user = userEvent.setup()
    mockDeleteDataset.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    setupMocks({ rows: [makeRow({ name: "GoodBye" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for GoodBye/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("GoodBye"))
    })
  })

  // 9
  it("[tag:dataset-list][tag:error] delete failure shows error toast", async () => {
    const user = userEvent.setup()
    mockDeleteDataset.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    setupMocks({ rows: [makeRow({ name: "FailDataset" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for FailDataset/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete "FailDataset".')
    })
  })

  it("[tag:dataset-list][tag:error] delete blocked by dependents shows warning toast with list", async () => {
    const user = userEvent.setup()
    mockDeleteDataset.mockReturnValue({
      unwrap: () =>
        Promise.reject({
          data: {
            code: "HAS_DEPENDENTS",
            error: "Cannot delete this dataset because it is still in use.",
            dependents: {
              items: [
                {
                  kind: "knowledge_base",
                  id: "kb-1",
                  name: "Docs KB",
                  relation: "uses_dataset",
                },
              ],
              nextCursor: null,
              totalByKind: { knowledge_base: 1 },
            },
          },
        }),
    })
    setupMocks({ rows: [makeRow({ name: "BlockedDataset" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for BlockedDataset/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        "Cannot delete this dataset because it is still in use.",
        {
          description: "Knowledge base: Docs KB",
          duration: 8000,
        },
      )
    })
  })

  // 10
  it("[tag:dataset-list] 'View details' action navigates to detail path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dset_id: "d-view", name: "ViewDataset" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ViewDataset/ }))
    await user.click(await screen.findByText("View details"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("d-view"))
    })
  })

  // 11
  it("[tag:dataset-list] edit action navigates to edit path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ dset_id: "d-edit", name: "EditDataset" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for EditDataset/ }))
    await user.click(await screen.findByText("Edit"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("d-edit"))
    })
  })

  // 12
  it("[tag:dataset-list] clicking data source name navigates to data source detail path", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ data_source: { dsrc_id: "ds-99", name: "Source Link" } })] })
    renderList()

    await user.click(screen.getByRole("button", { name: "Source Link" }))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("ds-99"))
    })
  })

  // 13
  it("[tag:dataset-list][tag:confirm-dialog] Cancel in delete dialog closes without deleting", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "KeepDataset" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for KeepDataset/ }))
    await user.click(await screen.findByText("Delete"))

    expect(await screen.findByText("Delete dataset")).toBeInTheDocument()

    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    await waitFor(() => {
      expect(screen.queryByText("Delete dataset")).not.toBeInTheDocument()
    })
    expect(mockDeleteDataset).not.toHaveBeenCalled()
  })
})
