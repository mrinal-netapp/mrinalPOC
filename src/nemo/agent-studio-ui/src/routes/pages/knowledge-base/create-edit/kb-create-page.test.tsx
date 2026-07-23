import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

vi.mock("./form/kb-form", () => ({
  KBForm: () => <div data-testid="kb-form" />,
}))

import { KBCreatePage } from "./kb-create-page"

describe("KBCreatePage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:kb-create-page] renders KBForm and remounts on location pathname change", () => {
    const { unmount } = renderWithProviders(undefined, {
      routeConfig: [
        { path: "/knowledge-bases/create", element: <KBCreatePage /> },
      ],
      initialEntries: ["/knowledge-bases/create"],
    })

    expect(screen.getByTestId("kb-form")).toBeInTheDocument()

    unmount()

    renderWithProviders(undefined, {
      routeConfig: [
        { path: "/knowledge-bases/create2", element: <KBCreatePage /> },
      ],
      initialEntries: ["/knowledge-bases/create2"],
    })

    expect(screen.getByTestId("kb-form")).toBeInTheDocument()
  })
})
