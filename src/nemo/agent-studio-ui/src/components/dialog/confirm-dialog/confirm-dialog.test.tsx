import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { ConfirmDialog } from "./confirm-dialog"

// ---------------------------------------------------------------------------
// Section 3 — ConfirmDialog
// ---------------------------------------------------------------------------

describe("ConfirmDialog", () => {
  // 3.1
  it("[tag:confirm-dialog] renders title, description, and default labels", () => {
    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete item"
        description="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByText("Delete item")).toBeInTheDocument()
    expect(screen.getByText("Are you sure?")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  // 3.2
  it("[tag:confirm-dialog][tag:default] confirm button uses solid variant (no destructive class)", async () => {
    const { container } = renderWithProviders(
      <ConfirmDialog
        open
        title="Confirm"
        description="desc"
        variant="default"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const confirmBtn = screen.getByRole("button", { name: "Confirm" })
    expect(confirmBtn).toBeInTheDocument()
    // Should NOT have destructive styling
    expect(container.innerHTML).not.toMatch(/solid-destructive/)
  })

  // 3.3
  it("[tag:confirm-dialog][tag:danger] confirm button uses solid-destructive variant", () => {
    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete"
        description="desc"
        variant="danger"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    // Dialog renders via portal into document.body — check the confirm button has destructive class
    const confirmBtn = screen.getByRole("button", { name: "Confirm" })
    expect(confirmBtn).toBeInTheDocument()
    // Button component applies variant class — destructive variant renders as btn-variant-solid-destructive
    expect(document.body.innerHTML).toMatch(/destructive/)
  })

  // 3.4
  it("[tag:confirm-dialog][tag:loading] cancel button is disabled when loading", async () => {
    renderWithProviders(
      <ConfirmDialog
        open
        title="Loading test"
        description="desc"
        loading
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const cancelBtn = screen.getByRole("button", { name: "Cancel" })
    expect(cancelBtn).toBeDisabled()
  })

  // 3.5
  it("[tag:confirm-dialog] onConfirm fires when confirm clicked", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()

    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete"
        description="desc"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Confirm" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  // 3.6
  it("[tag:confirm-dialog] onCancel fires when cancel clicked", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()

    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete"
        description="desc"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  // 3.7
  it("[tag:confirm-dialog] onOpenChange(false) calls onCancel and the passed onOpenChange prop", async () => {
    const onCancel = vi.fn()
    const onOpenChange = vi.fn()
    const user = userEvent.setup()

    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete"
        description="desc"
        onConfirm={vi.fn()}
        onCancel={onCancel}
        onOpenChange={onOpenChange}
      />,
    )

    // Pressing Escape triggers dialog's onOpenChange(false)
    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledOnce()
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  // 3.9 — Gap 4: covers `onOpenChange?.(nextOpen)` optional-call false-branch (line 42) when
  //         onOpenChange is not provided and the dialog is dismissed via Escape
  it("[tag:confirm-dialog] Escape without onOpenChange prop calls onCancel and does not throw", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()

    renderWithProviders(
      <ConfirmDialog
        open
        title="Delete"
        description="desc"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      // intentionally omitting onOpenChange
      />,
    )

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledOnce()
    })
  })

  // 3.10
  it("[tag:confirm-dialog][tag:loading] Escape while loading is true does not close the dialog or call onCancel", async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    const onOpenChange = vi.fn()

    renderWithProviders(
      <ConfirmDialog
        open
        title="Loading"
        description="desc"
        loading
        onConfirm={vi.fn()}
        onCancel={onCancel}
        onOpenChange={onOpenChange}
      />,
    )

    await user.keyboard("{Escape}")

    expect(onCancel).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // 3.8
  it("[tag:confirm-dialog] custom confirmLabel and cancelLabel override defaults", () => {
    renderWithProviders(
      <ConfirmDialog
        open
        title="Deactivate"
        description="desc"
        confirmLabel="Yes, deactivate"
        cancelLabel="Keep active"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "Yes, deactivate" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Keep active" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })
})
