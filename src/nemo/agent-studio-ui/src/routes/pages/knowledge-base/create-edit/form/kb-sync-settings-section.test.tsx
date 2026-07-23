import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBSyncSettingsSection } from "./kb-sync-settings-section"
import { TestFormWrapper } from "./test-helpers"

vi.mock("./kb-sync-schedule-content", () => ({
  KBSyncScheduleContent: () => <div data-testid="schedule-content">Schedule fields</div>,
}))

describe("KBSyncSettingsSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-sync-section] renders section header", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncSettingsSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Sync settings")).toBeInTheDocument()
    expect(screen.getByText(/Choose how this knowledge base stays in sync/)).toBeInTheDocument()
  })

  it("[tag:kb-sync-section] renders sync mode radio options", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncSettingsSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Synchronize manually")).toBeInTheDocument()
    expect(screen.getByText("Synchronize after dataset updates")).toBeInTheDocument()
    expect(screen.getByText("Sync on Knowledge Base schedule")).toBeInTheDocument()
  })

  it("[tag:kb-sync-section] schedule content hidden when mode is manual (default)", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncSettingsSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.queryByTestId("schedule-content")).not.toBeInTheDocument()
  })

  it("[tag:kb-sync-section] switching to scheduled mode shows schedule content", async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBSyncSettingsSection form={form} />}</TestFormWrapper>,
    )

    await user.click(screen.getByText("Sync on Knowledge Base schedule"))
    expect(screen.getByTestId("schedule-content")).toBeInTheDocument()
  })
})
