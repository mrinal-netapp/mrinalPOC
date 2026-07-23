import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBDataChangeThresholdSection } from "./kb-data-change-threshold-section"
import { TestFormWrapper } from "./test-helpers"

describe("KBDataChangeThresholdSection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-threshold-section] renders section header", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDataChangeThresholdSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Data change threshold")).toBeInTheDocument()
  })

  it("[tag:kb-threshold-section] toggle is rendered", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDataChangeThresholdSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText("Enable data change threshold")).toBeInTheDocument()
  })

  it("[tag:kb-threshold-section] disabled by default shows warning notice", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDataChangeThresholdSection form={form} />}</TestFormWrapper>,
    )
    expect(screen.getByText(/a new version is created for each file change/i)).toBeInTheDocument()
  })

  it("[tag:kb-threshold-section] enabling toggle shows threshold input", () => {
    renderWithProviders(
      <TestFormWrapper overrides={{ data_change_threshold_enabled: true }}>
        {(form) => <KBDataChangeThresholdSection form={form} />}
      </TestFormWrapper>,
    )
    expect(screen.getByPlaceholderText("1")).toBeInTheDocument()
  })
})
