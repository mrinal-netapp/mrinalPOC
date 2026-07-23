import { screen } from "@testing-library/react"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

import { ProvidersTablePanel } from "./providers-table-panel"

describe("ProvidersTablePanel", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:providers-panel] renders the providers table with its column headers", () => {
    renderWithProviders(<ProvidersTablePanel />)
    expect(screen.getByText("Provider")).toBeInTheDocument()
    expect(screen.getByText("Connection status")).toBeInTheDocument()
    expect(screen.getByText("Capabilities")).toBeInTheDocument()
  })
})
