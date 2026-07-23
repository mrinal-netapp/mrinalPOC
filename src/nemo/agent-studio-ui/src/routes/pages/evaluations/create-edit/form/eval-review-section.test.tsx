import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"
import { EvalReviewSection } from "./eval-review-section"

describe("EvalReviewSection", () => {
  it("[tag:eval] shows the higher estimate and judge copy for judge-based strategies", () => {
    renderWithProviders(<EvalReviewSection strategy="both" />)

    expect(screen.getByText("6.1")).toBeInTheDocument()
    expect(screen.getByText("$0.90")).toBeInTheDocument()
    expect(screen.getByText(/score judge dimensions/)).toBeInTheDocument()
  })

  it("[tag:eval] shows the lower estimate and deterministic-only copy", () => {
    renderWithProviders(<EvalReviewSection strategy="deterministic" />)

    expect(screen.getByText("1.8")).toBeInTheDocument()
    expect(screen.getByText("$0.12")).toBeInTheDocument()
    expect(screen.getByText(/No AI judge scoring/)).toBeInTheDocument()
  })
})
