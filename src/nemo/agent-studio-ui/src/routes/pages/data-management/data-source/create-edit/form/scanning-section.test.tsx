import { screen, render } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { ScanningSection } from "./scanning-section"
import { getScanNotice } from "@/components/data-source/utils/scan-notice"

// ---------------------------------------------------------------------------
// getScanNotice — direct unit tests (all 4 branches)
// ---------------------------------------------------------------------------

describe("getScanNotice", () => {
  it("[tag:get-scan-notice] depth='none' → disabled notice text", () => {
    const { text } = getScanNotice("none", null)
    expect(text).toBe("Scanning is disabled on this data source.")
  })

  it("[tag:get-scan-notice] depth='none' → icon uses disabled color", () => {
    const { icon } = getScanNotice("none", null)
    const { container } = render(icon)
    expect(container.querySelector("svg")!.style.color).toBe("var(--text-disabled)")
  })

  it("[tag:get-scan-notice] depth='top_2_levels' → enabled notice with depth label", () => {
    const { text } = getScanNotice("top_2_levels", null)
    expect(text).toBe("Scanning of top 2 folder levels enabled on this data source.")
  })

  it("[tag:get-scan-notice] depth='top_2_levels' → icon uses success color", () => {
    const { icon } = getScanNotice("top_2_levels", null)
    const { container } = render(icon)
    expect(container.querySelector("svg")!.style.color).toBe("var(--notification-success)")
  })

  it("[tag:get-scan-notice] depth='custom' + non-null customDepth → notice uses 'top N folder levels'", () => {
    const { text } = getScanNotice("custom", 7)
    expect(text).toBe("Scanning of top 7 folder levels enabled on this data source.")
  })

  it("[tag:get-scan-notice] depth='custom' + null customDepth → notice uses base 'custom' label", () => {
    const { text } = getScanNotice("custom", null)
    // SCAN_DEPTH_LABELS["custom"] = "Custom" → lowercased to "custom"
    expect(text).toBe("Scanning of custom enabled on this data source.")
  })
})

// ---------------------------------------------------------------------------
// Section 11.9, 11.9b, 11.9c, 11.9d — ScanningSection notice states
// ---------------------------------------------------------------------------

describe("ScanningSection", () => {
  // 11.9
  it("[tag:scanning-section] scanDepth='none' → disabled icon, 'Scanning is disabled' notice, 'Enable' button", () => {
    const onOpen = vi.fn()
    renderWithProviders(<ScanningSection scanDepth="none" customDepth={null} onOpenDialog={onOpen} />)

    expect(screen.getByText("Scanning is disabled on this data source.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Modify" })).not.toBeInTheDocument()
  })

  // 11.9b
  it("[tag:scanning-section] scanDepth='top_2_levels' → green check icon, enabled notice, 'Modify' button", () => {
    const onOpen = vi.fn()
    renderWithProviders(<ScanningSection scanDepth="top_2_levels" customDepth={null} onOpenDialog={onOpen} />)

    expect(screen.getByText(/top 2 folder levels/i)).toBeInTheDocument()
    expect(screen.getByText(/scanning of/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument()
  })

  // 11.9c
  it("[tag:scanning-section] scanDepth='custom' + non-null customDepth → notice includes 'top 5 folder levels'", () => {
    const onOpen = vi.fn()
    renderWithProviders(<ScanningSection scanDepth="custom" customDepth={5} onOpenDialog={onOpen} />)

    expect(screen.getByText(/top 5 folder levels/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument()
  })

  // 11.9d
  it("[tag:scanning-section] scanDepth='custom' + customDepth null → notice uses base 'custom' label", () => {
    const onOpen = vi.fn()
    renderWithProviders(<ScanningSection scanDepth="custom" customDepth={null} onOpenDialog={onOpen} />)

    // SCAN_DEPTH_LABELS["custom"] = "Custom" → lowercase = "custom"
    expect(screen.getByText(/scanning of custom enabled/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Modify" })).toBeInTheDocument()
  })

  it("[tag:scanning-section] clicking the button calls onOpenDialog", async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    renderWithProviders(<ScanningSection scanDepth="none" customDepth={null} onOpenDialog={onOpen} />)

    await user.click(screen.getByRole("button", { name: "Enable" }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
