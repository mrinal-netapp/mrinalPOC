import { Outlet } from "react-router"
import { screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/contexts/auth/guards/AppAuthGate", () => ({
  AppAuthGate: () => <Outlet />,
}))

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    token: null,
    roles: [],
    permissions: [],
    loading: false,
    error: null,
    logout: async () => {},
    checkAuth: async () => {},
    refreshToken: async () => null,
  })),
}))

import { renderWithProviders, userEvent } from "@test/render"
import { ObservabilityPage } from "./observability-page"

describe("ObservabilityPage", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("[tag:observability][tag:page][tag:rendering] renders page title and description", () => {
    renderWithProviders(<ObservabilityPage />)

    expect(screen.getByRole("heading", { name: "Observability" })).toBeInTheDocument()
    expect(screen.getByText(/Monitor logs, metrics, and traces/)).toBeInTheDocument()
  })

  it("[tag:observability][tag:page][tag:rendering] renders all four tile cards with headings", () => {
    renderWithProviders(<ObservabilityPage />)

    expect(screen.getByRole("heading", { name: "Logs" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Metrics" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "App Traces" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Agent Traces" })).toBeInTheDocument()
  })

  it("[tag:observability][tag:page][tag:button] opens Grafana service-overview URL in new tab when Metrics is clicked", async () => {
    vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
    vi.stubEnv("VITE_PHOENIX_URL", "https://phoenix.example.com")
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null)
    const user = userEvent.setup()

    renderWithProviders(<ObservabilityPage />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-abc", name: "", role: null },
        },
      },
    })

    const openButtons = screen.getAllByRole("button", { name: "Open" })
    await user.click(openButtons[1]) // Metrics is second

    expect(windowOpen).toHaveBeenCalledWith(
      expect.stringContaining("var-project=proj-abc"),
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("[tag:observability][tag:page][tag:button] opens App Logs dashboard without project scope when Logs is clicked", async () => {
    vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
    vi.stubEnv("VITE_PHOENIX_URL", "https://phoenix.example.com")
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null)
    const user = userEvent.setup()

    renderWithProviders(<ObservabilityPage />, {
      preloadedState: {
        projectContext: {
          activeProject: { id: "proj-abc", name: "", role: null },
        },
      },
    })

    const openButtons = screen.getAllByRole("button", { name: "Open" })
    await user.click(openButtons[0]) // Logs is first

    expect(windowOpen).toHaveBeenCalledWith(
      "https://grafana.example.com/d/app-logs/app-logs?orgId=1",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("[tag:observability][tag:page][tag:button] disables all Open buttons when observability URLs are not configured", () => {
    vi.stubEnv("VITE_GRAFANA_URL", "")
    vi.stubEnv("VITE_PHOENIX_URL", "")
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "")
    delete window.__RUNTIME_CONFIG__
    // jsdom uses "localhost" (single-label) → no domain fallback → all URLs empty

    renderWithProviders(<ObservabilityPage />)

    const openButtons = screen.getAllByRole("button", { name: "Open" })
    expect(openButtons).toHaveLength(4)
    openButtons.forEach((btn) => expect(btn).toBeDisabled())
  })

  it("[tag:observability][tag:page][tag:button] opens phoenix URL in new tab when Agent Traces is clicked", async () => {
    vi.stubEnv("VITE_GRAFANA_URL", "https://grafana.example.com")
    vi.stubEnv("VITE_PHOENIX_URL", "https://phoenix.example.com")
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null)
    const user = userEvent.setup()

    renderWithProviders(<ObservabilityPage />)

    const openButtons = screen.getAllByRole("button", { name: "Open" })
    await user.click(openButtons[3]) // Agent Traces is last

    expect(windowOpen).toHaveBeenCalledWith("https://phoenix.example.com", "_blank", "noopener,noreferrer")
  })
})
