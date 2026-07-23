import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders } from "@test/render"
import { EvalPropertyStatus } from "./eval-property-status"

describe("EvalPropertyStatus", () => {
  it("[tag:eval] renders a positive label with a success glyph", () => {
    const { container } = renderWithProviders(<EvalPropertyStatus label="Enabled" />)

    expect(screen.getByText("Enabled")).toBeInTheDocument()
    expect(container.querySelector(".eval-property-status__icon")).toBeInTheDocument()
  })

  it("[tag:eval] renders a negative label with a muted glyph", () => {
    const { container } = renderWithProviders(<EvalPropertyStatus label="Disabled" />)

    expect(screen.getByText("Disabled")).toBeInTheDocument()
    expect(container.querySelector(".eval-property-status__icon")).toBeInTheDocument()
  })

  it("[tag:eval] renders a neutral label without any glyph", () => {
    const { container } = renderWithProviders(<EvalPropertyStatus label="Draft" />)

    expect(screen.getByText("Draft")).toBeInTheDocument()
    expect(container.querySelector(".eval-property-status__icon")).not.toBeInTheDocument()
  })
})
