import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { DatasetDetail as DatasetDetailData } from "@/api/dataset.types"
import { apiSlice } from "@/api/api.slice"

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

const mockGetDataset = vi.fn()
const mockListDatasetKnowledgeBases = vi.fn()
const mockTriggerDatasetSync = vi.fn()
const mockUpdateDataset = vi.fn()
const mockDeleteDataset = vi.fn()
const mockShowDatasetDeleteErrorToast = vi.fn()

vi.mock("@/utils/delete-dependents.utils", () => ({
  showDatasetDeleteErrorToast: (...args: unknown[]) => mockShowDatasetDeleteErrorToast(...args),
}))

vi.mock("@/api/dataset-api.slice", () => ({
  useGetDatasetQuery: (...args: unknown[]) => mockGetDataset(...args),
  useListDatasetKnowledgeBasesQuery: (...args: unknown[]) => mockListDatasetKnowledgeBases(...args),
  useTriggerDatasetSyncMutation: () => [mockTriggerDatasetSync, { isLoading: false, reset: vi.fn() }],
  useUpdateDatasetMutation: () => [mockUpdateDataset, { isLoading: false, reset: vi.fn() }],
  useDeleteDatasetMutation: () => [mockDeleteDataset, { isLoading: false, reset: vi.fn() }],
}))

// Mock sub-tab components to isolate DatasetDetail shell
vi.mock("./dataset-detail-overview", () => ({
  DatasetDetailOverview: ({ data }: { data: DatasetDetailData }) => (
    <div data-testid="overview-tab" data-name={data.name} />
  ),
}))

vi.mock("./dataset-detail-sync", () => ({
  DatasetDetailSync: ({ data }: { data: DatasetDetailData }) => (
    <div data-testid="sync-tab" data-name={data.name} />
  ),
}))

vi.mock("./dataset-detail-kb", () => ({
  DatasetDetailKB: ({ dsetId }: { dsetId: string }) => (
    <div data-testid="kb-tab" data-id={dsetId} />
  ),
}))

vi.mock("./dataset-detail-data-preview", () => ({
  DatasetDetailDataPreview: ({ dsetId }: { dsetId: string }) => (
    <div data-testid="data-preview-tab" data-id={dsetId} />
  ),
}))

vi.mock("../create-edit/sync-settings-dialog", () => ({
  SyncSettingsDialog: () => null,
}))

vi.mock("@/components/dialog/confirm-dialog/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
  }: {
    open: boolean
    onConfirm: () => void
  }) => (open ? <button type="button" onClick={onConfirm}>Confirm delete</button> : null),
}))

import { DatasetDetail } from "./dataset-detail"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DETAIL: DatasetDetailData = {
  dset_id: "dset-abc",
  name: "My Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  deprecated: false,
  files_count: 3200,
  labels: ["prod"],
  data_source: { dsrc_id: "ds-1", name: "Prod Source" },
  latest_snapshot: { id: "snap-1", version: 3, date: "2024-06-15T10:00:00Z", total_files: 100, files_added: 5, files_removed: 2 },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  description: "Test dataset",
  spec: null,
  refresh_config: null,
  synchronization_summary: {
    status: "Completed",
    schedule: "Daily at 10:00",
    last_completed_synchronization: "2024-06-15T10:00:00Z",
    next_scheduled_synchronization: "2024-06-16T10:00:00Z",
  },
}

function renderDetail(dsetId = "dset-abc") {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/datasets/:dsetId",
        element: <DatasetDetail />,
      },
      {
        path: "/datasets",
        element: <div data-testid="dset-list" />,
      },
      {
        path: "/datasets/:dsetId/edit",
        element: <div data-testid="edit-page" />,
      },
    ],
    initialEntries: [`/datasets/${dsetId}`],
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListDatasetKnowledgeBases.mockReturnValue({
      data: { knowledge_bases: [] },
      isLoading: false,
      isError: false,
    })
  })

  it("[tag:dataset-detail][tag:loading] query loading → full-page spinner", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderDetail()

    expect(document.querySelector(".dset-detail__loading")).toBeInTheDocument()
    expect(screen.queryByText("My Dataset")).not.toBeInTheDocument()
  })

  it("[tag:dataset-detail][tag:error] query error → error message and Back button rendered", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderDetail()

    expect(screen.getByText("Failed to load dataset.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to datasets" })).toBeInTheDocument()
  })

  it("[tag:dataset-detail] success → breadcrumbs, title, stats card rendered", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByRole("heading", { name: "Dataset details" })).toBeInTheDocument()
    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toHaveTextContent("Datasets")
    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toHaveTextContent("My Dataset")
  })

  it("[tag:dataset-detail] stats card shows DatasetStatusCell and SyncStatusCell", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
    expect(screen.getByText("Refresh status")).toBeInTheDocument()
  })

  it("[tag:dataset-detail] failed dataset shows hoverable error message with copy action", async () => {
    const errorMessage = "acquisition activity failed: SQL syntax error";
    mockGetDataset.mockReturnValue({
      data: {
        ...MOCK_DETAIL,
        status: "Failed",
        synchronization_status: "Failed",
        error_message: errorMessage,
      },
      isLoading: false,
      isError: false,
    });

    const user = userEvent.setup();
    renderDetail();

    const failedTriggers = screen.getAllByRole("button", { name: "Failed" });
    expect(failedTriggers).toHaveLength(2);

    await user.hover(failedTriggers[0]);

    const copyButton = await screen.findByRole("button", { name: "Copy error message" });
    expect(copyButton).toBeInTheDocument();

    const tooltipPopup = copyButton.closest("[data-slot='tooltip-content']");
    expect(tooltipPopup).toHaveTextContent(errorMessage);
  })

  it("[tag:dataset-detail] sync tab label reflects schedule enabled state", () => {
    mockGetDataset.mockReturnValue({
      data: {
        ...MOCK_DETAIL,
        refresh_config: {
          auto_refresh_enabled: true,
          paused: false,
          schedule_type: "daily",
          timezone: "UTC",
          time_of_day: "10:00",
          day_of_week: null,
          day_of_month: null,
          cron_expression: null,
        },
      },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    expect(screen.getByRole("tab", { name: "Sync schedule (Enabled)" })).toBeInTheDocument()
  })

  it("[tag:dataset-detail] sync tab label shows Disabled when auto-refresh is off", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByRole("tab", { name: "Sync schedule (Disabled)" })).toBeInTheDocument()
  })

  it("[tag:dataset-detail] stats card shows revision from latest_snapshot", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByText("Version 3")).toBeInTheDocument()
    expect(screen.getByText("Revision")).toBeInTheDocument()
  })

  it("[tag:dataset-detail][tag:refresh] refresh icon invalidates dataset detail, snapshots, manifests, KBs, and assigned data source tags", async () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    const invalidateTagsSpy = vi.spyOn(apiSlice.util, "invalidateTags")
    renderDetail()

    await userEvent.click(screen.getByRole("button", { name: "Refresh dataset" }))

    expect(invalidateTagsSpy).toHaveBeenCalledWith([
      { type: "DatasetDetail", id: "dset-abc" },
      { type: "DatasetSnapshots", id: "dset-abc" },
      { type: "DatasetManifests", id: "dset-abc" },
      { type: "DatasetKBs", id: "dset-abc" },
      { type: "DataSourceDetail", id: "ds-1" },
    ])
    invalidateTagsSpy.mockRestore()
  })

  it("[tag:dataset-detail][tag:refresh] refresh icon omits DataSourceDetail tag for manual-upload datasets (no assigned data source)", async () => {
    mockGetDataset.mockReturnValue({
      data: { ...MOCK_DETAIL, data_source: null },
      isLoading: false,
      isError: false,
    })
    const invalidateTagsSpy = vi.spyOn(apiSlice.util, "invalidateTags")
    renderDetail()

    await userEvent.click(screen.getByRole("button", { name: "Refresh dataset" }))

    expect(invalidateTagsSpy).toHaveBeenCalledWith([
      { type: "DatasetDetail", id: "dset-abc" },
      { type: "DatasetSnapshots", id: "dset-abc" },
      { type: "DatasetManifests", id: "dset-abc" },
      { type: "DatasetKBs", id: "dset-abc" },
    ])
    invalidateTagsSpy.mockRestore()
  })

  it("[tag:dataset-detail] revision shows '-' when latest_snapshot is null", () => {
    mockGetDataset.mockReturnValue({
      data: { ...MOCK_DETAIL, latest_snapshot: null },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    const revisionBlock = screen.getByText("Revision").closest(".card-block") ??
      screen.getByText("Revision").parentElement
    expect(revisionBlock?.textContent).toContain("—")
  })

  it("[tag:dataset-detail] stats card shows last completed sync date", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByText("Last completed sync")).toBeInTheDocument()
    expect(screen.getByText(/Jun 15, 2024/)).toBeInTheDocument()
  })

  it("[tag:dataset-detail] last completed sync shows '-' when synchronization_summary is null", () => {
    mockGetDataset.mockReturnValue({
      data: { ...MOCK_DETAIL, synchronization_summary: null },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    const syncBlock = screen.getByText("Last completed sync").closest(".card-block") ??
      screen.getByText("Last completed sync").parentElement
    expect(syncBlock?.textContent).toContain("—")
  })

  it("[tag:dataset-detail] last completed sync shows '-' when sync status is Never even if summary has a date", () => {
    mockGetDataset.mockReturnValue({
      data: {
        ...MOCK_DETAIL,
        input_type: "upload" as const,
        synchronization_status: "Never" as const,
        synchronization_summary: {
          status: "Never",
          schedule: null,
          last_completed_synchronization: "2024-06-15T10:00:00Z",
          next_scheduled_synchronization: null,
        },
      },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    const syncBlock = screen.getByText("Last completed sync").closest(".card-block") ??
      screen.getByText("Last completed sync").parentElement
    expect(syncBlock?.textContent).toContain("—")
    expect(screen.queryByText(/Jun 15, 2024/)).not.toBeInTheDocument()
  })

  it("[tag:dataset-detail] manual upload shows Completed under Import status when ready", () => {
    mockGetDataset.mockReturnValue({
      data: {
        ...MOCK_DETAIL,
        input_type: "upload" as const,
        synchronization_status: "Never" as const,
        data_source: null,
      },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    expect(screen.getByText("Import status")).toBeInTheDocument()
    const importBlock = screen.getByText("Import status").closest(".card-block")
      ?? screen.getByText("Import status").parentElement
    expect(importBlock?.textContent).toContain("Completed")
    expect(screen.queryByText("Never synced")).not.toBeInTheDocument()
    expect(screen.queryByText("Disabled")).not.toBeInTheDocument()
  })

  it("[tag:dataset-detail] stats card shows assigned data source name", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByText("Assigned data source")).toBeInTheDocument()
    expect(screen.getByText("Prod Source")).toBeInTheDocument()
  })

  it("[tag:dataset-detail] assigned data source shows '-' when null", () => {
    mockGetDataset.mockReturnValue({
      data: { ...MOCK_DETAIL, data_source: null },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    const dsBlock = screen.getByText("Assigned data source").closest(".card-block") ??
      screen.getByText("Assigned data source").parentElement
    expect(dsBlock?.textContent).toContain("—")
  })

  it("[tag:dataset-detail] clicking Overview/Sync/Assigned KB tabs renders correct sub-component", async () => {
    const user = userEvent.setup()
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    // Overview is active by default
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()

    // Switch to Sync
    await user.click(screen.getByRole("tab", { name: /^Sync/ }))
    expect(screen.getByTestId("sync-tab")).toBeInTheDocument()

    // Switch to Assigned KB
    await user.click(screen.getByRole("tab", { name: /^Assigned knowledge bases/ }))
    expect(screen.getByTestId("kb-tab")).toBeInTheDocument()
  })

  it("[tag:dataset-detail][tag:disabled] Activity tab is disabled", () => {
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    const activityTab = screen.getByRole("tab", { name: "Activity" })
    expect(activityTab).toHaveAttribute("aria-disabled", "true")
  })

  it("[tag:dataset-detail] Back to datasets navigates to list path", async () => {
    const user = userEvent.setup()
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Back to datasets" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("datasets"),
    )
  })

  it("[tag:dataset-detail] Edit button navigates to edit path", async () => {
    const user = userEvent.setup()
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Edit" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("dset-abc"),
    )
  })

  it("[tag:dataset-detail] no dsetId route param shows error state", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/datasets",
          element: <DatasetDetail />,
        },
      ],
      initialEntries: ["/datasets"],
    })

    expect(screen.getByText("Failed to load dataset.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to datasets" })).toBeInTheDocument()
  })

  it("[tag:dataset-detail] Actions menu shows sync options for acquired (data-source) datasets", async () => {
    const user = userEvent.setup()
    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Dataset actions" }))

    expect(await screen.findByText("Sync now")).toBeInTheDocument()
    expect(screen.getByText("Edit sync settings")).toBeInTheDocument()
    expect(screen.getByText("Delete dataset")).toBeInTheDocument()
  })

  it("[tag:dataset-detail] Actions menu hides sync options for manual (upload) datasets", async () => {
    const user = userEvent.setup()
    mockGetDataset.mockReturnValue({
      data: { ...MOCK_DETAIL, input_type: "upload" },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Dataset actions" }))

    expect(await screen.findByText("Delete dataset")).toBeInTheDocument()
    expect(screen.queryByText("Sync now")).not.toBeInTheDocument()
    expect(screen.queryByText("Edit sync settings")).not.toBeInTheDocument()
  })

  it("[tag:dataset-detail][tag:error] delete blocked by dependents shows enriched error toast", async () => {
    const user = userEvent.setup()
    const blockedError = {
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
    }

    mockGetDataset.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    mockDeleteDataset.mockReturnValue({ unwrap: () => Promise.reject(blockedError) })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Dataset actions" }))
    await user.click(await screen.findByText("Delete dataset"))
    await user.click(await screen.findByRole("button", { name: "Confirm delete" }))

    expect(mockShowDatasetDeleteErrorToast).toHaveBeenCalledWith(blockedError)
  })
})
