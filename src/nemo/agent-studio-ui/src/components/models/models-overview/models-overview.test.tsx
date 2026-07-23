import { screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

import { ModelsOverview } from "./models-overview"

describe("ModelsOverview", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
  })
  afterEach(() => roCleanup?.())

  it("[tag:models-overview] renders the heading, lede, and the Providers tab by default", () => {
    renderWithProviders(<ModelsOverview />)

    expect(screen.getByRole("heading", { name: "Models", level: 1 })).toBeInTheDocument()
    expect(
      screen.getByText(/Manage the LLMs and embedding models for your agents/),
    ).toBeInTheDocument()
    // Providers tab is active first → providers table headers are present.
    expect(screen.getByText("Connection status")).toBeInTheDocument()
    expect(screen.getByText("Capabilities")).toBeInTheDocument()
  })

  it("[tag:models-overview] switches to the Models tab", async () => {
    renderWithProviders(<ModelsOverview />)

    await userEvent.click(screen.getByRole("tab", { name: "Models" }))

    expect(await screen.findByText("Type")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
  })
})
