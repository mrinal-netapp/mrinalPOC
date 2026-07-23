import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { ScanningSettingsDialog } from "./scanning-settings-dialog"

// ---------------------------------------------------------------------------
// Section 6 — ScanningSettingsDialog
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  open: true,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
  initialScanDepth: "none" as const,
  initialCustomDepth: null,
}

describe("ScanningSettingsDialog", () => {
  // 6.1
  it("[tag:scanning-settings-dialog] all SCAN_DEPTH_OPTIONS radio options render", () => {
    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} />)

    expect(screen.getByRole("radio", { name: /None/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /All folder levels/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Top 5 folder levels/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Top 2 folder levels/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /Custom folder level amount/ })).toBeInTheDocument()
  })

  // 6.2
  it("[tag:scanning-settings-dialog][tag:custom] selecting 'custom' enables the custom depth input", async () => {
    const user = userEvent.setup()

    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} />)

    // The input starts disabled (none is selected) — use type=number input role
    const input = screen.getByRole("spinbutton")
    expect(input).toBeDisabled()

    // Click the "Custom folder level amount" radio
    const customOption = screen.getByRole("radio", { name: /Custom folder level amount/i })
    await user.click(customOption)

    expect(input).not.toBeDisabled()
  })

  // 6.3
  it("[tag:scanning-settings-dialog][tag:disabled] custom depth input disabled for non-custom depths", () => {
    renderWithProviders(
      <ScanningSettingsDialog {...DEFAULT_PROPS} initialScanDepth="top_2_levels" />,
    )

    const input = screen.getByRole("spinbutton")
    expect(input).toBeDisabled()
  })

  // 6.4
  it("[tag:scanning-settings-dialog][tag:create] isEdit=false shows 'Enable data source scanning' title and 'Confirm' button", () => {
    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} isEdit={false} />)

    expect(screen.getByText("Enable data source scanning")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument()
  })

  // 6.5
  it("[tag:scanning-settings-dialog][tag:edit] isEdit=true shows 'Edit' title and 'Save' button", () => {
    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} isEdit />)

    expect(screen.getByText("Edit data source scanning")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()
  })

  // 6.6
  it("[tag:scanning-settings-dialog][tag:loading] isLoading=true disables Cancel button", () => {
    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} isLoading />)

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
  })

  // 6.7
  it("[tag:scanning-settings-dialog][tag:loading] dialog close is no-op while loading", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <ScanningSettingsDialog {...DEFAULT_PROPS} isLoading onClose={onClose} />,
    )

    await user.keyboard("{Escape}")

    // onClose should NOT be called because handleCancel guards against isLoading
    await waitFor(() => {
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  // 6.8
  it("[tag:scanning-settings-dialog] onConfirm called with selected scanDepth and customDepth", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    renderWithProviders(
      <ScanningSettingsDialog
        {...DEFAULT_PROPS}
        initialScanDepth="top_5_levels"
        onConfirm={onConfirm}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(onConfirm).toHaveBeenCalledWith("top_5_levels", null)
  })

  // 6.9
  it("[tag:scanning-settings-dialog] onClose called when Cancel clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    renderWithProviders(<ScanningSettingsDialog {...DEFAULT_PROPS} onClose={onClose} />)

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  // 6.10
  it("[tag:scanning-settings-dialog] opening dialog syncs initialScanDepth and initialCustomDepth", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    renderWithProviders(
      <ScanningSettingsDialog
        {...DEFAULT_PROPS}
        initialScanDepth="custom"
        initialCustomDepth={7}
        onConfirm={onConfirm}
      />,
    )

    // Confirm without changing anything — should use the initialised values
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(onConfirm).toHaveBeenCalledWith("custom", 7)
  })

  // 6.11 — covers line 67: localCustomDepth || 1 fallback when initialCustomDepth=0
  // onChange enforces || 1 so the only way to start with 0 is via the prop.
  it("[tag:scanning-settings-dialog][tag:custom] initialCustomDepth=0 falls back to 1 on confirm", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    renderWithProviders(
      <ScanningSettingsDialog
        {...DEFAULT_PROPS}
        initialScanDepth="custom"
        initialCustomDepth={0}
        onConfirm={onConfirm}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Confirm" }))

    expect(onConfirm).toHaveBeenCalledWith("custom", 1)
  })

  // Gap 5: handleOpen (lines 55-58) is called when Dialog.onOpenChange fires with true.
  // BaseUI's controlled Dialog does NOT fire onOpenChange(true) on external prop changes,
  // only on internal user-triggered open events (e.g. trigger click). Since this dialog has
  // no built-in trigger, handleOpen is untestable via RTL without mocking BaseUI internals.
  //
  // Covered behaviour: test 6.10 already verifies that useState initialises from the prop
  // on first render, which is the primary consumer of initialScanDepth/initialCustomDepth.
})
