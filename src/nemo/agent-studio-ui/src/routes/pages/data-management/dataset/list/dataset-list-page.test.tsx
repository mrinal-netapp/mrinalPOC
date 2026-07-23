import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("./dataset-list-content", () => ({
  DatasetListContent: () => <div data-testid="dataset-list-content" />,
}))

// Suppress CSS import error in test environment
vi.mock("../../data-management-page.scss", () => ({}))

import { DatasetListPage } from "./dataset-list-page"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetListPage", () => {
  it("[tag:dataset-list-page] renders the page heading 'Datasets'", () => {
    renderWithProviders(<DatasetListPage />)

    expect(screen.getByRole("heading", { level: 1, name: "Datasets" })).toBeInTheDocument()
  })

  it("[tag:dataset-list-page] renders the datasets list content", () => {
    renderWithProviders(<DatasetListPage />)

    expect(screen.getByTestId("dataset-list-content")).toBeInTheDocument()
  })

  it("[tag:dataset-list-page] renders the subtitle text", () => {
    renderWithProviders(<DatasetListPage />)

    expect(
      screen.getByText(/create datasets that organize the content/i),
    ).toBeInTheDocument()
  })
})
