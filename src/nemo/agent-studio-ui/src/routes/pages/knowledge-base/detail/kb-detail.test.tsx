import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { KBDetail as KBDetailData } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockGetKB = vi.fn()
const mockGetAssignedDataset = vi.fn()
const mockManualSyncKB = vi.fn()
const mockUpdateKB = vi.fn()

vi.mock("@/api/kb-api.slice", () => ({
  useGetKnowledgeBaseQuery: (...args: unknown[]) => mockGetKB(...args),
  useGetKBAssignedDatasetQuery: (...args: unknown[]) => mockGetAssignedDataset(...args),
  useManualSyncKBMutation: () => [mockManualSyncKB],
  useUpdateKnowledgeBaseMutation: () => [mockUpdateKB, { isLoading: false }],
  kbApi: {
    endpoints: {
      getKnowledgeBase: { select: () => () => ({ data: undefined }) },
    },
  },
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}))

const mockShowKBWorkflowOutcomeToast = vi.fn()
vi.mock("@/components/knowledge-base/utils/kb-workflow-outcome.utils", () => ({
  showKBWorkflowOutcomeToast: (...args: unknown[]) => mockShowKBWorkflowOutcomeToast(...args),
}))

vi.mock("./kb-detail-overview", () => ({
  KBDetailOverview: ({ data }: { data: KBDetailData }) => (
    <div data-testid="overview-tab" data-name={data.name} />
  ),
}))

vi.mock("./kb-detail-sync", () => ({
  KBDetailSync: ({ data }: { data: KBDetailData }) => (
    <div data-testid="sync-tab" data-name={data.name} />
  ),
}))

vi.mock("./kb-detail-dataset", () => ({
  KBDetailDataset: ({ kbId }: { kbId: string }) => (
    <div data-testid="dataset-tab" data-id={kbId} />
  ),
}))

vi.mock("./kb-detail-activity", () => ({
  KBDetailActivity: ({ data }: { data: KBDetailData }) => (
    <div data-testid="activity-tab" data-name={data.name} />
  ),
}))

vi.mock("./kb-detail-playground", () => ({
  KBDetailPlayground: ({ kbId }: { kbId: string }) => (
    <div data-testid="playground-tab" data-id={kbId} />
  ),
}))

import { KBDetail } from "./kb-detail"
import { toast } from "@/ui-lib/base-components/toast/toast"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: KBDetailData = {
  kb_id: "kb-1",
  name: "Test KB",
  status: "ready",
  deprecated: false,
  labels: ["production"],
  created_at: "2024-01-15T10:00:00Z",
  synchronization_status: "Completed",
  last_synchronized_at: "2024-06-15T10:00:00Z",
  assigned_dataset: { dset_id: "ds-42", name: "Training Data" },
  synchronization_config: { sync_mode: "manual" },
  snapshot: null,
}

function renderKBDetail(kbId = "kb-1") {
  return renderWithProviders(undefined, {
    routeConfig: [
      { path: "/knowledge-bases/:kbId", element: <KBDetail /> },
      { path: "/knowledge-bases", element: <div data-testid="kb-list" /> },
      { path: "/knowledge-bases/:kbId/edit", element: <div data-testid="kb-edit" /> },
    ],
    initialEntries: [`/knowledge-bases/${kbId}`],
    preloadedState: {
      projectContext: {
        activeProject: { id: "test-project", name: "Test Project", role: "admin" },
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAssignedDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })

  it("[tag:kb-detail][tag:loading] shows spinner while loading", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderKBDetail()

    expect(document.querySelector(".kb-detail__loading")).toBeInTheDocument()
    expect(screen.queryByText("Test KB")).not.toBeInTheDocument()
  })

  it("[tag:kb-detail][tag:error] shows error message and back button on error", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderKBDetail()

    expect(screen.getByText("Failed to load knowledge base.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to Knowledge Bases" })).toBeInTheDocument()
  })

  it("[tag:kb-detail][tag:error] back button navigates to KB list", async () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Back to Knowledge Bases" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:kb-detail] success state renders title", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    expect(screen.getByRole("heading", { name: "Test KB" })).toBeInTheDocument()
  })

  it("[tag:kb-detail] success state renders breadcrumbs", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    expect(screen.getByText("Knowledge Bases")).toBeInTheDocument()
  })

  it("[tag:kb-detail] stats card shows status label", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    expect(screen.getByText("Ready")).toBeInTheDocument()
  })

  it("[tag:kb-detail] stats card shows sync status", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("[tag:kb-detail] stats card shows assigned dataset name", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    mockGetAssignedDataset.mockReturnValue({
      data: { kb_id: "kb-1", dataset: { dset_id: "ds-42", name: "Training Data" } },
      isLoading: false,
      isError: false,
    })
    renderKBDetail()

    expect(screen.getByText("Training Data")).toBeInTheDocument()
  })

  it("[tag:kb-detail] Edit button navigates to edit page", async () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Edit" }))
    expect(mockNavigate).toHaveBeenCalled()
  })

  it("[tag:kb-detail] Actions menu triggers manualSyncKB mutation", async () => {
    mockManualSyncKB.mockReturnValue({
      unwrap: () => Promise.resolve({ workflowId: "wf-sync-1", knowledgeBaseId: "kb-1", projectId: "test-project" }),
    })
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Knowledge base actions" }))
    await user.click(await screen.findByText("Sync now"))
    expect(mockManualSyncKB).toHaveBeenCalledWith({ projectId: "test-project", kbId: "kb-1" })
    await waitFor(() => {
      expect(mockShowKBWorkflowOutcomeToast).toHaveBeenCalledWith("sync", {
        workflowId: "wf-sync-1",
        knowledgeBaseId: "kb-1",
        projectId: "test-project",
      })
    })
  })

  it("[tag:kb-detail] Sync now shows error toast when mutation fails", async () => {
    mockManualSyncKB.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Knowledge base actions" }))
    await user.click(await screen.findByText("Sync now"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to start synchronization.")
    })
  })

  it("[tag:kb-detail] overview tab is active by default", () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })

  it("[tag:kb-detail] switching to Sync tab shows sync content", async () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Sync" }))
    expect(screen.getByTestId("sync-tab")).toBeInTheDocument()
  })

  it("[tag:kb-detail] switching to Dataset tab shows dataset content", async () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Dataset" }))
    expect(screen.getByTestId("dataset-tab")).toBeInTheDocument()
  })

  it("[tag:kb-detail] switching to Activity tab shows activity content", async () => {
    mockGetKB.mockReturnValue({ data: MOCK_DATA, isLoading: false, isError: false })
    renderKBDetail()

    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Activity" }))
    expect(screen.getByTestId("activity-tab")).toBeInTheDocument()
  })

  it("[tag:kb-detail] stats card shows '—' when no assigned dataset", () => {
    mockGetKB.mockReturnValue({
      data: { ...MOCK_DATA, assigned_dataset: undefined },
      isLoading: false,
      isError: false,
    })
    renderKBDetail()

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-detail] skips query when kbId param is missing", () => {
    mockGetKB.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(undefined, {
      routeConfig: [
        { path: "/knowledge-bases", element: <KBDetail /> },
      ],
      initialEntries: ["/knowledge-bases"],
    })

    expect(mockGetKB).toHaveBeenCalled()
    expect(mockGetKB.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ skip: true }))
  })

  it("[tag:kb-detail] stats card shows '—' when synchronization_status is nullish", () => {
    mockGetKB.mockReturnValue({
      data: { ...MOCK_DATA, synchronization_status: undefined },
      isLoading: false,
      isError: false,
    })
    renderKBDetail()

    expect(screen.getByText("Sync status")).toBeInTheDocument()
    const dashes = screen.getAllByText("—")
    expect(dashes.length).toBeGreaterThanOrEqual(1)
  })
})
