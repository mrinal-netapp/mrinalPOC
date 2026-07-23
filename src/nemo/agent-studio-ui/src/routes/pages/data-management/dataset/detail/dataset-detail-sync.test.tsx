import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"

import { renderWithProviders, userEvent } from "@test/render"
import type { DatasetDetail, DatasetRefreshConfig } from "@/api/dataset.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUpdateDataset = vi.fn()
const mockTriggerSync = vi.fn()
const mockListSnapshots = vi.fn()

const mockUpdateSnapshot = vi.fn()

vi.mock("@/api/dataset-api.slice", () => ({
  useUpdateDatasetMutation: vi.fn(),
  useTriggerDatasetSyncMutation: vi.fn(),
  useUpdateDatasetSnapshotMutation: vi.fn(),
  useListDatasetSnapshotsQuery: (...args: unknown[]) => mockListSnapshots(...args),
}))

vi.mock("../create-edit/sync-settings-dialog", () => ({
  SyncSettingsDialog: ({
    open,
    onConfirm,
    onClose,
  }: {
    open: boolean
    onConfirm: (config: DatasetRefreshConfig) => void
    onClose: () => void
  }) =>
    open ? (
      <div data-testid="sync-settings-dialog">
        <button onClick={() => onConfirm({
          auto_refresh_enabled: true,
          schedule_type: "daily",
          time_of_day: "10:00",
          day_of_week: null,
          day_of_month: null,
          timezone: null,
          cron_expression: null,
          paused: false,
        })}>Confirm sync settings</button>
        <button onClick={onClose}>Close sync dialog</button>
      </div>
    ) : null,
}))

// Mock BaseTable for snapshot table
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    isLoading,
    isError,
    columns,
  }: {
    data: Array<Record<string, unknown>>
    isLoading: boolean
    isError: boolean
    columns: Array<{ cell?: (ctx: { row: { original: Record<string, unknown> } }) => ReactNode }>
  }) => (
    <div data-testid="snapshot-table" data-loading={String(isLoading)} data-error={String(isError)}>
      {isLoading && <span data-testid="table-loading">Loading…</span>}
      {isError && <span data-testid="table-error">Error</span>}
      {!isLoading && !isError && data.length === 0 && (
        <span data-testid="table-empty">No data</span>
      )}
      {!isLoading && !isError && data.map((row, i) => (
        <div key={i} data-testid="snapshot-row" data-id={String(row.id)}>
          {columns.map((col, ci) => (
            <span key={ci}>{col.cell?.({ row: { original: row } })}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}))

// Mock ActionsCell so menu items render as plain buttons (never truly disabled so coverage hits the no-op handlers)
vi.mock("@/components/data-source/columns/cells/actions-cell", () => ({
  ActionsCell: ({
    row,
    menuItems,
  }: {
    row: unknown
    name: string
    menuItems: Array<{ label: string; onClick: (r: unknown) => void; isDisabled?: boolean }>
  }) => (
    <span data-testid="actions-cell">
      {menuItems.map((item) => (
        <button
          key={item.label}
          data-disabled={item.isDisabled ? "true" : "false"}
          onClick={() => item.onClick(row)}
        >
          {item.label}
        </button>
      ))}
    </span>
  ),
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { useUpdateDatasetMutation, useTriggerDatasetSyncMutation, useUpdateDatasetSnapshotMutation } from "@/api/dataset-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { DatasetDetailSync } from "./dataset-detail-sync"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: DatasetDetail = {
  dset_id: "dset-1",
  name: "Test Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  deprecated: false,
  files_count: 500,
  labels: [],
  data_source: { dsrc_id: "ds-1", name: "Prod NFS" },
  latest_snapshot: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  description: null,
  spec: null,
  refresh_config: {
    auto_refresh_enabled: true,
    schedule_type: "daily",
    time_of_day: "10:00",
    day_of_week: null,
    day_of_month: null,
    timezone: null,
    cron_expression: null,
    paused: false,
  },
  synchronization_summary: {
    status: "Completed",
    schedule: "Daily at 10:00",
    last_completed_synchronization: "2024-06-15T10:00:00Z",
    next_scheduled_synchronization: "2024-06-16T10:00:00Z",
  },
}

function setupUpdateMock(result: { unwrap: () => Promise<unknown> } = { unwrap: () => Promise.resolve({}) }) {
  mockUpdateDataset.mockReturnValue(result)
  vi.mocked(useUpdateDatasetMutation).mockReturnValue([mockUpdateDataset, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useUpdateDatasetMutation>)
}

function setupSyncMock(result: { unwrap: () => Promise<unknown> } = { unwrap: () => Promise.resolve({}) }) {
  mockTriggerSync.mockReturnValue(result)
  vi.mocked(useTriggerDatasetSyncMutation).mockReturnValue([mockTriggerSync, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useTriggerDatasetSyncMutation>)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetDetailSync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateMock()
    setupSyncMock()
    mockUpdateSnapshot.mockReturnValue({ unwrap: () => Promise.resolve({}) })
    vi.mocked(useUpdateDatasetSnapshotMutation).mockReturnValue([mockUpdateSnapshot, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useUpdateDatasetSnapshotMutation>)
    mockListSnapshots.mockReturnValue({ data: { snapshots: [] }, isLoading: false, isError: false })
  })

  it("[tag:dset-detail-sync] sync metrics rendered with formatted values", () => {
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByText("Sync status")).toBeInTheDocument()
    expect(screen.getByText("Schedule")).toBeInTheDocument()
    expect(screen.getByText("Last completed synchronization")).toBeInTheDocument()
    expect(screen.getByText("Next scheduled synchronization")).toBeInTheDocument()
    expect(screen.getByText("Completed")).toBeInTheDocument()
    expect(screen.getByText("Runs every day at 10:00 AM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] last completed and next scheduled rendered from synchronization_summary", () => {
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByText(/Jun 15, 2024/)).toBeInTheDocument()
    expect(screen.getByText(/Jun 16, 2024/)).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] null synchronization_summary shows '-' for date fields", () => {
    const data = { ...MOCK_DATA, synchronization_summary: null }
    renderWithProviders(<DatasetDetailSync data={data} />)

    const lastLabel = screen.getByText("Last completed synchronization")
    const lastRow = lastLabel.closest(".card-block") ?? lastLabel.parentElement
    expect(lastRow?.textContent).toContain("—")
  })

  it("[tag:dset-detail-sync] schedule shows 'Manual' when auto_refresh disabled", () => {
    const data = { ...MOCK_DATA, refresh_config: null, synchronization_summary: null }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Manual")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] manual (upload) datasets show '-' for schedule, last completed and next scheduled sync", () => {
    const data = {
      ...MOCK_DATA,
      input_type: "upload" as const,
      synchronization_status: "Never" as const,
      refresh_config: null,
      synchronization_summary: {
        status: "Never" as const,
        schedule: "Daily at 10:00",
        last_completed_synchronization: "2024-06-15T10:00:00Z",
        next_scheduled_synchronization: "2024-06-16T10:00:00Z",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    const scheduleLabel = screen.getByText("Schedule")
    const scheduleRow = scheduleLabel.closest(".card-block") ?? scheduleLabel.parentElement
    expect(scheduleRow?.textContent).toContain("—")
    expect(screen.queryByText("Manual")).not.toBeInTheDocument()
    expect(screen.queryByText(/Jun 15, 2024/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Jun 16, 2024/)).not.toBeInTheDocument()

    const lastLabel = screen.getByText("Last completed synchronization")
    const lastRow = lastLabel.closest(".card-block") ?? lastLabel.parentElement
    expect(lastRow?.textContent).toContain("—")

    const nextLabel = screen.getByText("Next scheduled synchronization")
    const nextRow = nextLabel.closest(".card-block") ?? nextLabel.parentElement
    expect(nextRow?.textContent).toContain("—")

    expect(screen.getByText("Disabled")).toBeInTheDocument()
    expect(screen.queryByText("Never synced")).not.toBeInTheDocument()
  })

  it("[tag:dset-detail-sync][tag:sync] Sync button disabled when synchronization_status=Synchronizing", () => {
    const data = { ...MOCK_DATA, synchronization_status: "Synchronizing" as const }
    renderWithProviders(<DatasetDetailSync data={data} />)

    const syncBtn = screen.getByRole("button", { name: "Sync" })
    expect(syncBtn).toBeDisabled()
  })

  it("[tag:dset-detail-sync][tag:success] Sync button success → shows success toast", async () => {
    const user = userEvent.setup()
    setupSyncMock({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Sync" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Synchronization started successfully.")
    })
  })

  it("[tag:dset-detail-sync][tag:error] Sync button failure → shows error toast", async () => {
    const user = userEvent.setup()
    setupSyncMock({ unwrap: () => Promise.reject(new Error("sync error")) })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Sync" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to start synchronization.")
    })
  })

  it("[tag:dset-detail-sync] Sync button calls triggerDatasetSync with dset_id", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Sync" }))

    expect(mockTriggerSync).toHaveBeenCalledWith(expect.objectContaining({ dsetId: "dset-1" }))
  })

  it("[tag:dset-detail-sync] acquired (data-source) dataset does not show manual upload schedule notice", () => {
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(
      screen.queryByText("Sync schedule cannot be enabled for manually uploaded datasets."),
    ).not.toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] manual (upload) dataset shows sync controls greyed/disabled but keeps snapshot table", () => {
    const data = { ...MOCK_DATA, input_type: "upload" as const }
    renderWithProviders(<DatasetDetailSync data={data} />)

    // Controls stay visible (discoverable) but disabled — manual datasets have
    // no external source to sync from.
    const syncBtn = screen.getByRole("button", { name: "Sync" })
    expect(syncBtn).toBeInTheDocument()
    expect(syncBtn).toBeDisabled()

    const actionsBtn = screen.getByRole("button", { name: "Synchronization actions" })
    expect(actionsBtn).toBeInTheDocument()
    expect(actionsBtn).toBeDisabled()

    // Snapshot history is still produced by the import workflow, so keep it.
    expect(screen.getByTestId("snapshot-table")).toBeInTheDocument()
    expect(
      screen.getByText("Sync schedule cannot be enabled for manually uploaded datasets."),
    ).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] dropdown 'Sync now' triggers the same sync action", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Sync now"))

    expect(mockTriggerSync).toHaveBeenCalledWith(expect.objectContaining({ dsetId: "dset-1" }))
  })

  it("[tag:dset-detail-sync][tag:sync-settings-dialog] 'Edit sync settings' click opens dialog", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Edit sync settings"))

    expect(screen.getByTestId("sync-settings-dialog")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] dialog confirm calls updateDataset with refresh_config", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Edit sync settings"))
    await user.click(screen.getByText("Confirm sync settings"))

    expect(mockUpdateDataset).toHaveBeenCalledWith(
      expect.objectContaining({
        dsetId: "dset-1",
        body: expect.objectContaining({
          refresh_config: expect.objectContaining({
            auto_refresh_enabled: true,
            schedule_type: "daily",
          }),
        }),
      }),
    )
  })

  it("[tag:dset-detail-sync][tag:success] save success → toast message", async () => {
    const user = userEvent.setup()
    setupUpdateMock({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Edit sync settings"))
    await user.click(screen.getByText("Confirm sync settings"))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Synchronization settings updated successfully.")
    })
  })

  it("[tag:dset-detail-sync][tag:error] save failure → error toast", async () => {
    const user = userEvent.setup()
    setupUpdateMock({ unwrap: () => Promise.reject(new Error("Failed")) })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Edit sync settings"))
    await user.click(screen.getByText("Confirm sync settings"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to update synchronization settings.")
    })
  })

  it("[tag:dset-detail-sync] closing sync settings dialog without confirming", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Synchronization actions" }))
    await user.click(await screen.findByText("Edit sync settings"))

    expect(screen.getByTestId("sync-settings-dialog")).toBeInTheDocument()

    await user.click(screen.getByText("Close sync dialog"))

    await waitFor(() => {
      expect(screen.queryByTestId("sync-settings-dialog")).not.toBeInTheDocument()
    })
  })

  it("[tag:dset-detail-sync] snapshot table renders with data", () => {
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-1",
            version: 1,
            status: "completed",
            total_files: 100,
            total_folders: 10,
            files_synced: 95,
            files_added: 5,
            files_removed: 2,
            used_knowledge_base: null,
            expired: false,
            is_current: true,
            created_at: "2024-06-15T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const rows = screen.getAllByTestId("snapshot-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute("data-id", "snap-1")
    expect(screen.getByText("Version 1")).toBeInTheDocument()
    expect(screen.getByText("In use")).toBeInTheDocument()
    expect(screen.getByText("95")).toBeInTheDocument()
    expect(screen.getByText("+5")).toBeInTheDocument()
    expect(screen.getByText("-2")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshot table loading state", () => {
    mockListSnapshots.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByTestId("snapshot-table")).toHaveAttribute("data-loading", "true")
  })

  it("[tag:dset-detail-sync] snapshot table empty state", () => {
    mockListSnapshots.mockReturnValue({ data: { snapshots: [] }, isLoading: false, isError: false })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshots 409 while synchronizing shows loading, not error", () => {
    mockListSnapshots.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 409 },
    })
    const data = { ...MOCK_DATA, synchronization_status: "Synchronizing" as const }
    renderWithProviders(<DatasetDetailSync data={data} />)

    const table = screen.getByTestId("snapshot-table")
    expect(table).toHaveAttribute("data-loading", "true")
    expect(table).toHaveAttribute("data-error", "false")
    expect(screen.queryByTestId("table-error")).not.toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshots 409 when not synchronizing shows empty, not error", () => {
    mockListSnapshots.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 409 },
    })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const table = screen.getByTestId("snapshot-table")
    expect(table).toHaveAttribute("data-error", "false")
    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshots non-409 error still shows the error state", () => {
    mockListSnapshots.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { status: 500 },
    })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByTestId("snapshot-table")).toHaveAttribute("data-error", "true")
    expect(screen.getByTestId("table-error")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshot with no changes renders 'No changes'", () => {
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-2",
            version: 2,
            status: "completed",
            total_files: 100,
            total_folders: 10,
            files_synced: 100,
            files_added: 0,
            files_removed: 0,
            used_knowledge_base: null,
            expired: false,
            is_current: true,
            created_at: "2024-07-01T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByText("No changes")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] cron schedule shows cron expression", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "cron" as const,
        cron_expression: "0 10 * * *",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Cron: 0 10 * * *")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] cron schedule with null expression shows '-'", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "cron" as const,
        cron_expression: null,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Cron: —")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with 1 hour", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 60,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every hour")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with undefined interval defaults to 1 hour", () => {
    const config = { ...MOCK_DATA.refresh_config!, schedule_type: "hourly" as const }
    delete (config as Record<string, unknown>).interval_minutes
    const data = { ...MOCK_DATA, refresh_config: config }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every hour")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with N hours", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 180,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every 3 hours")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with 1 minute", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 1,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every minute")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with N minutes (< 60)", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 30,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every 30 minutes")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with 1 hour and remainder minutes", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 90,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every 1 hour and 30 minutes")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] hourly schedule with N hours and remainder minutes", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "hourly" as const,
        interval_minutes: 150,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every 2 hours and 30 minutes")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] daily schedule with no time_of_day", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "daily" as const,
        time_of_day: null,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every day")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] daily schedule with midnight time (hour=0 → 12 AM)", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "daily" as const,
        time_of_day: "00:30",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every day at 12:30 AM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] daily schedule with PM time (hour>12)", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "daily" as const,
        time_of_day: "15:45",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every day at 3:45 PM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] daily schedule at noon (hour=12 → 12 PM)", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "daily" as const,
        time_of_day: "12:00",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every day at 12:00 PM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] weekly schedule with days and time", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "weekly" as const,
        time_of_day: "09:00",
        day_of_week: [1, 3, 5],
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs weekly at 9:00 AM on Mon, Wed, Fri")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] weekly schedule with no days and no time", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "weekly" as const,
        time_of_day: null,
        day_of_week: null,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs weekly")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] monthly schedule with day and time", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "monthly" as const,
        time_of_day: "08:00",
        day_of_month: 15,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs monthly on day 15 at 8:00 AM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] monthly schedule with no day and no time", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "monthly" as const,
        time_of_day: null,
        day_of_month: null,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs monthly")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] unknown schedule_type renders as-is", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "custom_schedule" as never,
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("custom_schedule")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] falls back to syncSummary.schedule when no refresh_config", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: null,
      synchronization_summary: {
        ...MOCK_DATA.synchronization_summary!,
        schedule: "Every 2 hours",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Every 2 hours")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshot with is_current=true shows 'In use' resolved status", () => {
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-ds",
            version: 3,
            status: "completed",
            total_files: 50,
            total_folders: 5,
            files_synced: 50,
            files_added: null,
            files_removed: null,
            used_knowledge_base: null,
            expired: false,
            is_current: true,
            created_at: "2024-07-01T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByText("In use")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync] snapshot with null files_added/removed renders 'n/a'", () => {
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-null",
            version: 4,
            status: "completed",
            total_files: 10,
            total_folders: 1,
            files_synced: 10,
            files_added: null,
            files_removed: null,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-07-10T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const rows = screen.getAllByTestId("snapshot-row")
    expect(rows[0].textContent).toContain("n/a")
  })

  it("[tag:dset-detail-sync] snapshot with null version renders '-' for name", () => {
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-nover",
            version: null,
            status: "pending",
            total_files: null,
            total_folders: null,
            files_synced: null,
            files_added: null,
            files_removed: null,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-08-01T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const rows = screen.getAllByTestId("snapshot-row")
    expect(rows[0].textContent).toContain("—")
  })

  it("[tag:dset-detail-sync][tag:success] remove snapshot success → shows success toast", async () => {
    const user = userEvent.setup()
    mockUpdateSnapshot.mockReturnValue({ unwrap: () => Promise.resolve({}) })

    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-rm",
            version: 1,
            status: "completed",
            total_files: 10,
            total_folders: 1,
            files_synced: 10,
            files_added: 5,
            files_removed: 0,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-06-15T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const removeBtn = screen.getByText("Remove")
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockUpdateSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          dsetId: "dset-1",
          snapshotId: "snap-rm",
          body: { deprecated: true },
        }),
      )
      expect(toast.success).toHaveBeenCalledWith("Snapshot removed successfully.")
    })
  })

  it("[tag:dset-detail-sync] disabled action buttons (Rollback, View changes) are clickable no-ops", async () => {
    const user = userEvent.setup()
    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-act",
            version: 1,
            status: "completed",
            total_files: 5,
            total_folders: 1,
            files_synced: 5,
            files_added: 2,
            files_removed: 0,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-05-01T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByText("Rollback"))
    await user.click(screen.getByText("View changes"))
  })

  it("[tag:dset-detail-sync] time_of_day without colon uses '00' as minute fallback", () => {
    const data = {
      ...MOCK_DATA,
      refresh_config: {
        ...MOCK_DATA.refresh_config!,
        schedule_type: "daily" as const,
        time_of_day: "9",
      },
    }
    renderWithProviders(<DatasetDetailSync data={data} />)

    expect(screen.getByText("Runs every day at 9:00 AM")).toBeInTheDocument()
  })

  it("[tag:dset-detail-sync][tag:error] rollback snapshot failure → shows error toast", async () => {
    const user = userEvent.setup()
    mockUpdateSnapshot.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })

    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-rb-fail",
            version: 3,
            status: "completed",
            total_files: 10,
            total_folders: 1,
            files_synced: 10,
            files_added: 1,
            files_removed: 0,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-06-15T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    await user.click(screen.getByText("Rollback"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to rollback snapshot.")
    })
  })

  // Restore is disabled — no backend un-expire endpoint exists yet.
  // POST /restore-version rolls back dataset config, not Iceberg snapshot data.
  // Re-enable (and split back into success/error cases) when the backend ships a real endpoint.
  it("[tag:dset-detail-sync] clicking Restore on an expired snapshot → shows not-supported error toast", async () => {
    const user = userEvent.setup()

    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-restore",
            version: 5,
            status: "completed",
            total_files: 10,
            total_folders: 1,
            files_synced: 10,
            files_added: 1,
            files_removed: 0,
            used_knowledge_base: null,
            expired: true,
            is_current: false,
            created_at: "2024-06-15T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    expect(screen.getByText("Restore")).toBeInTheDocument()
    await user.click(screen.getByText("Restore"))

    await waitFor(() => {
      expect(mockUpdateSnapshot).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith("Snapshot restore is not yet supported.")
    })
  })

  it("[tag:dset-detail-sync][tag:error] remove snapshot failure → shows error toast", async () => {
    const user = userEvent.setup()
    mockUpdateSnapshot.mockReturnValue({ unwrap: () => Promise.reject(new Error("fail")) })

    mockListSnapshots.mockReturnValue({
      data: {
        snapshots: [
          {
            id: "snap-fail",
            version: 2,
            status: "completed",
            total_files: 10,
            total_folders: 1,
            files_synced: 10,
            files_added: 1,
            files_removed: 0,
            used_knowledge_base: null,
            expired: false,
            is_current: false,
            created_at: "2024-06-15T10:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(<DatasetDetailSync data={MOCK_DATA} />)

    const removeBtn = screen.getByText("Remove")
    await user.click(removeBtn)

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to remove snapshot.")
    })
  })
})
