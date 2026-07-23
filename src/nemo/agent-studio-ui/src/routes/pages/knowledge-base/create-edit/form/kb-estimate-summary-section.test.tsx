import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import { KBEstimateSummarySection } from "./kb-estimate-summary-section"

describe("KBEstimateSummarySection", () => {
  let roCleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:kb-estimate-section] renders section header", () => {
    renderWithProviders(<KBEstimateSummarySection />)
    expect(screen.getByText(/Estimated build summary/)).toBeInTheDocument()
  })

  it("[tag:kb-estimate-section] renders index size metric", () => {
    renderWithProviders(<KBEstimateSummarySection />)
    expect(screen.getByText("Index size")).toBeInTheDocument()
    expect(screen.getByText("2.4")).toBeInTheDocument()
  })

  it("[tag:kb-estimate-section] renders build time metric", () => {
    renderWithProviders(<KBEstimateSummarySection />)
    expect(screen.getByText("Build time")).toBeInTheDocument()
    expect(screen.getByText("25-35")).toBeInTheDocument()
  })

  it("[tag:kb-estimate-section] renders info notice", () => {
    renderWithProviders(<KBEstimateSummarySection />)
    expect(screen.getByText(/build process will scan files/)).toBeInTheDocument()
  })
})
