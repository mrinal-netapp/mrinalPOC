import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

// Mock DataSourceForm to keep the test isolated from form complexity
vi.mock("./form/data-source-form", () => ({
  DataSourceForm: () => <div data-testid="data-source-form" />,
}))

// DataSourceForm is mocked above — no RTK Query hooks from the real form run

import { DataSourceCreatePage } from "./data-source-create-page"

// ---------------------------------------------------------------------------
// Section 7.3 — DataSourceCreatePage
// ---------------------------------------------------------------------------

describe("DataSourceCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 7.3
  it("[tag:data-source-create-page] renders DataSourceForm and remounts on location pathname change", () => {
    // First render at /data-sources/create
    const { unmount } = renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/data-sources/create",
          element: <DataSourceCreatePage />,
        },
      ],
      initialEntries: ["/data-sources/create"],
    })

    expect(screen.getByTestId("data-source-form")).toBeInTheDocument()

    unmount()

    // Re-render at a different path — key prop will differ, triggering remount
    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/data-sources/create2",
          element: <DataSourceCreatePage />,
        },
      ],
      initialEntries: ["/data-sources/create2"],
    })

    expect(screen.getByTestId("data-source-form")).toBeInTheDocument()
  })
})
