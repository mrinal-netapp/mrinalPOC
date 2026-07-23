import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { DataSourceDetail, ScanDepth } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUpdateDataSource = vi.fn()
const mockTriggerScan = vi.fn()

vi.mock("@/api/data-source-api.slice", () => ({
  useUpdateDataSourceMutation: vi.fn(),
  useTriggerManualScanMutation: vi.fn(),
}))

vi.mock("@/components/data-source/browse-data-source-dialog", () => ({
  FolderBrowserDialog: ({
    open,
    onClose,
  }: {
    open: boolean
    onClose: () => void
  }) =>
    open ? (
      <div data-testid="folder-browser-dialog">
        <button onClick={onClose}>Close folder browser</button>
      </div>
    ) : null,
}))

vi.mock("../scanning-settings-dialog", () => ({
  ScanningSettingsDialog: ({
    open,
    onConfirm,
    onClose,
  }: {
    open: boolean
    onConfirm: (depth: ScanDepth, custom: number | null) => void
    onClose: () => void
  }) =>
    open ? (
      <div data-testid="scanning-settings-dialog">
        <button onClick={() => onConfirm("all_levels", null)}>Confirm scan settings</button>
        <button onClick={() => onConfirm("custom", 5)}>Confirm custom scan settings</button>
        <button onClick={onClose}>Close scan dialog</button>
      </div>
    ) : null,
}))

vi.mock("@/ui-lib/base-components/toast/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { useUpdateDataSourceMutation, useTriggerManualScanMutation } from "@/api/data-source-api.slice"
import { toast } from "@/ui-lib/base-components/toast/toast"
import { DataSourceDetailScanning } from "./data-source-detail-scanning"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: DataSourceDetail = {
  dsrc_id: "ds-1",
  name: "Test Source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: null,
  connection: {
    server: "nfs.example.com",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "",
  },
  modified_by: "admin",
  scan: {
    status: "Completed",
    scan_depth: "all_levels",
    custom_depth: null,
    total_files: 1500,
    total_folders: 80,
    total_size_bytes: 524_288_000,
    last_completed_at: "2024-06-15T08:00:00Z",
    status_message: null,
    file_type_stats: null,
  },
  scanned_data_count: 1500,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

function setupUpdateMock(result: { unwrap: () => Promise<unknown> } = { unwrap: () => Promise.resolve({}) }) {
  mockUpdateDataSource.mockReturnValue(result)
  vi.mocked(useUpdateDataSourceMutation).mockReturnValue([mockUpdateDataSource, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useUpdateDataSourceMutation>)
}

function setupScanMock(result: { unwrap: () => Promise<unknown> } = { unwrap: () => Promise.resolve({}) }) {
  mockTriggerScan.mockReturnValue(result)
  vi.mocked(useTriggerManualScanMutation).mockReturnValue([mockTriggerScan, { isLoading: false, reset: vi.fn() }] as unknown as ReturnType<typeof useTriggerManualScanMutation>)
}

// ---------------------------------------------------------------------------
// Section 10.6–10.12 — DataSourceDetailScanning
// ---------------------------------------------------------------------------

describe("DataSourceDetailScanning", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateMock()
    setupScanMock()
  })

  // 10.6
  it("[tag:ds-detail-scanning] scan metrics grid rendered with formatted values", () => {
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    // Status
    expect(screen.getByText("Scan status")).toBeInTheDocument()
    // Configuration
    expect(screen.getByText("Configuration")).toBeInTheDocument()
    // Last completed scan
    expect(screen.getByText("Last completed scan")).toBeInTheDocument()
    // Numeric values
    expect(screen.getByText("Files")).toBeInTheDocument()
    expect(screen.getByText("Folders")).toBeInTheDocument()
    expect(screen.getByText("Size")).toBeInTheDocument()
    // Formatted numbers
    expect(screen.getByText("1,500")).toBeInTheDocument()
    expect(screen.getByText("80")).toBeInTheDocument()
  })

  // 10.7
  it("[tag:ds-detail-scanning][tag:scanning] Scan button and dropdown disabled when scan_status=Scanning", () => {
    const data = { ...MOCK_DATA, scan_status: "Scanning" as const }
    renderWithProviders(<DataSourceDetailScanning data={data} />)

    const scanBtn = screen.getByRole("button", { name: "Scan" })
    expect(scanBtn).toBeDisabled()
  })

  // 10.8
  it("[tag:ds-detail-scanning][tag:scanning-settings-dialog] 'Edit scanning settings' click opens dialog", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    // Open the dropdown first
    const actionsBtn = screen.getByRole("button", { name: "Scanning actions" })
    await user.click(actionsBtn)

    const editItem = await screen.findByText("Edit scanning settings")
    await user.click(editItem)

    expect(screen.getByTestId("scanning-settings-dialog")).toBeInTheDocument()
  })

  // 10.9
  it("[tag:ds-detail-scanning] dialog confirm calls updateDataSource with new scan config", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    // Open dropdown and click edit
    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("Edit scanning settings"))

    // Confirm the dialog
    await user.click(screen.getByText("Confirm scan settings"))

    expect(mockUpdateDataSource).toHaveBeenCalledWith(
      expect.objectContaining({
        dsrcId: "ds-1",
        body: expect.objectContaining({
          scan_config: expect.objectContaining({
            scan_depth: "all_levels",
            custom_depth: null,
          }),
        }),
      }),
    )
  })

  // 10.9b — covers line 83: custom_depth: scanDepth === "custom" ? customDepth : null
  it("[tag:ds-detail-scanning] dialog confirm with custom depth passes customDepth to updateDataSource", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("Edit scanning settings"))
    await user.click(screen.getByText("Confirm custom scan settings"))

    expect(mockUpdateDataSource).toHaveBeenCalledWith(
      expect.objectContaining({
        dsrcId: "ds-1",
        body: expect.objectContaining({
          scan_config: expect.objectContaining({
            scan_depth: "custom",
            custom_depth: 5,
          }),
        }),
      }),
    )
  })

  // 10.10
  it("[tag:ds-detail-scanning][tag:success] save success → toast message", async () => {
    const user = userEvent.setup()
    setupUpdateMock({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("Edit scanning settings"))
    await user.click(screen.getByText("Confirm scan settings"))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Scanning settings updated successfully.")
    })
  })

  // 10.11
  it("[tag:ds-detail-scanning][tag:error] save failure → error toast", async () => {
    const user = userEvent.setup()
    setupUpdateMock({ unwrap: () => Promise.reject(new Error("Failed")) })
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("Edit scanning settings"))
    await user.click(screen.getByText("Confirm scan settings"))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to update scanning settings.")
    })
  })

  // Covers line 172: onClose={() => setEditDialogOpen(false)}
  it("[tag:ds-detail-scanning] closing scan settings dialog without confirming", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("Edit scanning settings"))

    expect(screen.getByTestId("scanning-settings-dialog")).toBeInTheDocument()

    await user.click(screen.getByText("Close scan dialog"))

    await waitFor(() => {
      expect(screen.queryByTestId("scanning-settings-dialog")).not.toBeInTheDocument()
    })
  })

  // 10.12
  it("[tag:ds-detail-scanning] null metric values show '-' via formatNumber/formatBytes", () => {
    const data = { ...MOCK_DATA, scan: null }
    renderWithProviders(<DataSourceDetailScanning data={data} />)

    // null scan → formatNumber(undefined) = "-", formatBytes(undefined) = "-"
    const dashes = screen.getAllByText("-")
    expect(dashes.length).toBeGreaterThanOrEqual(3) // files, folders, size all "-"
  })

  // Gap 10a: covers the Scan button onClick stub (line 92)
  it("[tag:ds-detail-scanning] clicking enabled Scan button does not throw", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    const scanBtn = screen.getByRole("button", { name: "Scan" })
    expect(scanBtn).not.toBeDisabled()
    await user.click(scanBtn)

    // No error; component remains intact
    expect(screen.getByText("Scan status")).toBeInTheDocument()
  })

  // Gap 10b: covers the "View scanned data" onClick — opens FolderBrowserDialog
  it("[tag:ds-detail-scanning] clicking 'View scanned data' dropdown item opens folder browser", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    const viewItem = await screen.findByText("View scanned data")
    await user.click(viewItem)

    expect(screen.getByTestId("folder-browser-dialog")).toBeInTheDocument()
  })

  // Covers line 201: FolderBrowserDialog onClose callback
  it("[tag:ds-detail-scanning] closing folder browser dialog sets viewDataOpen to false", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scanning actions" }))
    await user.click(await screen.findByText("View scanned data"))
    expect(screen.getByTestId("folder-browser-dialog")).toBeInTheDocument()

    await user.click(screen.getByText("Close folder browser"))
    await waitFor(() => {
      expect(screen.queryByTestId("folder-browser-dialog")).not.toBeInTheDocument()
    })
  })

  // Gap 3a: Scan button success → toast.success (covers line 68)
  it("[tag:ds-detail-scanning][tag:success] Scan button success → shows success toast", async () => {
    const user = userEvent.setup()
    setupScanMock({ unwrap: () => Promise.resolve({}) })
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scan" }))

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Scan started successfully.")
    })
  })

  // Covers line 158: `scan?.last_completed_at ? formatDateTimeFull(...) : "-"` truthy branch
  it("[tag:ds-detail-scanning] renders formatted scan.last_completed_at when set", () => {
    const data = {
      ...MOCK_DATA,
      scan: { ...MOCK_DATA.scan!, last_completed_at: "2024-06-20T10:30:00Z" },
    }
    renderWithProviders(<DataSourceDetailScanning data={data} />)

    // The formatted date appears under the "Last completed scan" label
    expect(screen.getByText(/Jun 20, 2024/)).toBeInTheDocument()
  })

  // Gap 3b: Scan button error → toast.error (covers line 70)
  it("[tag:ds-detail-scanning][tag:error] Scan button failure → shows error toast", async () => {
    const user = userEvent.setup()
    setupScanMock({ unwrap: () => Promise.reject(new Error("scan error")) })
    renderWithProviders(<DataSourceDetailScanning data={MOCK_DATA} />)

    await user.click(screen.getByRole("button", { name: "Scan" }))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to start scan.")
    })
  })
})
