import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { useLocation } from "react-router"
import type { ReactElement } from "react";

import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { toggleSidebar } from "@/store/slices/layout.slice"
import { PROJECT_SWITCHER_STRINGS } from "@/components/project-switcher/project-switcher.consts"

import { TopBar } from "./top-bar"

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }))

vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>()
  return {
    ...actual,
    useAppDispatch: () => mockDispatch,
  }
})

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(() => false),
}))

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    token: null,
    user: null,
    roles: [],
    permissions: [],
    loading: false,
    error: null,
    logout: async () => {},
    checkAuth: async () => {},
    refreshToken: async () => null,
  })),
}))

function LocationDisplay(): ReactElement {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

describe("TopBar", () => {
  beforeEach(() => {
    mockDispatch.mockClear()
    mockFetchSuccess({ projects: [] })
  })

  afterEach(() => {
    restoreAllMocks()
  })

  // -- 3.2 Renders all static elements
  it("[tag:topbar][tag:button][tag:routes][tag:redux] should render sections, logo, hamburger, and icon buttons", () => {
    renderWithProviders(<TopBar />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "test-project", name: "Test Project", role: "admin" },
        },
      },
    })

    expect(screen.getByTestId("top-bar-left")).toBeInTheDocument()
    expect(screen.getByTestId("top-bar-right")).toBeInTheDocument()
    expect(screen.getByText("Agent Studio")).toBeInTheDocument()
    expect(screen.getByTestId("project-switcher-trigger")).toBeInTheDocument()
    expect(screen.getByText(PROJECT_SWITCHER_STRINGS.TRIGGER_LABEL)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Current project: Test Project/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "NetApp" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Help" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "User profile" })).toBeInTheDocument()
  })

  // -- 3.7 Dispatches toggleSidebar on hamburger click
  it("[tag:topbar][tag:button][tag:redux] should dispatch toggleSidebar when hamburger button is clicked", async () => {
    // Setup
    const user = userEvent.setup()

    // Execute
    renderWithProviders(<TopBar />)
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }))

    // Validate
    expect(mockDispatch).toHaveBeenCalledOnce()
    expect(mockDispatch).toHaveBeenCalledWith(toggleSidebar())
  })

  // -- 3.8 Navigates to HOME on logo click
  it("[tag:topbar][tag:button][tag:routes] should navigate to home route when NetApp logo is clicked", async () => {
    // Setup
    const user = userEvent.setup()

    // Execute
    renderWithProviders(
      <>
        <TopBar />
        <LocationDisplay />
      </>,
      { initialEntries: ["/overview"] },
    )
    await user.click(screen.getByRole("button", { name: "NetApp" }))

    // Validate
    expect(screen.getByTestId("location")).toHaveTextContent("/")
  })

  it("[tag:topbar][tag:dialog] should open notifications and help panels", async () => {
    const user = userEvent.setup()

    renderWithProviders(<TopBar />)

    await user.click(screen.getByRole("button", { name: "Notifications" }))
    expect(await screen.findByText("Notifications")).toBeInTheDocument()
    expect(screen.getByText("Go To Settings")).toBeInTheDocument()
    expect(screen.getByText("No notifications")).toBeInTheDocument()
    expect(screen.getByText("You're all caught up.")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => {
      expect(screen.queryByText("No notifications")).not.toBeInTheDocument()
    })

    await user.click(screen.getByRole("button", { name: "Help" }))
    expect(await screen.findByText("Help")).toBeInTheDocument()
    expect(screen.getByText("Support")).toBeInTheDocument()
  })
})
