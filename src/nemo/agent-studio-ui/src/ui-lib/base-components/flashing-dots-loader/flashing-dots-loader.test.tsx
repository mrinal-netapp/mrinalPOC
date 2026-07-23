import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { renderWithProviders } from "@test/render"
import { FlashingDotsLoader } from "./flashing-dots-loader"

describe("FlashingDotsLoader", () => {
  it("[tag:loader] should render status container with ARIA attributes and 3 dots by default", () => {
    // Setup & Execute
    renderWithProviders(<FlashingDotsLoader />)

    // Validate
    const container = screen.getByRole("status", { name: "Loading" })
    expect(container).toBeInTheDocument()
    expect(container).toHaveClass("flashing-dots-loader")

    const dots = container.querySelectorAll(".dot-flashing")
    expect(dots).toHaveLength(3)
  })

  it("[tag:loader][tag:variant][tag:isGrey] should apply grey class when isGrey is true", () => {
    // Setup & Execute
    renderWithProviders(<FlashingDotsLoader isGrey />)

    // Validate
    const container = screen.getByRole("status", { name: "Loading" })
    expect(container).toHaveClass("grey")
  })

  it("[tag:loader][tag:variant][tag:isGrey] should not apply grey class when isGrey is false", () => {
    // Setup & Execute
    renderWithProviders(<FlashingDotsLoader isGrey={false} />)

    // Validate
    const container = screen.getByRole("status", { name: "Loading" })
    expect(container).not.toHaveClass("grey")
  })

  it("[tag:loader] should append custom className to the container", () => {
    // Setup & Execute
    renderWithProviders(<FlashingDotsLoader className="custom-class" />)

    // Validate
    const container = screen.getByRole("status", { name: "Loading" })
    expect(container).toHaveClass("custom-class")
    expect(container).toHaveClass("flashing-dots-loader")
  })
})
