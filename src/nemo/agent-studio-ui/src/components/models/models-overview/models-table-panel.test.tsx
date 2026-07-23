import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

const mockNavigate = vi.fn()
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router")
  return { ...actual, useNavigate: () => mockNavigate }
})

import { ModelsTablePanel } from "./models-table-panel"

describe("ModelsTablePanel", () => {
  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    mockNavigate.mockClear()
  })
  afterEach(() => roCleanup?.())

  it("[tag:models-panel] renders the models table with its column headers", () => {
    renderWithProviders(<ModelsTablePanel />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Type")).toBeInTheDocument()
    expect(screen.getByText("Provider")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
  })

  it("[tag:models-panel] exposes a Refresh action that pulls connection health", () => {
    renderWithProviders(<ModelsTablePanel />)
    expect(screen.getByRole("button", { name: /Refresh/i })).toBeInTheDocument()
  })
})
