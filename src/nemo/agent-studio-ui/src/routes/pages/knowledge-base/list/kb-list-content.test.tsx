import { screen, waitFor, within } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { KBListItem } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockDeleteKB = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/api/kb-api.slice", () => ({
  useListKnowledgeBasesQuery: vi.fn(),
  useDeleteKnowledgeBaseMutation: vi.fn(),
  kbApi: {
    endpoints: {
      listKnowledgeBases: { select: () => () => ({ data: undefined }) },
    },
  },
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
  useListKnowledgeBasesQuery,
  useDeleteKnowledgeBaseMutation,
} from "@/api/kb-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { KBListContent } from "./kb-list-content"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<KBListItem> = {}): KBListItem {
  return {
    kb_id: "kb-1",
    name: "My KB",
    status: "ready",
    deprecated: false,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    assigned_dataset: { dset_id: "ds-1", name: "Training Data" },
    ...overrides,
  }
}

function setupMocks({
  rows = [makeRow()],
  isLoading = false,
  isError = false,
  isDeleting = false,
}: {
  rows?: KBListItem[]
  isLoading?: boolean
  isError?: boolean
  isDeleting?: boolean
} = {}) {
  vi.mocked(useListKnowledgeBasesQuery).mockReturnValue({
    data: { data: rows, total: rows.length },
    isLoading,
    isError,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useListKnowledgeBasesQuery>)

  vi.mocked(useDeleteKnowledgeBaseMutation).mockReturnValue([
    mockDeleteKB,
    { isLoading: isDeleting, reset: vi.fn() } as unknown as ReturnType<typeof useDeleteKnowledgeBaseMutation>[1],
  ])
}

function renderList() {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/knowledge-bases", element: <KBListContent /> },
      { path: "/knowledge-bases/create", element: <div data-testid="create-page" /> },
      { path: "/knowledge-bases/:kbId", element: <div data-testid="detail-page" /> },
      { path: "/knowledge-bases/:kbId/edit", element: <div data-testid="edit-page" /> },
    ],
    initialEntries: ["/knowledge-bases"],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBListContent", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:kb-list] loading state propagates to table", () => {
    setupMocks({ isLoading: true })
    renderList()
    expect(screen.queryByText("My KB")).not.toBeInTheDocument()
  })

  it("[tag:kb-list] error state propagates to table", () => {
    setupMocks({ isError: true, rows: [] })
    renderList()
    expect(screen.queryByText("My KB")).not.toBeInTheDocument()
  })

  it("[tag:kb-list] rows are rendered", () => {
    setupMocks({ rows: [makeRow({ name: "Test KB" })] })
    renderList()
    expect(screen.getByText("Test KB")).toBeInTheDocument()
  })

  it("[tag:kb-list] rows are sorted by created_at descending (latest first)", () => {
    setupMocks({
      rows: [
        makeRow({ kb_id: "kb-old", name: "OldestKB", created_at: "2024-01-01T00:00:00Z" }),
        makeRow({ kb_id: "kb-new", name: "NewestKB", created_at: "2024-06-01T00:00:00Z" }),
        makeRow({ kb_id: "kb-mid", name: "MiddleKB", created_at: "2024-03-01T00:00:00Z" }),
      ],
    })
    renderList()

    const [headerRow, ...bodyRows] = screen.getAllByRole("row")
    expect(headerRow).toBeInTheDocument()
    // The "Name" column is the first cell in each row; its button text is the KB name.
    const rowNames = bodyRows.map((row) => within(row).getAllByRole("button")[0].textContent)

    expect(rowNames).toEqual(["NewestKB", "MiddleKB", "OldestKB"])
  })

  it("[tag:kb-list] clicking name navigates to detail", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ kb_id: "kb-42", name: "Clickable" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: "Clickable" }))
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-42"))
  })

  it("[tag:kb-list] Add button navigates to create page", async () => {
    const user = userEvent.setup()
    setupMocks()
    renderList()

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("create"))
  })

  it("[tag:kb-list] 'View details' action navigates to detail", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ kb_id: "kb-view", name: "ViewKB" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for ViewKB/ }))
    await user.click(await screen.findByText("View details"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-view"))
    })
  })

  it("[tag:kb-list] Edit action navigates to edit page", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ kb_id: "kb-edit", name: "EditKB" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for EditKB/ }))
    await user.click(await screen.findByText("Edit"))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("kb-edit"))
    })
  })

  it("[tag:kb-list][tag:confirm-dialog] Delete action opens confirm dialog", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "DeleteMe" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for DeleteMe/ }))
    const deleteItems = await screen.findAllByText("Delete")
    await user.click(deleteItems[0])

    expect(await screen.findByText("Delete knowledge base")).toBeInTheDocument()
  })

  it("[tag:kb-list][tag:success] confirm delete calls mutation and shows toast", async () => {
    const user = userEvent.setup()
    mockDeleteKB.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    setupMocks({ rows: [makeRow({ kb_id: "kb-del", name: "GoodBye" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for GoodBye/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(mockDeleteKB).toHaveBeenCalledWith(expect.objectContaining({ kbId: "kb-del" }))
    })
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("GoodBye"))
  })

  it("[tag:kb-list][tag:error] delete failure shows error toast", async () => {
    const user = userEvent.setup()
    mockDeleteKB.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    setupMocks({ rows: [makeRow({ name: "FailKB" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for FailKB/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete "FailKB".')
    })
  })

  it("[tag:kb-list][tag:error] delete blocked by dependents shows warning toast with list", async () => {
    const user = userEvent.setup()
    mockDeleteKB.mockReturnValue({
      unwrap: () =>
        Promise.reject({
          data: {
            code: "HAS_DEPENDENTS",
            error: "Cannot delete this knowledge base because it is still in use.",
            dependents: {
              items: [
                {
                  kind: "agent",
                  id: "agt-1",
                  name: "Support Bot",
                  relation: "uses_kb",
                },
              ],
              nextCursor: null,
              totalByKind: { agent: 1 },
            },
          },
        }),
    })
    setupMocks({ rows: [makeRow({ name: "BlockedKB" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for BlockedKB/ }))
    await user.click(await screen.findByText("Delete"))
    await user.click(await screen.findByRole("button", { name: "Delete" }))

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        "Cannot delete this knowledge base because it is still in use.",
        {
          description: "Agent: Support Bot",
          duration: 8000,
        },
      )
    })
  })

  it("[tag:kb-list][tag:confirm-dialog] Cancel closes dialog without deleting", async () => {
    const user = userEvent.setup()
    setupMocks({ rows: [makeRow({ name: "KeepKB" })] })
    renderList()

    await user.click(screen.getByRole("button", { name: /Actions for KeepKB/ }))
    await user.click(await screen.findByText("Delete"))
    expect(await screen.findByText("Delete knowledge base")).toBeInTheDocument()

    await user.click(await screen.findByRole("button", { name: "Cancel" }))

    await waitFor(() => {
      expect(screen.queryByText("Delete knowledge base")).not.toBeInTheDocument()
    })
    expect(mockDeleteKB).not.toHaveBeenCalled()
  })
})
