import { screen, waitFor, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { KBSynchronizationConfig } from "@/api/kb.types"

// ---------------------------------------------------------------------------
// Module mocks – schedule content component stub
// ---------------------------------------------------------------------------

vi.mock("../create-edit/form/kb-sync-schedule-content", () => ({
  KBSyncScheduleContent: () => <div data-testid="schedule-content">Schedule fields</div>,
}))

import { KBSyncSettingsDialog } from "./kb-sync-settings-dialog"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  isLoading: false,
  initialSyncConfig: null as KBSynchronizationConfig | null,
  onConfirm: vi.fn(),
}

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
  const props = { ...defaultProps, ...overrides }
  return renderWithProviders(<KBSyncSettingsDialog {...props} />)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBSyncSettingsDialog", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-sync-dialog] renders dialog content when open=true", () => {
    renderDialog()
    expect(screen.getByText("Edit synchronization settings")).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] does not render content when open=false", () => {
    renderDialog({ open: false })
    expect(screen.queryByText("Edit synchronization settings")).not.toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] renders radio group with sync mode options", () => {
    renderDialog()
    expect(screen.getByText("Synchronize manually")).toBeInTheDocument()
    expect(screen.getByText("Synchronize after dataset updates")).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] manual mode shows manual helper text", () => {
    renderDialog()
    expect(
      screen.getByText("This knowledge base will need to be manually synchronized from the detail page."),
    ).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] clicking 'after dataset updates' radio shows its helper text", async () => {
    const user = userEvent.setup()
    renderDialog()

    const afterRadio = screen.getByText("Synchronize after dataset updates")
    await user.click(afterRadio)

    await waitFor(() => {
      expect(
        screen.getByText("Synchronization will start automatically after each dataset synchronization completes."),
      ).toBeInTheDocument()
    })
  })

  it("[tag:kb-sync-dialog] Save button is present", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] Cancel button is present", () => {
    renderDialog()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] Cancel calls onClose when not busy", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog({ onClose })

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:kb-sync-dialog] Cancel does not call onClose when loading", () => {
    const onClose = vi.fn()
    renderDialog({ isLoading: true, onClose })

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it("[tag:kb-sync-dialog] Save button submits form and calls onConfirm", async () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    const user = userEvent.setup()
    renderDialog({ onConfirm })

    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalled()
    })
  })

  it("[tag:kb-sync-dialog] initialSyncConfig prefills the form defaults", () => {
    renderDialog({
      initialSyncConfig: {
        sync_mode: "after_dataset_updates",
      },
    })

    expect(
      screen.getByText("Synchronization will start automatically after each dataset synchronization completes."),
    ).toBeInTheDocument()
  })

  it("[tag:kb-sync-dialog] onOpenChange does not call onClose when isLoading is true", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog({ isLoading: true, onClose })

    await user.keyboard("{Escape}")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("[tag:kb-sync-dialog] onOpenChange calls onClose when not loading and dialog closes", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    renderDialog({ isLoading: false, onClose })

    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:kb-sync-dialog] selecting 'scheduled' mode shows schedule content", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByText("Sync on Knowledge Base schedule"))

    await waitFor(() => {
      expect(screen.getByTestId("schedule-content")).toBeInTheDocument()
    })
  })

  it("[tag:kb-sync-dialog] prefilling with scheduled config shows schedule content", () => {
    renderDialog({
      initialSyncConfig: {
        sync_mode: "scheduled",
        schedule_type: "daily",
      },
    })

    expect(screen.getByTestId("schedule-content")).toBeInTheDocument()
  })
})
