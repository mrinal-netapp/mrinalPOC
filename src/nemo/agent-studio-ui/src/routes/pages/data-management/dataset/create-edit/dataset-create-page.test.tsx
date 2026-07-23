import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

vi.mock("./form/dataset-form", () => ({
  DatasetForm: () => <div data-testid="dataset-form" />,
}))

import { DatasetCreatePage } from "./dataset-create-page"

// ---------------------------------------------------------------------------
// DatasetCreatePage
// ---------------------------------------------------------------------------

describe("DatasetCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:dataset-create-page] renders DatasetForm and remounts on location pathname change", () => {
    const { unmount } = renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/datasets/create",
          element: <DatasetCreatePage />,
        },
      ],
      initialEntries: ["/datasets/create"],
    })

    expect(screen.getByTestId("dataset-form")).toBeInTheDocument()

    unmount()

    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/datasets/create-alt",
          element: <DatasetCreatePage />,
        },
      ],
      initialEntries: ["/datasets/create-alt"],
    })

    expect(screen.getByTestId("dataset-form")).toBeInTheDocument()
  })
})
