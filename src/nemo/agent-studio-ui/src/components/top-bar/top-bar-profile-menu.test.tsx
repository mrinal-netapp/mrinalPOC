import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import type { AuthContextValue } from "@/contexts/auth/model/auth.types"

import { TopBarProfileMenu } from "./top-bar-profile-menu"

const mockLogout = vi.fn()

const BASE_AUTH: AuthContextValue = {
  isAuthenticated: false,
  token: null,
  user: null,
  roles: [],
  permissions: [],
  loading: false,
  error: null,
  logout: mockLogout,
  checkAuth: async () => {},
  refreshToken: async () => null,
}

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(() => false),
}))

vi.mock("@/contexts/auth/hooks/useAuth", () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    user: null,
    logout: mockLogout,
  })),
}))

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig"
import { useAuth } from "@/contexts/auth/hooks/useAuth"

describe("TopBarProfileMenu", () => {
  beforeEach(() => {
    mockLogout.mockReset()
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false)
    vi.mocked(useAuth).mockReturnValue(BASE_AUTH)
  })

  it("renders profile button without menu when OIDC is disabled", () => {
    renderWithProviders(<TopBarProfileMenu />)

    expect(screen.getByRole("button", { name: "User profile" })).toBeInTheDocument()
    expect(screen.queryByText("User Settings")).not.toBeInTheDocument()
  })

  it("shows user settings panel and calls logout when OIDC is enabled", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true)
    mockLogout.mockResolvedValue(undefined)
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: true,
      token: "token",
      user: {
        id: "user-1",
        name: "Test User",
        email: "test.user@example.com",
      },
    })

    const user = userEvent.setup()
    renderWithProviders(<TopBarProfileMenu />)

    await user.click(screen.getByRole("button", { name: "User profile" }))
    await screen.findByText("User Settings")
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Test User")).toBeInTheDocument()
    expect(screen.getByText("test.user@example.com")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Logout" }))

    await waitFor(() => {
      expect(mockLogout).toHaveBeenCalledOnce()
    })
  })

  it("shows email as the profile value when name is missing", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true)
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: true,
      token: "token",
      user: {
        id: "user-1",
        email: "fallback@example.com",
      },
    })

    const user = userEvent.setup()
    renderWithProviders(<TopBarProfileMenu />)

    await user.click(screen.getByRole("button", { name: "User profile" }))
    await screen.findByText("User Settings")

    const detailValue = document.querySelector(".top-bar-panel__detail-value")
    const detailMeta = document.querySelector(".top-bar-panel__detail-meta")

    expect(detailValue).toHaveTextContent("fallback@example.com")
    expect(detailMeta).toHaveTextContent("fallback@example.com")
  })

  it("shows unknown user when name and email are missing", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true)
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: true,
      token: "token",
    })

    const user = userEvent.setup()
    renderWithProviders(<TopBarProfileMenu />)

    await user.click(screen.getByRole("button", { name: "User profile" }))
    await screen.findByText("User Settings")

    expect(screen.getByText("Unknown user")).toBeInTheDocument()
    expect(document.querySelector(".top-bar-panel__detail-meta")).not.toBeInTheDocument()
  })
})
