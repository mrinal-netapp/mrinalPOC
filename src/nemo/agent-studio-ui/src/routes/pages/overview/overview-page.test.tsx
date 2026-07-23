import { screen, waitFor } from "@testing-library/react"
import { useLocation } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { renderWithProviders, userEvent } from "@test/render"
import { OVERVIEW_CREATE_PROJECT_TITLE, OVERVIEW_FEATURES, OVERVIEW_HERO } from "./overview.consts"
import { OverviewPage } from "./overview-page"

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    user: { id: "user-123" },
    loading: false,
  })),
}))

function LocationDisplay(): ReactElement {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

describe("OverviewPage", () => {
  afterEach(() => {
    restoreAllMocks()
  })

  it("[tag:overview] renders the hero copy", () => {
    mockFetchSuccess({ projects: [] })

    renderWithProviders(<OverviewPage />)

    expect(screen.getByRole("heading", { level: 1, name: OVERVIEW_HERO.title })).toBeInTheDocument()
    expect(screen.getByText(OVERVIEW_HERO.tagline)).toBeInTheDocument()
    expect(screen.getByText(OVERVIEW_HERO.description)).toBeInTheDocument()
  })

  it("[tag:overview][tag:projects] renders only the launch project tile when no projects exist", async () => {
    mockFetchSuccess({ projects: [] })

    renderWithProviders(<OverviewPage />)

    const launchTileHeading = await screen.findByRole("heading", {
      level: 2,
      name: OVERVIEW_FEATURES[0].title,
    })
    const grid = launchTileHeading.closest(".overview-page__grid")

    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1)
    expect(grid).toHaveClass("overview-page__grid--single")
    expect(screen.getByText(OVERVIEW_FEATURES[0].description)).toBeInTheDocument()
  })

  it("[tag:overview][tag:projects] renders all feature tiles and renames the first tile when projects exist", async () => {
    mockFetchSuccess({
      projects: [
        {
          id: "project-1",
          name: "Project 1",
          description: "A project",
          created_at: "2026-06-15T00:00:00Z",
          updated_at: "2026-06-15T00:00:00Z",
        },
      ],
    })

    renderWithProviders(<OverviewPage />)

    expect(await screen.findByRole("heading", { level: 2, name: OVERVIEW_CREATE_PROJECT_TITLE })).toBeInTheDocument()
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(OVERVIEW_FEATURES.length)
    expect(screen.queryByRole("heading", { level: 2, name: OVERVIEW_FEATURES[0].title })).not.toBeInTheDocument()
    expect(screen.getByText(OVERVIEW_FEATURES[1].title)).toBeInTheDocument()
  })

  it("[tag:overview][tag:routes] navigates to the feature route when a tile action is clicked", async () => {
    const user = userEvent.setup()
    mockFetchSuccess({ projects: [] })

    renderWithProviders(
      <>
        <OverviewPage />
        <LocationDisplay />
      </>,
      { initialEntries: ["/overview"] },
    )

    await user.click(await screen.findByRole("button", { name: OVERVIEW_FEATURES[0].buttonLabel }))

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(OVERVIEW_FEATURES[0].to)
    })
  })
})
