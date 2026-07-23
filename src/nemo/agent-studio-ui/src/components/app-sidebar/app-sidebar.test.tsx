import { Outlet } from "react-router"
import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

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

import { useAuth } from "@/contexts/auth/hooks/useAuth"
import { renderWithProviders, userEvent } from "@test/render"
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock"
import { routes } from "@/routes/routes"
import { ROUTES } from "@/routes/routes.consts"
import { PROJECTS_LIST_STRINGS } from "@/routes/pages/projects/projects.consts"
import { SIDEBAR_NAV_ITEMS } from "@/consts/sidebar-nav.consts"
import {
  layoutSlice,
  toggleSidebar,
  setSidebarOpen,
} from "@/store/slices/layout.slice"

import { AppSidebar } from "./app-sidebar"

const layoutReducer = layoutSlice.reducer
// The sidebar gates on BOTH `hasActiveProject` AND `requiredRoles` per
// item. Tests bypass with an admin project — that satisfies items
// without role gating, ["admin"], and ["admin","member","viewer"], but
// NOT ["super-admin"] (Jobs, Configurations, Chatbot). Tests that
// iterate every item filter via `VISIBLE_FOR_ADMIN` below to match the
// actually-rendered set.
const ALLOW_ALL_ROLES_CONTEXT = {
  hasAnyRole: () => true,
  hasActiveProject: true,
  activeProject: { id: "test-proj", name: "Test", role: "admin" as const },
}

/** Labels the admin-role test context renders — drops super-admin-only items. */
const VISIBLE_FOR_ADMIN = SIDEBAR_NAV_ITEMS
  .filter((item) => item.requiredRoles == null || item.requiredRoles.includes("admin"))
  .map(({ label }) => label)

/** Labels gated solely behind `super-admin` — the platform-tier pages
 * that require a Keycloak realm role rather than a project membership
 * role. Used by the super-admin coverage test below. */
const SUPER_ADMIN_ONLY_LABELS = SIDEBAR_NAV_ITEMS
  .filter((item) => item.requiredRoles?.includes("super-admin"))
  .map(({ label }) => label)

const DEFAULT_AUTH_VALUE = {
  isAuthenticated: false,
  token: null,
  // `user` is required by AuthContextValue's type; the sidebar never
  // reads it, but TS needs the field present for the override casts.
  user: null,
  roles: [] as readonly string[],
  permissions: [] as readonly string[],
  loading: false,
  error: null,
  logout: async () => {},
  checkAuth: async () => {},
  refreshToken: async () => null,
} as const

/** Override `useAuth` for one test — caller must restore after. */
function mockAuthRoles(roles: readonly string[]): void {
  vi.mocked(useAuth).mockReturnValue({ ...DEFAULT_AUTH_VALUE, roles })
}

describe("AppSidebar", () => {
  // -- 2.1 Renders all elements when expanded
  it("[tag:app-sidebar][tag:sidebar][tag:button][tag:typography][tag:routes][tag:expanded] should render header, all nav items, and expanded state", () => {
    renderWithProviders(<AppSidebar open={true} />, {
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    expect(screen.getByRole("tab", { name: "Agent Studio" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Management" })).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("complementary")).toHaveAttribute("data-state", "expanded")
    VISIBLE_FOR_ADMIN.forEach((label) => {
      expect(screen.getByText(label)).toBeInTheDocument()
    })
  })

  // -- 2.4 Collapsed state
  it("[tag:app-sidebar][tag:sidebar][tag:collapsed] should pass open=false to Sidebar as collapsed state", () => {
    renderWithProviders(<AppSidebar open={false} />)

    expect(screen.getByRole("complementary")).toHaveAttribute("data-state", "collapsed")
  })

  // -- 2.5 Active item based on route
  it("[tag:app-sidebar][tag:sidebar][tag:active][tag:routes] should mark the matching nav item as active based on current route", () => {
    renderWithProviders(<AppSidebar open={true} />, {
      initialEntries: ["/overview"],
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    expect(
      screen.getByText("Overview").closest("[data-slot='sidebar-menu-button']"),
    ).toHaveAttribute("data-active")

    const inactiveLabels = VISIBLE_FOR_ADMIN.filter((label) => label !== "Overview")
    inactiveLabels.forEach((label) => {
      expect(
        screen.getByText(label).closest("[data-slot='sidebar-menu-button']"),
      ).not.toHaveAttribute("data-active")
    })
  })

  // -- 2.6 No active item when route doesn't match
  it("[tag:app-sidebar][tag:sidebar][tag:inactive][tag:routes] should not mark any item as active when route does not match", () => {
    renderWithProviders(<AppSidebar open={true} />, {
      initialEntries: ["/"],
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    VISIBLE_FOR_ADMIN.forEach((label) => {
      expect(
        screen.getByText(label).closest("[data-slot='sidebar-menu-button']"),
      ).not.toHaveAttribute("data-active")
    })
  })

  // -- 2.7 Navigates on click
  it("[tag:app-sidebar][tag:sidebar][tag:button][tag:routes] should navigate and update active state when a nav item is clicked", async () => {
    // Setup
    const user = userEvent.setup()

    // Execute
    renderWithProviders(<AppSidebar open={true} />, {
      initialEntries: ["/overview"],
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })
    await user.click(screen.getByText("Knowledge Bases"))

    // Validate
    expect(
      screen.getByText("Knowledge Bases").closest("[data-slot='sidebar-menu-button']"),
    ).toHaveAttribute("data-active")
    expect(
      screen.getByText("Overview").closest("[data-slot='sidebar-menu-button']"),
    ).not.toHaveAttribute("data-active")
  })

  it("[tag:app-sidebar][tag:routes] should navigate to Management when Management tab is clicked", async () => {
    mockFetchSuccess({ projects: [] })
    const user = userEvent.setup()

    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: [`/${ROUTES.OVERVIEW}`],
    })

    await user.click(screen.getByRole("tab", { name: "Management" }))

    expect(screen.getByRole("heading", { name: PROJECTS_LIST_STRINGS.PAGE_TITLE })).toBeInTheDocument()

    restoreAllMocks()
  })

  it("[tag:app-sidebar][tag:sidebar][tag:button][tag:routes] should activate the clicked item for each navigation target", async () => {
    // Setup
    const user = userEvent.setup()

    // Execute & Validate — click each visible item and verify it becomes active
    renderWithProviders(<AppSidebar open={true} />, {
      initialEntries: ["/"],
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    for (const label of VISIBLE_FOR_ADMIN) {
      await user.click(screen.getByText(label))

      expect(
        screen.getByText(label).closest("[data-slot='sidebar-menu-button']"),
      ).toHaveAttribute("data-active")
    }
  })

  // -- super-admin realm role surfaces platform-tier nav items
  it("[tag:app-sidebar][tag:sidebar][tag:roles][tag:super-admin] should render super-admin-only items when the caller's auth realm roles include 'super-admin'", () => {
    // The sidebar unions the active project's membership role with the
    // caller's auth realm roles before checking `requiredRoles`. With
    // the default auth mock (`roles: []`) the super-admin items (Jobs,
    // Configurations, Chatbot) stay hidden even for an admin project
    // role. Overriding the auth roles flips them on. Active project is
    // still set so the project-scoped items also render.
    mockAuthRoles(["super-admin"])
    try {
      renderWithProviders(<AppSidebar open={true} />, {
        projectContext: ALLOW_ALL_ROLES_CONTEXT,
      })

      // Super-admin gate is satisfied → those rows are visible.
      expect(SUPER_ADMIN_ONLY_LABELS.length).toBeGreaterThan(0)
      SUPER_ADMIN_ONLY_LABELS.forEach((label) => {
        expect(screen.getByText(label)).toBeInTheDocument()
      })
      // Project-scoped items still render too (project role = admin).
      expect(screen.getByText("Overview")).toBeInTheDocument()
      expect(screen.getByText("Administration")).toBeInTheDocument()
    } finally {
      vi.mocked(useAuth).mockReturnValue(DEFAULT_AUTH_VALUE)
    }
  })

  // -- super-admin items are hidden when the realm role is absent
  it("[tag:app-sidebar][tag:sidebar][tag:roles][tag:super-admin] should hide super-admin-only items when the caller has no super-admin realm role", () => {
    // Default auth mock (roles=[]) + admin project role: confirms the
    // super-admin items are NOT visible. Acts as the negative half of
    // the test above so neither half can silently regress on its own.
    renderWithProviders(<AppSidebar open={true} />, {
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    expect(SUPER_ADMIN_ONLY_LABELS.length).toBeGreaterThan(0)
    SUPER_ADMIN_ONLY_LABELS.forEach((label) => {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    })
  })

  // -- Observability nav item
  it("[tag:app-sidebar][tag:sidebar][tag:observability] should render the Observability nav item and mark it active on click", async () => {
    const user = userEvent.setup()

    renderWithProviders(<AppSidebar open={true} />, {
      initialEntries: ["/"],
      projectContext: ALLOW_ALL_ROLES_CONTEXT,
    })

    expect(screen.getByText("Observability")).toBeInTheDocument()

    await user.click(screen.getByText("Observability"))

    expect(
      screen.getByText("Observability").closest("[data-slot='sidebar-menu-button']"),
    ).toHaveAttribute("data-active")
  })

  describe("layout slice", () => {
    // -- toggleSidebar reducer
    it("[tag:app-sidebar][tag:redux] should toggle isSidebarOpen from true to false", () => {
      const state = layoutReducer({ isSidebarOpen: true }, toggleSidebar())

      expect(state.isSidebarOpen).toBe(false)
    })

    // -- setSidebarOpen reducer
    it("[tag:app-sidebar][tag:redux] should set isSidebarOpen to the provided value", () => {
      const stateOff = layoutReducer({ isSidebarOpen: true }, setSidebarOpen(false))
      expect(stateOff.isSidebarOpen).toBe(false)

      const stateOn = layoutReducer({ isSidebarOpen: false }, setSidebarOpen(true))
      expect(stateOn.isSidebarOpen).toBe(true)
    })
  })
})
