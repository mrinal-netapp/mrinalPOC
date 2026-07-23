import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

vi.mock("./kb-list-content", () => ({
  KBListContent: () => <div data-testid="kb-list-content" />,
}))

import { KBListPage } from "./kb-list-page"

describe("KBListPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:kb-list-page] renders page title", () => {
    renderWithProviders(<KBListPage />)
    expect(screen.getByText("Knowledge Bases")).toBeInTheDocument()
  })

  it("[tag:kb-list-page] renders page subtitle", () => {
    renderWithProviders(<KBListPage />)
    expect(screen.getByText(/knowledge base is a collection/)).toBeInTheDocument()
  })

  it("[tag:kb-list-page] renders KBListContent component", () => {
    renderWithProviders(<KBListPage />)
    expect(screen.getByTestId("kb-list-content")).toBeInTheDocument()
  })
})
